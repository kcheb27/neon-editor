// Window entry point: builds the workbench (title bar, activity bar, sidebar, editor,
// bottom panel, status bar) and wires it to this project's Workspace Host.

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/400-italic.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

import type { GitStatus, RemoteStatus, SshHostEntry, WindowInit, WindowLayout, WorkspaceInfo } from '../../shared/protocol'
import { parseRemoteId, workspaceLabel } from '../../shared/workspaceId'
import { EditorArea } from './editorArea'
import { monaco, setupMonaco } from './monacoSetup'
import type { Host } from './rpc'
import { neon, waitForHostPort } from './rpc'
import { GitView, RemoteView, SearchView } from './sideViews'
import { BottomPanel } from './terminalPanel'
import { FileTree } from './tree'
import { ask, errorMessage, modal, pick, toast } from './ui'
import type { PickItem } from './ui'
import { basename, debounce, dirname, h, icon, relative, setPlatform, tildify } from './util'
import type { IconName } from './util'

const app = document.getElementById('app')!

function titleBar(init: WindowInit, center: HTMLElement | null, right: HTMLElement | null): HTMLElement {
  const cls = init.platform === 'darwin' ? 'mac' : init.platform === 'win32' ? 'win' : 'win'
  return h(
    'div',
    { class: `titlebar ${cls}` },
    h('span', { class: 'brand' }, 'Neon ', h('b', { text: 'Editor' })),
    h('div', { class: 'command-center' }, center),
    right
  )
}

// ---------- SSH ----------

const TYPED_HOST = '<typed>'

/** Pick a host (from ~/.ssh/config, or typed), then a folder on it, and open it. */
async function connectToHost(preset?: string): Promise<void> {
  let host = preset ?? null
  if (!host) {
    const hosts = (await neon.invoke('ssh:hosts').catch(() => [])) as SshHostEntry[]
    const choice = await pick(
      [
        { label: 'Enter user@host…', description: 'A host that is not in ~/.ssh/config', value: TYPED_HOST },
        ...hosts.map((entry) => ({
          label: entry.alias,
          description: `${entry.user}@${entry.hostName}${entry.port !== 22 ? `:${entry.port}` : ''}`,
          value: entry.alias
        }))
      ],
      { placeholder: 'Select an SSH host' }
    )
    if (choice === null) return
    host = choice === TYPED_HOST ? await ask('SSH host, e.g. user@example.com or user@example.com:2222') : choice
  }
  if (!host) return
  const folder = await ask(`Folder to open on ${host} (absolute path, or ~ for your home folder)`, '~')
  if (!folder) return
  try {
    await neon.invoke('workspace:openRemote', host, folder)
  } catch (err) {
    toast(errorMessage(err), 'error')
  }
}

interface PromptEvent {
  id: number
  kind: 'password' | 'passphrase' | 'keyboard' | 'hostkey'
  title: string
  message: string
  echo?: boolean
}

/** The Workspace Host asks for passwords, passphrases and host key approval through the window. */
function handleAuthPrompts(host: Host): void {
  host.on('auth.prompt', async (req: PromptEvent) => {
    let value: string | null
    if (req.kind === 'hostkey') {
      const r = await modal({ title: req.title, message: req.message, buttons: ['Accept and Connect', 'Cancel'], mono: true })
      value = r.button === 0 ? 'yes' : null
    } else {
      const r = await modal({
        title: req.title,
        message: req.message,
        input: req.echo ? 'text' : 'password',
        buttons: ['OK', 'Cancel']
      })
      value = r.button === 0 ? r.value : null
    }
    host.notify('auth.answer', { id: req.id, value })
  })
}

