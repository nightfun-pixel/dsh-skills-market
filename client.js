/**
 * The Skills Market page.
 *
 * One React tree, mounted in two seats: the sidebar's global panel list (beside
 * Plugins) and a section in Settings directly under MCP Hub. Both seats render
 * the same component, so the shop looks and behaves the same wherever it is
 * opened from — the sidebar is the fast path, Settings is where it sits next to
 * the other marketplaces.
 *
 * The page is a plain React tree — no iframe, no second app root — and it styles
 * itself only with the host's theme tokens, so it follows the active theme
 * instead of inventing one.
 *
 * All data comes from the host half over HTTP under `/dsh-skills-market`. Nothing
 * is cached: whether a skill is installed is a fact about the filesystem, and a
 * stale copy of it would be worse than no copy.
 *
 * @module @local/dsh-skills-market/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-skills-market',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'skills-market'

    /** The sidebar panel id; also the `main` slot key that renders this page. */
    const PANEL_ID = 'skills-market'

    /**
     * The language the host is currently rendering in.
     *
     * `t` is bound to the active locale, so a key that exists in every dictionary
     * with a different value reports which one is live. That keeps the catalog's
     * bilingual text in step with the rest of the page without a second source of
     * truth for the language.
     */
    const LANG_KEY = '__lang'

    const STRINGS = {
      en: {
        [LANG_KEY]: 'en',
        nav: 'Skills Market',
        title: 'Skills Market',
        subtitle: 'Browse installed SKILL.md files and install new ones from the catalog.',
        tabInstalled: 'Installed',
        tabCatalog: 'Catalog',
        search: 'Search skills…',
        refresh: 'Refresh',
        loading: 'Loading…',
        install: 'Install',
        installing: 'Installing…',
        installed: 'Installed',
        remove: 'Delete',
        view: 'View',
        close: 'Close',
        cancel: 'Cancel',
        roots: 'Scan roots',
        target: 'Install into',
        targetHint: 'A skill lands in <root>/<name>/SKILL.md.',
        emptyInstalled: 'Nothing installed yet.',
        emptyInstalledHint: 'Open the Catalog tab and install a skill — it will appear here.',
        emptyCatalog: 'No skills match this filter.',
        emptyLive: 'This source returned nothing.',
        allSources: 'All sources',
        allCategories: 'All',
        secCurated: 'Curated',
        secLive: 'Live search',
        open: 'Open source',
        fileFew: 'files',
        files: 'files',
        file: 'file',
        author: 'Author',
        version: 'Version',
        license: 'License',
        stars: 'stars',
        installs: 'installs',
        source: 'Source',
        missing: 'directory does not exist yet',
        confirmRemove: 'Delete this skill from disk?',
        toastTitle: 'Installed',
        toastReminder: 'Open a New Session so the agent picks up the new skill.',
        removeTitle: 'Deleted',
        removeBody: 'The skill was removed from disk.',
        error: 'Error',
        notInstallable: 'This card has no fetchable source.',
        fileCount: 'Contents',
      },
      ru: {
        [LANG_KEY]: 'ru',
        nav: 'Магазин скилов',
        title: 'Магазин скилов',
        subtitle: 'Смотрите установленные SKILL.md и ставьте новые из каталога.',
        tabInstalled: 'Установленные',
        tabCatalog: 'Каталог',
        search: 'Поиск скилов…',
        refresh: 'Обновить',
        loading: 'Загрузка…',
        install: 'Установить',
        installing: 'Установка…',
        installed: 'Установлен',
        remove: 'Удалить',
        view: 'Просмотреть',
        close: 'Закрыть',
        cancel: 'Отмена',
        roots: 'Корни поиска',
        target: 'Куда ставить',
        targetHint: 'Скил ляжет в <root>/<name>/SKILL.md.',
        emptyInstalled: 'Пока ничего не установлено.',
        emptyInstalledHint: 'Откройте вкладку «Каталог» и поставьте скил — он появится здесь.',
        emptyCatalog: 'Под этот фильтр ничего не подходит.',
        emptyLive: 'Этот источник ничего не вернул.',
        allSources: 'Все источники',
        allCategories: 'Все',
        secCurated: 'Курируемые',
        secLive: 'Живой поиск',
        open: 'Открыть источник',
        fileFew: 'файла',
        files: 'файлов',
        file: 'файл',
        author: 'Автор',
        version: 'Версия',
        license: 'Лицензия',
        stars: 'звёзд',
        installs: 'установок',
        source: 'Источник',
        missing: 'папки ещё нет',
        confirmRemove: 'Удалить скил с диска?',
        toastTitle: 'Установлено',
        toastReminder: 'Откройте New Session, чтобы агент загрузил новый скилл.',
        removeTitle: 'Удалено',
        removeBody: 'Скил удалён с диска.',
        error: 'Ошибка',
        notInstallable: 'У этой карточки нет источника для скачивания.',
        fileCount: 'Содержимое',
      },
    }

    /**
     * The host route prefix registered by `index.js`.
     *
     * Every endpoint below lives under this prefix. It is easy to leave off,
     * because the call sites read as absolute paths (`/catalog`) — but a fetch
     * resolves them against the page origin, so a missing prefix asks the app
     * shell for `/catalog` and gets a 404 that looks like a broken market rather
     * than a wrong URL. It is applied here, once, instead of at each call site.
     */
    const ROUTE = '/dsh-skills-market'

    /**
     * Build the URL of one host endpoint, honouring a non-root base path.
     *
     * The query string is kept: `new URL(...).pathname` alone silently drops it,
     * which would send every search as a request with no query at all.
     */
    function api(path) {
      const relative = `${ROUTE}/${path.replace(/^\/+/, '')}`.replace(/^\/+/, '')
      if (typeof document === 'undefined') return `/${relative}`
      const url = new URL(relative, document.baseURI)
      return `${url.pathname}${url.search}`
    }

    /**
     * Decode one JSON reply, naming the status when there is no body to decode.
     *
     * A bare `response.json()` reports a wrong path as a JSON syntax error
     * ("unexpected end of data"), which hides the actual fault — a 404.
     */
    async function readJson(response, path) {
      const text = await response.text()
      const target = api(path)
      if (!response.ok) {
        let detail = `HTTP ${response.status}`
        try {
          const parsed = JSON.parse(text)
          if (typeof parsed?.error === 'string') detail = parsed.error
        } catch {
          /* the status alone is the message */
        }
        throw new Error(`${detail} — ${target}`)
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`${target} did not return JSON (HTTP ${response.status})`)
      }
    }

    /** Read one JSON endpoint. */
    async function getJson(path) {
      const response = await fetch(api(path), { cache: 'no-store' })
      return await readJson(response, path)
    }

    /** Post a JSON body to one endpoint. */
    async function postJson(path, body) {
      const response = await fetch(api(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body ?? {}),
      })
      return await readJson(response, path)
    }

    /** Human-readable byte size. */
    function formatSize(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * `N files`, with the noun agreeing with the count.
     *
     * English needs two forms and Russian three, so the dictionaries carry
     * `file` / `fileFew` / `files` and the choice is made here. Concatenating a
     * count onto one fixed word is how `1 files` and `2 файлов` happen.
     */
    function fileCountLabel(count, t) {
      if (count === 1) return `1 ${t('file')}`
      if (t(LANG_KEY) === 'ru') {
        const mod10 = count % 10
        const mod100 = count % 100
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} ${t('fileFew')}`
      }
      return `${count} ${t('files')}`
    }

    /**
     * One colour per shelf.
     *
     * The spine is the only saturated thing in the page, so these are chosen to
     * stay distinguishable at 3px wide and to hold up on both the light and the
     * dark host theme. They are classification, not decoration: the spine is how
     * you find the frontend skills without reading a word.
     */
    const HUES = {
      frontend: '#6b7ff2',
      layout: '#2f9e8f',
      debug: '#c94f7c',
      prompt: '#9a6ae0',
      docs: '#5b86c9',
      testing: '#4f9d5d',
      git: '#b0842a',
    }

    /** The spine colour for a shelf; a plain rule for anything unclassified. */
    function hueFor(category) {
      return HUES[category] ?? 'var(--dsw-alias-border-l1)'
    }

    /**
     * The stylesheet, injected once per page instance.
     *
     * Every inner class is prefixed `sm-`-free but scoped under
     * `.dsh-skills-market`; generic names like `.card` were dropped because the
     * host's own unscoped rules would otherwise reach into this page.
     */
    const CSS = `
/* The frame hosting a main panel is height:100% with overflow:hidden, so a page
   in that seat has to scroll itself — the sidebar seat provides no scroll
   container at all. This is the same shape the Plugins page uses. In the
   Settings dialog the host does scroll, and height:100% then resolves against
   that box instead of running off it, so there is still exactly one scrollbar
   in both seats. */
.dsh-skills-market { box-sizing: border-box; height: 100%; overflow-y: auto; scrollbar-gutter: stable; padding: 20px clamp(16px, 2.5vw, 32px) 40px; color: var(--dsw-alias-label-primary); font-size: 13px; --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }
/* The cap belongs on the content, not on the scroller: a max-width on the
   scroll container parks its scrollbar in the middle of a wide panel. */
.dsh-skills-market .inner { max-width: 1200px; display: flex; flex-direction: column; gap: 14px; }
.dsh-skills-market h2 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -.01em; }
.dsh-skills-market h3 { margin: 0; font-size: 13px; font-weight: 600; }
.dsh-skills-market .sub { margin: 5px 0 0; color: var(--dsw-alias-label-secondary); line-height: 1.5; max-width: 64ch; }
.dsh-skills-market .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-skills-market .grow { flex: 1 1 auto; min-width: 0; }
.dsh-skills-market .muted { color: var(--dsw-alias-label-secondary); }
.dsh-skills-market code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }

