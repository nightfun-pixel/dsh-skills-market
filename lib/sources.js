/**
 * Live catalog sources — the "shop shelves" that are not bundled with the plugin.
 *
 * Three adapters, each answering the same question in a different dialect, and
 * each one written against a shape that was actually observed rather than
 * assumed:
 *
 *   `skillsmp`   SkillsMP's public index API. `GET /api/v1/skills/search`
 *                answers `{ success, data: { skills: [...], pagination }, meta }`
 *                with no credentials. Anonymous access is rate limited (50/day,
 *                10/min), so a key is a config field. Its relevance ranking is
 *                weak — a query returns loosely related rows — which is why the
 *                curated shelf, not this, is the shop's front window.
 *   `skillssh`   skills.sh's API, which also exposes a skill's full file tree —
 *                the one live source that could install a bundle rather than a
 *                single file. Every `/api/v1/*` route requires a Vercel OIDC
 *                bearer token; without one it answers
 *                `401 {"error":"authentication_required"}`, so this source is
 *                dark until a token is configured.
 *   `github`     GitHub code search over `SKILL.md`, which needs a token.
 *
 * **AgenticSkills is deliberately absent.** It was requested as a source, but
 * `agenticskills.com` is a parked domain: the homepage redirects cross-origin to
 * a domain-resale marketplace, and `/api/skills` and `/api/v1/skills` both
 * answer 404. There is no JSON API and no card markup, so there is nothing to
 * scrape. Shipping an adapter against it would put a permanently broken shelf in
 * the shop and imply a catalog that does not exist.
 *
 * Every adapter normalizes to one card shape and every adapter fails softly: a
 * dead source costs its own results and nothing else.
 *
 * @module skills-market/lib/sources
 */

import { fetchText } from './install.js'

/** Default number of cards requested from one source. */
export const DEFAULT_LIMIT = 24

/** Largest number of cards one source may return. */
export const MAX_LIMIT = 60

/** Adapter ids, with the metadata the UI needs to explain a source. */
export const SOURCES = [
  {
    id: 'curated',
    label: 'Curated',
    description: 'Hand-picked frontend, layout, debug and prompt skills, pinned to a verified commit path.',
    live: false,
    needsKey: false,
  },
  {
    id: 'skillsmp',
    label: 'SkillsMP',
    description: 'Public index over open SKILL.md files on GitHub. No key needed; anonymous access is rate limited, and its relevance ranking is loose.',
    live: true,
    needsKey: false,
    keyField: 'skillsmpKey',
    keyUrl: 'https://skillsmp.com',
  },
  {
    id: 'skillssh',
    label: 'skills.sh',
    description: 'Leaderboard of the most-installed skills, with a skill\u2019s full file tree for bundle installs. Every endpoint requires a Vercel OIDC token.',
    live: true,
    needsKey: true,
    keyField: 'skillsshToken',
    keyUrl: 'https://skills.sh/docs/api#authentication',
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'Code search across every public SKILL.md. Requires a personal access token.',
    live: true,
    needsKey: true,
    keyField: 'githubToken',
  },
]

/** Read the first present, non-empty value among several candidate keys. */
function pick(object, keys) {
  if (object === null || typeof object !== 'object') return undefined
  for (const key of keys) {
    const value = object[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    return value
  }
  return undefined
}

/** Read the first present array among several candidate keys. */
function pickList(object, keys) {
  const value = pick(object, keys)
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  return []
}

/** Truncate a description for a card. */
function clip(text, limit = 320) {
  if (typeof text !== 'string') return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return undefined
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat
}

/** Clamp a requested limit into range. */
function clampLimit(limit) {
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(value), MAX_LIMIT)
}

/**
 * Derive the raw SKILL.md URL from a GitHub blob or tree URL.
 * @param raw - A `github.com/.../blob/<branch>/<path>` or tree URL.
 * @returns A `raw.githubusercontent.com` URL, or `undefined`.
 */
