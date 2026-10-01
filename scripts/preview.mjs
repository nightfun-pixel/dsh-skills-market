/**
 * Render the real page to a standalone HTML file, so the layout can be looked at
 * without a running harness.
 *
 * The point is to review the actual component, not a hand-written mock: the
 * factory is loaded exactly as the host loads it, the stylesheet is captured
 * from the `<style>` element the page injects, and the element tree is
 * serialized from what the component returned. Live `/state` and `/catalog`
 * payloads are used when the server answers, so the preview shows real skill
 * names and real descriptions rather than lorem ipsum.
 *
 * The host's `--dsw-alias-*` tokens are not defined outside the harness, so the
 * page stands in a dark approximation of them. Only the values differ; every
 * rule under test is the shipped one.
 *
 * @module skills-market/scripts/preview
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const base = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'

/** Fetch a JSON endpoint, falling back to a small built-in sample. */
async function tryJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

/**
 * The preview is committed as a screenshot, so the machine's own paths must not
 * survive into the image: a public repository is the wrong place to publish the
 * author's directory layout. The two prefixes worth rewriting are the ones the
 * page actually prints — the resolved DSH home and the user profile.
 */
const HOME_PREFIXES = [
  [process.env.DSH_HOME, '%DSH_HOME%'],
  [process.env.USERPROFILE, '%USERPROFILE%'],
  [process.env.HOME, '~'],
].filter(([from]) => typeof from === 'string' && from !== '')

function sanitize(value) {
  if (typeof value === 'string') {
    let out = value
    for (const [from, to] of HOME_PREFIXES) out = out.split(from).join(to)
    return out
  }
  if (Array.isArray(value)) return value.map(sanitize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]))
  }
  return value
}

// ---------------------------------------------------------------- React shim

let captured = { css: '', head: [] }

function makeReact(queue) {
  return {
    Fragment: Symbol('react.fragment'),
    createElement(type, props, ...children) {
      const rest = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: { ...(props ?? {}), children: rest } }
    },
    useState: (initial) => [queue.length > 0 ? queue.shift() : initial, () => {}],
    useEffect(effect) {
      effect()
    },
    useCallback: (fn) => fn,
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (value) => String(value).replace(/[&<>"]/g, (char) => ESCAPES[char])

/** Serialize one element tree the way a renderer would, following function components. */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node !== 'object' || node.props === undefined) return ''

  if (typeof node.type === 'function') return render(node.type(node.props))
  if (typeof node.type === 'symbol') return render(node.props.children)

  const attrs = []
  for (const [key, value] of Object.entries(node.props)) {
    if (key === 'children' || value === undefined || value === null) continue
    if (key === 'className') attrs.push(`class="${esc(value)}"`)
    else if (key === 'style') {
      const css = Object.entries(value)
        .map(([prop, val]) => `${prop.startsWith('--') ? prop : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${val}`)
        .join(';')
      attrs.push(`style="${esc(css)}"`)
    } else if (key.startsWith('on') || key === 'key') continue
    else if (value === true) attrs.push(key)
    else attrs.push(`${key}="${esc(value)}"`)
  }
  const open = `<${node.type}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`
  return `${open}${render(node.props.children)}</${node.type}>`
}

// ------------------------------------------------------------------- capture

const source = readFileSync(path.join(root, 'client.js'), 'utf8')

let spec
const fakeWindow = {
  __ModuleLoader__: { load: (value) => { spec = value } },
  setTimeout: () => 0,
  clearTimeout: () => {},
  open: () => {},
}
new Function('window', source)(fakeWindow)

globalThis.document = {
  baseURI: `${base}/`,
  head: {
    appendChild(element) {
      captured.head.push(element)
      if (element.textContent !== undefined) captured.css = element.textContent
    },
  },
  createElement: () => ({ dataset: {}, textContent: '', parentNode: null }),
}
// The live payloads are read first, with the real fetch. Only then is fetch
// stubbed, so the page's own loaders resolve against the payloads handed to it
// instead of racing a network call during a synchronous render.
const [state, catalog] = (await Promise.all([tryJson(`${base}/dsh-skills-market/state`), tryJson(`${base}/dsh-skills-market/catalog`)])).map(sanitize)
globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '{}' })

