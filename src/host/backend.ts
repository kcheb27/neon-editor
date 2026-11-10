// Everything the Workspace Host needs from "where the files live". LocalBackend uses this
// machine; RemoteBackend uses an SSH connection. Paths are absolute in the backend's own
// style: Windows paths locally on Windows, POSIX paths on an SSH host.

import type * as nodePath from 'node:path'
import type { DirEntry, SearchResult, WorkspaceInfo } from '../shared/protocol'
import type { FileEvents } from './files.ts'
import type { SearchOptions } from './search.ts'

export type PathApi = typeof nodePath.posix

export interface FileStat {
  size: number
  mtimeMs: number
  isDir: boolean
}

/** A running shell with a terminal attached, local or remote. */
export interface PtyLike {
  onData(cb: (data: string) => void): void
  onExit(cb: (exitCode: number) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface SpawnedShell {
  pty: PtyLike
  shell: string
  cwd: string
}

export interface Backend {
  readonly remote: boolean
  readonly path: PathApi
  /** Resolves once the backend can be used (for SSH: connected and authenticated). */
  info(): Promise<WorkspaceInfo>

  readdir(dir: string): Promise<DirEntry[]>
  stat(p: string): Promise<FileStat>
  readFile(p: string): Promise<Uint8Array>
  writeFile(p: string, text: string): Promise<void>
  create(p: string, kind: 'dir' | 'file'): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Move to the trash. Only remote backends implement it; local trash goes through the main process. */
  trash(p: string): Promise<void>

  /** Every file in the workspace, honoring .gitignore when it is a git repository. */
  list(): Promise<string[]>
  search(opts: SearchOptions): Promise<SearchResult>
  /** Run git with the workspace as the working directory and return stdout. */
  git(args: string[]): Promise<string>
  spawnShell(cwd: string, cols: number, rows: number): Promise<SpawnedShell>

  startWatching(events: FileEvents): void
  /** Keep watching a folder outside the workspace while `holder` shows it. */
  acquire(holder: object, dir: string): void
  release(holder: object, dir: string): void
  releaseAll(holder: object): void
  /** Open files the watcher should keep an eye on (used by polling watchers). */
  setOpenFiles(get: () => string[]): void
  dispose(): void
}
