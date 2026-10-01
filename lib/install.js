/**
 * Install — turn a catalog card into a real `SKILL.md` on disk.
 *
 * The whole point of the market is that pressing Install produces a file the
 * agent will actually load, so this module is deliberately strict about the
 * three things that can go wrong:
 *
 *   1. **Where it writes.** The skill name is sanitized and the final path is
 *      proven to stay inside the chosen root, so a hostile name in a fetched
 *      frontmatter block cannot escape the skills directory.
 *   2. **What it fetches.** Only `https:` is accepted by default, redirects are
 *      followed by `fetch` itself but every response is size-capped, and a
 *      non-2xx status is an error rather than an empty file.
 *   3. **How much it writes.** A bundle's sibling files are fetched only when the
 *      source is a GitHub directory (the one case where the file list is
 *      knowable), bounded by count and by total bytes.
 *
 * A bundle is written whole or not at all: `SKILL.md` is written last, so a
 * failure part-way through leaves no directory that looks like a working skill.
 *
 * @module skills-market/lib/install
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { parseSkillMarkdown } from './frontmatter.js'
import { isSafeSkillName, resolveSkillPath } from './roots.js'

/** Largest single file accepted from a remote source. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

/** Largest total payload accepted for one bundle install. */
export const DEFAULT_MAX_TOTAL_BYTES = 12 * 1024 * 1024

/** Most sibling files fetched alongside a `SKILL.md`. */
export const DEFAULT_MAX_SIBLING_FILES = 40

/** Default network timeout for one request. */
export const DEFAULT_TIMEOUT_MS = 20_000

/**
 * Reject a URL this plugin refuses to fetch.
 *
 * `https:` only, unless the operator explicitly opted into insecure fetches. A
 * loopback or link-local host is refused even then: this endpoint is reachable
 * from the settings page, and an install that could be pointed at
 * `http://127.0.0.1:9200/` would be a request-forgery primitive against
 * whatever else is listening on the machine.
 *
 * @param rawUrl - Candidate URL.
 * @param options - `{ allowInsecure }`.
 * @returns The parsed `URL`.
 * @throws When the URL is not fetchable.
 */
export function assertFetchableUrl(rawUrl, { allowInsecure = false } = {}) {
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    throw new Error(`not a valid URL: ${String(rawUrl)}`)
  }

  if (url.protocol === 'http:') {
    if (!allowInsecure) throw new Error('refusing plain http; enable allowInsecure to permit it')
  } else if (url.protocol !== 'https:') {
    throw new Error(`refusing ${url.protocol} URLs`)
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const isLoopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  if (isLoopback && !allowInsecure) throw new Error(`refusing to fetch a private address: ${host}`)

  return url
}

/**
 * Fetch a URL as text, with a timeout and a hard size cap.
 *
 * @param rawUrl - Absolute URL.
 * @param options - `{ fetchImpl, timeoutMs, maxBytes, allowInsecure, token, headers }`.
 * @returns `{ text, url, status }` — `url` is the final URL after redirects.
 * @throws On a non-2xx status, an oversized body, or a network failure.
 */
export async function fetchText(rawUrl, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_FILE_BYTES,
    allowInsecure = false,
    token,
    headers = {},
  } = options

  const url = assertFetchableUrl(rawUrl, { allowInsecure })
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available')

  const requestHeaders = { accept: 'text/plain, text/markdown, application/json;q=0.9, */*;q=0.5', 'user-agent': 'dsh-skills-market', ...headers }
  if (typeof token === 'string' && token !== '') requestHeaders.authorization = `Bearer ${token}`

  const response = await fetchImpl(url.href, {
    headers: requestHeaders,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url.href}`)
  }

  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response too large: ${declared} bytes (limit ${maxBytes})`)
  }

  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`response too large: limit ${maxBytes} bytes`)
  }

  return { text, url: response.url ?? url.href, status: response.status }
}

