// Types shared by the main process, the Workspace Host and the windows.

export interface DirEntry {
  name: string
  kind: 'dir' | 'file'
}

/** Git state for the workspace. `files` maps absolute paths to a one-letter code. */
export interface GitStatus {
  repo: boolean
  branch: string
  ahead: number
  behind: number
  /** M modified, A added, U untracked, D deleted, R renamed, C conflict, ! ignored */
  files: Record<string, string>
}

export interface WindowLayout {
  tabs: string[]
  active: string | null
  sidebar: boolean
  sidebarWidth: number
  view: string
  panel: boolean
  panelHeight: number
  expanded: string[]
  termTree: boolean
  /** Open page tabs (plugin screens) by id, and the active one if a page tab is active. */
  pages?: string[]
  activePage?: string | null
}

/** What a window needs to know about its workspace once the Workspace Host is ready. */
export interface WorkspaceInfo {
  root: string
  /** Short name for titles, e.g. "project" or "devbox: project". */
  label: string
  remote: boolean
  /** The ssh config alias or user@host, for SSH workspaces. */
  sshHost: string
  sep: string
  platform: string
  home: string
  hostname: string
}

export type RemoteState = 'connecting' | 'connected' | 'reconnecting' | 'failed'

export interface RemoteStatus {
  state: RemoteState
  detail: string
  latencyMs: number | null
}

/** An SSH target listed in ~/.ssh/config. */
export interface SshHostEntry {
  alias: string
  hostName: string
  user: string
  port: number
}

export interface WindowInit {
  /** A local path, or "ssh://<host>/<path>" for an SSH workspace. */
  folder: string | null
  remote: boolean
  windowIndex: number
  windowCount: number
  sep: string
  platform: string
  home: string
  layout: WindowLayout | null
  recent: string[]
}

export interface SearchMatch {
  path: string
  line: number
  col: number
  len: number
  text: string
}

export interface SearchResult {
  matches: SearchMatch[]
  files: number
  truncated: boolean
}

export interface BufferOpen {
  state: Uint8Array
  dirty: boolean
  eol: '\n' | '\r\n'
}

export interface TermCreated {
  id: number
  shell: string
  cwd: string
  /**
   * Where the shell runs when that is not the workspace's machine: "local" (this machine,
   * from an SSH workspace) or an SSH host. Absent for the workspace's own machine.
   */
  target?: string
}

// Wire format on the MessagePort between a window and the Workspace Host.
export type WireMessage =
  | { t: 'req'; id: number; m: string; a: unknown }
  | { t: 'res'; id: number; ok: true; r: unknown }
  | { t: 'res'; id: number; ok: false; e: string }
  | { t: 'evt'; m: string; a: unknown }

// ---------- plugins ----------

export interface PluginScreen {
  /** Unique within its plugin. */
  id: string
  title: string
  /** HTML file inside the plugin folder, e.g. "screen/index.html". */
  entry: string
  /** A built-in icon name, an .svg/.png file inside the plugin folder, or empty for a letter. */
  icon: string
  /**
   * Where the screen opens by default: "sidebar" (a sidebar view, can also open as a tab) or
   * "editor" (a full-size editor tab only).
   */
  location: 'sidebar' | 'editor'
}

export interface PluginInfo {
  /** From package.json "name"; also the host part of its neon-plugin:// URLs. */
  id: string
  name: string
  version: string
  dir: string
  screens: PluginScreen[]
}

export interface PluginList {
  plugins: PluginInfo[]
  /** Plugins that could not be loaded, as human-readable messages. */
  errors: string[]
  /** Folders that are scanned, in order. The first is where "Open Plugins Folder" goes. */
  folders: string[]
}
