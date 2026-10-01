/**
 * A minimal reader for `SKILL.md` YAML frontmatter.
 *
 * Every `SKILL.md` opens with a frontmatter block:
 *
 *   ---
 *   name: react-component-patterns
 *   description: Composition rules for React function components.
 *   tags: [react, frontend, composition]
 *   ---
 *
 * The catalog needs four of those keys to draw a card, and a full YAML parser
 * would be a dependency this plugin cannot have. So this module implements the
 * subset that skill frontmatter actually uses — scalars, quoted scalars, inline
 * flow lists, block lists, and block scalars — and degrades to `null` rather
 * than throwing on anything it does not recognise. A skill whose frontmatter is
 * exotic still lists; it just lists with fewer facts on its card.
 *
 * @module skills-market/lib/frontmatter
 */

/** Match an opening `---` line and the matching closing `---` (or `...`). */
const BLOCK = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

/** A `key:` line; the value may be empty (a nested block follows) or inline. */
const KEY_LINE = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/

/** Strip one layer of matching quotes. */
function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1)
      return first === '"' ? inner.replace(/\\(["\\ntr])/g, (_, c) => ({ n: '\n', t: '\t', r: '\r' }[c] ?? c)) : inner.replace(/''/g, "'")
    }
  }
  return trimmed
}

/** Parse `[a, b, c]`, returning `undefined` when the value is not a flow list. */
function flowList(value) {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined
  const body = trimmed.slice(1, -1).trim()
  if (body === '') return []
  return body
    .split(',')
    .map((item) => unquote(item))
    .filter((item) => item !== '')
}

/** Coerce a scalar to the narrowest sensible type. */
function scalar(value) {
  const list = flowList(value)
  if (list !== undefined) return list
  const text = unquote(value)
  if (text === '') return ''
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+$/.test(text)) {
    const asNumber = Number(text)
    if (Number.isSafeInteger(asNumber)) return asNumber
  }
  return text
}

/**
 * Parse one frontmatter block into a plain object.
 *
 * Handles the four shapes that appear in real skill files: `key: value`,
 * `key: [a, b]`, a nested `- item` block list, and `key: |` / `key: >` block
 * scalars. Unknown or malformed lines are skipped rather than fatal.
 *
 * @param source - The text between the `---` fences.
 * @returns A plain object of parsed keys.
 */
export function parseFrontmatterBlock(source) {
  const result = {}
  const lines = source.split(/\r?\n/)
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    index += 1
    if (line.trim() === '' || /^\s*#/.test(line)) continue

    const match = KEY_LINE.exec(line)
    if (match === null) continue
    const key = match[1]
    const inline = match[2]

    // A block scalar: every following line that is blank or indented belongs to it.
    if (inline === '|' || inline === '>' || inline === '|-' || inline === '>-' || inline === '|+' || inline === '>+') {
      const folded = inline.startsWith('>')
      const body = []
      while (index < lines.length && (lines[index].trim() === '' || /^\s/.test(lines[index]))) {
        body.push(lines[index])
        index += 1
      }
      const dedented = body.map((entry) => entry.replace(/^ {1,8}/, ''))
      result[key] = folded
        ? dedented.join(' ').replace(/\s+/g, ' ').trim()
        : dedented.join('\n').replace(/\s+$/, '')
      continue
    }

    // An inline value: parse it on the spot.
    if (inline.trim() !== '') {
      result[key] = scalar(inline)
      continue
    }

    // An empty value: either a `- item` block list or a nested mapping.
    const items = []
    const nested = {}
    let sawItem = false
    let sawNested = false
    while (index < lines.length) {
      const next = lines[index]
      if (next.trim() === '') {
        index += 1
        continue
      }
      if (!/^\s/.test(next)) break
      const itemMatch = /^\s*-\s*(.*)$/.exec(next)
      if (itemMatch !== null) {
        sawItem = true
        index += 1
        items.push(unquote(itemMatch[1]))
        continue
      }
      const nestedMatch = KEY_LINE.exec(next.trim())
      if (nestedMatch !== null) {
        sawNested = true
        index += 1
        nested[nestedMatch[1]] = scalar(nestedMatch[2])
        continue
      }
      index += 1
    }

    if (sawItem && !sawNested) result[key] = items.filter((item) => item !== '')
    else if (sawNested) result[key] = nested
    else result[key] = ''
  }

  return result
}

/**
 * Read the frontmatter out of a `SKILL.md`.
 *
 * @param markdown - Full file text.
 * @returns `{ data, body }` — parsed keys and the markdown after the fence.
 *   `data` is `{}` when the file has no frontmatter, which is legal: the skill
 *   still lists, and its title falls back to the first `#` heading.
 */
export function parseSkillMarkdown(markdown) {
  const text = typeof markdown === 'string' ? markdown : ''
  const match = BLOCK.exec(text)
  if (match === null) return { data: {}, body: text }
  return { data: parseFrontmatterBlock(match[1]), body: text.slice(match[0].length) }
}

/**
 * The first `#` heading of a markdown body, used as a title fallback.
 * @param body - Markdown after the frontmatter fence.
 * @returns The heading text, or `undefined`.
 */
export function firstHeading(body) {
  const match = /^[ \t]*#[ \t]+(.+?)[ \t]*$/m.exec(typeof body === 'string' ? body : '')
  return match === null ? undefined : match[1].trim()
}

/**
 * Normalize whatever a frontmatter block said about tags into a clean list.
 *
 * Real skills write tags as `tags`, `keywords`, or a comma-separated string, and
 * a market that only understood one spelling would show empty tag rows.
 *
 * @param data - Parsed frontmatter.
 * @returns A de-duplicated, lowercased list of tags.
 */
export function readTags(data) {
  const raw = data?.tags ?? data?.keywords ?? data?.topics ?? data?.category
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : []
  const seen = new Set()
  const tags = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const tag = entry.trim().toLowerCase()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
    if (tags.length >= 12) break
  }
  return tags
}

/**
 * Read the author out of frontmatter, accepting the spellings skills use.
 * @param data - Parsed frontmatter.
 * @returns An author string, or `undefined`.
 */
export function readAuthor(data) {
  const raw = data?.author ?? data?.authors ?? data?.maintainer ?? data?.owner
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  if (Array.isArray(raw)) {
    const names = raw.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    if (names.length > 0) return names.join(', ')
  }
  if (raw !== null && typeof raw === 'object') {
    const name = raw.name ?? raw.handle
    if (typeof name === 'string' && name.trim() !== '') return name.trim()
  }
  return undefined
}
