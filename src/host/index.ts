// Workspace Host: one utility process per project. It owns everything the project's windows
// share (buffers, the file watcher, git state, terminals and, for SSH projects, the
// connection) and talks to each window over its own MessagePort.

import type { MessagePortMain } from 'electron'
import * as os from 'node:os'
import type { GitStatus, RemoteStatus, WireMessage } from '../shared/protocol'
import { isRemoteId, makeRemoteId, parseRemoteId } from '../shared/workspaceId'
import type { Backend } from './backend.ts'
import { BufferStore } from './buffers.ts'
import { Git } from './git.ts'
import { LocalBackend, spawnLocalShell } from './localBackend.ts'
import { RemoteBackend } from './remoteBackend.ts'
import type { Prompter, PromptRequest } from './ssh/connection.ts'
import { Terminals } from './terminals.ts'
import { decodeText } from './textUtil.ts'

const workspaceId = process.argv[2] ?? process.cwd()

class Conn {
  port: MessagePortMain
  constructor(port: MessagePortMain) {
    this.port = port
  }
  send(method: string, args: unknown): void {
    const msg: WireMessage = { t: 'evt', m: method, a: args }
    try {
      this.port.postMessage(msg)
    } catch {
      // the window is gone; its 'close' handler cleans up
    }
  }
}

const conns = new Set<Conn>()
const broadcast = (method: string, args: unknown): void => {
  for (const c of conns) c.send(method, args)
}

// ---------- prompts (passwords, passphrases, host keys) go to a window ----------

let nextPromptId = 1
const prompts = new Map<number, { conn: Conn; resolve: (v: string | null) => void }>()
const waitingForWindow: (() => void)[] = []
let remoteStatus: RemoteStatus | null = null

const prompter: Prompter = {
  async ask(req: PromptRequest): Promise<string | null> {
    // Prompts can come before any window is attached: wait for one.
    if (conns.size === 0) await new Promise<void>((resolve) => waitingForWindow.push(resolve))
    const conn = [...conns][conns.size - 1] // the most recently attached window
    const id = nextPromptId++
    return new Promise((resolve) => {
      prompts.set(id, { conn, resolve })
      conn.send('auth.prompt', { id, ...req })
    })
  },
  status(s: RemoteStatus): void {
    remoteStatus = s
    broadcast('remote.state', s)
  }
}

// ---------- services ----------

const backend: Backend = isRemoteId(workspaceId) ? new RemoteBackend(workspaceId, prompter) : new LocalBackend(workspaceId)
const buffers = new BufferStore({
  size: async (p) => (await backend.stat(p)).size,
  readFile: (p) => backend.readFile(p),
  writeFile: (p, text) => backend.writeFile(p, text)
})
let workspaceRoot = ''
const git = new Git((args) => backend.git(args), backend.path, () => workspaceRoot)
const terminals = new Terminals('', (cwd, cols, rows) => backend.spawnShell(cwd, cols, rows), !backend.remote && process.platform === 'win32')
backend.setOpenFiles(() => buffers.openPaths())

let gitTimer: ReturnType<typeof setTimeout> | null = null
let lastGit: GitStatus | null = null
function refreshGit(delay = 300): void {
  if (gitTimer) clearTimeout(gitTimer)
  gitTimer = setTimeout(async () => {
    gitTimer = null
    lastGit = await git.status()
    broadcast('git.changed', lastGit)
  }, delay)
}

let started = false
async function ready(): Promise<void> {
  const info = await backend.info()
  workspaceRoot = info.root
  if (!started) {
    started = true
    terminals.setDefaultCwd(info.root)
    backend.startWatching({
      dirsChanged: (dirs) => broadcast('fs.changed', { dirs }),
      filesChanged: (changed) => {
        for (const f of changed) void buffers.diskChanged(f)
      },
      gitChanged: () => refreshGit()
    })
  }
}

type Handler = (conn: Conn, a: any) => unknown

const handlers: Record<string, Handler> = {
  'ws.info': async () => {
    await ready()
    return backend.info()
  },
  'remote.retry': () => {
    if (backend instanceof RemoteBackend) backend.retry()
  },
  'auth.answer': (_c, a) => {
    const pending = prompts.get(a.id)
    prompts.delete(a.id)
    pending?.resolve(typeof a.value === 'string' ? a.value : null)
  },

  // `target` (optional) names another machine, for the file tree of a terminal running there.
  'fs.readdir': (_c, a) => fsFor(a.target).readdir(a.path),
  'fs.create': (_c, a) => fsFor(a.target).create(a.path, a.kind),
  'fs.rename': (_c, a) => fsFor(a.target).rename(a.from, a.to),
  'fs.trash': (_c, a) => fsFor(a.target).trash(a.path),
  'fs.stat': (_c, a) => fsFor(a.target).stat(a.path),
  'fs.list': () => backend.list(),
  // Plain text access for plugins. Files open in an editor are reloaded by the file watcher.
  'fs.readText': async (_c, a) => decodeText(await backend.readFile(a.path)).text,
  'fs.writeText': async (_c, a) => {
    await backend.writeFile(a.path, String(a.text))
    await buffers.diskChanged(a.path) // don't wait for the watcher to show it in open editors
  },
  'watch.acquire': (c, a) => backend.acquire(c, a.dir),
  'watch.release': (c, a) => backend.release(c, a.dir),

  'buf.open': (c, a) => buffers.open(c, a.path),
  'buf.update': (c, a) => buffers.update(c, a.path, a.update),
  'buf.close': (c, a) => buffers.close(c, a.path, !!a.discard),
  'buf.info': (_c, a) => buffers.info(a.path),
  'buf.save': (_c, a) => buffers.save(a.path),
  'buf.saveAll': () => buffers.saveAll(),
  'buf.undo': (_c, a) => buffers.undo(a.path),
  'buf.redo': (_c, a) => buffers.redo(a.path),

  'git.status': async () => {
    lastGit = lastGit ?? (await git.status())
    return lastGit
  },

  'search.run': (_c, a) => backend.search(a),

  'term.create': (c, a) => createTerminal(c, a),
  'term.input': (_c, a) => terminals.input(a.id, a.data),
  'term.resize': (_c, a) => terminals.resize(a.id, a.cols, a.rows),
  'term.kill': (_c, a) => terminals.kill(a.id)
}

