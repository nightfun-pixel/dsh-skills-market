/**
 * Skills Market tests.
 *
 * The suite is organized around the four things that can actually go wrong:
 * resolving the wrong root (so a skill installs where the agent never looks),
 * letting a hostile name escape the skills directory, mis-reading a
 * `SKILL.md`'s frontmatter (so a card is blank), and shipping a curated card
 * whose URL does not match its repository.
 *
 * The HTTP tests drive the real handler through a fake request/response pair,
 * because the route prefix, the loopback gate and the JSON envelope are the
 * contract the client half is written against.
 *
 * @module skills-market/test
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, afterEach, before, describe, it } from 'node:test'

import { CURATED, CATEGORIES, curatedCard, mergeCurated } from '../lib/curated.js'
import { firstHeading, parseSkillMarkdown, readAuthor, readTags } from '../lib/frontmatter.js'
import { indexByName, readSkill, removeSkill, scanAll, scanRoot } from '../lib/installed.js'
import {
  assertFetchableUrl,
  deriveSkillName,
  fetchText,
  githubRawUrl,
  readRetryAfter,
  resolveSource,
  safeRelativeFile,
  slugifySkillName,
  writeSkill,
} from '../lib/install.js'
import { ROOT, findRoot, isSafeSkillName, resolveHomes, resolveRoots, resolveSkillPath } from '../lib/roots.js'
import { searchLive, searchSource } from '../lib/sources.js'

/** A scratch directory tree, removed when the test ends. */
function scratch() {
  const base = mkdtempSync(path.join(tmpdir(), 'skills-market-'))
  return {
    base,
    dshHome: path.join(base, 'dsh-home'),
    agentsHome: path.join(base, 'agents-home'),
    dispose: () => rmSync(base, { recursive: true, force: true }),
  }
}

/** Write a `SKILL.md` at `<root>/<name>/SKILL.md`, plus any siblings. */
function writeBundle(rootDir, name, markdown, siblings = {}) {
  const dir = path.join(rootDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'SKILL.md'), markdown, 'utf8')
  for (const [relative, content] of Object.entries(siblings)) {
    const target = path.join(dir, ...relative.split('/'))
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return dir
}