.dsh-skills-market .tabs { display: inline-flex; gap: 2px; padding: 3px; align-self: flex-start; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); }
.dsh-skills-market .tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); padding: 6px 14px; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 500; display: flex; align-items: center; gap: 7px; }
.dsh-skills-market .tab:hover { color: var(--dsw-alias-label-primary); }
.dsh-skills-market .tab[data-active="true"] { color: var(--dsw-alias-label-primary); background: rgba(127,127,127,.16); font-weight: 600; }
.dsh-skills-market .count { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }

.dsh-skills-market input, .dsh-skills-market select { font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 11px; width: 100%; box-sizing: border-box; }
.dsh-skills-market input::placeholder { color: var(--dsw-alias-label-secondary); }
.dsh-skills-market button { font: inherit; cursor: pointer; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 6px 12px; font-size: 12.5px; }
.dsh-skills-market button:hover:not(:disabled) { border-color: var(--dsw-alias-label-secondary); }
.dsh-skills-market button:disabled { opacity: .55; cursor: default; }
.dsh-skills-market button.primary { background: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary)); color: var(--dsw-alias-bg-layer-1); border-color: transparent; font-weight: 600; }
.dsh-skills-market button.ghost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); padding: 6px 9px; }
.dsh-skills-market button.ghost:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: rgba(127,127,127,.13); border-color: transparent; }
.dsh-skills-market button.danger { color: var(--dsw-alias-state-error-primary); }
.dsh-skills-market :focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary)); outline-offset: 1px; border-radius: 6px; }

