// The script a plugin screen loads with <script src="_neon/api.js"></script>. It defines
// window.neon, which forwards each call to the editor window over postMessage. The window side
// (src/renderer/src/plugins.ts) decides what each call may do. Documented in docs/PLUGINS.md.

export const PLUGIN_API_JS = String.raw`(() => {
  'use strict'
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()
  let info = null
  const ready = new Promise((resolve) => {
    window.addEventListener('message', (e) => {
      if (e.source !== window.parent) return
      const m = e.data
      if (!m || m.neon !== 1) return
      if (m.type === 'init') {
        info = m.workspace
        applyTheme(m.theme)
        resolve()
      } else if (m.type === 'result') {
        const p = pending.get(m.id)
        if (!p) return
        pending.delete(m.id)
        if (m.ok) p.resolve(m.value)
        else p.reject(new Error(m.error))
      } else if (m.type === 'event') {
        for (const fn of listeners.get(m.event) || []) {
          try { fn(m.data) } catch (err) { console.error(err) }
        }
      }
    })
  })

  function applyTheme(theme) {
    const root = document.documentElement
    for (const [k, v] of Object.entries(theme || {})) root.style.setProperty('--neon-' + k, v)
    // Base look that matches the editor. :where() keeps it easy for the plugin to override.
    const style = document.createElement('style')
    style.textContent = ':where(html){color-scheme:dark}' +
      ':where(body){margin:0;padding:8px 12px;background:var(--neon-bg);color:var(--neon-fg);font:13px/1.45 var(--neon-font)}' +
      ':where(button){font:inherit;color:var(--neon-fg);background:var(--neon-bg-raised);border:1px solid var(--neon-border);border-radius:4px;padding:3px 10px;cursor:pointer}' +
      ':where(button:hover){border-color:var(--neon-accent)}' +
      ':where(input,textarea,select){font:inherit;color:var(--neon-fg);background:var(--neon-bg-input);border:1px solid var(--neon-border);border-radius:4px;padding:3px 6px}' +
      ':where(a){color:var(--neon-accent)}' +
      ':where(code,pre){font-family:var(--neon-mono)}'
    document.head.prepend(style)
  }

  function call(method, ...args) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      window.parent.postMessage({ neon: 1, type: 'call', id, method, args }, '*')
    })
  }

  window.neon = Object.freeze({
    apiVersion: 1,
    /** Resolves once the editor has sent the theme and workspace details. */
    ready,
    /** { root, label, remote, sshHost, sep, platform } */
    workspace: () => ready.then(() => info),
    fs: Object.freeze({
      readdir: (path) => call('fs.readdir', path),
      list: () => call('fs.list'),
      readText: (path) => call('fs.readText', path),
      writeText: (path, text) => call('fs.writeText', path, text)
    }),
    search: (query, opts) => call('search', query, opts || {}),
    git: Object.freeze({ status: () => call('git.status') }),
    editor: Object.freeze({
      open: (path, line, col) => call('editor.open', path, line, col),
      activeFile: () => call('editor.activeFile')
    }),
    terminal: Object.freeze({ run: (command, opts) => call('terminal.run', command, opts || {}) }),
    ui: Object.freeze({
      toast: (message, kind) => call('ui.toast', message, kind),
      ask: (prompt, value) => call('ui.ask', prompt, value),
      confirm: (message, buttons) => call('ui.confirm', message, buttons)
    }),
    commands: Object.freeze({ run: (id) => call('commands.run', id), list: () => call('commands.list') }),
    /** Open one of this plugin's screens: { location: 'sidebar' | 'editor' } (default: the screen's own). */
    screens: Object.freeze({ open: (id, opts) => call('screens.open', id, opts || {}) }),
    storage: Object.freeze({
      get: (key) => call('storage.get', key),
      set: (key, value) => call('storage.set', key, value)
    }),
    /** Events: 'show', 'hide', 'files-changed' ({ dirs }), 'git-changed', 'active-file' ({ path }). */
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event).delete(fn)
    }
  })
})()
`
