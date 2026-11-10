// Editor area: tabs, breadcrumbs and one Monaco editor. Each open file is a Monaco model
// bound to a Yjs replica of the Workspace Host's shared buffer.

import { MonacoBinding } from 'y-monaco'
import * as Y from 'yjs'
import type { BufferOpen } from '../../shared/protocol'
import { createEditor, monaco } from './monacoSetup'
import type { Host } from './rpc'
import { neon } from './rpc'
import { errorMessage, toast } from './ui'
import { basename, fileBadge, h, icon, pathKey, relative, samePath } from './util'

interface OpenFile {
  path: string
  doc: Y.Doc
  model: monaco.editor.ITextModel
  binding: MonacoBinding
  dirty: boolean
  eol: '\n' | '\r\n'
  view: monaco.editor.ICodeEditorViewState | null
}

function languageFor(path: string): string {
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id
    if (ext && lang.extensions?.includes(ext)) return lang.id
  }
  return 'plaintext'
}

/**
 * A tab that is not a file: a full-size page (e.g. a plugin screen) shown over the editor.
 * Its element stays in the DOM while the tab is open, so switching tabs keeps its state.
 */
export interface PageTab {
  /** Unique among page tabs. */
  id: string
  title: string
  /** Tooltip, e.g. which plugin it comes from. */
  detail?: string
  icon(): Element
  el: HTMLElement
  /** The tab became the visible one, or stopped being it. */
  onVisible?(visible: boolean): void
  /** The tab was closed; release what it holds. */
  onClose?(): void
}

// Page tabs share the tab order with file paths; this prefix cannot start a real path.
const PAGE = '\u0000page:'
const isPageKey = (k: string): boolean => k.startsWith(PAGE)

export class EditorArea {
  readonly el: HTMLElement
  readonly editor: monaco.editor.IStandaloneCodeEditor
  private host: Host
  private root: string
  private files = new Map<string, OpenFile>() // key -> file
  private order: string[] = [] // file paths and PAGE+id keys, in tab order
  private active: string | null = null // a file path or a PAGE+id key
  private pages = new Map<string, PageTab>() // PAGE+id -> page
  private pageHost: HTMLElement
  private emptyActions: HTMLElement
  private tabsEl: HTMLElement
  private crumbsEl: HTMLElement
  private emptyEl: HTMLElement
  private opening = new Map<string, Promise<OpenFile | null>>()
  /** Called whenever tabs, the active file or dirty state change. */
  onChange: () => void = () => {}

