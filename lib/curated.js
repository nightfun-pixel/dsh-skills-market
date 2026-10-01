/**
 * Curated cards — the shop's own shelves.
 *
 * The data lives in `lib/curated-data.js`, generated from `data/catalog.json`
 * and validated at generation time. This module owns everything about those
 * entries that is logic rather than data: turning a registry row into the one
 * card shape the UI and the installer both speak, and folding a remote registry
 * into the same shape.
 *
 * The curated shelf is the reason the Install button is reliable on a fresh
 * machine: no API key, no rate limit, no third-party availability. Every entry
 * points at a public `SKILL.md` whose raw URL was fetched and confirmed.
 *
 * @module skills-market/lib/curated
 */

import { CATEGORIES, CURATED } from './curated-data.js'

export { CATEGORIES, CURATED }

/** Split `owner/repo`, or `undefined` when the shape is wrong. */
function splitRepo(repo) {
  if (typeof repo !== 'string') return undefined
  const parts = repo.trim().split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return undefined
  return { owner: parts[0], repo: parts[1] }
}

/** Read the first present, non-empty string among several candidate keys. */
function pick(object, keys) {
  if (object === null || typeof object !== 'object') return undefined
  for (const key of keys) {
    const value = object[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Normalize a tags field into a clean lowercase list. */
function normalizeTags(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  const seen = new Set()
  const tags = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const tag = entry.trim().toLowerCase()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

/**
 * Turn a registry row into the card shape the API serves.
 *
 * The install descriptor is a `github` source rather than a raw URL: a GitHub
 * source is the only one that lets the installer ask for the bundle's sibling
 * files, and a skill whose `SKILL.md` references `rules/` or `references/` is
 * broken without them.
 *
 * @param entry - One row from `CURATED` or from a remote registry.
 * @param index - Position, used to keep ids unique when a row has no id.
 * @returns A card, or `undefined` when the row is not installable.
 */
export function curatedCard(entry, index = 0) {
  const parts = splitRepo(entry?.repo)
  if (parts === undefined) return undefined

  const branch = pick(entry, ['branch']) ?? 'main'
  const filePath = pick(entry, ['path'])
  if (filePath === undefined) return undefined

  const name = pick(entry, ['name', 'id']) ?? `${parts.repo}-${index}`
  const raw = pick(entry, ['raw']) ?? `https://raw.githubusercontent.com/${parts.owner}/${parts.repo}/${branch}/${filePath}`

  return {
    id: `curated:${pick(entry, ['id']) ?? name}`,
    name,
    title: pick(entry, ['title']) ?? name,
    description: pick(entry, ['description']),
    tags: normalizeTags(entry?.tags),
    author: pick(entry, ['author']) ?? parts.owner,
    category: pick(entry, ['category']),
    license: pick(entry, ['license']) ?? null,
    source: 'curated',
    sourceLabel: 'Curated',
    url: `https://github.com/${parts.owner}/${parts.repo}/blob/${branch}/${filePath}`,
    githubUrl: `https://github.com/${parts.owner}/${parts.repo}`,
    raw,
    install: { kind: 'github', ...parts, branch, path: filePath, name, withSiblings: true },
    installable: true,
  }
}

/**
 * Fold a remote registry into the bundled cards.
 *
 * Rows that are not installable are dropped rather than shown as a card whose
 * Install button does nothing, and a remote row whose id collides with a bundled
 * one is skipped so the verified entry always wins.
 *
 * @param bundled - Cards built from `CURATED`.
 * @param rows - Rows parsed out of the remote registry JSON.
 * @returns The merged card list, bundled first.
 */
export function mergeCurated(bundled, rows) {
  const merged = [...bundled]
  const seen = new Set(bundled.map((card) => card.id))
  const seenNames = new Set(bundled.map((card) => card.name.toLowerCase()))

  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const card = curatedCard(row, index)
    if (card === undefined) continue
    if (seen.has(card.id)) continue
    const nameKey = card.name.toLowerCase()
    if (seenNames.has(nameKey)) continue
    seen.add(card.id)
    seenNames.add(nameKey)
    merged.push({ ...card, sourceLabel: 'Curated (remote)' })
  }

  return merged
}