export function rawFromGithubUrl(raw) {
  if (typeof raw !== 'string') return undefined
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+?)\/?$/.exec(raw.trim())
  if (match === null) return undefined
  const [, owner, repo, branch, rest] = match
  const path = rest.endsWith('.md') ? rest : `${rest.replace(/\/$/, '')}/SKILL.md`
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`
}

/**
 * Split a GitHub URL into the parts the installer needs.
 * @param raw - A GitHub URL.
 * @returns `{ owner, repo, branch, path }`, or `undefined`.
 */
export function githubSpecFromUrl(raw) {
  if (typeof raw !== 'string') return undefined
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+?)\/?$/.exec(raw.trim())
  if (match === null) return undefined
  const [, owner, repo, branch, rest] = match
  const path = rest.endsWith('.md') ? rest : `${rest.replace(/\/$/, '')}/SKILL.md`
  return { owner, repo, branch, path }
}

/**
 * Choose the cheapest install descriptor that gets this card onto disk.
 *
 * A card that knows its repository installs as a bundle (siblings included); a
 * card that only knows a raw URL installs as a single file.
 *
 * @param card - A partially built card.
 * @returns An install descriptor, or `undefined` when the card is not installable.
 */
function installDescriptorFor(card) {
  if (typeof card.raw === 'string' && card.raw !== '') return { kind: 'raw', url: card.raw, name: card.name }
  const spec = githubSpecFromUrl(card.githubUrl)
  if (spec !== undefined) return { kind: 'github', ...spec, name: card.name }
  return undefined
}

/** Attach the derived install descriptor and drop the bookkeeping fields. */
function finalize(card, source) {
  const install = installDescriptorFor(card)
  return {
    id: card.id,
    name: card.name,
    title: card.title ?? card.name,
    description: card.description,
    tags: card.tags ?? [],
    author: card.author,
    category: card.category,
    source,
    sourceLabel: SOURCES.find((entry) => entry.id === source)?.label ?? source,
    stars: card.stars,
    installs: card.installs,
    updatedAt: card.updatedAt,
    url: card.url ?? card.githubUrl,
    githubUrl: card.githubUrl,
    raw: card.raw,
    install,
    installable: install !== undefined,
  }
}

/**
 * SkillsMP search.
 *
 * The verified response is `{ success, data: { skills, pagination, filters }, meta }`
 * and each skill carries `id`, `name`, `author`, `description`, `contentLanguage`,
 * `githubUrl`, `skillUrl`, `stars`, `updatedAt`. The `githubUrl` is what makes a
 * card installable: it is rewritten to a raw URL, and to a GitHub directory
 * source when it points at a tree rather than a blob.
 *
 * @param options - `{ query, limit, config, fetchImpl, timeoutMs }`.
 * @returns `{ cards, degraded, note }`.
 */
async function searchSkillsMp({ query, limit, config, fetchImpl, timeoutMs }) {
  const url = new URL('https://skillsmp.com/api/v1/skills/search')
  url.searchParams.set('q', query === '' ? 'skill' : query)
  url.searchParams.set('limit', String(clampLimit(limit)))

  const { text } = await fetchText(url.href, { fetchImpl, timeoutMs, token: config.skillsmpKey, maxBytes: 4 * 1024 * 1024 })
  const payload = JSON.parse(text)
  const rows = pickList(payload?.data ?? payload, ['skills', 'results', 'items'])

  const cards = rows
    .filter((row) => row !== null && typeof row === 'object')
    .map((row) => {
      const name = String(pick(row, ['name', 'id']) ?? 'skill')
      const githubUrl = pick(row, ['githubUrl'])
      const spec = githubSpecFromUrl(githubUrl)
      return finalize(
        {
          id: `skillsmp:${pick(row, ['id', 'name']) ?? name}`,
          name,
          title: name,
          description: clip(pick(row, ['description'])),
          // The index does not publish tags; the language and the author are the
          // only extra facets it does publish, so they become the card's chips.
          tags: [pick(row, ['contentLanguage']), pick(row, ['author'])].filter((tag) => typeof tag === 'string' && tag !== ''),
          author: pick(row, ['author']),
          stars: Number(pick(row, ['stars'])) || undefined,
          updatedAt: pick(row, ['updatedAt']),
          url: pick(row, ['skillUrl']),
          githubUrl,
          raw: rawFromGithubUrl(githubUrl),
          spec,
        },
        'skillsmp',
      )
    })
    // A `githubUrl` pointing at a directory installs as a bundle; a blob or a
    // missing URL installs as the single file the raw rewrite produced.
    .map((card, index) => {
      const spec = githubSpecFromUrl(pick(rows[index], ['githubUrl']))
      const direct = pick(rows[index], ['githubUrl'])
      if (spec === undefined || typeof direct !== 'string' || !/\/tree\//.test(direct)) return card
      return {
        ...card,
        install: { kind: 'github', ...spec, name: card.name, withSiblings: true },
        installable: true,
      }
    })

  return { cards, degraded: false, note: undefined }
}

/**
 * skills.sh search.
 *
 * Every `/api/v1/*` route requires a Vercel OIDC bearer token and answers
 * `401 {"error":"authentication_required"}` without one. The response shape
 * beyond that wall is unverified, so the mapping here is deliberately tolerant:
 * it reads the fields the leaderboard is documented to carry and ignores the
 * rest rather than assuming a layout nobody has observed.
 *
 * @param options - `{ query, limit, config, fetchImpl, timeoutMs }`.
 * @returns `{ cards, degraded, note }`.
 */
