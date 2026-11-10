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

export class EditorArea {
  readonly el: HTMLElement
  readonly editor: monaco.editor.IStandaloneCodeEditor
  private host: Host
  private root: string
  private files = new Map<string, OpenFile>() // key -> file
  private order: string[] = [] // paths, in tab order
  private active: string | null = null
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
    editorHost.append(this.emptyEl)
    this.el = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' }, this.tabsEl, this.crumbsEl, editorHost)
    this.editor = createEditor(editorHost)

    // Undo and redo go to the shared undo stack in the Workspace Host, so they undo the
    // latest edit to this file no matter which window made it.
    const undo = (): void => {
      if (this.active) this.host.notify('buf.undo', { path: this.active })
    }
    const redo = (): void => {
      if (this.active) this.host.notify('buf.redo', { path: this.active })
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

  get activePath(): string | null {
    return this.active
  }

  get paths(): string[] {
    return [...this.order]
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
        const at = this.active ? this.order.findIndex((p) => samePath(p, this.active!)) + 1 : this.order.length
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
    if (this.active && !samePath(this.active, file.path)) {
      const prev = this.files.get(pathKey(this.active))
      if (prev) prev.view = this.editor.saveViewState()
    }
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
    const index = this.order.findIndex((p) => samePath(p, path))
    this.order.splice(index, 1)
    this.files.delete(key)
    this.host.notify('buf.close', { path, discard })
    file.binding.destroy()
    file.doc.destroy()
    if (this.active && samePath(this.active, path)) {
      this.active = null
      const next = this.order[Math.min(index, this.order.length - 1)]
      if (next) this.show(this.files.get(pathKey(next))!)
      else this.editor.setModel(null)
    }
    file.model.dispose()
    this.render()
    this.onChange()
    return true
  }

  async save(path = this.active ?? ''): Promise<boolean> {
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
    const i = this.order.findIndex((p) => samePath(p, this.active!))
    const next = this.order[(i + step + this.order.length) % this.order.length]
    void this.open(next)
  }

  private render(): void {
    this.tabsEl.replaceChildren(
      ...this.order.map((p) => {
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

    if (this.active) {
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