/**
 * Build a `raw.githubusercontent.com` URL.
 * @param spec - `{ owner, repo, branch, path }`.
 * @returns The raw URL.
 * @throws When any segment contains characters that would change the URL shape.
 */
export function githubRawUrl({ owner, repo, branch = 'main', path: filePath }) {
  const segment = /^[A-Za-z0-9._-]+$/
  if (!segment.test(String(owner ?? ''))) throw new Error(`bad GitHub owner: ${owner}`)
  if (!segment.test(String(repo ?? ''))) throw new Error(`bad GitHub repo: ${repo}`)
  if (!segment.test(String(branch ?? ''))) throw new Error(`bad GitHub branch: ${branch}`)
  const clean = String(filePath ?? '').replace(/^\/+/, '')
  if (clean === '' || clean.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`bad GitHub path: ${filePath}`)
  }
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${clean}`
}

/**
 * Reduce arbitrary text to a safe skill directory name.
 *
 * The standard allows letters, digits, and `-` `_` `.`; anything else is folded
 * to `-` so a skill named `React: Patterns & Pitfalls` still installs as
 * `react-patterns-pitfalls` instead of being rejected outright.
 *
 * @param value - Candidate name.
 * @returns A safe, non-empty name.
 */
export function slugifySkillName(value) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-_.]+/, '')
    .replace(/[-_.]+$/, '')
    .slice(0, 64)
  return slug === '' ? 'skill' : slug
}

/**
 * Decide what to call the skill being installed.
 *
 * Precedence: an explicit name from the card, then the fetched frontmatter's own
 * `name:`, then the URL — where a `.../<dir>/SKILL.md` URL yields `<dir>` rather
 * than the literal `SKILL.md`.
 *
 * @param options - `{ explicit, markdown, url }`.
 * @returns A safe skill name.
 */
export function deriveSkillName({ explicit, markdown, url } = {}) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return slugifySkillName(explicit.trim())

  if (typeof markdown === 'string') {
    const { data } = parseSkillMarkdown(markdown)
    if (typeof data.name === 'string' && data.name.trim() !== '') return slugifySkillName(data.name.trim())
  }

  if (typeof url === 'string') {
    try {
      const parts = new URL(url).pathname.split('/').filter((part) => part !== '')
      const last = parts[parts.length - 1] ?? ''
      const stem = last.toLowerCase() === 'skill.md' ? (parts[parts.length - 2] ?? '') : last.replace(/\.md$/i, '')
      if (stem !== '') return slugifySkillName(stem)
    } catch {
      /* fall through to the generic name */
    }
  }

  return 'skill'
}

/**
 * Normalize a relative file name coming from a remote listing.
 * @param relative - Candidate relative path.
 * @returns A safe, forward-slashed relative path.
 * @throws When the path is absolute, empty, or contains a traversal segment.
 */
export function safeRelativeFile(relative) {
  const clean = String(relative ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (clean === '') throw new Error('empty file name')
  const parts = clean.split('/')
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') throw new Error(`unsafe file path: ${relative}`)
    if (part.includes('\0')) throw new Error(`unsafe file path: ${relative}`)
  }
  return clean
}

/**
 * List a GitHub directory through the public contents API.
 *
 * Used only to find a bundle's sibling files. The API allows 60 unauthenticated
 * requests an hour, which is why a token is a config field: a rate-limited
 * listing degrades to "install just `SKILL.md`" instead of failing the install.
 *
 * @param spec - `{ owner, repo, branch, dir, token, fetchImpl, timeoutMs }`.
 * @returns `{ files }` — entries of `{ path, name, downloadUrl }`.
 * @throws When the API rejects the request.
 */
export async function listGithubDirectory({ owner, repo, branch = 'main', dir = '', token, fetchImpl, timeoutMs }) {
  const cleanDir = String(dir ?? '').replace(/^\/+|\/+$/g, '')
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${cleanDir}?ref=${encodeURIComponent(branch)}`
  const { text } = await fetchText(url, {
    fetchImpl,
    timeoutMs,
    maxBytes: 1024 * 1024,
    token,
    headers: { accept: 'application/vnd.github+json' },
  })

  const payload = JSON.parse(text)
  if (!Array.isArray(payload)) throw new Error('GitHub contents API did not return a directory listing')

  return {
    files: payload
      .filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => ({
        name: String(entry.name ?? ''),
        path: String(entry.path ?? ''),
        type: String(entry.type ?? ''),
        downloadUrl: typeof entry.download_url === 'string' ? entry.download_url : undefined,
      })),
  }
}