/** Shown while an SSH workspace connects. Resolves with the workspace info once connected. */
async function connectScreen(init: WindowInit, host: Host): Promise<WorkspaceInfo> {
  const remote = parseRemoteId(init.folder!)!
  const status = h('div', { class: 'note', style: 'display:flex;align-items:center;gap:10px' })
  const errorEl = h('div', { class: 'error' })
  const buttons = h('div', { style: 'display:flex;gap:8px' })
  app.replaceChildren(
    titleBar(init, null, null),
    h(
      'div',
      { class: 'connecting' },
      h('div', { class: 'connecting-card' }, h('h2', { text: `Opening ${remote.path} on ${remote.host}` }), status, errorEl, buttons)
    )
  )
  const setStatus = (text: string, busy: boolean): void => {
    status.replaceChildren(...(busy ? [h('span', { class: 'spinner' })] : []), text)
  }
  host.on('remote.state', (st: RemoteStatus) => {
    if (st.state === 'connected') setStatus('Connected. Opening the folder…', true)
  })
  for (;;) {
    setStatus(`Connecting to ${remote.host}…`, true)
    errorEl.textContent = ''
    buttons.replaceChildren()
    try {
      return await host.call<WorkspaceInfo>('ws.info')
    } catch (err) {
      setStatus('Could not open the folder.', false)
      errorEl.textContent = errorMessage(err)
      const retry = h('button', { class: 'btn', text: 'Retry' })
      const other = h('button', { class: 'btn ghost', text: 'Connect to Another Host…' })
      other.addEventListener('click', () => void connectToHost())
      buttons.replaceChildren(retry, other)
      retry.focus()
      await new Promise<void>((resolve) => retry.addEventListener('click', () => resolve(), { once: true }))
      host.notify('remote.retry')
    }
  }
}

// ---------- welcome (no folder open) ----------

function renderWelcome(init: WindowInit): void {
  const open = h('button', { class: 'btn', text: 'Open Folder…' })
  open.addEventListener('click', () => void neon.invoke('workspace:pick'))
  const connect = h('button', { class: 'btn ghost', text: 'Connect to SSH Host…' })
  connect.addEventListener('click', () => void connectToHost())
  const recent = init.recent.slice(0, 8).map((folder) => {
    const remote = parseRemoteId(folder)
    const b = h(
      'button',
      { title: remote ? `${remote.host}:${remote.path}` : folder },
      h('span', { text: workspaceLabel(folder, basename) }),
      h('span', { class: 'path', text: remote ? `SSH · ${remote.path}` : tildify(dirname(folder), init.home) })
    )
    b.addEventListener('click', () =>
      neon.invoke('workspace:open', folder).catch(() => toast(`${folder} no longer exists`, 'error'))
    )
    return b
  })
  app.replaceChildren(
    titleBar(init, null, null),
    h(
      'div',
      { class: 'welcome' },
      h(
        'div',
        { class: 'welcome-card' },
        h('h1', {}, 'Neon ', h('b', { text: 'Editor' })),
        h('div', { class: 'note', text: 'Open a folder to start. Each folder gets its own shared workspace, and you can open it in as many windows as you have monitors.' }),
        h('div', { style: 'display:flex;gap:8px' }, open, connect),
        recent.length ? h('div', { class: 'section-title', style: 'padding:0', text: 'Recent' }) : null,
        h('div', { class: 'recent' }, ...recent)
      )
    )
  )
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 'o') {
      e.preventDefault()
      void neon.invoke('workspace:pick')
    }
  })
}

// ---------- workbench ----------

interface Command {
  id: string
  label: string
  keybinding?: string
  run: () => void
}

