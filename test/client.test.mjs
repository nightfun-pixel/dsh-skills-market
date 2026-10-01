/**
 * Client-half tests.
 *
 * The browser half cannot be rendered here — React is bundled into the web
 * client and is not resolvable from this package — so this suite tests the two
 * things that actually break a client plugin and that a browser would only
 * reveal as a blank panel:
 *
 *   1. **The registration contract.** The sidebar row, the keyed `main` panel
 *      and the Settings section are three separate registrations with exact
 *      ids, keys and orders. If the `main` key stops matching the sidebar id,
 *      the row opens nothing; if the order drifts, the section lands in the
 *      wrong place.
 *   2. **That the page builds.** `MarketPage` is a plain function, so it can be
 *      called with a shimmed React and a preset hook queue. A typo in the tree
 *      throws here instead of rendering an empty section.
 *
 * The `client.js` source is loaded the way the host loads it: by evaluating the
 * file against a `window` that carries `__ModuleLoader__`.
 *
 * @module skills-market/test/client
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.resolve(here, '..', 'client.js')
const PACKAGE_PATH = path.resolve(here, '..', 'package.json')

/**
 * Evaluate `client.js` against a fake module loader.
 * @param react - The React shim the factory will receive.
 * @returns `{ spec, exported }` — the load spec and the object the factory returned.
 */
function loadClient(react) {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  let spec
  const window = {
    __ModuleLoader__: {
      load(value) {
        spec = value
      },
    },
    // The component closes over this object, so anything it reaches for on
    // `window` has to exist here. The countdown row starts an interval; the
    // handle is returned without a real timer so the suite does not hang.
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  }
  // eslint-disable-next-line no-new-func -- the file is a browser script, not a module
  new Function('window', source)(window)
  assert.ok(spec !== undefined, 'client.js never called window.__ModuleLoader__.load')
  const exported = spec.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  })
  return { spec, exported }
}

/**
 * A React shim whose `useState` drains a preset queue.
 * @param queue - Values to hand back, in hook order.
 * @param options - `runEffects` calls each effect during render instead of
 *   dropping it, which is what lets a test observe the requests a page issues.
 * @returns A React-shaped object.
 */
function makeReact(queue = [], options = {}) {
  return {
    Fragment: Symbol('react.fragment'),
    createElement(type, props, ...children) {
      const rest = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: { ...(props ?? {}), children: rest } }
    },
    useState(initial) {
      // React resolves a lazy initializer; the countdown row seeds its deadline
      // that way, so the shim has to as well.
      const value = queue.length > 0 ? queue.shift() : initial
      return [typeof value === 'function' ? value() : value, () => {}]
    },
    useEffect(effect) {
      if (options.runEffects === true) effect()
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    useRef(initial) {
      return { current: initial }
    },
  }
}

/**
 * Collect every string in a rendered element tree, calling function components
 * the way a renderer would.
 *
 * The registration hands back an element whose type is the page component, so a
 * walker that only read `props.children` would see nothing at all — the shimmed
 * hooks make a real render unnecessary, but the component still has to be called.
 */
function collectText(node, into = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return into
  if (typeof node === 'string' || typeof node === 'number') {
    into.push(String(node))
    return into
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, into)
    return into
  }
  if (typeof node === 'object' && node.props !== undefined) {
    if (typeof node.type === 'function') return collectText(node.type(node.props), into)
    return collectText(node.props.children, into)
  }
  return into
}

/**
 * A fake browser plugin context that records every registration.
 * @returns `{ ctx, registrations, namespaces }`.
 */