/** Deepest a bundle's subdirectories are walked when fetching siblings. */
const MAX_BUNDLE_DEPTH = 2

/**
 * Fetch a GitHub skill directory's sibling files, recursively but bounded.
 *
 * A bundle's `SKILL.md` routinely points at `rules/`, `references/` or
 * `themes/`, so a one-level listing would install a skill whose own instructions
 * reference files that are not there. The walk therefore descends, but under
 * three hard limits — depth, file count, and a byte budget — because
 * `vercel-labs/agent-skills` ships a skill with roughly eighty rule files and an
 * unbounded fetch would turn one Install click into a large download.
 *
 * A directory that cannot be listed, and a file that cannot be read, are both
 * skipped: `SKILL.md` is the contract, and a partial bundle beats a failed
 * install.
 *
 * @param options - `{ owner, repo, branch, dir, token, fetchImpl, timeoutMs, allowInsecure, maxFiles, budget }`.
 * @returns `{ files, bytes }` — `{ name, content }` entries relative to `dir`.
 */
async function collectGithubBundle({ owner, repo, branch, dir, token, fetchImpl, timeoutMs, allowInsecure, maxFiles, budget }) {
  const collected = []
  const queue = [{ dir, depth: 0 }]
  let spent = 0

  while (queue.length > 0 && collected.length < maxFiles && spent < budget) {
    const { dir: current, depth } = queue.shift()
    let listing
    try {
      ;({ files: listing } = await listGithubDirectory({ owner, repo, branch, dir: current, token, fetchImpl, timeoutMs }))
    } catch {
      continue
    }

    for (const entry of listing) {
      if (collected.length >= maxFiles || spent >= budget) break

      if (entry.type === 'dir') {
        if (depth < MAX_BUNDLE_DEPTH && entry.path !== '') queue.push({ dir: entry.path, depth: depth + 1 })
        continue
      }
      if (entry.type !== 'file' || entry.downloadUrl === undefined) continue
      if (entry.name.toLowerCase() === 'skill.md') continue

      const relative = dir === '' ? entry.path : entry.path.slice(dir.length + 1)
      try {
        const sibling = await fetchText(entry.downloadUrl, {
          fetchImpl,
          timeoutMs,
          allowInsecure,
          maxBytes: Math.min(budget - spent, DEFAULT_MAX_FILE_BYTES),
        })
        collected.push({ name: relative, content: sibling.text })
        spent += Buffer.byteLength(sibling.text, 'utf8')
      } catch {
        // One unreadable sibling must not fail the install: SKILL.md is the contract.
      }
    }
  }

  return { files: collected, bytes: spent }
}

/**
 * Resolve a catalog source descriptor into the exact files to write.
 *
 * Supported kinds:
 *   `raw`        a direct URL to a `SKILL.md`
 *   `github`     `{ owner, repo, branch, path }`, optionally with siblings
 *   `files`      an already-resolved `{ name, content }` list (used by callers
 *                that fetched through another API, e.g. the skills.sh tree)
 *
 * @param options - `{ source, fetchImpl, config, timeoutMs }`.
 * @returns `{ name, files, origin }` where `files[0].name` is `SKILL.md`.
 * @throws On an unknown kind, a failed fetch, or a source without a `SKILL.md`.
 */
