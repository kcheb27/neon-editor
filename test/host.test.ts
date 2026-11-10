import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as Y from 'yjs'
import { BufferStore } from '../src/host/buffers.ts'
import type { Sub } from '../src/host/buffers.ts'
import { CwdParser } from '../src/host/cwdParser.ts'
import { parsePorcelainV2 } from '../src/host/gitParse.ts'
import { decodeText, diffRange, encodeText } from '../src/host/textUtil.ts'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A fake window: a Yjs replica wired to the store the same way the real renderer is. */
class FakeWindow implements Sub {
  doc = new Y.Doc()
  dirty = false
  store: BufferStore
  path: string
  constructor(store: BufferStore, path: string) {
    this.store = store
    this.path = path
    this.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'remote') store.update(this, path, u)
    })
  }
  send(method: string, args: any): void {
    if (method === 'buf.update') Y.applyUpdate(this.doc, args.update, 'remote')
    if (method === 'buf.dirty') this.dirty = args.dirty
  }
  async open(): Promise<void> {
    const r = await this.store.open(this, this.path)
    Y.applyUpdate(this.doc, r.state, 'remote')
    this.dirty = r.dirty
  }
  get text(): Y.Text {
    return this.doc.getText('body')
  }
}

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'neon-test-'))
  const file = join(dir, 'a.txt')
  writeFileSync(file, content)
  return file
}

test('text: CRLF and BOM survive a decode/encode round trip', () => {
  const original = '\ufeffone\r\ntwo\r\nthree'
  const d = decodeText(Buffer.from(original, 'utf8'))
  assert.equal(d.text, 'one\ntwo\nthree')
  assert.equal(d.eol, '\r\n')
  assert.equal(d.bom, true)
  assert.equal(encodeText(d.text, d.eol, d.bom), original)
})

test('text: diffRange finds the smallest replacement', () => {
  assert.deepEqual(diffRange('hello world', 'hello brave world'), { start: 6, deleteCount: 0, insert: 'brave ' })
  assert.deepEqual(diffRange('abc', 'abc'), { start: 3, deleteCount: 0, insert: '' })
  assert.deepEqual(diffRange('aXb', 'ab'), { start: 1, deleteCount: 1, insert: '' })
})

test('buffers: an edit in one window appears in the other', async () => {
  const file = tempFile('hello\n')
  const store = new BufferStore()
  const a = new FakeWindow(store, file)
  const b = new FakeWindow(store, file)
  await a.open()
  await b.open()
  assert.equal(b.text.toString(), 'hello\n')

  a.text.insert(5, ' world')
  assert.equal(b.text.toString(), 'hello world\n')
  b.text.insert(0, '> ')
  assert.equal(a.text.toString(), '> hello world\n')
  assert.equal(a.dirty, true)
  assert.equal(b.dirty, true)
})

test('buffers: undo from any window undoes the latest shared edit', async () => {
  const file = tempFile('base')
  const store = new BufferStore()
  const a = new FakeWindow(store, file)
  const b = new FakeWindow(store, file)
  await a.open()
  await b.open()

  a.text.insert(4, ' A')
  await wait(450) // past the undo grouping window
  b.text.insert(6, ' B')
  assert.equal(a.text.toString(), 'base A B')

  store.undo(file) // requested by window A, undoes B's edit
  assert.equal(a.text.toString(), 'base A')
  assert.equal(b.text.toString(), 'base A')
  store.undo(file)
  assert.equal(b.text.toString(), 'base')
  store.redo(file)
  assert.equal(a.text.toString(), 'base A')
})

test('buffers: save writes original line endings and clears dirty; undo to saved text is clean', async () => {
  const file = tempFile('one\r\ntwo\r\n')
  const store = new BufferStore()
  const a = new FakeWindow(store, file)
  await a.open()
  assert.equal(a.text.toString(), 'one\ntwo\n')

  a.text.insert(a.text.length, 'three\n')
  assert.equal(a.dirty, true)
  await store.save(file)
  assert.equal(readFileSync(file, 'utf8'), 'one\r\ntwo\r\nthree\r\n')
  assert.equal(a.dirty, false)

  a.text.insert(0, 'x')
  assert.equal(a.dirty, true)
  store.undo(file)
  await wait(200)
  assert.equal(a.dirty, false)
})

test('buffers: unsaved text survives the last window closing, and a clean buffer follows the disk', async () => {
  const file = tempFile('v1')
  const store = new BufferStore()
  const a = new FakeWindow(store, file)
  await a.open()
  a.text.insert(2, ' edited')
  store.close(a, file)
  assert.deepEqual(store.dirtyPaths(), [file])

  const b = new FakeWindow(store, file)
  await b.open()
  assert.equal(b.text.toString(), 'v1 edited')
  assert.equal(b.dirty, true)

  // unsaved buffers ignore disk changes
  writeFileSync(file, 'from disk')
  await store.diskChanged(file)
  assert.equal(b.text.toString(), 'v1 edited')

  await store.save(file)
  writeFileSync(file, 'v1 edited, then changed outside')
  await store.diskChanged(file)
  assert.equal(b.text.toString(), 'v1 edited, then changed outside')
  await wait(200)
  assert.equal(b.dirty, false)
})

test('cwd: reads the PowerShell report, including escaped characters', () => {
  const p = new CwdParser(true)
  const r = p.feed('\x1b]633;P;Cwd=c:\\\\Users\\\\me\\\\a\\x3bb\x07PS C:\\Users\\me> ')
  assert.deepEqual(r, { path: 'C:\\Users\\me\\a;b', host: '' })
})

test('cwd: reads OSC 7 file URLs with a host and encoded spaces', () => {
  const unix = new CwdParser(false)
  assert.deepEqual(unix.feed('\x1b]7;file://devbox/home/dev/my%20proj\x1b\\$ '), { path: '/home/dev/my proj', host: 'devbox' })
  const win = new CwdParser(true)
  assert.deepEqual(win.feed('\x1b]7;file://PC/C:/code/app\x07'), { path: 'C:\\code\\app', host: 'PC' })
})

test('cwd: a report split across chunks is still found, and the last one wins', () => {
  const p = new CwdParser(false)
  assert.equal(p.feed('output\x1b]7;file://h/ho'), null)
  assert.deepEqual(p.feed('me/a\x07$ '), { path: '/home/a', host: 'h' })
  assert.deepEqual(p.feed('\x1b]7;file://h/x\x07\x1b]7;file://h/y\x07'), { path: '/y', host: 'h' })
  assert.equal(p.feed('plain text, \x1b[31mcolors\x1b[0m'), null)
})

test('git: parses branch, ahead/behind and each kind of entry', () => {
  const out = [
    '# branch.oid abc',
    '# branch.head main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/a file.ts',
    '1 A. N... 000000 100644 100644 aaa bbb src/new.ts',
    '1 .D N... 100644 100644 000000 aaa bbb gone.ts',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
    'old name.ts',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc both.ts',
    '? untracked dir/',
    '! node_modules/',
    ''
  ].join('\0')
  const s = parsePorcelainV2(out)
  assert.equal(s.branch, 'main')
  assert.equal(s.ahead, 2)
  assert.equal(s.behind, 1)
  assert.deepEqual(s.entries, [
    { path: 'src/a file.ts', code: 'M' },
    { path: 'src/new.ts', code: 'A' },
    { path: 'gone.ts', code: 'D' },
    { path: 'new name.ts', code: 'R' },
    { path: 'both.ts', code: 'C' },
    { path: 'untracked dir', code: 'U' },
    { path: 'node_modules', code: '!' }
  ])
})
