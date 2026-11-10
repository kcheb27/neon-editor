// Main process: creates windows, starts one Workspace Host per project, and remembers where
// each project's windows were so they come back on the same monitors.

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, MessageChannelMain, screen, shell, utilityProcess } from 'electron'
import type { Rectangle, UtilityProcess } from 'electron'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { listHosts } from '../host/ssh/config'
import type { SshHostEntry, WindowInit, WindowLayout } from '../shared/protocol'
import { isRemoteId, makeRemoteId, workspaceLabel } from '../shared/workspaceId'
import { handlePluginProtocol, listPlugins, pluginFolders, registerPluginScheme, scanPlugins, storageGet, storageSet } from './plugins'

const labelOf = (folder: string): string => workspaceLabel(folder, (p) => path.basename(p) || p)

interface SavedWindow {
  bounds: Rectangle | null
  maximized: boolean
  layout: WindowLayout | null
}

interface State {
  recent: string[]
  workspaces: Record<string, { windows: SavedWindow[] }>
}

interface Workspace {
  folder: string
  host: UtilityProcess
  windows: BrowserWindow[]
  replies: Map<number, (result: unknown) => void>
  nextRequest: number
  /** The user already answered the unsaved-changes question for this workspace. */
  closeApproved: boolean
  asking: boolean
}

interface WinMeta {
  ws: Workspace | null
  saved: SavedWindow
}

// Dev-only test hook: NEON_SMOKE=<script.cjs> drives the app and takes screenshots.
const smokeScript = !app.isPackaged ? process.env.NEON_SMOKE : undefined
if (smokeScript) app.setPath('userData', path.join(os.tmpdir(), `neon-smoke-${process.pid}`))

registerPluginScheme() // must happen before the app is ready

const workspaces = new Map<string, Workspace>()
const meta = new Map<BrowserWindow, WinMeta>()
let quitting = false

// ---------- persisted state ----------

const stateFile = (): string => path.join(app.getPath('userData'), 'state.json')
let state: State = { recent: [], workspaces: {} }
let saveTimer: ReturnType<typeof setTimeout> | null = null

function loadState(): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    state = { recent: parsed.recent ?? [], workspaces: parsed.workspaces ?? {} }
  } catch {
    // first run or unreadable file: start fresh
  }
}

function writeState(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('[main] could not save state:', err)
  }
}

function persist(ws: Workspace | null): void {
  if (ws) {
    state.workspaces[ws.folder] = { windows: ws.windows.map((w) => meta.get(w)!.saved) }
  }
  if (!saveTimer) saveTimer = setTimeout(writeState, 500)
}

// ---------- windows ----------

function isOnScreen(b: Rectangle): boolean {
  // Enough of the title bar must be on some display to grab it.
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    const overlapX = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)
    const overlapY = Math.min(b.y + 40, a.y + a.height) - Math.max(b.y, a.y)
    return overlapX >= 120 && overlapY >= 20
  })
}

function defaultBounds(offset: number, near?: Rectangle): Rectangle {
  if (near) {
    // Next to the window it was opened from, on that window's monitor, shifted down and right
    // so both title bars show. Wraps back to the top-left of the monitor when it runs out.
    const area = screen.getDisplayMatching(near).workArea
    const width = Math.min(near.width, area.width)
    const height = Math.min(near.height, area.height)
    let x = near.x + 32
    let y = near.y + 32
    if (x + width > area.x + area.width || y + height > area.y + area.height) {
      x = area.x + 16
      y = area.y + 16
    }
    return { x, y, width, height }
  }
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(1440, area.width - 80)
  const height = Math.min(900, area.height - 80)
  const shift = (offset % 8) * 32
  return {
    x: area.x + Math.round((area.width - width) / 2) + shift,
    y: area.y + Math.round((area.height - height) / 2) + shift,
    width,
    height
  }
}

function announceCount(ws: Workspace): void {
  ws.windows.forEach((w, i) => {
    if (!w.isDestroyed()) w.webContents.send('window:count', { index: i + 1, count: ws.windows.length })
  })
}

