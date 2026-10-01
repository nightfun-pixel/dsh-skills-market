/**
 * Skills Market — a shop for `SKILL.md`, inside the harness.
 *
 * `SKILL.md` is a cross-platform standard: DSH, Claude Code, Cursor and Codex all
 * read the same file, and the public catalogs that index it are large. What none
 * of them give you is a place to *browse and install* one without leaving the
 * editor. That is the whole of this plugin:
 *
 *   1. **Installed.** Scan `DSH_HOME/skills` and `DSH_AGENTS_HOME/skills`, show
 *      what is already there, let it be read and removed.
 *   2. **Catalog.** A bundled curated registry plus four live sources — SkillsMP,
 *      skills.sh, AgenticSkills and GitHub code search — behind one card shape.
 *   3. **Install.** Fetch a `SKILL.md` (and, when the source is a GitHub
 *      directory, its sibling files), write it into the chosen root, and say so.
 *
 * The host half owns the filesystem and the network; the client half owns the
 * page. They meet at a small JSON API under `/dsh-skills-market`, registered on
 * the harness web server exactly the way the shipped plugins do it.
 *
 * The plugin is dependency-free by construction: a profile-installed bundle
 * resolves bare specifiers from its own directory, which cannot see the
 * installation's `node_modules`. Only `node:*` builtins are imported.
 *
 * @module @local/dsh-skills-market
 */

import { CURATED, curatedCard, mergeCurated } from './lib/curated.js'
import { indexByName, readSkill, removeSkill, scanAll } from './lib/installed.js'
import { installSkill, resolveSource, writeSkill } from './lib/install.js'
import { findRoot, resolveHomes, resolveRoots } from './lib/roots.js'
import { SOURCES, resolveSkillsShTree, searchLive, searchSource } from './lib/sources.js'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'skills-market'

/**
 * No required service: the plugin is a filesystem reader and a web surface, and
 * a headless composition should still load it rather than fail on a missing
 * dependency. The web server is reached through `ctx.inject` below, which is
 * also what keeps a profile without one loading cleanly — it simply has no page.
 */
export const inject = []

/** Largest JSON request body the HTTP API accepts. */
const MAX_BODY_BYTES = 1_000_000

/** Default bound on sibling files fetched with one bundle. */
const DEFAULT_MAX_SIBLING_FILES = 40

/** Upper bound accepted for `maxSiblingFiles`. */
const MAX_SIBLING_FILES_CAP = 200

/** Default target root for a new install. */
const DEFAULT_TARGET = 'user-dsh'

/**
 * The live sources searched when the config does not name any.
 *
 * Only SkillsMP is on by default: it is the one adapter that works with no
 * credentials at all. skills.sh stays dark until a Vercel OIDC token is set, and
 * a default that always renders an authentication error would read as a bug
 * rather than a missing key.
 */
const DEFAULT_LIVE_SOURCES = ['skillsmp']

/**
 * Normalize the plugin's configuration.
 *
 * Values arrive from a loader row a human may have edited, so every field is
 * validated here and a bad field falls back to its default rather than
 * propagating a value that would fail later.
 *
 * @param raw - The row's `config` block, of unknown shape.
 * @returns A complete configuration object.
 */
function normalizeConfig(raw) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const text = (key) => (typeof value[key] === 'string' && value[key].trim() !== '' ? value[key].trim() : undefined)
  const siblings = Number(value.maxSiblingFiles)

  const listed = typeof value.liveSources === 'string'
    ? value.liveSources.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
    : Array.isArray(value.liveSources)
      ? value.liveSources.filter((entry) => typeof entry === 'string')
      : DEFAULT_LIVE_SOURCES
  const known = new Set(SOURCES.map((entry) => entry.id))
  const liveSources = listed.filter((entry) => known.has(entry) && entry !== 'curated')

  return {
    enabled: value.enabled !== false,
    dshHome: text('dshHome'),
    agentsHome: text('agentsHome'),
    projectRoot: text('projectRoot'),
    defaultTarget: known.has(value.defaultTarget) ? value.defaultTarget : DEFAULT_TARGET,
    curatedUrl: text('curatedUrl'),
    liveSources: liveSources.length > 0 ? liveSources : DEFAULT_LIVE_SOURCES,
    githubToken: text('githubToken'),
    skillsmpKey: text('skillsmpKey'),
    skillsshToken: text('skillsshToken'),
    allowRemote: value.allowRemote === true,
    allowInsecure: value.allowInsecure === true,
    maxSiblingFiles: Number.isFinite(siblings) && siblings >= 0 ? Math.min(Math.floor(siblings), MAX_SIBLING_FILES_CAP) : DEFAULT_MAX_SIBLING_FILES,
  }
}

