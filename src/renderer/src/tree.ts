// File tree. The same component draws the main Explorer and each terminal's mini tree;
// they differ only in their root and in who changes it.

import type { DirEntry, GitStatus } from '../../shared/protocol'
import type { Host } from './rpc'
import { neon } from './rpc'
import { ask, errorMessage, showMenu, toast } from './ui'
import { basename, dirname, fileBadge, GIT_COLORS, h, icon, isInside, join, pathKey } from './util'

export interface TreeContext {
  host: Host
  workspaceRoot: string
  /** Name of the SSH host for remote workspaces; empty for local ones. */
  remoteHost?: string
  getGit(): GitStatus | null
  openFile(path: string): void
  /** Optional extra context-menu entries, e.g. "Open in Terminal". */
  extraMenu?(path: string, isDir: boolean): { label: string; run: () => void }[]
}

interface GitView {
  files: Map<string, string>
  changedDirs: Set<string>
  ignored: Set<string>
}

const MAX_ROWS = 5000

export class FileTree {
  readonly el: HTMLElement
  private ctx: TreeContext
  private root = ''
  private expanded = new Map<string, string>() // key -> path
  private children = new Map<string, DirEntry[]>() // key -> entries
  private loading = new Map<string, Promise<void>>()
  private selected: string | null = null
  private watched = new Map<string, string>() // out-of-workspace folders we asked the host to watch
  private gitView: GitView | null = null
  private gitSource: GitStatus | null = null
  private renderQueued = false
  private emptyText: string

  constructor(ctx: TreeContext, emptyText = 'This folder is empty') {
    this.ctx = ctx
    this.emptyText = emptyText
    this.el = h('div', { class: 'tree', role: 'tree', tabindex: '-1' })
    this.el.addEventListener('contextmenu', (e) => {
      if (e.target === this.el && this.root) {
        e.preventDefault()
        this.menu(e, this.root, true)
      }
    })
  }

  getRoot(): string {
    return this.root
  }

  getExpanded(): string[] {
    return [...this.expanded.values()].filter((p) => p !== this.root)
  }

  /** Point the tree at a new folder. Folders expanded under it before stay expanded. */
  async setRoot(root: string, expand: string[] = []): Promise<void> {
    if (this.root && pathKey(this.root) === pathKey(root)) return
    this.root = root
    // Drop expanded folders that are no longer under the root.
    for (const [key, p] of [...this.expanded]) {
      if (!isInside(root, p)) {
        this.expanded.delete(key)
        this.unwatch(p)
      }
    }
    this.expanded.set(pathKey(root), root)
    for (const p of expand) if (isInside(root, p)) this.expanded.set(pathKey(p), p)
    await Promise.all([...this.expanded.values()].map((p) => this.load(p)))
    this.render()
  }

  private watch(dir: string): void {
    const key = pathKey(dir)
    if (isInside(this.ctx.workspaceRoot, dir) || this.watched.has(key)) return
    this.watched.set(key, dir)
    this.ctx.host.notify('watch.acquire', { dir })
  }

  private unwatch(dir: string): void {
    const key = pathKey(dir)
    if (!this.watched.delete(key)) return
    this.ctx.host.notify('watch.release', { dir })
  }

  dispose(): void {
    for (const p of [...this.watched.values()]) this.unwatch(p)
    this.el.remove()
  }

  private load(dir: string): Promise<void> {
    const key = pathKey(dir)
    let pending = this.loading.get(key)
    if (pending) return pending
    pending = this.ctx.host
      .call<DirEntry[]>('fs.readdir', { path: dir })
      .then((entries) => {
        this.children.set(key, entries)
        this.watch(dir)
      })
      .catch(() => {
        // Gone or unreadable: show it as empty and stop watching.
        this.children.set(key, [])
      })
      .finally(() => this.loading.delete(key))
    this.loading.set(key, pending)
    return pending
  }