/**
 * `from` is the window the user asked from (e.g. "New Window"): the new one opens beside it, on
 * the same monitor, and comes to the front.
 */
function createWindow(ws: Workspace | null, saved?: SavedWindow, from?: BrowserWindow | null): BrowserWindow {
  const record: SavedWindow = saved ?? { bounds: null, maximized: false, layout: null }
  // A window saved on a monitor that is no longer connected opens on the primary display.
  const near = from && !from.isDestroyed() && !from.isMinimized() ? from.getNormalBounds() : undefined
  const bounds = record.bounds && isOnScreen(record.bounds) ? record.bounds : defaultBounds(meta.size, near)

  const win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 400,
    show: false,
    backgroundColor: '#10121A', // matches the boot screen in index.html, so nothing flashes
    title: ws ? `${labelOf(ws.folder)} - Neon Editor` : 'Neon Editor',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#10121A', symbolColor: '#8A93B0', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Windows on other monitors are often unfocused or partly covered. They must keep
      // painting edits made elsewhere, so Chromium may not pause them.
      backgroundThrottling: false
    }
  })
  meta.set(win, { ws, saved: record })
  if (ws) ws.windows.push(win)

  if (record.maximized) win.maximize()
  if (!smokeScript) {
    // Show on the first paint. ready-to-show does not always arrive (the window then stayed
    // invisible, yet was counted and saved, and only appeared on the next start), so the
    // page finishing loading, or a few seconds passing, shows it too.
    let shown = false
    const reveal = (): void => {
      if (shown || win.isDestroyed()) return
      shown = true
      clearTimeout(fallback)
      win.show()
      if (from) {
        win.moveTop()
        win.focus()
      }
    }
    const fallback = setTimeout(reveal, 3000)
    win.once('ready-to-show', reveal)
    win.webContents.once('did-finish-load', reveal)
    win.webContents.once('did-fail-load', reveal)
    win.once('closed', () => clearTimeout(fallback))
  }

  const remember = (): void => {
    const m = meta.get(win)
    if (!m || win.isDestroyed() || win.isMinimized()) return
    m.saved.maximized = win.isMaximized()
    if (!m.saved.maximized) m.saved.bounds = win.getBounds()
    persist(m.ws)
  }
  win.on('resize', remember)
  win.on('move', remember)

  win.on('close', (event) => {
    const m = meta.get(win)
    const w = m?.ws
    if (!w || w.closeApproved) return
    // Other windows still show this project, so nothing can be lost by closing this one.
    if (w.windows.length > 1 && !quitting) return
    event.preventDefault()
    void confirmClose(w, win)
  })

  win.on('closed', () => {
    const m = meta.get(win)
    meta.delete(win)
    const w = m?.ws
    if (!w) return
    const lastOne = w.windows.length === 1
    w.windows = w.windows.filter((x) => x !== win)
    if (w.windows.length === 0) {
      w.host.kill()
      workspaces.delete(w.folder)
    } else if (!quitting && !lastOne) {
      // The user closed one of several windows: forget it. (Closing the last window, or
      // quitting, keeps the saved set so the project reopens the way it was.)
      persist(w)
      announceCount(w)
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))

  if (ws) {
    persist(ws)
    announceCount(ws)
  }
  return win
}

// ---------- workspaces ----------

function hostRequest<T>(ws: Workspace, type: string, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const id = ws.nextRequest++
    const timer = setTimeout(() => {
      ws.replies.delete(id)
      resolve(fallback)
    }, 5000)
    ws.replies.set(id, (result) => {
      clearTimeout(timer)
      resolve(result as T)
    })
    ws.host.postMessage({ type, id })
  })
}