const page = process.argv[2] ?? 'catalog'
const queue = page === 'installed'
  ? ['installed', state, catalog, '', 'all', 'all', state?.defaultTarget ?? null, null, '', '', []]
  : ['catalog', state, catalog, '', 'all', 'all', state?.defaultTarget ?? null, null, '', '', []]

const exported = spec.factory((name) => {
  if (name === 'react') return makeReact(queue)
  throw new Error(`unexpected require(${name})`)
})

const registrations = []
exported.apply({
  effect: (factory) => factory(),
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
  },
  slots: {
    inject: (_name, callback) => {
      const result = callback()
      if (result !== null && typeof result === 'object' && typeof result.next === 'function') for (const _ of result) { /* drain */ }
    },
    register: (options, component) => {
      registrations.push({ ...options, component })
      return () => {}
    },
  },
})

const section = registrations.find((entry) => entry.name === 'settings.section')
const html = render(section.component({ t: (key) => key }))

const TOKENS = `
:root {
  --dsw-alias-label-primary: #e9e9ec;
  --dsw-alias-label-secondary: #97979f;
  --dsw-alias-bg-layer-1: #17171a;
  --dsw-alias-border-l1: #2b2b31;
  --dsw-alias-brand-primary: #4f7cf7;
  --dsw-alias-state-success-primary: #35c759;
  --dsw-alias-state-error-primary: #ff5a52;
  --dsw-alias-state-warning-primary: #f0a020;
}
html, body { margin: 0; background: #0d0d0f; color: #e9e9ec;
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }

/* Stand in for the host frame, which is \`height:100%; overflow:hidden\`. If the
   page does not scroll itself, the shot shows the clipping rather than hiding
   it behind a scrolling document body. */
html, body { height: 100%; overflow: hidden; }
body { display: flex; flex-direction: column; }
`

// A screenshot cannot show whether a box scrolls — a clipped box and a
// scrollable one look identical in a still. `--probe` overlays the numbers so a
// shot can be read for the answer; it stays off for images meant for the README.
const PROBE = process.argv.includes('--probe')
  ? `<div id="probe" style="position:fixed;left:8px;top:6px;z-index:99;font:600 14px ui-monospace,monospace;color:#0b0b0d;background:#7CFC00;padding:4px 8px;border-radius:5px"></div>
<script>
  var el = document.querySelector('.dsh-skills-market')
  function report() {
    var style = getComputedStyle(el)
    document.getElementById('probe').textContent =
      'PROBE win=' + window.innerHeight +
      ' client=' + el.clientHeight +
      ' scroll=' + el.scrollHeight +
      ' overflowY=' + style.overflowY +
      ' SCROLLABLE=' + (el.scrollHeight > el.clientHeight)
  }
  report()
  window.addEventListener('load', report)
  requestAnimationFrame(report)
</script>`
  : ''

const out = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Skills Market — ${page}</title><style>${TOKENS}${captured.css}</style></head>
<body>${html}
${PROBE}
</body></html>`

const target = path.join(root, `preview-${page}.html`)
writeFileSync(target, out, 'utf8')

process.stdout.write(`wrote ${target}\n`)
process.stdout.write(`  css captured : ${captured.css.length} bytes\n`)
process.stdout.write(`  page         : ${page}\n`)
process.stdout.write(`  state        : ${state === null ? 'unavailable (offline sample)' : `${state.total} skills, ${state.roots.length} roots`}\n`)
process.stdout.write(`  catalog      : ${catalog === null ? 'unavailable' : `${catalog.curated?.length ?? 0} curated, ${catalog.live?.length ?? 0} live`}\n`)
process.stdout.write(`  html         : ${html.length} bytes\n`)
