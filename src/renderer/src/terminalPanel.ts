// Bottom panel: terminals (each with a file tree that follows its working directory) and Problems.

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { GitStatus, TermCreated } from '../../shared/protocol'
import { monaco, palette } from './monacoSetup'
import { neon, type Host } from './rpc'
import { FileTree } from './tree'
import { errorMessage, showMenu, toast } from './ui'
import { basename, dirname, h, icon, pathKey, relative, tildify } from './util'

interface TermView {
  id: number
  shell: string
  term: Terminal
  fit: FitAddon
  el: HTMLElement
  tree: FileTree
  /** Directory the shell last reported. */
  cwd: string
  /** Hostname from the shell's report, when it differs from this machine. */
  remoteHost: string
  following: boolean
  exited: boolean
  /** A shell on this machine in an SSH workspace. Its files are not the workspace's, so it has no tree. */
  local: boolean
}

const XTERM_THEME = {
  background: palette.bgChrome,
  foreground: palette.fg,
  cursor: palette.fg,
  cursorAccent: palette.bgChrome,
  selectionBackground: palette.selection,
  black: '#1C1F2B', brightBlack: '#5F6886',
  red: '#FF5370', brightRed: '#FF6E6E',
  green: '#A6F25C', brightGreen: '#C3F78C',
  yellow: '#FFC857', brightYellow: '#FFD866',
  blue: '#59C2FF', brightBlue: '#82D2FF',
  magenta: '#FF5FA2', brightMagenta: '#F8A5FF',
  cyan: '#4FD6FF', brightCyan: '#7EE7C7',
  white: '#C6CEE6', brightWhite: '#FFFFFF'
}

export interface PanelContext {
  host: Host
  root: string
  home: string
  /** This workspace's machine name, as its shells report it. */
  hostname: string
  /** SSH host alias for remote workspaces; empty for local ones. */
  sshHost: string
  getGit(): GitStatus | null
  openFile(path: string, line?: number, col?: number): void
  revealInExplorer(path: string): void
  onLayoutChange(): void
}

export class BottomPanel {
  readonly el: HTMLElement
  private ctx: PanelContext
  private terms: TermView[] = []
  private active: TermView | null = null
  private tab: 'terminal' | 'problems' = 'terminal'
  private showTree = true
  private barEl: HTMLElement
  private termArea: HTMLElement
  private miniEl: HTMLElement
  private miniHead: HTMLElement
  private miniStatus: HTMLElement
  private miniTreeSlot: HTMLElement
  private problemsEl: HTMLElement
  private bodyEl: HTMLElement
  private hostName = ''