/** A minimal valid `SKILL.md`. */
function skillMd(name, extra = '') {
  return `---\nname: ${name}\ndescription: A test skill called ${name}.\ntags: [alpha, beta]\nauthor: tester\n${extra}---\n\n# ${name}\n\nBody text.\n`
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

describe('roots', () => {
  let sandbox

  before(() => {
    sandbox = scratch()
  })
  after(() => {
    sandbox.dispose()
  })

  it('reads DSH_HOME and DSH_AGENTS_HOME rather than assuming ~/.dsh', () => {
    const homes = resolveHomes({}, { DSH_HOME: sandbox.dshHome, DSH_AGENTS_HOME: sandbox.agentsHome })
    assert.equal(homes.dshHome, path.resolve(sandbox.dshHome))
    assert.equal(homes.agentsHome, path.resolve(sandbox.agentsHome))
  })

  it('lets an explicit config value win over the environment', () => {
    const homes = resolveHomes({ dshHome: path.join(sandbox.base, 'explicit') }, { DSH_HOME: sandbox.dshHome })
    assert.equal(homes.dshHome, path.resolve(sandbox.base, 'explicit'))
  })

  it('hangs both user roots off their home, and adds project roots only when asked', () => {
    const userOnly = resolveRoots({}, { DSH_HOME: sandbox.dshHome, DSH_AGENTS_HOME: sandbox.agentsHome })
    assert.deepEqual(userOnly.map((root) => root.id), [ROOT.DSH, ROOT.AGENTS])
    assert.equal(userOnly[0].dir, path.join(path.resolve(sandbox.dshHome), 'skills'))
    assert.equal(userOnly[0].installable, true)

    const withProject = resolveRoots({ projectRoot: sandbox.base }, { DSH_HOME: sandbox.dshHome, DSH_AGENTS_HOME: sandbox.agentsHome })
    assert.deepEqual(withProject.map((root) => root.id), [ROOT.DSH, ROOT.AGENTS, ROOT.PROJECT_DSH, ROOT.PROJECT_AGENTS])
    assert.equal(withProject[2].installable, false)
    assert.equal(withProject[2].dir, path.join(path.resolve(sandbox.base), '.dsh', 'skills'))
  })

  it('refuses names that could escape a root', () => {
    for (const bad of ['../evil', '..', 'a/b', 'a\\b', '.hidden', '', '  ', 'x'.repeat(200), 'a\0b']) {
      assert.equal(isSafeSkillName(bad), false, `expected ${JSON.stringify(bad)} to be rejected`)
    }
    for (const good of ['react-patterns', 'foo.bar', 'a_b-c', 'Skill1']) {
      assert.equal(isSafeSkillName(good), true, `expected ${good} to be accepted`)
    }
  })

  it('proves a resolved skill path stays inside its root', () => {
    const root = { id: ROOT.DSH, dir: path.join(sandbox.base, 'skills') }
    assert.equal(resolveSkillPath(root, 'ok', false), path.join(root.dir, 'ok'))
    assert.equal(resolveSkillPath(root, 'ok', true), path.join(root.dir, 'ok.md'))
    assert.throws(() => resolveSkillPath(root, '../escape', false), /unsafe skill name/)
  })
})

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

describe('frontmatter', () => {
  it('parses scalars, inline lists and quoted values', () => {
    const { data, body } = parseSkillMarkdown('---\nname: demo\ndescription: "A: quoted value"\ntags: [one, two]\nversion: 2\n---\n\n# Heading\n')
    assert.equal(data.name, 'demo')
    assert.equal(data.description, 'A: quoted value')
    assert.deepEqual(data.tags, ['one', 'two'])
    assert.equal(data.version, 2)
    assert.equal(firstHeading(body), 'Heading')
  })

  it('parses a block list and a folded scalar', () => {
    const { data } = parseSkillMarkdown('---\nname: demo\nkeywords:\n  - one\n  - two\nsummary: >\n  line one\n  line two\n---\n')
    assert.deepEqual(data.keywords, ['one', 'two'])
    assert.equal(data.summary, 'line one line two')
  })

  it('returns an empty object when there is no frontmatter, and still finds a heading', () => {
    const { data, body } = parseSkillMarkdown('# Just a heading\n\nText.\n')
    assert.deepEqual(data, {})
    assert.equal(firstHeading(body), 'Just a heading')
  })

  it('accepts every spelling of tags and author that skills actually use', () => {
    assert.deepEqual(readTags({ tags: ['A', 'a', 'b'] }), ['a', 'b'])
    assert.deepEqual(readTags({ keywords: 'x, y' }), ['x', 'y'])
    assert.deepEqual(readTags({ topics: ['t'] }), ['t'])
    assert.deepEqual(readTags({}), [])
    assert.equal(readAuthor({ author: ' Ada ' }), 'Ada')
    assert.equal(readAuthor({ authors: ['A', 'B'] }), 'A, B')
    assert.equal(readAuthor({ author: { name: 'Obj' } }), 'Obj')
    assert.equal(readAuthor({}), undefined)
  })
})

// ---------------------------------------------------------------------------
// Installed skills
// ---------------------------------------------------------------------------

describe('installed skills', () => {
  let sandbox
  let roots

  before(() => {
    sandbox = scratch()
    roots = resolveRoots({}, { DSH_HOME: sandbox.dshHome, DSH_AGENTS_HOME: sandbox.agentsHome })
    const dshRoot = findRoot(roots, ROOT.DSH)
    const agentsRoot = findRoot(roots, ROOT.AGENTS)

    writeBundle(dshRoot.dir, 'bundle-skill', skillMd('bundle-skill'), { 'references/notes.md': '# notes\n', 'LICENSE.txt': 'MIT\n' })
    mkdirSync(agentsRoot.dir, { recursive: true })
    writeFileSync(path.join(agentsRoot.dir, 'flat-skill.md'), skillMd('flat-skill'), { encoding: 'utf8' })
    // A directory without a SKILL.md is not a skill; neither is a hidden one.
    mkdirSync(path.join(dshRoot.dir, 'not-a-skill'), { recursive: true })
    writeFileSync(path.join(dshRoot.dir, 'not-a-skill', 'readme.md'), 'nope\n', 'utf8')
    writeBundle(dshRoot.dir, '.hidden', skillMd('hidden'))
  })

  after(() => {
    sandbox.dispose()
  })

  it('finds bundles and flat files, and ignores everything else', () => {
    const found = scanAll(roots)
    assert.deepEqual(found.skills.map((skill) => skill.name).sort(), ['bundle-skill', 'flat-skill'])
    assert.equal(found.total, 2)
    assert.equal(found.roots.length, 2)
  })

  it('reports a bundle its siblings and a flat file its single file', () => {
    const skills = scanAll(roots).skills
    const bundle = skills.find((skill) => skill.name === 'bundle-skill')
    assert.equal(bundle.flat, false)
    assert.equal(bundle.rootId, ROOT.DSH)
    assert.equal(bundle.fileCount, 3)
    // Sorted by locale collation, so compare as a set rather than pin an order
    // that ICU is free to choose.
    assert.deepEqual([...bundle.files].sort(), ['LICENSE.txt', 'SKILL.md', 'references/notes.md'])
    assert.deepEqual(bundle.tags, ['alpha', 'beta'])
    assert.equal(bundle.author, 'tester')

    const flat = skills.find((skill) => skill.name === 'flat-skill')
    assert.equal(flat.flat, true)
    assert.equal(flat.fileCount, 1)
    assert.equal(flat.relative, 'flat-skill.md')
  })

  it('reports a root that does not exist yet instead of failing', () => {
    const missing = resolveRoots({ projectRoot: sandbox.base }, { DSH_HOME: sandbox.dshHome, DSH_AGENTS_HOME: sandbox.agentsHome })
    const projectRoot = findRoot(missing, ROOT.PROJECT_DSH)
    assert.equal(projectRoot.exists, false)
    assert.deepEqual(scanRoot(projectRoot), [])
  })

  it('reads and removes a skill, and refuses an unknown one', () => {
    const agentsRoot = findRoot(roots, ROOT.AGENTS)
    const read = readSkill(agentsRoot, 'flat-skill', true)
    assert.match(read.markdown, /name: flat-skill/)

    const removed = removeSkill(agentsRoot, 'flat-skill', true)
    assert.equal(removed.removed, true)
    assert.equal(existsSync(path.join(agentsRoot.dir, 'flat-skill.md')), false)
    assert.throws(() => readSkill(agentsRoot, 'flat-skill', true), /skill not found/)
    assert.throws(() => removeSkill(agentsRoot, 'flat-skill', true), /skill not found/)
  })

  it('indexes by lowercase name', () => {
    const index = indexByName([{ name: 'Bundle-Skill' }])
    assert.equal(index.get('bundle-skill').name, 'Bundle-Skill')
  })
})

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

describe('install', () => {
  it('refuses plain http, private addresses and non-http protocols', () => {
    assert.throws(() => assertFetchableUrl('http://example.com/s.md'), /plain http/)
    assert.throws(() => assertFetchableUrl('file:///etc/passwd'), /refusing file:/)
    assert.throws(() => assertFetchableUrl('https://127.0.0.1/s.md'), /private address/)
    assert.throws(() => assertFetchableUrl('https://192.168.1.5/s.md'), /private address/)
    assert.equal(assertFetchableUrl('https://example.com/s.md').hostname, 'example.com')
    assert.equal(assertFetchableUrl('http://example.com/s.md', { allowInsecure: true }).protocol, 'http:')
  })

  it('validates every GitHub URL segment', () => {
    assert.equal(
      githubRawUrl({ owner: 'a', repo: 'b', branch: 'main', path: 'skills/x/SKILL.md' }),
      'https://raw.githubusercontent.com/a/b/main/skills/x/SKILL.md',
    )
    assert.throws(() => githubRawUrl({ owner: 'a/b', repo: 'b', branch: 'main', path: 'x' }), /bad GitHub owner/)
    assert.throws(() => githubRawUrl({ owner: 'a', repo: 'b', branch: 'main', path: '../x' }), /bad GitHub path/)
  })

  it('slugifies a name that the standard would reject outright', () => {
    assert.equal(slugifySkillName('React: Patterns & Pitfalls'), 'react-patterns-pitfalls')
    assert.equal(slugifySkillName('  ...  '), 'skill')
    assert.equal(slugifySkillName('Café Skill'), 'cafe-skill')
  })

  it('prefers an explicit name, then the frontmatter, then the URL', () => {
    assert.equal(deriveSkillName({ explicit: 'Explicit' }), 'explicit')
    assert.equal(deriveSkillName({ markdown: skillMd('from-frontmatter') }), 'from-frontmatter')
    assert.equal(deriveSkillName({ url: 'https://example.com/skills/cool-thing/SKILL.md' }), 'cool-thing')
    assert.equal(deriveSkillName({ url: 'https://example.com/one-offs/thing.md' }), 'thing')
    assert.equal(deriveSkillName({}), 'skill')
  })

  it('normalizes a remote relative path, and rejects one that would escape the bundle', () => {
    assert.equal(safeRelativeFile('references/a.md'), 'references/a.md')
    assert.equal(safeRelativeFile('a\\b.md'), 'a/b.md')
    // A leading slash is stripped rather than trusted: the result is still a
    // path inside the bundle, which is the only thing that matters here.
    assert.equal(safeRelativeFile('/abs.md'), 'abs.md')
    assert.throws(() => safeRelativeFile('../a.md'), /unsafe file path/)
    assert.throws(() => safeRelativeFile('a/../../b.md'), /unsafe file path/)
    assert.throws(() => safeRelativeFile(''), /empty file name/)
  })

  it('writes SKILL.md plus siblings, and refuses a bundle without an entry point', () => {
    const sandbox = scratch()
    try {
      const root = findRoot(resolveRoots({}, { DSH_HOME: sandbox.dshHome, DSH_AGENTS_HOME: sandbox.agentsHome }), ROOT.DSH)
      const result = writeSkill({
        root,
        name: 'written',
        files: [
          { name: 'references/a.md', content: '# a\n' },
          { name: 'SKILL.md', content: skillMd('written') },
        ],
      })
      assert.deepEqual(result.files, ['SKILL.md', 'references/a.md'])
      assert.equal(existsSync(path.join(result.dir, 'SKILL.md')), true)
      assert.equal(existsSync(path.join(result.dir, 'references', 'a.md')), true)
      assert.match(readFileSync(result.path, 'utf8'), /name: written/)

      assert.throws(() => writeSkill({ root, name: 'empty', files: [{ name: 'notes.md', content: 'x' }] }), /without SKILL.md/)
      assert.throws(() => writeSkill({ root, name: '../escape', files: [{ name: 'SKILL.md', content: 'x' }] }), /unsafe skill name/)
      assert.throws(
        () => writeSkill({ root, name: 'traverse', files: [{ name: 'SKILL.md', content: 'x' }, { name: 'a/../../b.md', content: 'x' }] }),
        /unsafe file path/,
      )
    } finally {
      sandbox.dispose()
    }
  })

  it('resolves a raw source through a fetch, and a github source with its nested siblings', async () => {
    const requested = []
    const fetchImpl = async (url) => {
      requested.push(String(url))
      if (String(url).includes('api.github.com')) {
        const dir = decodeURIComponent(new URL(String(url)).pathname.split('/contents/')[1] ?? '')
        const listing = dir === 'skills/demo'
          ? [
              { name: 'SKILL.md', path: 'skills/demo/SKILL.md', type: 'file', download_url: 'https://raw.githubusercontent.com/o/r/main/skills/demo/SKILL.md' },
              { name: 'rules', path: 'skills/demo/rules', type: 'dir' },
            ]
          : [{ name: 'one.md', path: 'skills/demo/rules/one.md', type: 'file', download_url: 'https://raw.githubusercontent.com/o/r/main/skills/demo/rules/one.md' }]
        return { ok: true, status: 200, url: String(url), headers: new Map(), text: async () => JSON.stringify(listing) }
      }
      return { ok: true, status: 200, url: String(url), headers: new Map(), text: async () => skillMd('demo') }
    }

    const raw = await resolveSource({ source: { kind: 'raw', url: 'https://example.com/skills/demo/SKILL.md' }, fetchImpl })
    assert.equal(raw.name, 'demo')
    assert.deepEqual(raw.files.map((file) => file.name), ['SKILL.md'])

    const github = await resolveSource({
      source: { kind: 'github', owner: 'o', repo: 'r', branch: 'main', path: 'skills/demo/SKILL.md' },
      fetchImpl,
      config: { maxSiblingFiles: 10 },
    })
    assert.equal(github.name, 'demo')
    assert.deepEqual(github.files.map((file) => file.name).sort(), ['SKILL.md', 'rules/one.md'])
    assert.ok(requested.some((url) => url.includes('api.github.com')), 'expected the contents API to be consulted')
  })

  it('surfaces a non-2xx fetch as an error rather than an empty skill', async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, statusText: 'Not Found', url: 'https://example.com/x', headers: new Map(), text: async () => '' })
    await assert.rejects(
      resolveSource({ source: { kind: 'raw', url: 'https://example.com/missing/SKILL.md' }, fetchImpl }),
      /404 Not Found/,
    )
    await assert.rejects(resolveSource({ source: { kind: 'nope' }, fetchImpl }), /unknown source kind/)
  })
})