// ---------- terminals on other machines ----------

// A terminal can run somewhere other than the workspace: on this machine ("local") from an SSH
// workspace, or on any SSH host. Each extra host gets one connection, made on first use.
const workspaceSshHost = parseRemoteId(workspaceId)?.host ?? ''
const otherHosts = new Map<string, RemoteBackend>()

// Prompts for extra hosts go to a window as usual, but their connection state must not
// replace the workspace's own in the status bar.
const otherPrompter: Prompter = { ask: (req) => prompter.ask(req), status() {} }

let localFs: LocalBackend | null = null

/** File access on `target` ("local", an SSH host, or empty for the workspace's own machine). */
function fsFor(target: unknown): Backend {
  const t = typeof target === 'string' ? target.trim() : ''
  if (!t || (t === 'local' ? !backend.remote : t === workspaceSshHost)) return backend
  if (t === 'local') return (localFs ??= new LocalBackend(os.homedir()))
  return otherHost(t)
}

function otherHost(host: string): RemoteBackend {
  let b = otherHosts.get(host)
  if (!b) {
    b = new RemoteBackend(makeRemoteId(host, '~'), otherPrompter)
    otherHosts.set(host, b)
  }
  return b
}

async function createTerminal(c: Conn, a: { cwd?: string; cols: number; rows: number; target?: string }) {
  const target = (a.target ?? '').trim()
  const isWorkspace = !target || (target === 'local' ? !backend.remote : target === workspaceSshHost)
  if (isWorkspace) return terminals.create(c, a.cwd, a.cols, a.rows)
  if (target === 'local') {
    const created = await terminals.create(c, '', a.cols, a.rows, { spawn: spawnLocalShell, windowsPaths: process.platform === 'win32' })
    return { ...created, target }
  }
  const remote = otherHost(target)
  try {
    await remote.info() // connect (asking for a password or host key if needed)
  } catch (err) {
    // Never connected: forget it so the next attempt starts fresh and can ask again.
    if (otherHosts.get(target) === remote) otherHosts.delete(target)
    remote.dispose()
    throw err
  }
  const created = await terminals.create(c, '', a.cols, a.rows, { spawn: (cwd, cols, rows) => remote.spawnShell(cwd, cols, rows), windowsPaths: false })
  return { ...created, target }
}

function attach(port: MessagePortMain): void {
  const conn = new Conn(port)
  conns.add(conn)
  port.on('message', async (event) => {
    const msg = event.data as WireMessage
    if (msg.t !== 'req') return
    const handler = handlers[msg.m]
    let reply: WireMessage
    try {
      if (!handler) throw new Error(`Unknown method ${msg.m}`)
      reply = { t: 'res', id: msg.id, ok: true, r: await handler(conn, msg.a ?? {}) }
    } catch (err) {
      reply = { t: 'res', id: msg.id, ok: false, e: err instanceof Error ? err.message : String(err) }
    }
    if (msg.id >= 0) {
      try {
        port.postMessage(reply)
      } catch {
        // window closed while we were working
      }
    }
  })
  port.on('close', () => {
    conns.delete(conn)
    buffers.closeAll(conn)
    terminals.killOwnedBy(conn)
    backend.releaseAll(conn)
    // Prompts shown in this window can no longer be answered.
    for (const [id, p] of [...prompts]) {
      if (p.conn === conn) {
        prompts.delete(id)
        p.resolve(null)
      }
    }
  })
  port.start()
  if (remoteStatus) conn.send('remote.state', remoteStatus)
  for (const resolve of waitingForWindow.splice(0)) resolve()
}

// Messages from the main process: new windows to attach, and questions before closing.
process.parentPort.on('message', async (event) => {
  const msg = event.data as { type: string; id?: number }
  if (msg.type === 'attach' && event.ports[0]) {
    attach(event.ports[0])
  } else if (msg.type === 'dirty') {
    process.parentPort.postMessage({ type: 'reply', id: msg.id, result: buffers.dirtyPaths() })
  } else if (msg.type === 'saveAll') {
    let error: string | null = null
    try {
      await buffers.saveAll()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    process.parentPort.postMessage({ type: 'reply', id: msg.id, result: error })
  }
})

process.on('uncaughtException', (err) => console.error('[host] uncaught:', err))
process.on('unhandledRejection', (err) => console.error('[host] unhandled rejection:', err))
process.on('exit', () => {
  terminals.dispose()
  backend.dispose()
  for (const b of otherHosts.values()) b.dispose()
  localFs?.dispose()
})