  constructor(ctx: PanelContext) {
    this.ctx = ctx
    this.hostName = ctx.hostname
    this.barEl = h('div', { class: 'panel-bar' })
    this.miniHead = h('div', { class: 'mini-head' })
    this.miniStatus = h('div', { class: 'mini-status' })
    this.miniTreeSlot = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' })
    this.miniEl = h('div', { class: 'mini', 'aria-label': 'Terminal file tree' }, this.miniHead, this.miniStatus, this.miniTreeSlot)
    this.termArea = h('div', { class: 'term-area' })
    this.problemsEl = h('div', { class: 'problems' })
    this.bodyEl = h('div', { class: 'panel-body' }, this.miniEl, this.termArea, this.problemsEl)
    this.el = h('div', { class: 'panel' }, this.barEl, this.bodyEl)

    ctx.host.on('term.data', ({ id, data }: { id: number; data: string }) => this.find(id)?.term.write(data))
    ctx.host.on('term.cwd', ({ id, cwd, host }: { id: number; cwd: string; host: string }) => this.cwdChanged(id, cwd, host))
    ctx.host.on('term.exit', ({ id, exitCode }: { id: number; exitCode: number }) => {
      const tv = this.find(id)
      if (!tv) return
      tv.exited = true
      tv.term.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`)
      this.render()
    })
    ctx.host.on('fs.changed', ({ dirs }: { dirs: string[] }) => {
      for (const tv of this.terms) void tv.tree.refresh(dirs)
    })
    monaco.editor.onDidChangeMarkers(() => {
      if (this.tab === 'problems') this.renderProblems()
      this.render()
    })

    new ResizeObserver(() => this.fitActive()).observe(this.termArea)
    this.render()
  }

  get treeVisible(): boolean {
    return this.showTree
  }

  set treeVisible(on: boolean) {
    this.showTree = on
    this.render()
  }

  get hasTerminals(): boolean {
    return this.terms.length > 0
  }

  private find(id: number): TermView | undefined {
    return this.terms.find((t) => t.id === id)
  }

  gitChanged(status: GitStatus): void {
    for (const tv of this.terms) tv.tree.setGit(status)
  }

  focus(): void {
    if (this.tab === 'terminal') this.active?.term.focus()
  }

  showProblems(): void {
    this.tab = 'problems'
    this.renderProblems()
    this.render()
  }

  showTerminal(): void {
    this.tab = 'terminal'
    this.render()
    if (!this.terms.length) void this.newTerminal()
    else requestAnimationFrame(() => this.focus())
  }

  /** Opens a shell. In an SSH workspace, `local` opens it on this machine instead of the SSH host. */
  async newTerminal(cwd?: string, local = false): Promise<void> {
    if (!this.ctx.sshHost) local = false
    this.tab = 'terminal'
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: false,
      scrollback: 5000,
      theme: XTERM_THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const el = h('div', { class: 'term-view' })
    this.termArea.append(el)
    el.classList.add('on')
    term.open(el)
    try {
      fit.fit()
    } catch {
      // not laid out yet
    }

    let created: TermCreated
    try {
      created = await this.ctx.host.call<TermCreated>('term.create', { cwd: local ? '' : (cwd ?? this.ctx.root), cols: term.cols, rows: term.rows, local })
    } catch (err) {
      el.remove()
      term.dispose()
      toast(`Could not start a terminal: ${errorMessage(err)}`, 'error')
      return
    }

    const tree = new FileTree(
      {
        host: this.ctx.host,
        workspaceRoot: this.ctx.root,
        remoteHost: this.ctx.sshHost,
        getGit: this.ctx.getGit,
        openFile: (p) => this.ctx.openFile(p),
        extraMenu: (p) => [{ label: 'Reveal in Explorer', run: () => this.ctx.revealInExplorer(p) }]
      },
      'Empty folder'
    )
    const tv: TermView = {
      id: created.id,
      shell: created.shell,
      term,
      fit,
      el,
      tree,
      cwd: created.cwd,
      remoteHost: '',
      following: true,
      exited: false,
      local: !!created.local
    }
    this.terms.push(tv)
    term.onData((data) => {
      if (!tv.exited) this.ctx.host.notify('term.input', { id: tv.id, data })
    })
    term.onResize(({ cols, rows }) => this.ctx.host.notify('term.resize', { id: tv.id, cols, rows }))
    // Let the app's own shortcuts through instead of sending them to the shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const k = e.key.toLowerCase()
      if (e.ctrlKey && e.shiftKey && ['p', 'f', 'e', 'g', 'n', '`', '~'].includes(k)) return false
      if (e.ctrlKey && !e.shiftKey && ['p', 'b', 'j', '`', 'tab'].includes(k)) return false
      // Copy: Ctrl+C with a selection (otherwise it is SIGINT), or Ctrl+Shift+C.
      if (e.ctrlKey && k === 'c' && (term.hasSelection() || e.shiftKey)) {
        e.preventDefault()
        copySelection()
        return false
      }
      // Paste: Ctrl+V, Ctrl+Shift+V or Shift+Insert.
      if ((e.ctrlKey && k === 'v') || (e.shiftKey && k === 'insert')) {
        e.preventDefault()
        paste()
        return false
      }
      return true
    })
    const copySelection = (): void => {
      if (!term.hasSelection()) return
      void neon.invoke('clipboard:write', term.getSelection()).catch((err) => toast(`Copy failed: ${errorMessage(err)}`, 'error'))
      term.clearSelection()
    }
    const paste = (): void => {
      void neon
        .invoke('clipboard:read')
        .then((text) => {
          if (typeof text === 'string' && text) term.paste(text)
        })
        .catch((err) => toast(`Paste failed: ${errorMessage(err)}`, 'error'))
    }
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const hadSelection = term.hasSelection()
      showMenu(e.clientX, e.clientY, [
        ...(hadSelection ? [{ label: 'Copy', run: copySelection }] : []),
        { label: 'Paste', run: () => { paste(); term.focus() } }
      ])
    })
    if (!tv.local) void tree.setRoot(created.cwd)
    this.select(tv)
  }

  private select(tv: TermView): void {
    this.active = tv
    this.tab = 'terminal'
    for (const t of this.terms) t.el.classList.toggle('on', t === tv)
    this.miniTreeSlot.replaceChildren(tv.tree.el)
    this.render()
    requestAnimationFrame(() => {
      this.fitActive()
      tv.term.focus()
    })
  }

  kill(tv: TermView): void {
    this.ctx.host.notify('term.kill', { id: tv.id })
    tv.term.dispose()
    tv.tree.dispose()
    tv.el.remove()
    const i = this.terms.indexOf(tv)
    this.terms.splice(i, 1)
    if (this.active === tv) {
      this.active = null
      const next = this.terms[Math.min(i, this.terms.length - 1)]
      if (next) this.select(next)
      else this.miniTreeSlot.replaceChildren()
    }
    this.render()
  }

  private cwdChanged(id: number, cwd: string, reportedHost: string): void {
    const tv = this.find(id)
    if (!tv) return
    tv.cwd = cwd
    if (tv.local) {
      if (tv === this.active) this.render()
      return
    }
    // A different hostname means the shell is now on another machine (e.g. `ssh` typed by hand).
    // Compare the short names: some shells report "devbox", others "devbox.example.com".
    const short = (n: string): string => n.toLowerCase().split('.')[0]
    tv.remoteHost = reportedHost && this.hostName && short(reportedHost) !== short(this.hostName) ? reportedHost : ''
    if (!this.hostName && reportedHost) this.hostName = reportedHost
    if (tv.following && !tv.remoteHost) void tv.tree.setRoot(cwd)
    if (tv === this.active) this.render()
  }

  private fitActive(): void {
    if (!this.active || this.tab !== 'terminal' || this.el.classList.contains('hidden')) return
    try {
      this.active.fit.fit()
    } catch {
      // hidden
    }
  }

  private renderMini(): void {
    const tv = this.active
    if (!tv) {
      this.miniHead.replaceChildren()
      this.miniStatus.textContent = ''
      return
    }
    if (tv.local) {
      this.miniHead.replaceChildren(
        h('span', { class: 'host-badge local', text: 'local', title: 'Shell is on this machine, not the SSH host' }),
        h('span', { class: 'mini-path', title: tv.cwd }, h('bdi', { text: tv.cwd }))
      )
      this.miniStatus.textContent = `Local shell on this machine. The workspace stays on ${this.ctx.sshHost}.`
      this.miniStatus.classList.add('paused')
      tv.tree.el.style.display = 'none'
      return
    }
    const root = tv.tree.getRoot() || tv.cwd
    const shown = tv.remoteHost ? tv.cwd : root
    const display = tildify(shown, this.ctx.home)
    const head: (HTMLElement | null)[] = [
      h('span', {
        class: `host-badge ${tv.remoteHost || this.ctx.sshHost ? 'remote' : 'local'}`,
        text: tv.remoteHost || this.ctx.sshHost || 'local',
        title: tv.remoteHost
          ? `Shell moved to ${tv.remoteHost}`
          : this.ctx.sshHost
            ? `Shell is on ${this.ctx.sshHost}`
            : 'Shell is on this machine'
      }),
      h('span', { class: 'mini-path', title: shown }, h('bdi', { text: display }))
    ]
    if (!tv.remoteHost) {
      if (tv.following) {
        const up = h('button', { class: 'icon-btn', 'aria-label': 'Browse parent folder', title: 'Browse parent folder' }, icon('up', 14, 2.2))
        up.addEventListener('click', () => {
          const parent = dirname(root)
          if (pathKey(parent) === pathKey(root)) return
          tv.following = false
          void tv.tree.setRoot(parent).then(() => this.render())
        })
        head.push(up)
      } else {
        const back = h('button', { class: 'small-btn', text: 'Back to cwd', title: tildify(tv.cwd, this.ctx.home) })
        back.addEventListener('click', () => {
          tv.following = true
          void tv.tree.setRoot(tv.cwd).then(() => this.render())
        })
        const up = h('button', { class: 'icon-btn', 'aria-label': 'Browse parent folder', title: 'Browse parent folder' }, icon('up', 14, 2.2))
        up.addEventListener('click', () => {
          const parent = dirname(root)
          if (pathKey(parent) !== pathKey(root)) void tv.tree.setRoot(parent).then(() => this.render())
        })
        head.push(up, back)
      }
    }
    this.miniHead.replaceChildren(...head.filter((x): x is HTMLElement => !!x))

    let status: string
    let paused = false
    if (tv.remoteHost) {
      status = `Shell is on ${tv.remoteHost}. Open it with "Connect to SSH Host" to browse its files.`
      paused = true
    } else if (!tv.following) {
      status = 'Browsing above cwd, not following'
      paused = true
    } else {
      const rel = relative(this.ctx.root, tv.cwd)
      status = rel === tv.cwd ? 'Following terminal cwd (outside the project)' : 'Following terminal cwd'
    }
    this.miniStatus.textContent = status
    this.miniStatus.classList.toggle('paused', paused)
    tv.tree.el.style.display = tv.remoteHost ? 'none' : ''
  }

  private renderProblems(): void {
    const markers = monaco.editor
      .getModelMarkers({})
      .filter((m) => m.severity >= monaco.MarkerSeverity.Warning)
      .sort((a, b) => b.severity - a.severity)
    if (!markers.length) {
      this.problemsEl.replaceChildren(h('div', { class: 'note', style: 'padding:6px 16px', text: 'No problems in open files.' }))
      return
    }
    this.problemsEl.replaceChildren(
      ...markers.slice(0, 500).map((m) => {
        const isError = m.severity === monaco.MarkerSeverity.Error
        const row = h(
          'button',
          { class: 'problem' },
          h('span', { style: `color:${isError ? palette.error : palette.warning}`, text: isError ? '●' : '▲' }),
          h('span', { text: m.message }),
          h('span', { class: 'muted', text: `${basename(m.resource.fsPath)} [Ln ${m.startLineNumber}, Col ${m.startColumn}]` })
        )
        row.addEventListener('click', () => this.ctx.openFile(m.resource.fsPath, m.startLineNumber, m.startColumn))
        return row
      })
    )
  }

  render(): void {
    const markers = monaco.editor.getModelMarkers({})
    const errors = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length
    const warnings = markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length

    const tabBtn = (id: 'terminal' | 'problems', label: string): HTMLElement => {
      const b = h('button', { class: `panel-tab${this.tab === id ? ' on' : ''}`, text: label })
      b.addEventListener('click', () => (id === 'terminal' ? this.showTerminal() : this.showProblems()))
      return b
    }
    const bar: (HTMLElement | null)[] = [tabBtn('terminal', 'TERMINAL'), tabBtn('problems', `PROBLEMS ${errors + warnings || ''}`.trim())]

    if (this.tab === 'terminal') {
      bar.push(h('span', { class: 'sep' }))
      for (const tv of this.terms) {
        const name = tv.local
          ? `${tv.shell} (local): ${basename(tv.cwd) || tv.cwd}`
          : tv.remoteHost
            ? `${tv.shell} @ ${tv.remoteHost}`
            : `${tv.shell}: ${basename(tv.cwd) || tv.cwd}`
        const kill = h('button', { class: 'icon-btn', 'aria-label': `Kill ${name}`, title: 'Kill terminal' }, icon('trash', 12, 2))
        kill.addEventListener('click', (e) => {
          e.stopPropagation()
          this.kill(tv)
        })
        const t = h('div', { class: `term-tab${tv === this.active ? ' on' : ''}`, title: tv.cwd }, h('span', { text: name }), kill)
        t.addEventListener('click', () => this.select(tv))
        bar.push(t)
      }
      const add = h('button', { class: 'icon-btn', 'aria-label': 'New terminal', title: 'New terminal (Ctrl+Shift+`)' }, icon('plus', 15, 2))
      add.addEventListener('click', () => void this.newTerminal())
      bar.push(add)
      if (this.ctx.sshHost) {
        // SSH workspace: also offer a shell on this machine. The workspace itself stays on SSH.
        const kind = h('button', { class: 'icon-btn', 'aria-label': 'Choose terminal type', title: 'New SSH or local terminal' }, icon('down', 12, 2.2))
        kind.addEventListener('click', () => {
          const r = kind.getBoundingClientRect()
          showMenu(r.left, r.bottom + 2, [
            { label: `New Terminal on ${this.ctx.sshHost}`, run: () => void this.newTerminal() },
            { label: 'New Local Terminal (this machine)', run: () => void this.newTerminal(undefined, true) }
          ])
        })
        bar.push(kind)
      }
    }
    bar.push(h('div', { style: 'flex:1' }))
    if (this.tab === 'terminal') {
      const toggle = h(
        'button',
        { class: `icon-btn${this.showTree ? ' on' : ''}`, 'aria-label': 'Toggle terminal file tree', 'aria-pressed': String(this.showTree), title: 'Toggle terminal file tree' },
        icon('split', 15, 2)
      )
      toggle.addEventListener('click', () => {
        this.showTree = !this.showTree
        this.render()
        this.ctx.onLayoutChange()
      })
      bar.push(toggle)
    }
    const hide = h('button', { class: 'icon-btn', 'aria-label': 'Hide panel', title: 'Hide panel (Ctrl+`)' }, icon('close', 14, 2.4))
    hide.addEventListener('click', () => {
      this.el.classList.add('hidden')
      this.ctx.onLayoutChange()
    })
    bar.push(hide)
    this.barEl.replaceChildren(...bar.filter((x): x is HTMLElement => !!x))

    const terminalTab = this.tab === 'terminal'
    this.termArea.style.display = terminalTab ? '' : 'none'
    this.problemsEl.style.display = terminalTab ? 'none' : ''
    this.miniEl.classList.toggle('hidden', !terminalTab || !this.showTree || !this.active)
    this.renderMini()
    requestAnimationFrame(() => this.fitActive())
  }

  dispose(): void {
    for (const tv of [...this.terms]) this.kill(tv)
  }
}