// ---------------------------------------------------------------------------
// Curated registry
// ---------------------------------------------------------------------------

describe('curated registry', () => {
  it('ships cards, every one installable and pointing at a real repository path', () => {
    assert.ok(CURATED.length >= 20, `expected a real catalog, got ${CURATED.length}`)
    const seen = new Set()
    for (const entry of CURATED) {
      assert.equal(seen.has(entry.id), false, `duplicate id ${entry.id}`)
      seen.add(entry.id)
      assert.ok(CATEGORIES.includes(entry.category), `unknown category ${entry.category}`)
      assert.ok(entry.tags.length > 0, `${entry.id} has no tags`)

      const [owner, repo] = entry.repo.split('/')
      assert.equal(entry.raw, `https://raw.githubusercontent.com/${owner}/${repo}/${entry.branch}/${entry.path}`, `${entry.id} raw URL disagrees with its repo path`)

      const card = curatedCard(entry)
      assert.equal(card.installable, true)
      assert.equal(card.install.kind, 'github')
      assert.equal(card.install.withSiblings, true)
      assert.equal(card.install.path, entry.path)
    }
  })

  it('drops an unusable remote row and keeps the bundled card on an id collision', () => {
    const bundled = CURATED.map(curatedCard)
    const merged = mergeCurated(bundled, [
      { id: 'frontend-design', name: 'frontend-design', repo: 'someone/else', path: 'SKILL.md' },
      { id: 'good', name: 'good', repo: 'someone/good', branch: 'main', path: 'SKILL.md', tags: 'x, y' },
      { id: 'bad', name: 'bad', repo: 'no-slash', path: 'SKILL.md' },
      { id: 'worse', name: 'worse', repo: 'a/b' },
    ])
    assert.equal(merged.length, bundled.length + 1)
    assert.equal(merged.find((card) => card.name === 'frontend-design').author, 'anthropics')
    const added = merged.find((card) => card.name === 'good')
    assert.deepEqual(added.tags, ['x', 'y'])
    assert.equal(added.sourceLabel, 'Curated (remote)')
  })
})