  /** The host reports these folders changed on disk. */
  async refresh(dirs: string[]): Promise<void> {
    const reloads: Promise<void>[] = []
    for (const dir of dirs) {
      const key = pathKey(dir)
      if (this.children.has(key)) {
        this.children.delete(key)
        if (this.expanded.has(key)) reloads.push(this.load(dir))
      }
    }
    if (reloads.length) {
      await Promise.all(reloads)
      this.render()
    }
  }

  async reveal(path: string): Promise<void> {
    if (!this.root || !isInside(this.root, path)) return
    const chain: string[] = []
    for (let d = dirname(path); isInside(this.root, d) && pathKey(d) !== pathKey(this.root); d = dirname(d)) chain.unshift(d)
    for (const d of chain) {
      this.expanded.set(pathKey(d), d)
      await this.load(d)
    }
    this.selected = path
    this.render()
    this.el.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' })
  }

  setGit(status: GitStatus | null): void {
    this.gitSource = status
    this.gitView = null
    this.scheduleRender()
  }

  private git(): GitView | null {
    const status = this.gitSource ?? this.ctx.getGit()
    if (!status?.repo) return null
    if (!this.gitView) {
      const files = new Map<string, string>()
      const changedDirs = new Set<string>()
      const ignored = new Set<string>()
      for (const [p, code] of Object.entries(status.files)) {
        const key = pathKey(p)
        if (code === '!') {
          ignored.add(key)
          continue
        }
        files.set(key, code)
        for (let d = dirname(p), i = 0; i < 64; d = dirname(d), i++) {
          const dk = pathKey(d)
          if (changedDirs.has(dk) || dk === pathKey(dirname(d))) break
          changedDirs.add(dk)
        }
      }
      this.gitView = { files, changedDirs, ignored }
    }
    return this.gitView
  }

  private isIgnored(view: GitView, path: string): boolean {
    for (let p = path, i = 0; i < 64; p = dirname(p), i++) {
      const key = pathKey(p)
      if (view.ignored.has(key)) return true
      if (key === pathKey(dirname(p))) break
    }
    return false
  }

  private scheduleRender(): void {
    if (this.renderQueued) return
    this.renderQueued = true
    requestAnimationFrame(() => {
      this.renderQueued = false
      this.render()
    })
  }