async function renderWorkbench(init: WindowInit, host: Host, info: WorkspaceInfo): Promise<void> {
  setupMonaco()
  const root = info.root
  const label = info.label
  const saved: WindowLayout = {
    tabs: [],
    active: null,
    sidebar: true,
    sidebarWidth: 280,
    view: 'explorer',
    panel: true,
    panelHeight: 260,
    expanded: [],
    termTree: true,
    ...(init.layout ?? {})
  }
  let windowIndex = init.windowIndex
  let windowCount = init.windowCount
  let git: GitStatus | null = null
  let view = saved.view
  let sidebarOn = saved.sidebar
  // Assigned once the UI exists; calls before then are no-ops.
  let saveLayout: () => void = () => {}

  const editors = new EditorArea(host, root)
  const openFile = (p: string, line?: number, col?: number): void => void editors.open(p, line, col)

  // ---- sidebar views ----
  const explorer = new FileTree({ host, workspaceRoot: root, remoteHost: info.sshHost, getGit: () => git, openFile })
  const remoteView = new RemoteView(info.sshHost, (target) => void connectToHost(target))
  const search = new SearchView(host, root, openFile)
  const gitView = new GitView(root, openFile)
  gitView.render(null)

  const refreshBtn = h('button', { class: 'icon-btn', 'aria-label': 'Refresh explorer', title: 'Refresh' }, icon('refresh', 14, 2))
  refreshBtn.addEventListener('click', () => void explorer.refresh([root, ...explorer.getExpanded()]))
  const views: Record<string, { title: string; icon: IconName; label: string; el: HTMLElement }> = {
    explorer: {
      title: `Explorer: ${label}`,
      icon: 'files',
      label: 'Explorer (Ctrl+Shift+E)',
      el: h('div', { class: 'view' }, h('div', { class: 'section-title' }, h('span', { class: 'grow', text: `Explorer: ${label}` }), refreshBtn), explorer.el)
    },
    search: {
      title: 'Search',
      icon: 'search',
      label: 'Search (Ctrl+Shift+F)',
      el: h('div', { class: 'view' }, h('div', { class: 'section-title', text: 'Search' }), search.el)
    },
    git: {
      title: 'Source Control',
      icon: 'git',
      label: 'Source Control (Ctrl+Shift+G)',
      el: h('div', { class: 'view' }, h('div', { class: 'section-title', text: 'Source Control' }), gitView.el)
    },
    remote: {
      title: 'Remote',
      icon: 'remote',
      label: 'Remote Explorer',
      el: h('div', { class: 'view' }, h('div', { class: 'section-title', text: 'Remote Explorer' }), remoteView.el)
    }
  }
  if (!views[view]) view = 'explorer'

  const sash = h('div', { class: 'sash-v', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize sidebar' })
  const sidebar = h('div', { class: 'sidebar', style: `width:${saved.sidebarWidth}px` }, ...Object.values(views).map((v) => v.el), sash)

  const activityButtons = new Map<string, HTMLButtonElement>()
  const gitCount = h('span', { class: 'count', style: 'display:none' })
  const activityTop = h('div', {})
  for (const [id, v] of Object.entries(views)) {
    const b = h('button', { class: 'activity', 'aria-label': v.label, title: v.label }, icon(v.icon, 24, 1.6))
    if (id === 'git') b.append(gitCount)
    b.addEventListener('click', () => {
      if (view === id && sidebarOn) setSidebar(false)
      else showView(id)
    })
    activityButtons.set(id, b)
    activityTop.append(b)
  }
  const devtools = h('button', { class: 'activity', 'aria-label': 'Developer tools', title: 'Developer tools (Ctrl+Shift+I)' }, icon('code', 22, 1.6))
  devtools.addEventListener('click', () => void neon.invoke('window:devtools'))
  const activitybar = h('div', { class: 'activitybar' }, activityTop, h('div', {}, devtools))

  function setSidebar(on: boolean): void {
    sidebarOn = on
    sidebar.classList.toggle('hidden', !on)
    renderActivity()
    saveLayout()
  }

  function showView(id: string, focus = true): void {
    view = id
    for (const [vid, v] of Object.entries(views)) v.el.classList.toggle('hidden', vid !== id)
    sidebarOn = true
    sidebar.classList.remove('hidden')
    renderActivity()
    saveLayout()
    if (focus && id === 'search') search.focus()
  }

  function renderActivity(): void {
    for (const [id, b] of activityButtons) b.classList.toggle('on', sidebarOn && id === view)
  }

  // ---- bottom panel ----
  const panel = new BottomPanel({
    host,
    root,
    home: info.home,
    hostname: info.hostname,
    sshHost: info.sshHost,
    getGit: () => git,
    openFile,
    revealInExplorer: (p) => {
      showView('explorer')
      void explorer.reveal(p)
    },
    onLayoutChange: () => saveLayout()
  })
  panel.treeVisible = saved.termTree
  panel.el.style.height = `${saved.panelHeight}px`
  const panelSash = h('div', { class: 'sash-h', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize panel' })
  panel.el.append(panelSash)
  if (!saved.panel) panel.el.classList.add('hidden')

  function togglePanel(show?: boolean): void {
    const visible = !panel.el.classList.contains('hidden')
    const next = show ?? !visible
    panel.el.classList.toggle('hidden', !next)
    if (next) panel.showTerminal()
    else editors.editor.focus()
    saveLayout()
  }

  // ---- status bar ----
  const remoteItem = h('button', { class: `item remote${info.remote ? '' : ' local'}` })
  remoteItem.addEventListener('click', () => (info.remote ? showView('remote') : void connectToHost()))
  let remoteDown = false
  const renderRemote = (st: RemoteStatus | null): void => {
    if (!info.remote) {
      remoteItem.replaceChildren(icon('code', 12, 2.4), 'Local')
      remoteItem.title = 'Files are on this computer. Click to connect to an SSH host.'
      return
    }
    const state = st?.state ?? 'connected'
    remoteItem.classList.toggle('reconnecting', state === 'reconnecting' || state === 'connecting')
    remoteItem.classList.toggle('failed', state === 'failed')
    const suffix = state === 'connected' ? '' : state === 'failed' ? ' (disconnected)' : ' (reconnecting…)'
    remoteItem.replaceChildren(icon('code', 12, 2.4), `SSH: ${info.sshHost}${suffix}`)
    remoteItem.title = st?.detail ? `${state}: ${st.detail}` : `Connected to ${info.sshHost}`
  }
  renderRemote(null)
  remoteView.setStatus({ state: 'connected', detail: '', latencyMs: null })
  host.on('remote.state', (st: RemoteStatus) => {
    renderRemote(st)
    remoteView.setStatus(st)
    if (st.state === 'connected') {
      if (remoteDown) toast(`Reconnected to ${info.sshHost}.`)
      remoteDown = false
    } else if (!remoteDown) {
      remoteDown = true
      toast(`Lost the connection to ${info.sshHost}. Reconnecting… Unsaved changes are kept.`)
    }
  })
  const status = {
    branch: h('button', { class: 'item', title: 'Source Control' }),
    problems: h('button', { class: 'item', title: 'Problems' }),
    cursor: h('span', { class: 'item' }),
    indent: h('span', { class: 'item' }),
    eol: h('span', { class: 'item' }),
    lang: h('span', { class: 'item' }),
    windows: h('button', { class: 'item', title: 'Open another window for this project (Ctrl+Shift+N)' })
  }
  status.branch.addEventListener('click', () => showView('git'))
  status.problems.addEventListener('click', () => {
    panel.el.classList.remove('hidden')
    panel.showProblems()
    saveLayout()
  })
  status.windows.addEventListener('click', () => void neon.invoke('window:new'))
  const statusbar = h(
    'div',
    { class: 'statusbar' },
    remoteItem,
    status.branch,
    status.problems,
    h('span', { class: 'grow' }),
    status.cursor,
    status.indent,
    h('span', { class: 'item', text: 'UTF-8' }),
    status.eol,
    status.lang,
    status.windows,
    h('span', { class: 'item', style: 'color:var(--accent)', text: 'Neon Night' })
  )

  function renderStatus(): void {
    if (git?.repo) {
      status.branch.style.display = ''
      const sync = `${git.ahead ? ` ↑${git.ahead}` : ''}${git.behind ? ` ↓${git.behind}` : ''}`
      const changed = Object.values(git.files).filter((c) => c !== '!').length
      status.branch.replaceChildren(icon('git', 12, 2.2), `${git.branch || 'detached'}${changed ? '*' : ''}${sync}`)
    } else status.branch.style.display = 'none'

    const markers = monaco.editor.getModelMarkers({})
    const errors = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length
    const warnings = markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length
    status.problems.replaceChildren(
      h('span', { style: 'color:var(--error)', text: `● ${errors}` }),
      h('span', { style: 'color:var(--warning)', text: `▲ ${warnings}` })
    )

    const model = editors.editor.getModel()
    const pos = editors.editor.getPosition()
    const active = editors.activePath
    for (const el of [status.cursor, status.indent, status.eol, status.lang]) el.style.display = model ? '' : 'none'
    if (model && pos && active) {
      const sel = editors.editor.getSelection()
      const selected = sel && !sel.isEmpty() ? model.getValueInRange(sel).length : 0
      status.cursor.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}${selected ? ` (${selected} selected)` : ''}`
      const opts = model.getOptions()
      status.indent.textContent = opts.insertSpaces ? `Spaces: ${opts.tabSize}` : `Tab Size: ${opts.tabSize}`
      status.eol.textContent = editors.eolOf(active)
      const lang = monaco.languages.getLanguages().find((l) => l.id === model.getLanguageId())
      status.lang.textContent = lang?.aliases?.[0] ?? model.getLanguageId()
    }
    status.windows.textContent = `Window ${windowIndex} of ${windowCount}`
    windowChip.lastChild!.textContent = windowCount > 1 ? `Window ${windowIndex} of ${windowCount}` : 'New Window'
  }

  // ---- title bar ----
  const commandCenter = h(
    'button',
    { title: 'Go to file (Ctrl+P)' },
    icon('search', 14, 2),
    h('span', { text: `${label} — Search files` })
  )
  commandCenter.addEventListener('click', () => void quickOpen())
  const windowChip = h('button', { class: 'window-chip', title: 'Open another window for this project (Ctrl+Shift+N)' }, icon('windows', 14, 2), h('span', { text: '' }))
  windowChip.addEventListener('click', () => void neon.invoke('window:new'))

  // ---- assemble ----
  const center = h('div', { class: 'center' }, editors.el, panel.el)
  app.replaceChildren(
    titleBar(init, commandCenter, windowChip),
    h('div', { class: 'workbench' }, activitybar, sidebar, center),
    statusbar
  )
  document.title = `${label} - Neon Editor`
  showView(view, false)
  setSidebar(sidebarOn)

  // ---- resizing ----
  function drag(handle: HTMLElement, onMove: (e: PointerEvent) => void): void {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      handle.setPointerCapture(e.pointerId)
      handle.classList.add('drag')
      const move = (ev: PointerEvent): void => onMove(ev)
      const up = (): void => {
        handle.classList.remove('drag')
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        saveLayout()
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
    })
  }
  drag(sash, (e) => {
    const left = sidebar.getBoundingClientRect().left
    sidebar.style.width = `${Math.min(600, Math.max(170, e.clientX - left))}px`
  })
  drag(panelSash, (e) => {
    const bottom = center.getBoundingClientRect().bottom
    panel.el.style.height = `${Math.min(window.innerHeight - 200, Math.max(100, bottom - e.clientY))}px`
  })

  // ---- layout persistence ----
  saveLayout = debounce(() => {
    const layout: WindowLayout = {
      tabs: editors.paths,
      active: editors.activePath,
      sidebar: sidebarOn,
      sidebarWidth: sidebar.getBoundingClientRect().width || saved.sidebarWidth,
      view,
      panel: !panel.el.classList.contains('hidden'),
      panelHeight: panel.el.getBoundingClientRect().height || saved.panelHeight,
      expanded: explorer.getExpanded(),
      termTree: panel.treeVisible
    }
    neon.send('window:layout', layout)
  }, 400)

  // ---- events ----
  editors.onChange = () => {
    renderStatus()
    saveLayout()
  }
  editors.editor.onDidChangeCursorSelection(() => renderStatus())
  monaco.editor.onDidChangeMarkers(() => renderStatus())

  host.on('fs.changed', ({ dirs }: { dirs: string[] }) => void explorer.refresh(dirs))
  const applyGit = (s: GitStatus): void => {
    git = s
    explorer.setGit(s)
    panel.gitChanged(s)
    gitView.render(s)
    const changed = s.repo ? Object.values(s.files).filter((c) => c !== '!').length : 0
    gitCount.textContent = String(changed)
    gitCount.style.display = changed ? '' : 'none'
    renderStatus()
  }
  host.on('git.changed', applyGit)
  neon.on('window:count', ({ index, count }: { index: number; count: number }) => {
    windowIndex = index
    windowCount = count
    renderStatus()
  })

  // ---- commands ----
  async function quickOpen(): Promise<void> {
    let files: string[]
    try {
      files = await host.call<string[]>('fs.list')
    } catch {
      files = []
    }
    const recent = editors.paths.slice().reverse()
    const ordered = [...recent, ...files.filter((f) => !recent.includes(f))]
    const items: PickItem<string>[] = ordered.map((f) => ({
      label: basename(f),
      description: relative(root, dirname(f)),
      value: f
    }))
    const chosen = await pick(items, {
      placeholder: 'Search files by name',
      matchOn: (item) => relative(root, item.value),
      max: 100
    })
    if (chosen) openFile(chosen)
  }

  const commands: Command[] = [
    { id: 'quickOpen', label: 'Go to File…', keybinding: 'Ctrl+P', run: () => void quickOpen() },
    { id: 'save', label: 'File: Save', keybinding: 'Ctrl+S', run: () => void editors.save() },
    { id: 'saveAll', label: 'File: Save All', keybinding: 'Ctrl+Alt+S', run: () => void editors.saveAll() },
    { id: 'close', label: 'View: Close Editor', keybinding: 'Ctrl+W', run: () => editors.activePath && void editors.close(editors.activePath) },
    { id: 'newWindow', label: 'Window: New Window for This Project', keybinding: 'Ctrl+Shift+N', run: () => void neon.invoke('window:new') },
    { id: 'openFolder', label: 'File: Open Folder…', keybinding: 'Ctrl+O', run: () => void neon.invoke('workspace:pick') },
    { id: 'connect', label: 'Remote: Connect to SSH Host…', run: () => void connectToHost() },
    { id: 'remote', label: 'View: Show Remote Explorer', run: () => showView('remote') },
    { id: 'sidebar', label: 'View: Toggle Sidebar', keybinding: 'Ctrl+B', run: () => setSidebar(!sidebarOn) },
    { id: 'panel', label: 'View: Toggle Terminal Panel', keybinding: 'Ctrl+`', run: () => togglePanel() },
    { id: 'newTerminal', label: 'Terminal: New Terminal', keybinding: 'Ctrl+Shift+`', run: () => { togglePanel(true); void panel.newTerminal() } },
    {
      id: 'termTree',
      label: 'Terminal: Toggle File Tree',
      run: () => {
        panel.treeVisible = !panel.treeVisible
        togglePanel(true)
      }
    },
    { id: 'explorer', label: 'View: Show Explorer', keybinding: 'Ctrl+Shift+E', run: () => showView('explorer') },
    { id: 'search', label: 'View: Search in Files', keybinding: 'Ctrl+Shift+F', run: () => showView('search') },
    { id: 'git', label: 'View: Show Source Control', keybinding: 'Ctrl+Shift+G', run: () => showView('git') },
    {
      id: 'problems',
      label: 'View: Show Problems',
      run: () => {
        panel.el.classList.remove('hidden')
        panel.showProblems()
      }
    },
    {
      id: 'reveal',
      label: 'File: Reveal Active File in Explorer',
      run: () => {
        if (!editors.activePath) return
        showView('explorer')
        void explorer.reveal(editors.activePath)
      }
    },
    { id: 'find', label: 'Editor: Find', keybinding: 'Ctrl+F', run: () => editors.editor.getAction('actions.find')?.run() },
    { id: 'replace', label: 'Editor: Replace', keybinding: 'Ctrl+H', run: () => editors.editor.getAction('editor.action.startFindReplaceAction')?.run() },
    { id: 'format', label: 'Editor: Format Document', keybinding: 'Shift+Alt+F', run: () => editors.editor.getAction('editor.action.formatDocument')?.run() },
    { id: 'gotoLine', label: 'Editor: Go to Line…', keybinding: 'Ctrl+G', run: () => editors.editor.getAction('editor.action.gotoLine')?.run() },
    { id: 'symbol', label: 'Editor: Go to Symbol in File…', keybinding: 'Ctrl+Shift+O', run: () => editors.editor.getAction('editor.action.quickOutline')?.run() },
    { id: 'comment', label: 'Editor: Toggle Line Comment', keybinding: 'Ctrl+/', run: () => editors.editor.getAction('editor.action.commentLine')?.run() },
    { id: 'devtools', label: 'Developer: Toggle Developer Tools', keybinding: 'Ctrl+Shift+I', run: () => void neon.invoke('window:devtools') }
  ]

  async function palette(): Promise<void> {
    const chosen = await pick(
      commands.map((c) => ({ label: c.label, keybinding: c.keybinding, value: c })),
      { placeholder: 'Type a command' }
    )
    if (chosen) {
      // Let the palette close and focus return before running.
      setTimeout(() => chosen.run(), 0)
    }
  }

  // Shortcuts are handled in the capture phase so they work from the editor and the terminal too.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.ctrlKey || e.metaKey) return
      const k = e.key.toLowerCase()
      const shift = e.shiftKey
      const alt = e.altKey
      let run: (() => void) | null = null
      if (shift && k === 'p') run = () => void palette()
      else if (!shift && !alt && k === 'p') run = () => void quickOpen()
      else if (!shift && !alt && k === 's') run = () => void editors.save()
      else if (!shift && alt && k === 's') run = () => void editors.saveAll()
      else if (!shift && !alt && k === 'w') run = () => editors.activePath && void editors.close(editors.activePath)
      else if (shift && k === 'n') run = () => void neon.invoke('window:new')
      else if (!shift && k === 'o') run = () => void neon.invoke('workspace:pick')
      else if (!shift && k === 'b') run = () => setSidebar(!sidebarOn)
      else if (!shift && (k === '`' || k === 'j')) run = () => togglePanel()
      else if (shift && (k === '`' || k === '~')) run = () => { togglePanel(true); void panel.newTerminal() }
      else if (shift && k === 'e') run = () => showView('explorer')
      else if (shift && k === 'f') run = () => showView('search')
      else if (shift && k === 'g') run = () => showView('git')
      else if (shift && k === 'i') run = () => void neon.invoke('window:devtools')
      else if (k === 'tab') run = () => editors.cycle(shift ? -1 : 1)
      if (!run) return
      e.preventDefault()
      e.stopPropagation()
      run()
    },
    true
  )

  // ---- restore ----
  await explorer.setRoot(root, saved.expanded)
  host
    .call<GitStatus>('git.status')
    .then(applyGit)
    .catch(() => applyGit({ repo: false, branch: '', ahead: 0, behind: 0, files: {} }))
  for (const p of saved.tabs) await editors.open(p)
  if (saved.active) await editors.open(saved.active)
  if (saved.panel) panel.showTerminal()
  renderStatus()
}

async function start(): Promise<void> {
  // Listen for the host port before asking for it: it can arrive before the reply.
  const hostReady = waitForHostPort()
  const init = await neon.invoke('window:init') as WindowInit
  setPlatform(init.sep, init.platform)
  if (!init.folder) {
    renderWelcome(init)
    return
  }
  const host = await hostReady
  handleAuthPrompts(host)
  const info = init.remote ? await connectScreen(init, host) : await host.call<WorkspaceInfo>('ws.info')
  setPlatform(info.sep, info.platform)
  await renderWorkbench(init, host, info)
}

start().catch((err) => {
  console.error(err)
  app.replaceChildren(h('pre', { style: 'padding:24px;color:#FF5370', text: `Neon Editor failed to start:\n${err?.stack ?? err}` }))
})
