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
}

// Wire format on the MessagePort between a window and the Workspace Host.
export type WireMessage =
  | { t: 'req'; id: number; m: string; a: unknown }
  | { t: 'res'; id: number; ok: true; r: unknown }
  | { t: 'res'; id: number; ok: false; e: string }
  | { t: 'evt'; m: string; a: unknown }
