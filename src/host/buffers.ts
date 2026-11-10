// Shared buffers. The Workspace Host owns one Yjs document per open file; every window that
// shows the file holds a replica and they exchange Yjs updates through the host. That is what
// makes the same file in two windows the same buffer.

import { promises as fsp } from 'node:fs'
import * as Y from 'yjs'
import { decodeText, diffRange, encodeText, isBinary } from './textUtil.ts'
import type { Eol } from './textUtil.ts'

/** One connected window, as far as buffers are concerned. */
export interface Sub {
  send(method: string, args: unknown): void
}

/** Transaction origin for edits that arrived from a window. Tracked by the shared undo stack. */
export class WinOrigin {
  sub: Sub
  constructor(sub: Sub) {
    this.sub = sub
  }
}

/** How the store reads and writes files: the local disk by default, SFTP for SSH workspaces. */
export interface BufferIO {
  size(path: string): Promise<number>
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, text: string): Promise<void>
}

export const localIO: BufferIO = {
  size: async (p) => (await fsp.stat(p)).size,
  readFile: (p) => fsp.readFile(p),
  writeFile: (p, text) => fsp.writeFile(p, text, 'utf8')
}

const MAX_BYTES = 50 * 1024 * 1024
const DIRTY_CHECK_MS = 120

interface Buf {
  path: string
  doc: Y.Doc
  text: Y.Text
  undo: Y.UndoManager
  saved: string
  eol: Eol
  bom: boolean
  dirty: boolean
  subs: Set<Sub>
  timer: ReturnType<typeof setTimeout> | null
}

export class BufferStore {
  private bufs = new Map<string, Buf>()
  private loading = new Map<string, Promise<Buf>>()
  private origins = new Map<Sub, WinOrigin>()
  private io: BufferIO

  constructor(io: BufferIO = localIO) {
    this.io = io
  }

  private originFor(sub: Sub): WinOrigin {
    let origin = this.origins.get(sub)
    if (!origin) {
      origin = new WinOrigin(sub)
      this.origins.set(sub, origin)
    }
    return origin
  }

  private async load(path: string): Promise<Buf> {
    if ((await this.io.size(path)) > MAX_BYTES) throw new Error('File is larger than 50 MB')
    const bytes = await this.io.readFile(path)
    if (isBinary(bytes)) throw new Error('Binary files cannot be opened in the editor')
    const { text, eol, bom } = decodeText(bytes)

    const doc = new Y.Doc()
    const ytext = doc.getText('body')
    doc.transact(() => ytext.insert(0, text), 'load')
    const undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([WinOrigin]), captureTimeout: 400 })
    const buf: Buf = {
      path, doc, text: ytext, undo, saved: text, eol, bom,
      dirty: false, subs: new Set(), timer: null
    }

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const from = origin instanceof WinOrigin ? origin.sub : null
      for (const sub of buf.subs) {
        if (sub !== from) sub.send('buf.update', { path, update })
      }
      if (from && !buf.dirty) this.setDirty(buf, true)
      if (buf.timer) clearTimeout(buf.timer)
      buf.timer = setTimeout(() => {
        buf.timer = null
        this.setDirty(buf, buf.text.toString() !== buf.saved)
      }, DIRTY_CHECK_MS)
    })
    return buf
  }

  private setDirty(buf: Buf, dirty: boolean): void {
    if (buf.dirty === dirty) return
    buf.dirty = dirty
    for (const sub of buf.subs) sub.send('buf.dirty', { path: buf.path, dirty })
    if (!dirty && buf.subs.size === 0) this.drop(buf)
  }

  private drop(buf: Buf): void {
    if (buf.timer) clearTimeout(buf.timer)
    buf.undo.destroy()
    buf.doc.destroy()
    this.bufs.delete(buf.path)
  }

  async open(sub: Sub, path: string): Promise<{ state: Uint8Array; dirty: boolean; eol: Eol }> {
    let buf = this.bufs.get(path)
    if (!buf) {
      let pending = this.loading.get(path)
      if (!pending) {
        pending = this.load(path).finally(() => this.loading.delete(path))
        this.loading.set(path, pending)
      }
      buf = await pending
      if (!this.bufs.has(path)) this.bufs.set(path, buf)
      buf = this.bufs.get(path)!
    }
    buf.subs.add(sub)
    return { state: Y.encodeStateAsUpdate(buf.doc), dirty: buf.dirty, eol: buf.eol }
  }

  update(sub: Sub, path: string, update: Uint8Array): void {
    const buf = this.bufs.get(path)
    if (!buf) return
    Y.applyUpdate(buf.doc, update, this.originFor(sub))
  }

  /** A window stopped showing the file. Unsaved text is kept unless `discard` is set. */
  close(sub: Sub, path: string, discard = false): void {
    const buf = this.bufs.get(path)
    if (!buf) return
    buf.subs.delete(sub)
    if (buf.subs.size === 0 && (discard || !buf.dirty)) this.drop(buf)
  }

  closeAll(sub: Sub): void {
    for (const buf of [...this.bufs.values()]) {
      if (buf.subs.has(sub)) this.close(sub, buf.path)
    }
    this.origins.delete(sub)
  }

  info(path: string): { open: boolean; dirty: boolean; windows: number } {
    const buf = this.bufs.get(path)
    return { open: !!buf, dirty: !!buf?.dirty, windows: buf?.subs.size ?? 0 }
  }

  openPaths(): string[] {
    return [...this.bufs.keys()]
  }

  dirtyPaths(): string[] {
    return [...this.bufs.values()].filter((b) => b.dirty).map((b) => b.path)
  }

  undo(path: string): void {
    this.bufs.get(path)?.undo.undo()
  }

  redo(path: string): void {
    this.bufs.get(path)?.undo.redo()
  }

  async save(path: string): Promise<void> {
    const buf = this.bufs.get(path)
    if (!buf) return
    const text = buf.text.toString()
    await this.io.writeFile(path, encodeText(text, buf.eol, buf.bom))
    buf.saved = text
    buf.undo.stopCapturing() // edits after a save are a new undo step
    this.setDirty(buf, buf.text.toString() !== buf.saved)
  }

  async saveAll(): Promise<void> {
    for (const path of this.dirtyPaths()) await this.save(path)
  }

  /** The file changed on disk. Clean buffers follow the disk; unsaved ones are left alone. */
  async diskChanged(path: string): Promise<void> {
    const buf = this.bufs.get(path)
    if (!buf || buf.dirty) return
    let bytes: Uint8Array
    try {
      bytes = await this.io.readFile(path)
    } catch {
      return // deleted or unreadable: keep what we have
    }
    if (buf.dirty || isBinary(bytes)) return
    const { text, eol, bom } = decodeText(bytes)
    const current = buf.text.toString()
    if (text === current) return
    const d = diffRange(current, text)
    buf.saved = text
    buf.eol = eol
    buf.bom = bom
    buf.doc.transact(() => {
      if (d.deleteCount) buf.text.delete(d.start, d.deleteCount)
      if (d.insert) buf.text.insert(d.start, d.insert)
    }, 'disk')
  }
}