async function searchSkillsSh({ query, limit, config, fetchImpl, timeoutMs }) {
  if (typeof config.skillsshToken !== 'string' || config.skillsshToken === '') {
    return {
      cards: [],
      degraded: true,
      note: 'skills.sh requires a Vercel OIDC token; add one in the settings card to light this source up.',
    }
  }

  const url = new URL(query === '' ? 'https://skills.sh/api/v1/skills/curated' : 'https://skills.sh/api/v1/skills/search')
  if (query !== '') url.searchParams.set('q', query)
  url.searchParams.set('limit', String(clampLimit(limit)))

  const { text } = await fetchText(url.href, { fetchImpl, timeoutMs, token: config.skillsshToken, maxBytes: 4 * 1024 * 1024 })
  const payload = JSON.parse(text)
  const rows = pickList(payload?.data ?? payload, ['skills', 'results', 'items'])

  const cards = rows
    .filter((row) => row !== null && typeof row === 'object')
    .map((row) => {
      const source = String(pick(row, ['source', 'repo', 'repository', 'owner']) ?? '')
      const skillId = String(pick(row, ['skillId', 'slug', 'id', 'name']) ?? '')
      const name = String(pick(row, ['name', 'slug', 'skillId', 'id']) ?? 'skill')
      const githubUrl = source === '' ? undefined : `https://github.com/${source}`
      const installable = source !== '' && skillId !== ''
      return finalize(
        {
          id: `skillssh:${source}/${skillId}`,
          name,
          title: pick(row, ['title', 'name', 'slug']) ?? name,
          description: clip(pick(row, ['description', 'summary'])),
          tags: pickList(row, ['tags', 'keywords']).map((tag) => String(tag).toLowerCase()),
          author: source === '' ? undefined : source.split('/')[0],
          installs: Number(pick(row, ['installs', 'installCount', 'downloads'])) || undefined,
          url: installable ? `https://skills.sh/${source}/${skillId}` : undefined,
          githubUrl,
          // skills.sh resolves its own tree, so this card installs through its
          // API rather than a raw URL rewrite.
          install: installable ? { kind: 'skillssh', source, skill: skillId, name } : undefined,
          installable,
        },
        'skillssh',
      )
    })

  return { cards, degraded: false, note: undefined }
}

/**
 * GitHub code search over `SKILL.md` files.
 * @param options - `{ query, limit, config, fetchImpl, timeoutMs }`.
 * @returns `{ cards, degraded, note }`.
 */
async function searchGithub({ query, limit, config, fetchImpl, timeoutMs }) {
  if (typeof config.githubToken !== 'string' || config.githubToken === '') {
    return { cards: [], degraded: true, note: 'GitHub search needs a personal access token; add one in the settings card.' }
  }

  const url = new URL('https://api.github.com/search/code')
  url.searchParams.set('q', `filename:SKILL.md ${query === '' ? '' : query}`.trim())
  url.searchParams.set('per_page', String(clampLimit(limit)))

  const { text } = await fetchText(url.href, {
    fetchImpl,
    timeoutMs,
    token: config.githubToken,
    maxBytes: 4 * 1024 * 1024,
    headers: { accept: 'application/vnd.github.text-match+json' },
  })

  const payload = JSON.parse(text)
  const rows = pickList(payload, ['items'])

  const cards = rows
    .filter((row) => row !== null && typeof row === 'object')
    .map((row) => {
      const repository = row.repository ?? {}
      const owner = String(repository.owner?.login ?? '')
      const repo = String(repository.name ?? '')
      const filePath = String(row.path ?? 'SKILL.md')
      const branch = String(repository.default_branch ?? 'main')
      const name = filePath.toLowerCase() === 'skill.md' ? repo : (filePath.split('/').slice(-2)[0] ?? repo)
      return finalize(
        {
          id: `github:${owner}/${repo}/${filePath}`,
          name,
          title: name,
          description: clip(repository.description),
          tags: pickList(repository, ['topics']).map((tag) => String(tag).toLowerCase()),
          author: owner,
          stars: Number(repository.stargazers_count) || undefined,
          url: String(row.html_url ?? ''),
          githubUrl: `https://github.com/${owner}/${repo}`,
          raw: owner === '' || repo === '' ? undefined : `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`,
        },
        'github',
      )
    })

  return { cards, degraded: false, note: undefined }
}