// ---------------------------------------------------------------------------
// Config: a hand-written native Schemastery graph. No schema library is imported.
//
// The host reads exactly three things off a plugin's Config export:
//   * Cordis mounts the row through the Standard Schema face, `Config['~standard'].validate`.
//   * `dsh-app-boot` recognises the graph by `Symbol.for('schemastery') === true`, a string
//     `type`, and an object `meta`, then walks `dict` to project a JSON Schema.
//   * `dsh-settings` rebuilds a real Schemastery schema from `Config.toJSON()` and keeps
//     the fields whose nearest volatile ancestor makes them live-editable.
// ---------------------------------------------------------------------------

/** The key Schemastery brands its schema nodes with; a global symbol, reachable without importing it. */
const SCHEMA_SYMBOL = Symbol.for('schemastery')

/**
 * Build one node of the native schema graph.
 * @param type - Schemastery type name.
 * @param meta - Node metadata; `volatile` is what makes a field live-editable.
 * @param extra - `dict` for objects, `inner` for arrays.
 * @returns The node.
 */
function schemaNode(type, meta, extra = {}) {
  return {
    [SCHEMA_SYMBOL]: true,
    type,
    meta,
    toJSON() {
      return toSchemaJson(this)
    },
    ...extra,
  }
}

/** One volatile field node with its default and its description. */
function field(type, meta) {
  return schemaNode(type, { volatile: true, ...meta })
}

/** The live-editable controls, in the order the stock settings card lists them. */
const FIELD_NODES = {
  enabled: field('boolean', { default: true, description: 'Load the market at all.' }),
  defaultTarget: field('string', {
    default: DEFAULT_TARGET,
    description: 'Root a new install lands in: user-dsh (DSH_HOME/skills) or user-agents (DSH_AGENTS_HOME/skills).',
  }),
  dshHome: field('string', { default: '', description: 'Override DSH_HOME. Empty uses the environment, then ~/.dsh.' }),
  agentsHome: field('string', { default: '', description: 'Override the agents home. Empty uses DSH_AGENTS_HOME, then ~/.agents.' }),
  projectRoot: field('string', { default: '', description: 'Also scan this project\u2019s .dsh/skills and .agents/skills. Empty scans user roots only.' }),
  curatedUrl: field('string', {
    default: '',
    description: 'Remote curated registry: a JSON array of cards on GitHub or any HTTPS host. Empty uses the bundled registry.',
  }),
  liveSources: field('string', {
    default: DEFAULT_LIVE_SOURCES.join(','),
    description: 'Comma-separated live sources to search: skillsmp, skillssh, github.',
  }),
  githubToken: field('string', { default: '', description: 'Personal access token for GitHub code search and a larger API rate limit.' }),
  skillsmpKey: field('string', { default: '', description: 'SkillsMP API key. Anonymous access is limited to 50 requests a day.' }),
  skillsshToken: field('string', {
    default: '',
    description: 'Vercel OIDC token. Every skills.sh endpoint requires one; without it that source stays dark.',
  }),
  allowRemote: field('boolean', {
    default: false,
    description: 'Permit install and delete from a non-loopback address. Off by default: these routes write files.',
  }),
  allowInsecure: field('boolean', {
    default: false,
    description: 'Permit plain http and private addresses when fetching a skill. Off by default.',
  }),
  maxSiblingFiles: field('number', {
    step: 1,
    min: 0,
    max: MAX_SIBLING_FILES_CAP,
    default: DEFAULT_MAX_SIBLING_FILES,
    description: 'How many sibling files a bundle install may fetch alongside SKILL.md. 0 installs the entry point alone.',
  }),
}

/** The root graph: a plain object over those fields. */
const CONFIG_SCHEMA = schemaNode('object', { default: {} }, { dict: FIELD_NODES })

/**
 * Serialize a schema graph the way Schemastery does: a root uid plus a refs table
 * in which every nested node appears as the uid number pointing back into it.
 * @param root - The graph node to serialize.
 * @returns `{ uid, refs }`, the serialized form.
 */
function toSchemaJson(root) {
  const refs = {}
  const uids = new Map()
  let next = 9400
  const encode = (node) => {
    const known = uids.get(node)
    if (known !== undefined) return known
    const uid = next++
    uids.set(node, uid)
    const plain = { type: node.type, meta: node.meta }
    if (node.dict !== undefined) {
      plain.dict = Object.fromEntries(Object.entries(node.dict).map(([key, child]) => [key, encode(child)]))
    }
    if (node.inner !== undefined) plain.inner = encode(node.inner)
    refs[uid] = plain
    return uid
  }
  return { uid: encode(root), refs }
}

