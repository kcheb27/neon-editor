// Plugin screens: each one is an HTML page from a plugin folder, shown in a sandboxed iframe
// (scripts allowed, but a unique origin: no access to this window, its storage or Node).
// The page calls window.neon.* (src/main/pluginApi.ts), which arrives here as postMessage.
// Everything a plugin can do is in `methods` below.

import type { PluginInfo, PluginScreen, WorkspaceInfo } from '../../shared/protocol'
import { palette } from './monacoSetup'
import { neon, type Host } from './rpc'
import { ask, errorMessage, modal, toast } from './ui'
import { h } from './util'

export interface PluginBridgeContext {
  host: Host
  info: WorkspaceInfo
  openFile(path: string, line?: number, col?: number): void
  activeFile(): string | null
  /** Opens a terminal (on `target`, see BottomPanel.newTerminal) and types `command` into it. */
  runInTerminal(command: string, target: string): Promise<void>
  /** Opens one of the plugin's own screens, in the sidebar or as an editor tab. */
  openScreen(pluginId: string, screenId: string, location?: 'sidebar' | 'editor'): void
  /** The workbench's commands, for commands.run / commands.list. */
  commands(): { id: string; label: string; run(): void }[]
}

const THEME = {
  bg: palette.bgChrome,
  'bg-raised': palette.bgRaised,
  'bg-input': palette.bgRaised,
  fg: palette.fg,
  muted: palette.muted,
  accent: palette.accent,
  border: '#2a3350',
  error: palette.error,
  warning: palette.warning,
  success: palette.string,
  font: "Inter, 'Segoe UI', system-ui, sans-serif",
  mono: "'JetBrains Mono', Consolas, monospace"
}

const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)

export class PluginScreenView {
  readonly el: HTMLElement
  readonly plugin: PluginInfo
  readonly screen: PluginScreen
  private frame: HTMLIFrameElement
  private ctx: PluginBridgeContext
  private onMessage: (e: MessageEvent) => void
  private visible = false

  constructor(plugin: PluginInfo, screen: PluginScreen, ctx: PluginBridgeContext) {
    this.plugin = plugin
    this.screen = screen
    this.ctx = ctx
    this.frame = h('iframe', {
      class: 'plugin-frame',
      title: `${screen.title} (${plugin.name})`,
      // No allow-same-origin: the page gets an opaque origin and cannot reach this window.
      sandbox: 'allow-scripts allow-forms allow-downloads'
    }) as HTMLIFrameElement
    this.frame.addEventListener('load', () => this.post({ type: 'init', theme: THEME, workspace: this.workspace() }))
    this.frame.src = `neon-plugin://${plugin.id}/${screen.entry}`
    this.el = this.frame

    this.onMessage = (e) => {
      if (e.source !== this.frame.contentWindow) return // only this screen's own page
      const m = e.data
      if (!m || m.neon !== 1 || m.type !== 'call' || typeof m.method !== 'string') return
      void this.handle(m.id, m.method, Array.isArray(m.args) ? m.args : [])
    }
    window.addEventListener('message', this.onMessage)
  }

  private workspace() {
    const { root, label, remote, sshHost, sep, platform } = this.ctx.info
    return { root, label, remote, sshHost, sep, platform }
  }

  private post(msg: Record<string, unknown>): void {
    this.frame.contentWindow?.postMessage({ neon: 1, ...msg }, '*')
  }

  /** Sends an event to the page (see neon.on in the API). */
  emit(event: string, data?: unknown): void {
    this.post({ type: 'event', event, data })
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return
    this.visible = on
    this.emit(on ? 'show' : 'hide')
  }

  private abs(p: unknown): string {
    if (typeof p !== 'string' || !p) throw new Error('A path is required')
    if (isAbsolute(p)) return p
    const { root, sep } = this.ctx.info
    return root.replace(/[\\/]+$/, '') + sep + p.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep)
  }

  private async handle(id: number, method: string, args: any[]): Promise<void> {
    const fn = this.methods[method]
    try {
      if (!fn) throw new Error(`Unknown plugin API method: ${method}`)
      const value = await fn(...args)
      this.post({ type: 'result', id, ok: true, value: value === undefined ? null : value })
    } catch (err) {
      this.post({ type: 'result', id, ok: false, error: errorMessage(err) })
    }
  }

  private methods: Record<string, (...args: any[]) => unknown> = {
    'fs.readdir': (p) => this.ctx.host.call('fs.readdir', { path: p ? this.abs(p) : this.ctx.info.root }),
    'fs.list': () => this.ctx.host.call('fs.list'),
    'fs.readText': (p) => this.ctx.host.call('fs.readText', { path: this.abs(p) }),
    'fs.writeText': (p, text) => this.ctx.host.call('fs.writeText', { path: this.abs(p), text: String(text ?? '') }),
    search: (query, opts) =>
      this.ctx.host.call('search.run', { query: String(query ?? ''), regex: !!opts?.regex, caseSensitive: !!opts?.caseSensitive }),
    'git.status': () => this.ctx.host.call('git.status'),
    'editor.open': (p, line, col) => this.ctx.openFile(this.abs(p), typeof line === 'number' ? line : undefined, typeof col === 'number' ? col : undefined),
    'editor.activeFile': () => this.ctx.activeFile(),
    'terminal.run': (command, opts) => this.ctx.runInTerminal(String(command ?? ''), typeof opts?.target === 'string' ? opts.target : ''),
    'ui.toast': (message, kind) => toast(`${this.plugin.name}: ${String(message ?? '')}`, kind === 'error' ? 'error' : 'info'),
    'ui.ask': (prompt, value) => ask(`${this.plugin.name}: ${String(prompt ?? '')}`, typeof value === 'string' ? value : ''),
    'ui.confirm': async (message, buttons) => {
      const labels = Array.isArray(buttons) && buttons.length ? buttons.map(String) : ['OK', 'Cancel']
      const r = await modal({ title: this.plugin.name, message: String(message ?? ''), buttons: labels })
      return labels[r.button] ?? null
    },
    'screens.open': (screenId, opts) => {
      const s = this.plugin.screens.find((x) => x.id === screenId)
      if (!s) throw new Error(`${this.plugin.name} has no screen "${String(screenId)}"`)
      const location = opts?.location === 'editor' || opts?.location === 'sidebar' ? opts.location : undefined
      this.ctx.openScreen(this.plugin.id, s.id, location)
    },
    'commands.list': () => this.ctx.commands().map(({ id, label }) => ({ id, label })),
    'commands.run': (cmdId) => {
      const cmd = this.ctx.commands().find((c) => c.id === cmdId)
      if (!cmd) throw new Error(`No command ${String(cmdId)}`)
      cmd.run()
    },
    'storage.get': (key) => neon.invoke('plugins:storageGet', this.plugin.id, String(key)),
    'storage.set': (key, value) => neon.invoke('plugins:storageSet', this.plugin.id, String(key), value)
  }

  dispose(): void {
    window.removeEventListener('message', this.onMessage)
    this.frame.remove()
  }
}