// ---------------------------------------------------------------------------
// Live sources
// ---------------------------------------------------------------------------

describe('live sources', () => {
  /** A fetch that answers the verified SkillsMP envelope. */
  const skillsmpFetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://skillsmp.com/api/v1/skills/search',
    headers: new Map(),
    text: async () =>
      JSON.stringify({
        success: true,
        data: {
          skills: [
            {
              id: 'abc',
              name: 'tailwind-helper',
              author: 'someone',
              description: 'Helpers for Tailwind.',
              contentLanguage: 'en',
              githubUrl: 'https://github.com/someone/skills/blob/main/tailwind-helper/SKILL.md',
              skillUrl: 'https://skillsmp.com/skills/abc',
              stars: 12,
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          pagination: { page: 1, limit: 24, total: 1 },
        },
        meta: {},
      }),
  })

  it('maps the verified SkillsMP envelope into a card with a raw install source', async () => {
    const result = await searchSource('skillsmp', { query: 'tailwind', limit: 5, config: {}, fetchImpl: skillsmpFetch })
    assert.equal(result.degraded, false)
    assert.equal(result.cards.length, 1)
    const card = result.cards[0]
    assert.equal(card.name, 'tailwind-helper')
    assert.equal(card.author, 'someone')
    assert.equal(card.stars, 12)
    assert.equal(card.raw, 'https://raw.githubusercontent.com/someone/skills/main/tailwind-helper/SKILL.md')
    assert.equal(card.install.kind, 'raw')
  })

  it('keeps skills.sh dark without a token instead of reporting an empty catalog', async () => {
    const result = await searchSource('skillssh', { query: '', limit: 5, config: {}, fetchImpl: skillsmpFetch })
    assert.equal(result.degraded, true)
    assert.deepEqual(result.cards, [])
    assert.match(result.note, /Vercel OIDC token/)
  })

  it('does not ship an AgenticSkills adapter, because that host is parked', async () => {
    const result = await searchSource('agenticskills', { query: '', limit: 5, config: {}, fetchImpl: skillsmpFetch })
    assert.equal(result.degraded, true)
    assert.match(result.note, /unknown source/)
  })

  it('turns a dead source into a note rather than a thrown request', async () => {
    const failing = async () => {
      throw new Error('network down')
    }
    const result = await searchSource('skillsmp', { query: 'x', limit: 5, config: {}, fetchImpl: failing })
    assert.equal(result.error, true)
    assert.equal(result.degraded, true)
    assert.match(result.note, /network down/)
  })

  it('merges sources, de-duplicating by name and reporting each source its own yield', async () => {
    const merged = await searchLive({ sources: ['skillsmp', 'skillssh'], query: 'x', limit: 5, config: {}, fetchImpl: skillsmpFetch })
    assert.equal(merged.cards.length, 1)
    assert.deepEqual(
      merged.results.map((row) => [row.source, row.count]),
      [
        ['skillsmp', 1],
        ['skillssh', 0],
      ],
    )
  })
})

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