.dsh-skills-market .bar { display: flex; flex-direction: column; gap: 9px; }
.dsh-skills-market .chips { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
.dsh-skills-market .chip { border-radius: 999px; padding: 4px 11px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 12px; }
.dsh-skills-market .chip:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-secondary); }
.dsh-skills-market .chip[data-active="true"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-primary); }
.dsh-skills-market .cats { display: flex; gap: 2px; flex-wrap: wrap; align-items: center; }
.dsh-skills-market .cat { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 6px; }
.dsh-skills-market .cat:hover { color: var(--dsw-alias-label-primary); background: rgba(127,127,127,.12); }
.dsh-skills-market .cat[data-active="true"] { color: var(--dsw-alias-label-primary); background: rgba(127,127,127,.16); font-weight: 600; }

.dsh-skills-market .sec { display: flex; align-items: baseline; gap: 8px; margin: 4px 0 9px; }

.dsh-skills-market .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }

/* An inventory is a list, not a shelf of cards. These records are uniform and
   short, so aligned columns scan far better than boxes that are mostly empty
   space with a badge floating away from the title. */
.dsh-skills-market .rows { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.dsh-skills-market .srow { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 10px 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-skills-market .srow:first-child { border-top: 0; }
.dsh-skills-market .srow:hover { background: rgba(127,127,127,.07); }
.dsh-skills-market .srow .who { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dsh-skills-market .srow .nm { display: flex; align-items: center; gap: 8px; font-weight: 600; min-width: 0; }
.dsh-skills-market .srow .ttl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-skills-market .srow .facts { display: flex; gap: 9px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.dsh-skills-market .srow .where { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-skills-market .srow .acts { display: flex; gap: 4px; }
@media (max-width: 720px) {
  .dsh-skills-market .srow { grid-template-columns: minmax(0, 1fr); gap: 7px; }
}

.dsh-skills-market .card { position: relative; display: flex; flex-direction: column; padding: 13px 15px 0 18px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.dsh-skills-market .card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--hue, var(--dsw-alias-border-l1)); }
.dsh-skills-market .kicker { font-size: 11px; color: var(--dsw-alias-label-secondary); letter-spacing: .02em; }
/* The title and the abstract each reserve their full clamp height. Without it a
   one-line title pulls its author up while the card beside it pushes its own
   down, and every row reads as ragged even though the boxes line up. */
.dsh-skills-market .name { margin: 3px 0 0; font-size: 14px; font-weight: 600; line-height: 1.35; min-height: 38px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.dsh-skills-market .by { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 3px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsh-skills-market .text { margin-top: 9px; font-size: 12.5px; line-height: 1.55; min-height: 58px; color: var(--dsw-alias-label-secondary); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
.dsh-skills-market .tags { display: flex; gap: 5px; margin-top: 10px; max-height: 19px; overflow: hidden; }
.dsh-skills-market .tag { font-size: 11px; padding: 1px 7px; border-radius: 5px; background: rgba(127,127,127,.13); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-skills-market .foot { margin: auto -15px 0 -18px; padding: 10px 15px 10px 18px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; align-items: center; gap: 6px; }
.dsh-skills-market .foot .src { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dsh-skills-market .on { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 500; color: var(--dsw-alias-state-success-primary, #22c55e); }

.dsh-skills-market .roots { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.dsh-skills-market .root { display: flex; align-items: baseline; gap: 9px; padding: 9px 14px; border-top: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.dsh-skills-market .root:first-child { border-top: 0; }
.dsh-skills-market .root .muted { font-size: 11.5px; }
.dsh-skills-market .targets { display: flex; gap: 6px; flex-wrap: wrap; }
.dsh-skills-market .target { display: inline-flex; align-items: center; gap: 7px; padding: 5px 11px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; cursor: pointer; font-size: 12.5px; }
.dsh-skills-market .target[data-active="true"] { border-color: var(--dsw-alias-label-primary); }
.dsh-skills-market .target input { width: auto; margin: 0; }

.dsh-skills-market .panel { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.dsh-skills-market .alert { border-radius: 9px; padding: 10px 12px; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; word-break: break-word; }
.dsh-skills-market .note { border-radius: 9px; padding: 8px 12px; border: 1px solid var(--dsw-alias-state-warning-primary, var(--dsw-alias-border-l1)); color: var(--dsw-alias-label-secondary); }

.dsh-skills-market .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; padding: 24px; z-index: 60; }
.dsh-skills-market .modal { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; max-width: 880px; width: 100%; max-height: 84vh; display: flex; flex-direction: column; gap: 10px; padding: 16px; }
.dsh-skills-market .modal pre { margin: 0; overflow: auto; flex: 1 1 auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-primary); }
.dsh-skills-market .toasts { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 10px; z-index: 70; max-width: 380px; }
.dsh-skills-market .toast { border: 1px solid var(--dsw-alias-border-l1); border-left: 3px solid var(--dsw-alias-state-success-primary, #22c55e); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); padding: 11px 13px; display: flex; flex-direction: column; gap: 5px; box-shadow: 0 8px 26px rgba(0,0,0,.28); }
.dsh-skills-market .toast[data-kind="error"] { border-left-color: var(--dsw-alias-state-error-primary); }
.dsh-skills-market .toast .t { font-weight: 600; }
.dsh-skills-market .toast .b { color: var(--dsw-alias-label-secondary); line-height: 1.5; }

@media (prefers-reduced-motion: no-preference) {
  .dsh-skills-market button, .dsh-skills-market .chip, .dsh-skills-market .cat { transition: background-color .12s ease, border-color .12s ease, color .12s ease; }
}
`

    /** Mount the stylesheet once and remove it with the page. */
    function useStyles() {
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const element = document.createElement('style')
        element.dataset.dshSkillsMarket = 'true'
        element.textContent = CSS
        document.head.appendChild(element)
        return () => {
          if (element.parentNode !== null) element.parentNode.removeChild(element)
        }
      }, [])
    }

    /**
     * The card shown for one catalog entry.
     *
     * The spine is set per card from the shelf, so the colour is information
     * rather than decoration. Everything below it is deliberately quiet: the
     * title is the entry point, the abstract is clamped to three lines so a
     * grid row keeps a single height, and the tags are capped at three so the
     * tag set never becomes the loudest thing on the card.
     */
    function Card(props) {
      const { card, t, busy, onInstall, onOpen } = props
      const installed = card.installed !== undefined
      const disabled = busy || card.installable !== true || installed
      const facts = []
      if (card.author !== undefined) facts.push(card.author)
      if (Number.isFinite(card.stars) && card.stars > 0) facts.push(`★ ${card.stars}`)
      if (Number.isFinite(card.installs) && card.installs > 0) facts.push(`${card.installs} ${t('installs')}`)
      const tags = Array.isArray(card.tags) ? card.tags : []
      const shown = tags.slice(0, 3)

      return h(
        'article',
        { className: 'card', style: { '--hue': hueFor(card.category) } },
        h('div', { className: 'kicker' }, card.category ?? ''),
        h('div', { className: 'name' }, card.title ?? card.name),
        facts.length > 0 ? h('div', { className: 'by' }, facts.map((fact, index) => h('span', { key: index }, fact))) : null,
        card.description !== undefined ? h('div', { className: 'text' }, card.description) : null,
        shown.length > 0
          ? h(
              'div',
              { className: 'tags' },
              shown.map((tag) => h('span', { className: 'tag', key: tag }, tag)),
              tags.length > shown.length ? h('span', { className: 'tag' }, `+${tags.length - shown.length}`) : null,
            )
          : null,
        h(
          'div',
          { className: 'foot' },
          installed
            ? h('span', { className: 'on' }, '✓', t('installed'))
            : h(
                'button',
                {
                  className: 'primary',
                  disabled,
                  onClick: () => onInstall(card),
                  title: card.installable === true ? undefined : t('notInstallable'),
                },
                busy ? t('installing') : t('install'),
              ),
          card.url !== undefined ? h('button', { className: 'ghost', onClick: () => onOpen(card.url), title: t('open') }, '↗') : null,
          h('span', { className: 'src' }, card.sourceLabel ?? card.source ?? ''),
        ),
      )
    }

    /** The full-page market. */
    function MarketPage(props) {
      const { t } = props
      useStyles()

      const [tab, setTab] = React.useState('installed')
      const [state, setState] = React.useState(null)
      const [catalog, setCatalog] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [source, setSource] = React.useState('all')
      const [category, setCategory] = React.useState('all')
      const [target, setTarget] = React.useState(null)
      const [viewer, setViewer] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [toasts, setToasts] = React.useState([])

      /** Show a toast; the install reminder stays long enough to be read. */
      const pushToast = React.useCallback((toast) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        setToasts((current) => [...current, { id, kind: 'ok', duration: 7000, ...toast }])
        if (typeof window !== 'undefined') {
          window.setTimeout(() => {
            setToasts((current) => current.filter((entry) => entry.id !== id))
          }, toast.duration ?? 7000)
        }
      }, [])

      /** Re-read the installed inventory. */
      const loadState = React.useCallback(async () => {
        const data = await getJson('/state')
        setState(data)
        setTarget((current) => current ?? data.defaultTarget)
        return data
      }, [])

      /** Re-read the catalog for the current query and source filter. */
      const loadCatalog = React.useCallback(async (searchText, sourceId) => {
        const params = new URLSearchParams()
        if (searchText !== '') params.set('q', searchText)
        if (sourceId !== 'all' && sourceId !== 'curated') params.set('source', sourceId)
        if (sourceId === 'curated') params.set('source', '')
        const data = await getJson(`/catalog?${params.toString()}`)
        setCatalog(data)
        return data
      }, [])

      React.useEffect(() => {
        let cancelled = false
        loadState().catch((failure) => {
          if (!cancelled) setError(failure.message)
        })
        return () => {
          cancelled = true
        }
      }, [loadState])

      // Debounce the search so typing does not fire a request per keystroke.
      React.useEffect(() => {
        let cancelled = false
        const timer = window.setTimeout(() => {
          loadCatalog(query, source).catch((failure) => {
            if (!cancelled) setError(failure.message)
          })
        }, 320)
        return () => {
          cancelled = true
          window.clearTimeout(timer)
        }
      }, [query, source, loadCatalog])

      const install = React.useCallback(
        async (card) => {
          if (target === null) return
          setBusy(card.id)
          setError('')
          try {
            const result = await postJson('/install', { source: card.install, targetRootId: target })
            pushToast({
              title: `${t('toastTitle')}: ${result.name}`,
              body: `${t('toastReminder')}\n${result.path}`,
              duration: 14000,
            })
            await Promise.all([loadState(), loadCatalog(query, source)])
          } catch (failure) {
            setError(failure.message)
            pushToast({ kind: 'error', title: t('error'), body: failure.message })
          } finally {
            setBusy('')
          }
        },
        [target, pushToast, t, loadState, loadCatalog, query, source],
      )

      const remove = React.useCallback(
        async (skill) => {
          if (typeof window !== 'undefined' && !window.confirm(`${t('confirmRemove')}\n\n${skill.path}`)) return
          setError('')
          try {
            await postJson('/remove', { rootId: skill.rootId, name: skill.name, flat: skill.flat })
            pushToast({ title: t('removeTitle'), body: `${skill.title} — ${t('removeBody')}` })
            await Promise.all([loadState(), loadCatalog(query, source)])
          } catch (failure) {
            setError(failure.message)
            pushToast({ kind: 'error', title: t('error'), body: failure.message })
          }
        },
        [t, pushToast, loadState, loadCatalog, query, source],
      )

      const view = React.useCallback(
        async (skill) => {
          setError('')
          try {
            const data = await getJson(`/skill?root=${encodeURIComponent(skill.rootId)}&name=${encodeURIComponent(skill.name)}&flat=${skill.flat === true}`)
            setViewer({ title: skill.title, ...data })
          } catch (failure) {
            setError(failure.message)
          }
        },
        [],
      )

      if (state === null) {
        return h('div', { className: 'dsh-skills-market' }, h('p', { className: 'sub' }, error === '' ? t('loading') : error))
      }

      const installableRoots = state.roots.filter((root) => root.installable === true)
      const curated = catalog?.curated ?? []
      const live = catalog?.live ?? []
      const categories = Array.from(new Set(curated.map((card) => card.category).filter((value) => typeof value === 'string'))).sort()
      const curatedShown = category === 'all' ? curated : curated.filter((card) => card.category === category)
      const showCurated = source === 'all' || source === 'curated'

      return h(
        'div',
        { className: 'dsh-skills-market' },
        h(
          'div',
          { className: 'inner' },
          h(
            'div',
            null,
            h('h2', null, t('title')),
            h('p', { className: 'sub' }, t('subtitle')),
          ),

        h(
          'div',
          { className: 'tabs' },
          h(
            'button',
            { className: 'tab', 'data-active': String(tab === 'installed'), onClick: () => setTab('installed') },
            t('tabInstalled'),
            h('span', { className: 'count' }, `${state.total}`),
          ),
          h('button', { className: 'tab', 'data-active': String(tab === 'catalog'), onClick: () => setTab('catalog') }, t('tabCatalog')),
        ),

        error !== '' ? h('div', { className: 'alert' }, error) : null,

        tab === 'installed'
          ? h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'panel' },
                h('h3', null, t('roots')),
                h(
                  'div',
                  { className: 'roots' },
                  state.roots.map((root) =>
                    h(
                      'div',
                      { className: 'root', key: root.id },
                      h('strong', null, root.label),
                      root.exists !== true ? h('span', { className: 'tag' }, t('missing')) : h('span', { className: 'tag' }, `${root.count}`),
                      h('code', null, root.dir),
                      h('span', { className: 'muted' }, root.note),
                    ),
                  ),
                ),
                h('h3', null, t('target')),
                h(
                  'div',
                  { className: 'targets' },
                  installableRoots.map((root) =>
                    h(
                      'label',
                      { className: 'target', key: root.id, 'data-active': String(target === root.id) },
                      h('input', { type: 'radio', name: 'dsh-skills-market-target', checked: target === root.id, onChange: () => setTarget(root.id) }),
                      h('span', null, root.label),
                      h('code', null, root.dir),
                    ),
                  ),
                ),
                h('div', { className: 'muted' }, t('targetHint')),
              ),

              state.skills.length === 0
                ? h('div', { className: 'panel' }, h('div', null, t('emptyInstalled')), h('div', { className: 'muted' }, t('emptyInstalledHint')))
                : h(
                    'div',
                    { className: 'rows' },
                    state.skills.map((skill) =>
                      h(
                        'div',
                        { className: 'srow', key: skill.id },
                        h(
                          'div',
                          { className: 'who' },
                          h('div', { className: 'nm' }, h('span', { className: 'ttl' }, skill.title), h('span', { className: 'tag' }, skill.rootLabel)),
                          h(
                            'div',
                            { className: 'facts' },
                            h('span', null, fileCountLabel(skill.fileCount, t)),
                            h('span', null, formatSize(skill.size)),
                            h('span', { className: 'where', title: skill.path }, skill.relative),
                            skill.author !== undefined ? h('span', null, skill.author) : null,
                          ),
                        ),
                        h(
                          'div',
                          { className: 'acts' },
                          h('button', { className: 'ghost', onClick: () => view(skill) }, t('view')),
                          h('button', { className: 'ghost danger', onClick: () => remove(skill) }, t('remove')),
                        ),
                      ),
                    ),
                  ),
            )
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'bar' },
                h(
                  'div',
                  { className: 'row' },
                  h('div', { className: 'grow', style: { minWidth: '220px' } }, h('input', { value: query, placeholder: t('search'), onChange: (event) => setQuery(event.target.value) })),
                  h(
                    'div',
                    { className: 'chips' },
                    h('button', { className: 'chip', 'data-active': String(source === 'all'), onClick: () => setSource('all') }, t('allSources')),
                    (state.sources ?? []).map((entry) =>
                      h(
                        'button',
                        { className: 'chip', key: entry.id, 'data-active': String(source === entry.id), onClick: () => setSource(entry.id), title: entry.description },
                        entry.label,
                      ),
                    ),
                  ),
                ),
                categories.length > 0 && showCurated
                  ? h(
                      'div',
                      { className: 'cats' },
                      h('button', { className: 'cat', 'data-active': String(category === 'all'), onClick: () => setCategory('all') }, t('allCategories')),
                      categories.map((entry) => h('button', { className: 'cat', key: entry, 'data-active': String(category === entry), onClick: () => setCategory(entry) }, entry)),
                    )
                  : null,
                catalog?.curatedNote !== undefined ? h('div', { className: 'note' }, catalog.curatedNote) : null,
                (catalog?.sources ?? [])
                  .filter((entry) => entry.degraded === true && entry.note !== undefined)
                  .map((entry) => h('div', { className: 'note', key: entry.source }, `${entry.source}: ${entry.note}`)),
              ),

              showCurated && curatedShown.length > 0
                ? h(
                    'div',
                    null,
                    h('div', { className: 'sec' }, h('h3', null, t('secCurated')), h('span', { className: 'count' }, `${curatedShown.length}`)),
                    h('div', { className: 'grid' }, curatedShown.map((card) => h(Card, { key: card.id, card, t, busy: busy === card.id, onInstall: install, onOpen: (url) => window.open(url, '_blank', 'noopener') }))),
                  )
                : null,

              live.length > 0
                ? h(
                    'div',
                    null,
                    h('div', { className: 'sec' }, h('h3', null, t('secLive')), h('span', { className: 'count' }, `${live.length}`)),
                    h('div', { className: 'grid' }, live.map((card) => h(Card, { key: card.id, card, t, busy: busy === card.id, onInstall: install, onOpen: (url) => window.open(url, '_blank', 'noopener') }))),
                  )
                : null,

              (showCurated ? curatedShown.length : 0) + live.length === 0
                ? h('div', { className: 'panel' }, h('div', null, query === '' ? t('emptyCatalog') : `${t('emptyCatalog')} — «${query}»`))
                : null,
            ),

        viewer !== null
          ? h(
              'div',
              { className: 'overlay', onClick: (event) => { if (event.target === event.currentTarget) setViewer(null) } },
              h(
                'div',
                { className: 'modal' },
                h('div', { className: 'row' }, h('h3', { className: 'grow' }, viewer.title), h('button', { onClick: () => setViewer(null) }, t('close'))),
                h('div', { className: 'muted' }, h('code', null, viewer.path)),
                h('div', { className: 'by' }, `${t('fileCount')}: ${(viewer.files ?? []).map((file) => file.name).join(', ')}`),
                h('pre', null, viewer.markdown),
              ),
            )
          : null,

        toasts.length > 0
          ? h(
              'div',
              { className: 'toasts' },
              toasts.map((toast) =>
                h(
                  'div',
                  { className: 'toast', key: toast.id, 'data-kind': toast.kind },
                  h('div', { className: 't' }, toast.title),
                  h('div', { className: 'b' }, toast.body),
                ),
              ),
            )
          : null,
        ),
      )
    }

    /** The sidebar glyph: a small shop awning over a shelf. */
    function MarketIcon(props) {
      const size = props?.size ?? 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M3 9.5 4.6 4.8A1 1 0 0 1 5.6 4h12.8a1 1 0 0 1 1 .8L21 9.5' }),
        h('path', { d: 'M3 9.5a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0' }),
        h('path', { d: 'M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7' }),
        h('path', { d: 'M9.5 20v-4.5h5V20' }),
      )
    }

    return {
      /**
       * Services the two registrations need: the slot registry, the locale
       * service, and the layout service whose panel list the sidebar page joins.
       */
      inject: ['slots', 'locale'],

      /**
       * Contribute the market to the sidebar and to Settings.
       * @param ctx - the browser plugin context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, STRINGS), 'skills-market: dictionaries')
        const t = ctx.locale.bind(NS)

        // The page itself, addressed by the sidebar row's id. Registered first so
        // the panel exists by the time the sidebar resolves its metadata.
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              inject: () => ({ t }),
            },
            (ownerProps) => h(MarketPage, { ...(ownerProps ?? {}), t }),
          )
        })

        // The sidebar row, immediately after Plugins (which registers order 0).
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 1,
              label: () => t('nav'),
              locale: NS,
            },
            MarketIcon,
          ),
        )

        // The Settings section, one slot under MCP Hub (which registers order 45).
        ctx.slots.inject('settings.section', () => {
          const off = ctx.slots.register(
            {
              name: 'settings.section',
              id: PANEL_ID,
              order: 46,
              label: () => t('nav'),
              locale: NS,
              inject: () => ({ t }),
            },
            (ownerProps) => h(MarketPage, { ...(ownerProps ?? {}), t }),
          )
          return typeof off === 'function' ? off : () => {}
        })
      },
    }
  },
})