/** The adapter table, keyed by source id. */
const ADAPTERS = {
  skillsmp: searchSkillsMp,
  skillssh: searchSkillsSh,
  github: searchGithub,
}

/**
 * Search one live source.
 *
 * @param sourceId - One of the live ids in `SOURCES`.
 * @param options - `{ query, limit, config, fetchImpl, timeoutMs }`.
 * @returns `{ source, cards, degraded, note, error }`. A failing adapter returns
 *   its error instead of throwing, so one dead source never blanks the shop.
 */
export async function searchSource(sourceId, options = {}) {
  const adapter = ADAPTERS[sourceId]
  if (adapter === undefined) return { source: sourceId, cards: [], degraded: true, note: `unknown source: ${sourceId}` }
  try {
    const result = await adapter(options)
    return { source: sourceId, ...result }
  } catch (error) {
    return {
      source: sourceId,
      cards: [],
      degraded: true,
      note: error instanceof Error ? error.message : String(error),
      error: true,
      // Carried separately from the prose so the page can run a countdown
      // rather than parse a sentence back into a number.
      status: error?.status,
      retryAfterSeconds: error?.retryAfterSeconds,
    }
  }
}

/**
 * Search several live sources at once.
 *
 * @param options - `{ sources, query, limit, config, fetchImpl, timeoutMs }`.
 * @returns `{ cards, results }` — merged cards plus the per-source report.
 */
export async function searchLive({ sources, query, limit, config, fetchImpl, timeoutMs } = {}) {
  const ids = (Array.isArray(sources) && sources.length > 0 ? sources : SOURCES.filter((entry) => entry.live).map((entry) => entry.id)).filter(
    (id) => ADAPTERS[id] !== undefined,
  )

  const results = await Promise.all(
    ids.map((id) => searchSource(id, { query: query ?? '', limit, config, fetchImpl, timeoutMs })),
  )

  const seen = new Set()
  const cards = []
  for (const result of results) {
    for (const card of result.cards) {
      const key = `${card.name}`.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      cards.push(card)
    }
  }

  return {
    cards,
    // Each row reports its own source's yield, not the merged total — a source
    // that returned nothing has to be distinguishable from one that returned
    // cards another source had already contributed.
    results: results.map((result) => ({
      source: result.source,
      count: result.cards.length,
      degraded: result.degraded,
      note: result.note,
      error: result.error,
      status: result.status,
      retryAfterSeconds: result.retryAfterSeconds,
    })),
  }
}

/**
 * Resolve a skills.sh skill into a full file list, for a bundle install.
 *
 * @param options - `{ source, skill, fetchImpl, timeoutMs }`.
 * @returns `{ files }` — `{ name, content }` entries including `SKILL.md`.
 * @throws When the API does not return a usable tree.
 */
export async function resolveSkillsShTree({ source, skill, fetchImpl, timeoutMs }) {
  const url = `https://skills.sh/api/v1/skills/${encodeURIComponent(source)}/${encodeURIComponent(skill)}`
  const { text } = await fetchText(url, { fetchImpl, timeoutMs, maxBytes: 8 * 1024 * 1024 })
  const payload = JSON.parse(text)
  const rows = pickList(payload?.data ?? payload, ['files', 'tree', 'contents'])

  const files = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const name = pick(row, ['path', 'name', 'file'])
    const content = pick(row, ['content', 'text', 'body'])
    if (typeof name !== 'string' || typeof content !== 'string') continue
    files.push({ name, content })
  }

  if (!files.some((file) => file.name.toLowerCase() === 'skill.md')) {
    const single = pick(payload?.data ?? payload, ['content', 'skillMd', 'markdown', 'readme'])
    if (typeof single === 'string') files.unshift({ name: 'SKILL.md', content: single })
  }

  if (files.length === 0) throw new Error('skills.sh returned no files for this skill')
  return { files }
}