describe('http api', () => {
  let sandbox
  let handler
  let restoreFetch

  before(async () => {
    sandbox = scratch()
    restoreFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      const target = String(url)
      if (target.includes('api.github.com')) {
        return { ok: true, status: 200, url: target, headers: new Map(), text: async () => JSON.stringify([]) }
      }
      // Derive the skill name from the URL so a test can install two different
      // skills without the frontmatter colliding on one name.
      const parts = new URL(target).pathname.split('/').filter((part) => part !== '')
      const stem = parts[parts.length - 1].toLowerCase() === 'skill.md' ? parts[parts.length - 2] : parts[parts.length - 1].replace(/\.md$/i, '')
      return { ok: true, status: 200, url: target, headers: new Map(), text: async () => skillMd(stem) }
    }

    const { apply } = await import('../index.js')
    const registered = []
    const ctx = {
      logger: { info() {}, warn() {} },
      inject(services, callback) {
        assert.deepEqual(services, ['webServer'])
        callback({
          effect: (factory) => factory(),
          webServer: {
            register(spec) {
              registered.push(spec)
              return () => {}
            },
          },
        })
      },
    }
    apply(ctx, {
      dshHome: sandbox.dshHome,
      agentsHome: sandbox.agentsHome,
      defaultTarget: ROOT.DSH,
      liveSources: 'skillsmp',
    })

    assert.equal(registered.length, 1)
    assert.equal(registered[0].kind, 'prefix')
    assert.equal(registered[0].path, '/dsh-skills-market')
    handler = registered[0].handler
  })

  after(() => {
    globalThis.fetch = restoreFetch
    sandbox.dispose()
  })

  afterEach(() => {
    // Each test starts from an empty skills directory.
    for (const dir of [path.join(sandbox.dshHome, 'skills'), path.join(sandbox.agentsHome, 'skills')]) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /** Drive the handler with a fake request and response. */
  async function call({ method = 'GET', url = '/', body, remoteAddress = '127.0.0.1' } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
    req.method = method
    req.url = url
    req.socket = { remoteAddress }
    let status = 0
    let payload = ''
    const res = {
      writeHead(code) {
        status = code
      },
      end(text) {
        payload = text
      },
    }
    await handler(req, res)
    return { status, body: payload === '' ? undefined : JSON.parse(payload) }
  }

  it('answers /state with the resolved homes, roots and inventory', async () => {
    const { status, body } = await call({ url: '/state' })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.homes.dshHome, path.resolve(sandbox.dshHome))
    assert.deepEqual(body.roots.map((root) => root.id), [ROOT.DSH, ROOT.AGENTS])
    assert.equal(body.total, 0)
    assert.ok(body.sources.some((entry) => entry.id === 'curated'))
  })

  it('serves the curated catalog and filters it by query', async () => {
    const all = await call({ url: '/catalog' })
    assert.equal(all.status, 200)
    assert.ok(all.body.curated.length >= 20)
    assert.equal(all.body.curated.every((card) => card.installable === true), true)

    const filtered = await call({ url: '/catalog?q=tailwind' })
    assert.ok(filtered.body.curated.length > 0)
    assert.ok(filtered.body.curated.every((card) => JSON.stringify(card).toLowerCase().includes('tailwind')))
  })

  it('installs a skill into the chosen root and reports where it landed', async () => {
    const installed = await call({
      method: 'POST',
      url: '/install',
      body: {
        targetRootId: ROOT.DSH,
        source: { kind: 'raw', url: 'https://example.com/skills/installed-by-test/SKILL.md' },
      },
    })
    assert.equal(installed.status, 200)
    assert.equal(installed.body.ok, true)
    assert.equal(installed.body.name, 'installed-by-test')
    assert.equal(installed.body.rootId, ROOT.DSH)
    assert.equal(existsSync(path.join(sandbox.dshHome, 'skills', 'installed-by-test', 'SKILL.md')), true)

    // The install must be visible to the very next scan.
    const state = await call({ url: '/state' })
    assert.equal(state.body.total, 1)
    assert.equal(state.body.skills[0].name, 'installed-by-test')

    const read = await call({ url: '/skill?root=user-dsh&name=installed-by-test&flat=false' })
    assert.equal(read.status, 200)
    assert.match(read.body.markdown, /name: installed-by-test/)
  })

  it('removes a skill it installed', async () => {
    await call({ method: 'POST', url: '/install', body: { targetRootId: ROOT.AGENTS, source: { kind: 'raw', url: 'https://example.com/skills/gone/SKILL.md' } } })
    const removed = await call({ method: 'POST', url: '/remove', body: { rootId: ROOT.AGENTS, name: 'gone', flat: false } })
    assert.equal(removed.status, 200)
    assert.equal(removed.body.removed, true)
    assert.equal(existsSync(path.join(sandbox.agentsHome, 'skills', 'gone')), false)
  })

  it('refuses to write from a non-loopback address', async () => {
    const refused = await call({
      method: 'POST',
      url: '/install',
      remoteAddress: '10.0.0.9',
      body: { targetRootId: ROOT.DSH, source: { kind: 'raw', url: 'https://example.com/skills/x/SKILL.md' } },
    })
    assert.equal(refused.status, 403)
    assert.match(refused.body.error, /loopback-only/)
  })

  it('refuses a traversal attempt through the query string', async () => {
    const escaped = await call({ url: '/skill?root=user-dsh&name=..%2F..%2Fsecret&flat=false' })
    assert.equal(escaped.status, 400)
    assert.match(escaped.body.error, /unsafe skill name/)
  })

  it('reports unknown roots, unknown routes and a wrong method', async () => {
    assert.equal((await call({ url: '/skill?root=nope&name=x' })).status, 404)
    assert.equal((await call({ url: '/nope' })).status, 404)
    assert.equal((await call({ method: 'GET', url: '/install' })).status, 405)
    assert.equal((await call({ method: 'GET', url: '/remove' })).status, 405)
    assert.equal((await call({ method: 'POST', url: '/install', body: {} })).status, 400)
  })
})

