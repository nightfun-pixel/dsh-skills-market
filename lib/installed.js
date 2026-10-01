/**
 * Installed skills — scanning, reading, and removing what is already on disk.
 *
 * This is the read side of the market: it answers "what does this machine
 * already have?" by walking the roots `lib/roots.js` resolved. Every entry it
 * returns is a real file the agent will load, so the list is deliberately built
 * from the filesystem and never from a cache — a skill deleted in a file manager
 * disappears from the market on the next request.
 *
 * Both legal shapes are recognised:
 *
 *   <root>/<name>/SKILL.md     bundle — may carry references, scripts, assets
 *   <root>/<name>.md           flat   — one file, no siblings
 *
 * @module skills-market/lib/installed
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { firstHeading, parseSkillMarkdown, readAuthor, readTags } from './frontmatter.js'
import { fileSize, resolveSkillPath } from './roots.js'

/** Directory names never worth descending into when listing a skill's files. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.venv', 'venv', 'dist', 'build'])

/** Longest file listing reported for one bundle skill. */
const MAX_LISTED_FILES = 200

/** How deep a bundle's sibling files are listed. */
const MAX_FILE_DEPTH = 4

/** Truncate a description to something a card can render. */
function clip(text, limit = 320) {
  if (typeof text !== 'string') return undefined
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return undefined
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat
}

/**
 * Walk a bundle directory and describe its files, bounded in both depth and count.
 * @param base - The bundle directory.
 * @param root - The bundle directory itself, for computing relative names.
 * @returns An array of `{ name, size }`, sorted by name.
 */
function listFiles(base, root = base, depth = 0) {
  const found = []
  if (depth > MAX_FILE_DEPTH || found.length >= MAX_LISTED_FILES) return found

  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return found
  }

  for (const entry of entries) {
    if (found.length >= MAX_LISTED_FILES) break
    if (entry.name.startsWith('.')) continue
    const absolute = path.join(base, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      found.push(...listFiles(absolute, root, depth + 1))
      continue
    }
    if (!entry.isFile()) continue
    found.push({ name: path.relative(root, absolute).split(path.sep).join('/'), size: fileSize(absolute) })
  }

  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Build one market entry from a `SKILL.md` and where it lives.
 *
 * @param options - `{ root, dirName, flat, skillFile, files }`.
 * @returns A skill entry, or `undefined` when the file cannot be read.
 */
function buildEntry({ root, dirName, flat, skillFile, files }) {
  let markdown
  try {
    markdown = readFileSync(skillFile, 'utf8')
  } catch {
    return undefined
  }

  const { data, body } = parseSkillMarkdown(markdown)
  const declared = typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : undefined
  const title = declared ?? firstHeading(body) ?? dirName
  let mtime = 0
  try {
    mtime = statSync(skillFile).mtimeMs
  } catch {
    mtime = 0
  }

  const size = files.reduce((total, file) => total + file.size, 0)

  return {
    // The id is stable across requests and safe in a URL: root plus the on-disk name.
    id: `${root.id}:${dirName}`,
    name: dirName,
    declaredName: declared,
    title,
    description: clip(data.description),
    tags: readTags(data),
    author: readAuthor(data),
    version: typeof data.version === 'string' ? data.version : undefined,
    license: typeof data.license === 'string' ? data.license : undefined,
    flat,
    rootId: root.id,
    rootLabel: root.label,
    rootDir: root.dir,
    scope: root.scope,
    path: skillFile,
    relative: path.relative(root.dir, skillFile).split(path.sep).join('/'),
    fileCount: files.length,
    files: files.map((file) => file.name),
    size,
    mtime,
  }
}

/**
 * Scan one root for skills.
 *
 * A directory counts only when it directly contains `SKILL.md`; a deeper
 * `SKILL.md` is not a skill of this root, it is a file inside one. That matches
 * how `@deepseek-ai/dsh-skill-filesystem` identifies bundles.
 *
 * @param root - A resolved root descriptor.
 * @returns An array of skill entries, sorted by title.
 */
export function scanRoot(root) {
  if (!existsSync(root.dir)) return []

  let entries
  try {
    entries = readdirSync(root.dir, { withFileTypes: true })
  } catch {
    return []
  }

  const skills = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue

    if (entry.isDirectory()) {
      const skillFile = path.join(root.dir, entry.name, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      const entryBuilt = buildEntry({
        root,
        dirName: entry.name,
        flat: false,
        skillFile,
        files: listFiles(path.join(root.dir, entry.name)),
      })
      if (entryBuilt !== undefined) skills.push(entryBuilt)
      continue
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const dirName = entry.name.slice(0, -3)
      const skillFile = path.join(root.dir, entry.name)
      const entryBuilt = buildEntry({
        root,
        dirName,
        flat: true,
        skillFile,
        files: [{ name: entry.name, size: fileSize(skillFile) }],
      })
      if (entryBuilt !== undefined) skills.push(entryBuilt)
    }
  }

  return skills.sort((left, right) => left.title.localeCompare(right.title))
}

/**
 * Scan every root.
 *
 * Roots are reported even when they do not exist yet, because "this directory
 * does not exist" is the fact that explains an empty list, and the install
 * button is what creates it.
 *
 * @param roots - The resolved root list.
 * @returns `{ roots, skills, total }`.
 */
export function scanAll(roots) {
  const skills = []
  for (const root of roots) skills.push(...scanRoot(root))
  return { roots, skills, total: skills.length }
}

/**
 * Read one installed skill in full, for the viewer.
 *
 * @param root - A resolved root descriptor.
 * @param name - The on-disk skill name.
 * @param flat - `true` for `<name>.md`, `false` for the `<name>/` bundle.
 * @returns `{ markdown, files, path }`.
 * @throws When the name is unsafe or the skill does not exist.
 */
export function readSkill(root, name, flat = false) {
  const target = resolveSkillPath(root, name, flat)
  const skillFile = flat ? target : path.join(target, 'SKILL.md')
  if (!existsSync(skillFile)) throw new Error(`skill not found: ${name}`)
  const markdown = readFileSync(skillFile, 'utf8')
  return {
    markdown,
    path: skillFile,
    files: flat ? [{ name: `${name}.md`, size: fileSize(skillFile) }] : listFiles(target),
  }
}

/**
 * Delete one installed skill.
 *
 * The whole bundle goes, not just `SKILL.md`: a bundle whose references survived
 * its entry point would be a half-deleted skill the agent could still partially
 * read.
 *
 * @param root - A resolved root descriptor.
 * @param name - The on-disk skill name.
 * @param flat - `true` for `<name>.md`, `false` for the `<name>/` bundle.
 * @returns `{ removed, path }`.
 * @throws When the name is unsafe or the skill does not exist.
 */
export function removeSkill(root, name, flat = false) {
  const target = resolveSkillPath(root, name, flat)
  if (!existsSync(target)) throw new Error(`skill not found: ${name}`)
  rmSync(target, { recursive: true, force: true })
  return { removed: true, path: target }
}

/**
 * Index installed skills by lowercase on-disk name, for "already installed" badges.
 * @param skills - Entries from `scanAll`.
 * @returns A `Map` from lowercase name to entry.
 */
export function indexByName(skills) {
  const index = new Map()
  for (const skill of skills) {
    const key = skill.name.toLowerCase()
    if (!index.has(key)) index.set(key, skill)
  }
  return index
}