function makeContext() {
  const registrations = []
  const namespaces = new Map()
  const ctx = {
    effect(factory) {
      const off = factory()
      return typeof off === 'function' ? off : () => {}
    },
    locale: {
      register(namespace, strings) {
        namespaces.set(namespace, strings)
        return () => {}
      },
      bind(namespace) {
        const strings = namespaces.get(namespace) ?? {}
        return (key) => strings.en?.[key] ?? key
      },
    },
    slots: {
      // `inject` fires the callback immediately, the way a slot that is already
      // declared behaves; the callback may be a generator of disposers.
      inject(name, callback) {
        const result = callback()
        if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
          for (const _ of result) {
            /* drain the generator so every yield runs */
          }
        }
        return () => {}
      },
      register(options, component) {
        registrations.push({ ...options, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, namespaces }
}

describe('client half', () => {
  it('is loaded under the package name, so the host can address its chunks', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'))
    const { spec } = loadClient(makeReact())
    assert.equal(spec.id, pkg.name)
    assert.equal(pkg.dsh.client.platform, 'web')
    assert.equal(pkg.exports['./client'], './client.js')
  })

  it('declares the two services its registrations need', () => {
    const { exported } = loadClient(makeReact())
    assert.deepEqual(exported.inject, ['slots', 'locale'])
    assert.equal(typeof exported.apply, 'function')
  })

  it('registers the sidebar row, the main panel and the Settings section', () => {
    const { exported } = loadClient(makeReact())
    const { ctx, registrations } = makeContext()
    exported.apply(ctx)

    const main = registrations.find((entry) => entry.name === 'main')
    const sidebar = registrations.find((entry) => entry.name === 'sidebar.panellist')
    const settings = registrations.find((entry) => entry.name === 'settings.section')

    assert.ok(main !== undefined, 'no main panel registration')
    assert.ok(sidebar !== undefined, 'no sidebar.panellist registration')
    assert.ok(settings !== undefined, 'no settings.section registration')

    // The sidebar id addresses the main panel: if these drift apart, the row
    // renders and opens nothing.
    assert.equal(main.key, 'skills-market')
    assert.equal(sidebar.id, main.key)
    assert.equal(settings.id, main.key)

    // The sidebar row sits immediately after Plugins (order 0).
    assert.equal(sidebar.order, 1)
    // The Settings section sits immediately after MCP Hub (order 45).
    assert.equal(settings.order, 46)

    for (const entry of [main, sidebar, settings]) {
      assert.equal(entry.locale, 'skills-market')
    }
    assert.equal(typeof sidebar.label, 'function')
    assert.equal(sidebar.label(), 'Skills Market')
  })

  it('carries the install reminder verbatim in both dictionaries', () => {
    const { exported } = loadClient(makeReact())
    const { ctx, namespaces } = makeContext()
    exported.apply(ctx)

    const strings = namespaces.get('skills-market')
    assert.ok(strings !== undefined, 'locale namespace was never registered')
    assert.equal(strings.ru.toastReminder, 'Откройте New Session, чтобы агент загрузил новый скилл.')
    assert.match(strings.en.toastReminder, /New Session/)

    // Every key must exist in both dictionaries, or one language renders a raw key.
    const enKeys = Object.keys(strings.en).sort()
    const ruKeys = Object.keys(strings.ru).sort()
    assert.deepEqual(ruKeys, enKeys)
  })

  it('builds the installed tab without throwing', () => {
    const state = {
      ok: true,
      homes: { dshHome: 'D:/home', agentsHome: 'C:/agents' },
      roots: [
        { id: 'user-dsh', label: 'DSH', dir: 'D:/home/skills', installable: true, exists: true, count: 1, note: 'DSH_HOME/skills' },
        { id: 'user-agents', label: 'Agents', dir: 'C:/agents/skills', installable: true, exists: false, count: 0, note: 'cross-platform' },
      ],
      skills: [
        {
          id: 'user-dsh:demo',
          name: 'demo',
          title: 'Demo Skill',
          rootId: 'user-dsh',
          rootLabel: 'DSH',
          flat: false,
          fileCount: 2,
          size: 2048,
          author: 'tester',
          tags: ['alpha'],
          relative: 'demo/SKILL.md',
          path: 'D:/home/skills/demo/SKILL.md',
        },
      ],
      total: 1,
      sources: [{ id: 'curated', label: 'Curated', description: 'bundled' }],
      defaultTarget: 'user-dsh',
    }

    const react = makeReact(['installed', state, null, '', 'all', 'all', 'user-dsh', null, '', '', []])
    const { exported } = loadClient(react)
    const { ctx, registrations } = makeContext()
    exported.apply(ctx)

    // The Settings registration's component is the page; call it directly.
    const page = registrations.find((entry) => entry.name === 'settings.section')
    const Component = page.component
    assert.equal(typeof Component, 'function', 'the registration did not carry a component')

    const tree = Component({ t: (key) => key })
    const text = collectText(tree).join(' | ')
    assert.match(text, /Scan roots/)
    assert.match(text, /D:\/home\/skills/)
    assert.match(text, /C:\/agents\/skills/)
    assert.match(text, /Demo Skill/)
    // The root that does not exist yet is called out rather than silently empty.
    assert.match(text, /directory does not exist yet/)
    // And the page really renders the resolved paths, not placeholders.
    assert.match(text, /2 files/)
  })

  it('addresses every host endpoint under the plugin route prefix', () => {
    // The page reads as if it were calling absolute paths (`/state`,
    // `/catalog`). A fetch resolves those against the page origin, so dropping
    // the prefix asks the app shell for `/catalog` and gets a 404 that reads as
    // a broken market rather than a wrong URL. This test observes the real
    // request URLs, which is the only way that mistake shows up.
    const calls = []
    const head = { appendChild(element) { element.parentNode = head } }
    const originalDocument = globalThis.document
    const originalFetch = globalThis.fetch

    globalThis.document = {
      baseURI: 'http://127.0.0.1:3080/',
      head,
      createElement() {
        return { dataset: {}, textContent: '', parentNode: null }
      },
    }
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, skills: [], roots: [], total: 0, sources: [] }),
      }
    }

    try {
      const { exported } = loadClient(makeReact([], { runEffects: true }))
      const { ctx, registrations } = makeContext()
      exported.apply(ctx)
      const page = registrations.find((entry) => entry.name === 'settings.section')
      collectText(page.component({ t: (key) => key }))
    } finally {
      globalThis.document = originalDocument
      globalThis.fetch = originalFetch
    }

    assert.ok(calls.length > 0, 'the page issued no request at all')
    assert.equal(calls[0], '/dsh-skills-market/state')
    for (const url of calls) {
      assert.match(url, /^\/dsh-skills-market\//, `request escaped the route prefix: ${url}`)
    }
  })

  it('renders the sidebar glyph at the size the sidebar asks for', () => {
    const { exported } = loadClient(makeReact())
    const { ctx, registrations } = makeContext()
    exported.apply(ctx)

    const sidebar = registrations.find((entry) => entry.name === 'sidebar.panellist')
    const Icon = sidebar.component
    assert.equal(typeof Icon, 'function', 'the sidebar row did not carry an icon component')

    const icon = Icon({ size: 22, active: true })
    assert.equal(icon.type, 'svg')
    assert.equal(icon.props.width, 22)
    assert.equal(icon.props.height, 22)
  })

  /**
   * Render the page with a preset hook queue and the real English dictionary,
   * so an assertion about wording is an assertion about what ships.
   */
  function renderPage(queue) {
    const { exported } = loadClient(makeReact(queue))
    const { ctx, registrations } = makeContext()
    exported.apply(ctx)
    const Component = registrations.find((entry) => entry.name === 'settings.section').component
    return collectText(Component({ t: ctx.locale.bind('skills-market') })).join(' | ')
  }

  /** The hook queue `MarketPage` consumes, in order. */
  const pageQueue = (tab, catalog, error) => [
    tab,
    { total: 0, roots: [], skills: [], sources: [], defaultTarget: 'user-dsh' },
    catalog,
    '',
    'all',
    'all',
    'user-dsh',
    null,
    '',
    error,
    [],
  ]

  it('shows an error only in the tab that raised it', () => {
    // The alert sits above the tab switch, so a failure carrying no scope
    // paints over whichever tab the reader happens to be on — including the
    // installed inventory, which had nothing to do with it and offers no way
    // to act on it.
    const failure = { message: 'catalog exploded', scope: 'catalog' }
    const catalog = { curated: [], live: [], sources: [] }

    assert.doesNotMatch(renderPage(pageQueue('installed', catalog, failure)), /catalog exploded/)
    assert.match(renderPage(pageQueue('catalog', catalog, failure)), /catalog exploded/)
  })

  it('counts a rate-limited source down instead of reprinting the status code', () => {
    // 78860 is the Retry-After SkillsMP actually answers with once its daily
    // quota is gone. "21 h 54 min" is a decision a reader can make; "429" is not.
    const catalog = {
      curated: [],
      live: [],
      sources: [
        { source: 'skillsmp', count: 0, degraded: true, error: true, status: 429, note: '429 Too Many Requests', retryAfterSeconds: 78860 },
      ],
    }

    const text = renderPage(pageQueue('catalog', catalog, null))
    assert.match(text, /429 Too Many Requests/)
    assert.match(text, /retry in 21 h 54 min/)
  })

  it('reports a degraded source with no stated window as a plain note', () => {
    const catalog = {
      curated: [],
      live: [],
      sources: [{ source: 'skillsmp', count: 0, degraded: true, error: true, status: 503, note: '503 Service Unavailable' }],
    }

    const text = renderPage(pageQueue('catalog', catalog, null))
    assert.match(text, /503 Service Unavailable/)
    // No window was named, so no clock is invented for it.
    assert.doesNotMatch(text, /retry in/)
  })
})