/**
 * A `429` on its own does not say whether to wait a second or a day, and the
 * page counts the window down rather than reprinting the code — so the number
 * has to survive the trip from the response headers to the rendered row.
 */
describe('rate-limit cooldowns', () => {
  /** A `Headers`-like stand-in, matching what a fetch response exposes. */
  const headers = (entries) => new Map(Object.entries(entries))

  /** A response that fails with the given status and headers. */
  const failing = (status, statusText, entries) => async () => ({
    ok: false,
    status,
    statusText,
    url: 'https://skillsmp.com/api/v1/skills/search',
    headers: headers(entries),
    text: async () => '{}',
  })

  it('reads Retry-After as delta-seconds', () => {
    assert.equal(readRetryAfter(headers({ 'retry-after': '78860' })), 78860)
    assert.equal(readRetryAfter(headers({ 'retry-after': '0' })), 0)
  })

  it('reads Retry-After as an HTTP date', () => {
    const now = Date.parse('2026-10-01T00:00:00Z')
    assert.equal(readRetryAfter(headers({ 'retry-after': 'Thu, 01 Oct 2026 00:10:00 GMT' }), now), 600)
  })

  it('falls back to x-ratelimit-reset in unix seconds', () => {
    const now = Date.parse('2026-10-01T00:00:00Z')
    // 1790899200 is the reset SkillsMP sent alongside Retry-After: 78860 —
    // midnight UTC, the daily quota boundary.
    assert.equal(readRetryAfter(headers({ 'x-ratelimit-reset': '1790899200' }), now), 86400)
  })

  it('states no window rather than inventing one', () => {
    assert.equal(readRetryAfter(headers({})), undefined)
    assert.equal(readRetryAfter(undefined), undefined)
    assert.equal(readRetryAfter(headers({ 'retry-after': 'soon' })), undefined)
    assert.equal(readRetryAfter(headers({ 'x-ratelimit-reset': 'not-a-number' })), undefined)
  })

  it('carries the cooldown on the thrown error, not only the status code', async () => {
    await assert.rejects(
      () => fetchText('https://skillsmp.com/api/v1/skills/search', { fetchImpl: failing(429, 'Too Many Requests', { 'retry-after': '78860' }) }),
      (error) => {
        assert.equal(error.status, 429)
        assert.equal(error.retryAfterSeconds, 78860)
        assert.match(error.message, /429 Too Many Requests/)
        return true
      },
    )
  })

  it('leaves retryAfterSeconds unset when the host names no window', async () => {
    await assert.rejects(
      () => fetchText('https://skillsmp.com/api/v1/skills/search', { fetchImpl: failing(500, 'Server Error', {}) }),
      (error) => {
        assert.equal(error.status, 500)
        assert.equal(error.retryAfterSeconds, undefined)
        return true
      },
    )
  })

  it('passes the cooldown through a degraded source row', async () => {
    const row = await searchSource('skillsmp', { query: 'react', config: {}, fetchImpl: failing(429, 'Too Many Requests', { 'retry-after': '120' }) })
    assert.equal(row.degraded, true)
    assert.equal(row.error, true)
    assert.equal(row.status, 429)
    assert.equal(row.retryAfterSeconds, 120)
    assert.match(row.note, /429 Too Many Requests/)
  })

  it('reports a degraded source with no window as having none', async () => {
    const row = await searchSource('skillsmp', { query: 'react', config: {}, fetchImpl: failing(503, 'Service Unavailable', {}) })
    assert.equal(row.degraded, true)
    assert.equal(row.status, 503)
    assert.equal(row.retryAfterSeconds, undefined)
  })
})