async function confirmClose(ws: Workspace, win: BrowserWindow): Promise<void> {
  if (ws.asking) return
  ws.asking = true
  const wasQuitting = quitting
  quitting = false
  try {
    const dirty = await hostRequest<string[]>(ws, 'dirty', [])
    if (dirty.length > 0) {
      const names = dirty.slice(0, 8).map((p) => path.basename(p)).join('\n')
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        message: dirty.length === 1 ? 'Save changes to 1 file?' : `Save changes to ${dirty.length} files?`,
        detail: `${names}${dirty.length > 8 ? '\n…' : ''}\n\nYour changes will be lost if you don't save them.`,
        buttons: ['Save All', "Don't Save", 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
      if (response === 2) return
      if (response === 0) {
        const error = await hostRequest<string | null>(ws, 'saveAll', 'The workspace did not respond')
        if (error) {
          dialog.showErrorBox('Could not save', error)
          return
        }
      }
    }
    ws.closeApproved = true
    if (wasQuitting) {
      quitting = true
      app.quit()
    } else if (!win.isDestroyed()) {
      win.close()
    }
  } finally {
    ws.asking = false
  }
}

function startWorkspace(folder: string): Workspace {
  const host = utilityProcess.fork(path.join(__dirname, 'host.js'), [folder], {
    serviceName: `Neon Workspace Host (${labelOf(folder)})`,
    stdio: 'inherit'
  })
  const ws: Workspace = {
    folder, host, windows: [], replies: new Map(), nextRequest: 1, closeApproved: false, asking: false
  }
  host.on('message', (msg: { type: string; id: number; result: unknown }) => {
    if (msg.type !== 'reply') return
    const resolve = ws.replies.get(msg.id)
    ws.replies.delete(msg.id)
    resolve?.(msg.result)
  })
  host.on('exit', (code) => {
    if (workspaces.get(folder) === ws && ws.windows.length > 0) {
      console.error(`[main] Workspace Host for ${folder} exited unexpectedly (code ${code})`)
    }
  })
  workspaces.set(folder, ws)
  return ws
}

function openWorkspace(folderArg: string, from?: BrowserWindow): void {
  const folder = isRemoteId(folderArg) ? folderArg : path.resolve(folderArg)
  const existing = workspaces.get(folder)
  if (existing) {
    existing.windows[0]?.focus()
    return
  }
  const ws = startWorkspace(folder)
  state.recent = [folder, ...state.recent.filter((f) => f !== folder)].slice(0, 12)
  const saved = state.workspaces[folder]?.windows ?? []
  const records: SavedWindow[] = saved.length ? saved : [{ bounds: null, maximized: false, layout: null }]

  // An empty window that asked for the folder becomes the project's first window.
  const fromMeta = from ? meta.get(from) : undefined
  if (from && fromMeta && !fromMeta.ws) {
    const first = records.shift()!
    fromMeta.ws = ws
    fromMeta.saved.layout = first.layout
    ws.windows.push(from)
    from.setTitle(`${labelOf(folder)} - Neon Editor`)
    from.webContents.reload()
  }
  for (const record of records) createWindow(ws, record)
  persist(ws)
  announceCount(ws)
}

// ---------- IPC from windows ----------

function senderWindow(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

ipcMain.handle('window:init', (event): WindowInit => {
  const win = senderWindow(event)
  const m = win ? meta.get(win) : undefined
  const ws = m?.ws ?? null
  if (ws) {
    // A private channel between this window and its Workspace Host.
    const { port1, port2 } = new MessageChannelMain()
    ws.host.postMessage({ type: 'attach' }, [port1])
    event.sender.postMessage('host-port', null, [port2])
  }
  return {
    folder: ws?.folder ?? null,
    remote: !!ws && isRemoteId(ws.folder),
    windowIndex: ws && win ? ws.windows.indexOf(win) + 1 : 1,
    windowCount: ws?.windows.length ?? 1,
    sep: path.sep,
    platform: process.platform,
    home: os.homedir(),
    layout: m?.saved.layout ?? null,
    recent: state.recent.filter((f) => f !== ws?.folder)
  }
})

ipcMain.handle('workspace:pick', async (event) => {
  const win = senderWindow(event)
  if (!win) return
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Open Folder' })
  if (!result.canceled && result.filePaths[0]) openWorkspace(result.filePaths[0], win)
})

ipcMain.handle('workspace:open', (event, folder: string) => {
  if (typeof folder !== 'string') throw new Error('Folder not found')
  if (!isRemoteId(folder) && !fs.existsSync(folder)) throw new Error('Folder not found')
  openWorkspace(folder, senderWindow(event) ?? undefined)
})

ipcMain.handle('workspace:openRemote', (event, host: string, folder: string) => {
  if (typeof host !== 'string' || !host.trim() || /[\s/]/.test(host.trim())) throw new Error('Enter a host like user@example.com')
  openWorkspace(makeRemoteId(host.trim(), typeof folder === 'string' ? folder : '~'), senderWindow(event) ?? undefined)
})

ipcMain.handle('ssh:hosts', (): SshHostEntry[] => {
  try {
    return listHosts()
  } catch (err) {
    console.error('[main] could not read ssh config:', err)
    return []
  }
})

ipcMain.handle('window:new', (event) => {
  const win = senderWindow(event)
  const m = win ? meta.get(win) : undefined
  createWindow(m?.ws ?? null, undefined, win)
})

ipcMain.on('window:layout', (event, layout: WindowLayout) => {
  const win = senderWindow(event)
  const m = win ? meta.get(win) : undefined
  if (!m) return
  m.saved.layout = layout
  persist(m.ws)
})

// Clipboard goes through the main process: navigator.clipboard can fail silently in a
// packaged (file://) window, so the terminal's copy and paste would do nothing.
ipcMain.handle('clipboard:read', () => clipboard.readText())
ipcMain.handle('clipboard:write', (_event, text: string) => clipboard.writeText(String(text)))

ipcMain.handle('shell:trash', (_event, target: string) => shell.trashItem(target))
ipcMain.handle('shell:reveal', (_event, target: string) => shell.showItemInFolder(target))

ipcMain.handle('dialog:confirm', async (event, opts: { message: string; detail?: string; buttons: string[] }) => {
  const win = senderWindow(event)
  if (!win) return opts.buttons.length - 1
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: opts.message,
    detail: opts.detail,
    buttons: opts.buttons,
    defaultId: 0,
    cancelId: opts.buttons.length - 1,
    noLink: true
  })
  return response
})