  constructor(host: Host, root: string) {
    this.host = host
    this.root = root
    this.tabsEl = h('div', { class: 'tabs', role: 'tablist' })
    this.crumbsEl = h('div', { class: 'crumbs' })
    const editorHost = h('div', { class: 'editor-host' })
    this.emptyEl = h(
      'div',
      { class: 'editor-empty' },
      h('div', { class: 'big' }, 'Neon ', h('b', { text: 'Editor' })),
      h(
        'div',
        { class: 'keys' },
        'Open a file',
        h('kbd', { text: 'Ctrl+P' }),
        'Run a command',
        h('kbd', { text: 'Ctrl+Shift+P' }),
        'Search in files',
        h('kbd', { text: 'Ctrl+Shift+F' }),
        'Toggle terminal',
        h('kbd', { text: 'Ctrl+`' }),
        'New window for this project',
        h('kbd', { text: 'Ctrl+Shift+N' })
      )
    )
    this.pageHost = h('div', { class: 'page-host' })
    this.pageHost.style.display = 'none'
    this.emptyActions = h('div', { class: 'empty-actions' })
    this.emptyEl.insertBefore(this.emptyActions, this.emptyEl.children[1] ?? null)
    editorHost.append(this.emptyEl, this.pageHost)
    this.el = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' }, this.tabsEl, this.crumbsEl, editorHost)
    this.editor = createEditor(editorHost)

    // Undo and redo go to the shared undo stack in the Workspace Host, so they undo the
    // latest edit to this file no matter which window made it.
    const undo = (): void => {
      if (this.activePath) this.host.notify('buf.undo', { path: this.activePath })
    }
    const redo = (): void => {
      if (this.activePath) this.host.notify('buf.redo', { path: this.activePath })
    }
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, undo)
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, redo)
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, redo)

    host.on('buf.update', ({ path, update }: { path: string; update: Uint8Array }) => {
      const file = this.files.get(pathKey(path))
      if (file) Y.applyUpdate(file.doc, update, 'remote')
    })
    host.on('buf.dirty', ({ path, dirty }: { path: string; dirty: boolean }) => {
      const file = this.files.get(pathKey(path))
      if (!file || file.dirty === dirty) return
      file.dirty = dirty
      this.render()
      this.onChange()
    })
    this.render()
  }

  /** Buttons shown on the empty editor screen (when no tab is open). */
  setEmptyActions(...buttons: HTMLElement[]): void {
    this.emptyActions.replaceChildren(...buttons)
  }

  /** The active file, or null when no file tab (or a page tab) is active. */
  get activePath(): string | null {
    return this.active && !isPageKey(this.active) ? this.active : null
  }

  /** Open files, in tab order. */
  get paths(): string[] {
    return this.order.filter((k) => !isPageKey(k))
  }

  /** Ids of open page tabs, in tab order. */
  get pageIds(): string[] {
    return this.order.filter(isPageKey).map((k) => k.slice(PAGE.length))
  }

  /** The active page tab's id, or null. */
  get activePageId(): string | null {
    return this.active && isPageKey(this.active) ? this.active.slice(PAGE.length) : null
  }

  hasPage(id: string): boolean {
    return this.pages.has(PAGE + id)
  }

  /** Shows a page tab, adding it after the active tab if it is not open yet. */
  openPage(page: PageTab): void {
    const key = PAGE + page.id
    if (!this.pages.has(key)) {
      this.pages.set(key, page)
      page.el.style.display = 'none'
      this.pageHost.append(page.el)
      const at = this.active ? this.order.indexOf(this.active) + 1 : this.order.length
      this.order.splice(at, 0, key)
    }
    this.showPage(key)
  }

  /** Shows an open page tab by id. Returns false if it is not open. */
  focusPage(id: string): boolean {
    if (!this.pages.has(PAGE + id)) return false
    this.showPage(PAGE + id)
    return true
  }

  private showPage(key: string): void {
    const page = this.pages.get(key)!
    if (this.active === key) return
    this.leaveActive()
    this.active = key
    for (const [k, p] of this.pages) p.el.style.display = k === key ? '' : 'none'
    this.pageHost.style.display = ''
    page.onVisible?.(true)
    this.render()
    this.onChange()
  }

  /** Before switching tabs: remember the file's scroll/cursor, or hide the page. */
  private leaveActive(): void {
    if (!this.active) return
    if (isPageKey(this.active)) {
      const page = this.pages.get(this.active)
      if (page) {
        page.el.style.display = 'none'
        page.onVisible?.(false)
      }
      this.pageHost.style.display = 'none'
    } else {
      const prev = this.files.get(pathKey(this.active))
      if (prev) prev.view = this.editor.saveViewState()
    }
  }

  closePage(id: string): void {
    const key = PAGE + id
    const page = this.pages.get(key)
    if (!page) return
    const index = this.order.indexOf(key)
    const wasActive = this.active === key
    if (wasActive) this.leaveActive()
    this.order.splice(index, 1)
    this.pages.delete(key)
    page.el.remove()
    page.onClose?.()
    if (wasActive) {
      this.active = null
      const next = this.order[Math.min(index, this.order.length - 1)]
      if (next) this.activate(next)
      else this.editor.setModel(null)
    }
    this.render()
    this.onChange()
  }

  /** Switches to a tab by its order key (file path or page key). */
  private activate(key: string): void {
    if (isPageKey(key)) this.showPage(key)
    else {
      const file = this.files.get(pathKey(key))
      if (file) this.show(file)
    }
  }

  isDirty(path: string): boolean {
    return !!this.files.get(pathKey(path))?.dirty
  }

  eolOf(path: string): string {
    return this.files.get(pathKey(path))?.eol === '\r\n' ? 'CRLF' : 'LF'
  }

  private async load(path: string): Promise<OpenFile | null> {
    try {
      const res = await this.host.call<BufferOpen>('buf.open', { path })
      const doc = new Y.Doc()
      Y.applyUpdate(doc, res.state, 'remote')
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== 'remote') this.host.notify('buf.update', { path, update })
      })
      const uri = monaco.Uri.file(path)
      monaco.editor.getModel(uri)?.dispose()
      const model = monaco.editor.createModel('', languageFor(path), uri)
      model.setEOL(monaco.editor.EndOfLineSequence.LF)
      const binding = new MonacoBinding(doc.getText('body'), model, new Set([this.editor]))
      return { path, doc, model, binding, dirty: res.dirty, eol: res.eol, view: null }
    } catch (err) {
      toast(`Could not open ${basename(path)}: ${errorMessage(err)}`, 'error')
      return null
    }
  }

  async open(path: string, line?: number, col = 1): Promise<void> {
    const key = pathKey(path)
    let file = this.files.get(key)
    if (!file) {
      let pending = this.opening.get(key)
      if (!pending) {
        pending = this.load(path).finally(() => this.opening.delete(key))
        this.opening.set(key, pending)
      }
      const loaded = await pending
      if (!loaded) return
      file = this.files.get(key)
      if (!file) {
        file = loaded
        this.files.set(key, file)
        const at = this.active ? this.order.indexOf(this.active) + 1 : this.order.length
        this.order.splice(at, 0, path)
      }
    }
    this.show(file)
    if (line) {
      const pos = { lineNumber: line, column: col }
      this.editor.setPosition(pos)
      this.editor.revealPositionInCenter(pos)
    }
    this.editor.focus()
  }

  private show(file: OpenFile): void {
    if (this.active && (isPageKey(this.active) || !samePath(this.active, file.path))) this.leaveActive()
    this.active = file.path
    this.editor.setModel(file.model)
    if (file.view) this.editor.restoreViewState(file.view)
    this.render()
    this.onChange()
  }

  async close(path: string): Promise<boolean> {
    const key = pathKey(path)
    const file = this.files.get(key)
    if (!file) return true
    let discard = false
    if (file.dirty) {
      // Another window still showing the file keeps the unsaved text alive: nothing to ask.
      const info = await this.host.call<{ windows: number }>('buf.info', { path })
      if (info.windows <= 1) {
        const choice = await neon.invoke('dialog:confirm', {
          message: `Save changes to ${basename(path)}?`,
          detail: "Your changes will be lost if you don't save them.",
          buttons: ['Save', "Don't Save", 'Cancel']
        })
        if (choice === 2) return false
        if (choice === 0) {
          if (!(await this.save(path))) return false
        } else discard = true
      }
    }
    const index = this.order.findIndex((p) => !isPageKey(p) && samePath(p, path))
    this.order.splice(index, 1)
    this.files.delete(key)
    this.host.notify('buf.close', { path, discard })
    file.binding.destroy()
    file.doc.destroy()
    if (this.activePath && samePath(this.activePath, path)) {
      this.active = null
      this.editor.setModel(null)
      const next = this.order[Math.min(index, this.order.length - 1)]
      if (next) this.activate(next)
    }
    file.model.dispose()
    this.render()
    this.onChange()
    return true
  }

  async save(path = this.activePath ?? ''): Promise<boolean> {
    if (!path) return false
    try {
      await this.host.call('buf.save', { path })
      return true
    } catch (err) {
      toast(`Could not save ${basename(path)}: ${errorMessage(err)}`, 'error')
      return false
    }
  }

  async saveAll(): Promise<void> {
    try {
      await this.host.call('buf.saveAll')
    } catch (err) {
      toast(`Could not save: ${errorMessage(err)}`, 'error')
    }
  }

  cycle(step: number): void {
    if (this.order.length < 2 || !this.active) return
    const i = this.order.indexOf(this.active)
    this.activate(this.order[(i + step + this.order.length) % this.order.length])
  }

  private pageTabEl(key: string): HTMLElement {
    const page = this.pages.get(key)!
    const on = this.active === key
    const close = h(
      'button',
      { class: 'close', 'aria-label': `Close ${page.title}`, title: 'Close (Ctrl+W)' },
      h('span', { class: 'x', style: 'display:flex' }, icon('close', 12, 2.4))
    )
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      this.closePage(page.id)
    })
    const tab = h(
      'div',
      { class: `tab page${on ? ' on' : ''}`, role: 'tab', 'aria-selected': String(on), title: page.detail ?? page.title },
      h('span', { class: 'page-icon' }, page.icon()),
      h('span', { text: page.title }),
      close
    )
    tab.addEventListener('click', () => this.showPage(key))
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) this.closePage(page.id)
    })
    return tab
  }

  private render(): void {
    this.tabsEl.replaceChildren(
      ...this.order.map((p) => {
        if (isPageKey(p)) return this.pageTabEl(p)
        const file = this.files.get(pathKey(p))!
        const on = !!this.active && samePath(p, this.active)
        const [badge, color] = fileBadge(basename(p))
        const close = h(
          'button',
          { class: 'close', 'aria-label': `Close ${basename(p)}`, title: 'Close (Ctrl+W)' },
          h('span', { class: 'dot' }),
          h('span', { class: 'x', style: 'display:flex' }, icon('close', 12, 2.4))
        )
        close.addEventListener('click', (e) => {
          e.stopPropagation()
          void this.close(p)
        })
        const tab = h(
          'div',
          { class: `tab${on ? ' on' : ''}${file.dirty ? ' dirty' : ''}`, role: 'tab', 'aria-selected': String(on), title: p },
          h('span', { class: 'badge', style: `color:${color}`, text: badge }),
          h('span', { text: basename(p) }),
          close
        )
        tab.addEventListener('click', () => void this.open(p))
        tab.addEventListener('auxclick', (e) => {
          if (e.button === 1) void this.close(p)
        })
        return tab
      })
    )
    this.tabsEl.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })

    const page = this.active && isPageKey(this.active) ? this.pages.get(this.active) : null
    if (page) {
      this.crumbsEl.style.display = 'none'
      this.emptyEl.style.display = 'none'
    } else if (this.active) {
      const rel = relative(this.root, this.active)
      const parts = rel.split(/[\\/]/).filter(Boolean)
      const crumbs: (HTMLElement | string)[] = []
      parts.forEach((part, i) => {
        if (i > 0) crumbs.push(h('span', { class: 'muted', text: '›' }))
        crumbs.push(h('span', { text: part }))
      })
      this.crumbsEl.replaceChildren(...crumbs)
      this.crumbsEl.style.display = ''
      this.emptyEl.style.display = 'none'
    } else {
      this.crumbsEl.style.display = 'none'
      this.emptyEl.style.display = ''
    }
  }
}