/**
 * The plugin's config schema.
 *
 * `~standard` is the Standard Schema v1 contract Cordis validates through;
 * `meta.volatile` and `toJSON()` are the two things `dsh-settings` reads to list
 * this entry as a live, editable settings section.
 */
export const Config = {
  ...CONFIG_SCHEMA,
  '~standard': {
    version: 1,
    vendor: 'schemastery',
    validate(value) {
      return { value: normalizeConfig(value) }
    },
  },
  toJSON() {
    return toSchemaJson(CONFIG_SCHEMA)
  },
}

/** Render a thrown value for a diagnostic line. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read a JSON request body, bounded.
 * @param req - The Node request.
 * @returns The parsed body, or `{}` when empty.
 * @throws When the body exceeds `MAX_BODY_BYTES` or is not valid JSON.
 */
async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/**
 * How many times this plugin has been activated in the current host process.
 *
 * Cordis re-runs `apply` when a loader row's config changes, and it re-imports
 * this module to do it — so a module-level counter would reset to 1 every time
 * and prove nothing. `globalThis` outlives the re-import, which makes this the
 * one honest signal that a hot reload actually reached this plugin. That
 * question is otherwise invisible, and it decides whether a client-bundle edit
 * is being served yet: a re-activation re-reads the bundle's filesystem
 * baseline, and the served revision is derived from that baseline alone.
 */
const ACTIVATION_KEY = '__dshSkillsMarketActivations'

/**
 * Mount the plugin.
 *
 * @param ctx - The Cordis context.
 * @param rawConfig - The loader row's `config` block.
 */