export async function resolveSource({ source, fetchImpl, config = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const allowInsecure = config.allowInsecure === true
  const maxSiblings = config.maxSiblingFiles ?? DEFAULT_MAX_SIBLING_FILES
  const kind = source?.kind

  if (kind === 'files') {
    const files = Array.isArray(source.files) ? source.files : []
    const entry = files.find((file) => String(file?.name ?? '').toLowerCase() === 'skill.md')
    if (entry === undefined) throw new Error('source has no SKILL.md')
    return {
      name: deriveSkillName({ explicit: source.name, markdown: entry.content, url: source.url }),
      files: files.map((file) => ({ name: safeRelativeFile(file.name), content: String(file.content ?? '') })),
      origin: source.url ?? 'files',
    }
  }

  if (kind === 'raw') {
    const { text, url } = await fetchText(source.url, { fetchImpl, timeoutMs, allowInsecure })
    return {
      name: deriveSkillName({ explicit: source.name, markdown: text, url }),
      files: [{ name: 'SKILL.md', content: text }],
      origin: url,
    }
  }

  if (kind === 'github') {
    const { owner, repo, branch = 'main', path: filePath, name } = source
    const rawUrl = githubRawUrl({ owner, repo, branch, path: filePath })
    const { text } = await fetchText(rawUrl, { fetchImpl, timeoutMs, allowInsecure })

    const files = [{ name: 'SKILL.md', content: text }]
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : ''

    if (source.withSiblings !== false && dir !== '' && maxSiblings > 0) {
      const bundle = await collectGithubBundle({
        owner,
        repo,
        branch,
        dir,
        token: config.githubToken,
        fetchImpl,
        timeoutMs,
        allowInsecure,
        maxFiles: maxSiblings,
        budget: DEFAULT_MAX_TOTAL_BYTES - Buffer.byteLength(text, 'utf8'),
      })
      files.push(...bundle.files)
    }

    return { name: deriveSkillName({ explicit: name, markdown: text, url: rawUrl }), files, origin: rawUrl }
  }

  throw new Error(`unknown source kind: ${String(kind)}`)
}

/**
 * Write a resolved skill into a root.
 *
 * `SKILL.md` is written last so that a crash part-way through a bundle leaves no
 * directory that would scan as an installed skill with missing references.
 *
 * @param options - `{ root, name, files }`.
 * @returns `{ name, dir, path, files, bytes }`.
 * @throws When the name is unsafe or the skill already exists.
 */
export function writeSkill({ root, name, files, overwrite = false }) {
  if (!isSafeSkillName(name)) throw new Error(`unsafe skill name: ${JSON.stringify(name)}`)

  const entryPoint = files.find((file) => file.name.toLowerCase() === 'skill.md')
  if (entryPoint === undefined) throw new Error('refusing to write a bundle without SKILL.md')

  const dir = resolveSkillPath(root, name, false)
  const target = path.join(dir, 'SKILL.md')

  mkdirSync(dir, { recursive: true })

  const written = []
  let bytes = 0
  for (const file of files) {
    if (file.name.toLowerCase() === 'skill.md') continue
    const relative = safeRelativeFile(file.name)
    const absolute = path.join(dir, ...relative.split('/'))
    const inside = path.relative(dir, absolute)
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`refusing to write outside the skill: ${file.name}`)
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, file.content, 'utf8')
    written.push(relative)
    bytes += Buffer.byteLength(file.content, 'utf8')
  }

  writeFileSync(target, entryPoint.content, 'utf8')
  written.unshift('SKILL.md')
  bytes += Buffer.byteLength(entryPoint.content, 'utf8')

  return { name, dir, path: target, files: written, bytes, overwrite }
}

/**
 * Resolve a source and write it into a root, in one call.
 *
 * @param options - `{ source, root, config, fetchImpl, timeoutMs }`.
 * @returns The `writeSkill` result plus `origin` and the resolved `files` list.
 */
export async function installSkill({ source, root, config = {}, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const resolved = await resolveSource({ source, fetchImpl, config, timeoutMs })
  const result = writeSkill({ root, name: resolved.name, files: resolved.files })
  return { ...result, origin: resolved.origin, fileCount: resolved.files.length }
}