  render(): void {
    const scroll = this.el.scrollTop
    const git = this.git()
    const rows: HTMLElement[] = []
    const walk = (dir: string, depth: number): void => {
      const entries = this.children.get(pathKey(dir))
      if (!entries) return
      for (const entry of entries) {
        if (rows.length >= MAX_ROWS) return
        const p = join(dir, entry.name)
        const key = pathKey(p)
        const isDir = entry.kind === 'dir'
        const open = isDir && this.expanded.has(key)
        let code = ''
        let ignored = false
        if (git) {
          ignored = this.isIgnored(git, p)
          code = git.files.get(key) ?? ''
          if (!code && isDir && git.changedDirs.has(key)) code = '•'
        }
        const color = code && code !== '•' ? GIT_COLORS[code] : code === '•' ? GIT_COLORS.M : ''
        const [badgeText, badgeColor] = isDir ? ['', ''] : fileBadge(entry.name)
        const row = h(
          'button',
          {
            class: `row${open ? ' open' : ''}${this.selected && pathKey(this.selected) === key ? ' sel' : ''}${ignored ? ' ignored' : ''}`,
            role: 'treeitem',
            'aria-expanded': isDir ? String(open) : undefined,
            title: p,
            style: `padding-left:${8 + depth * 14}px`
          },
          h('span', { class: 'chev' }, isDir ? icon('chevron', 12, 2.5) : null),
          h('span', { class: 'badge', style: `color:${badgeColor}`, text: badgeText }),
          h('span', { class: 'name', text: entry.name, style: color && !ignored ? `color:${color}` : '' }),
          h('span', { class: 'git', text: code === '•' ? '' : code, style: color ? `color:${color}` : '' })
        )
        row.addEventListener('click', () => void this.activate(p, isDir))
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          this.selected = p
          this.render()
          this.menu(e, p, isDir)
        })
        rows.push(row)
        if (open) walk(p, depth + 1)
      }
    }
    if (this.root) walk(this.root, 0)
    if (this.root && rows.length === 0 && this.children.has(pathKey(this.root))) {
      rows.push(h('div', { class: 'empty', text: this.emptyText }))
    }
    this.el.replaceChildren(...rows)
    this.el.scrollTop = scroll
  }

  private async activate(p: string, isDir: boolean): Promise<void> {
    this.selected = p
    if (!isDir) {
      this.render()
      this.ctx.openFile(p)
      return
    }
    const key = pathKey(p)
    if (this.expanded.has(key)) {
      this.expanded.delete(key)
      this.unwatch(p)
    } else {
      this.expanded.set(key, p)
      await this.load(p)
    }
    this.render()
  }

  private menu(e: MouseEvent, p: string, isDir: boolean): void {
    const dir = isDir ? p : dirname(p)
    const isRoot = pathKey(p) === pathKey(this.root)
    showMenu(e.clientX, e.clientY, [
      { label: 'New File…', run: () => void this.create(dir, 'file') },
      { label: 'New Folder…', run: () => void this.create(dir, 'dir') },
      'separator',
      ...(this.ctx.extraMenu?.(p, isDir) ?? []),
      { label: 'Copy Path', run: () => void navigator.clipboard.writeText(p) },
      ...(this.ctx.remoteHost ? [] : [{ label: 'Reveal in File Explorer', run: () => void neon.invoke('shell:reveal', p) }]),
      ...(isRoot
        ? []
        : ([
            'separator',
            { label: 'Rename…', run: () => void this.rename(p) },
            { label: 'Delete', run: () => void this.remove(p) }
          ] as const))
    ])
  }

  private async create(dir: string, kind: 'file' | 'dir'): Promise<void> {
    const name = await ask(kind === 'file' ? `New file in ${basename(dir)}` : `New folder in ${basename(dir)}`)
    if (!name) return
    const target = join(dir, name.replace(/[\\/]+$/, ''))
    try {
      await this.ctx.host.call('fs.create', { path: target, kind })
      this.expanded.set(pathKey(dir), dir)
      await this.refresh([dir, dirname(target)])
      await this.reveal(target)
      if (kind === 'file') this.ctx.openFile(target)
    } catch (err) {
      toast(`Could not create ${name}: ${errorMessage(err)}`, 'error')
    }
  }

  private async rename(p: string): Promise<void> {
    const name = await ask(`Rename ${basename(p)}`, basename(p), true)
    if (!name || name === basename(p)) return
    const target = join(dirname(p), name)
    try {
      await this.ctx.host.call('fs.rename', { from: p, to: target })
      await this.refresh([dirname(p)])
      this.selected = target
      this.render()
    } catch (err) {
      toast(`Could not rename: ${errorMessage(err)}`, 'error')
    }
  }

  private async remove(p: string): Promise<void> {
    const remote = this.ctx.remoteHost
    const choice = await neon.invoke('dialog:confirm', {
      message: `Delete "${basename(p)}"?`,
      detail: remote
        ? `It will be moved to ~/.local/share/Trash/files on ${remote}.`
        : 'It will be moved to the Recycle Bin / Trash.',
      buttons: ['Move to Trash', 'Cancel']
    })
    if (choice !== 0) return
    try {
      if (remote) await this.ctx.host.call('fs.trash', { path: p })
      else await neon.invoke('shell:trash', p)
      await this.refresh([dirname(p)])
    } catch (err) {
      toast(`Could not delete: ${errorMessage(err)}`, 'error')
    }
  }
}