export function apply(ctx, rawConfig) {
  globalThis[ACTIVATION_KEY] = (globalThis[ACTIVATION_KEY] ?? 0) + 1
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return

  /** Resolve the root list for this request; re-read so an external edit is visible. */
  const rootsNow = () => resolveRoots(config)

  /**
   * Load the curated registry: the bundled array, optionally extended by a
   * remote JSON registry.
   *
   * A remote registry that fails to load is reported and the bundled cards are
   * still served — a broken URL should cost the extra cards, not the shop.
   *
   * @returns `{ cards, remote, note }`.
   */
  async function loadCurated() {
    const bundled = CURATED.map(curatedCard)
    if (config.curatedUrl === undefined) return { cards: bundled, remote: false, note: undefined }
    try {
      const response = await fetch(config.curatedUrl, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const payload = await response.json()
      const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.skills) ? payload.skills : []
      return { cards: mergeCurated(bundled, rows), remote: true, note: `${rows.length} remote cards from ${config.curatedUrl}` }
    } catch (error) {
      return { cards: bundled, remote: false, note: `remote registry failed: ${describe(error)}` }
    }
  }

  ctx.inject(['webServer'], (http) => {
    /**
     * Whether this request may write files.
     *
     * Install and delete mutate the disk, so they are loopback-only unless the
     * operator opted in. A market reachable from the LAN would otherwise be a
     * remote file-write primitive.
     * @param req - The Node request.
     * @returns `true` when the caller may mutate.
     */
    const mayControl = (req) => {
      if (config.allowRemote) return true
      const address = req.socket?.remoteAddress ?? ''
      return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
    }

    /**
     * Handle one request under `/dsh-skills-market`.
     * @param req - The Node request.
     * @param res - The Node response.
     */
    async function handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.replace(/^\/dsh-skills-market/, '').replace(/\/+$/, '') || '/'
      const query = url.searchParams

      const send = (status, payload) => {
        const text = JSON.stringify(payload)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(text),
        })
        res.end(text)
      }

      try {
        // -- Read-only routes -------------------------------------------------

        if (route === '/' || route === '/state') {
          const roots = rootsNow()
          const scan = scanAll(roots)
          const { dshHome, agentsHome } = resolveHomes(config)
          return send(200, {
            ok: true,
            activations: globalThis[ACTIVATION_KEY] ?? 1,
            homes: { dshHome, agentsHome },
            roots: roots.map((root) => ({ ...root, count: scan.skills.filter((skill) => skill.rootId === root.id).length })),
            skills: scan.skills,
            total: scan.total,
            sources: SOURCES,
            liveSources: config.liveSources,
            defaultTarget: config.defaultTarget,
            allowInsecure: config.allowInsecure,
            hasGithubToken: config.githubToken !== undefined,
            hasSkillsmpKey: config.skillsmpKey !== undefined,
            hasSkillsshToken: config.skillsshToken !== undefined,
            curatedUrl: config.curatedUrl,
          })
        }

        if (route === '/catalog') {
          const q = (query.get('q') ?? '').trim()
          const limit = Number(query.get('limit') ?? 24)
          const requested = (query.get('source') ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
          const wantLive = requested.length > 0 ? requested : config.liveSources

          const curated = await loadCurated()
          const installedIndex = indexByName(scanAll(rootsNow()).skills)

          const curatedMatches = q === ''
            ? curated.cards
            : curated.cards.filter((card) =>
                `${card.title} ${card.name} ${card.description ?? ''} ${card.tags.join(' ')} ${card.category ?? ''}`
                  .toLowerCase()
                  .includes(q.toLowerCase()),
              )

          let live = { cards: [], results: [] }
          if (wantLive.length > 0) {
            live = await searchLive({ sources: wantLive, query: q, limit, config })
          }

          const decorate = (card) => {
            const already = installedIndex.get(String(card.name).toLowerCase())
            return { ...card, installed: already === undefined ? undefined : { id: already.id, rootId: already.rootId, title: already.title } }
          }

          return send(200, {
            ok: true,
            query: q,
            curated: curatedMatches.map(decorate),
            live: live.cards.map(decorate),
            sources: live.results,
            curatedNote: curated.note,
            curatedRemote: curated.remote,
          })
        }

        if (route === '/skill') {
          const rootId = query.get('root') ?? ''
          const skillName = query.get('name') ?? ''
          const flat = query.get('flat') === 'true'
          const root = findRoot(rootsNow(), rootId)
          if (root === undefined) return send(404, { ok: false, error: `unknown root: ${rootId}` })
          const skill = readSkill(root, skillName, flat)
          return send(200, { ok: true, root: root.id, name: skillName, ...skill })
        }

        if (route === '/search') {
          const q = (query.get('q') ?? '').trim()
          const source = query.get('source') ?? ''
          if (source === '' || source === 'curated') {
            const curated = await loadCurated()
            return send(200, { ok: true, source: 'curated', cards: curated.cards, note: curated.note })
          }
          const result = await searchSource(source, { query: q, limit: Number(query.get('limit') ?? 24), config })
          return send(200, { ok: true, ...result })
        }

        // -- Mutating routes --------------------------------------------------

        if (route === '/install') {
          if (req.method !== 'POST') return send(405, { ok: false, error: 'POST required' })
          if (!mayControl(req)) return send(403, { ok: false, error: 'install is loopback-only unless allowRemote is on' })

          const body = await readJsonBody(req)
          const roots = rootsNow()
          const targetId = typeof body.targetRootId === 'string' && body.targetRootId !== '' ? body.targetRootId : config.defaultTarget
          const root = findRoot(roots, targetId)
          if (root === undefined) return send(404, { ok: false, error: `unknown root: ${targetId}` })
          if (root.installable !== true) return send(400, { ok: false, error: `root is not an install target: ${targetId}` })

          const source = body.source
          if (source === null || typeof source !== 'object') return send(400, { ok: false, error: 'source descriptor required' })

          // A skills.sh card installs through its tree API, which is the only
          // live source that knows a bundle's sibling files.
          if (source.kind === 'skillssh') {
            const tree = await resolveSkillsShTree({ source: source.source, skill: source.skill })
            const resolved = await resolveSource({ source: { kind: 'files', ...tree, name: source.name }, config })
            const result = writeSkill({ root, name: resolved.name, files: resolved.files })
            ctx.logger?.info?.(`skills-market: installed ${result.name} into ${result.dir}`)
            return send(200, { ok: true, ...result, rootId: root.id, origin: `skills.sh/${source.source}/${source.skill}` })
          }

          const result = await installSkill({ source, root, config })
          ctx.logger?.info?.(`skills-market: installed ${result.name} into ${result.dir}`)
          return send(200, { ok: true, ...result, rootId: root.id })
        }

        if (route === '/remove') {
          if (req.method !== 'POST') return send(405, { ok: false, error: 'POST required' })
          if (!mayControl(req)) return send(403, { ok: false, error: 'remove is loopback-only unless allowRemote is on' })

          const body = await readJsonBody(req)
          const root = findRoot(rootsNow(), body.rootId ?? '')
          if (root === undefined) return send(404, { ok: false, error: `unknown root: ${body.rootId}` })
          const result = removeSkill(root, body.name, body.flat === true)
          ctx.logger?.info?.(`skills-market: removed ${body.name} from ${root.dir}`)
          return send(200, { ok: true, ...result, rootId: root.id })
        }

        return send(404, { ok: false, error: `no route: ${route}` })
      } catch (error) {
        return send(400, { ok: false, error: describe(error) })
      }
    }

    http.effect(
      () => http.webServer.register({ kind: 'prefix', path: '/dsh-skills-market', handler: handle }),
      'skills-market http',
    )
  })
}