ipcMain.handle('window:devtools', (event) => event.sender.toggleDevTools())

// ---------- plugins ----------

ipcMain.handle('plugins:list', () => listPlugins())
ipcMain.handle('plugins:reload', () => scanPlugins())
ipcMain.handle('plugins:openFolder', async () => {
  const folder = pluginFolders()[0]
  fs.mkdirSync(folder, { recursive: true })
  const err = await shell.openPath(folder)
  if (err) throw new Error(err)
  return folder
})
ipcMain.handle('plugins:storageGet', (_event, id: string, key: string) => storageGet(String(id))[String(key)] ?? null)
ipcMain.handle('plugins:storageSet', (_event, id: string, key: string, value: unknown) => storageSet(String(id), String(key), value))

// ---------- app lifecycle ----------

function folderFromArgv(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  for (const arg of args.reverse()) {
    if (arg.startsWith('-')) continue
    if (isRemoteId(arg)) return arg
    const full = path.resolve(arg)
    try {
      if (full !== app.getAppPath() && fs.statSync(full).isDirectory()) return full
    } catch {
      // not a path
    }
  }
  return null
}

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  writeState()
  if (process.platform !== 'darwin' || quitting) app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow(null)
})

void app.whenReady().then(async () => {
  loadState()
  scanPlugins()
  handlePluginProtocol()
  // The app draws its own menus in the title bar. macOS keeps the system menu for Cmd+Q, copy and paste.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  const fromArgs = folderFromArgv()
  // SSH projects are not reopened automatically: they may ask for a password right away.
  const last = state.recent.find((f) => !isRemoteId(f) && fs.existsSync(f))
  if (fromArgs) openWorkspace(fromArgs)
  else if (last && !smokeScript) openWorkspace(last)
  else createWindow(null)

  if (smokeScript) {
    const run = createRequire(__filename)(path.resolve(smokeScript))
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`))
    }
    try {
      await run({ app, BrowserWindow, createWindow: () => createWindow([...workspaces.values()][0] ?? null) })
    } catch (err) {
      console.error('[smoke] failed:', err)
      process.exitCode = 1
    }
    for (const ws of workspaces.values()) ws.closeApproved = true
    app.quit()
  }
})
