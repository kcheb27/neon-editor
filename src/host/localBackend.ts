// Backend for a folder on this machine.

import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as pty from 'node-pty'
import type { DirEntry, SearchResult, WorkspaceInfo } from '../shared/protocol'
import type { Backend, FileStat, PathApi, SpawnedShell } from './backend.ts'
import { Files } from './files.ts'
import type { FileEvents } from './files.ts'
import { searchFiles } from './search.ts'
import type { SearchOptions } from './search.ts'

// Runs once inside PowerShell: wraps the prompt so every prompt reports the current folder.
// Passed with -EncodedCommand, so the machine's script execution policy does not block it.
const POWERSHELL_INTEGRATION = `
$Global:__NeonOrigPrompt = $function:prompt
function Global:prompt {
  $loc = $ExecutionContext.SessionState.Path.CurrentLocation
  $osc = ''
  if ($loc.Provider.Name -eq 'FileSystem') {
    $p = $loc.ProviderPath.Replace('\\', '\\\\').Replace(';', '\\x3b')
    $osc = "$([char]27)]633;P;Cwd=$p$([char]7)"
  }
  $osc + (& $Global:__NeonOrigPrompt)
}
`

// bash runs this before every prompt. zsh and fish need their own hooks (not wired up yet).
const BASH_PROMPT_COMMAND = `printf '\\033]7;file://%s%s\\007' "$HOSTNAME" "$PWD"`

function shellCommand(): { file: string; args: string[]; env: Record<string, string> } {
  if (process.platform === 'win32') {
    const encoded = Buffer.from(POWERSHELL_INTEGRATION, 'utf16le').toString('base64')
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-EncodedCommand', encoded], env: {} }
  }
  const shell = process.env.SHELL || '/bin/bash'
  const env: Record<string, string> = {}
  if (path.basename(shell) === 'bash') {
    const existing = process.env.PROMPT_COMMAND
    env.PROMPT_COMMAND = existing ? `${BASH_PROMPT_COMMAND};${existing}` : BASH_PROMPT_COMMAND
  }
  return { file: shell, args: [], env }
}

export class LocalBackend implements Backend {
  readonly remote = false
  readonly path: PathApi = path as unknown as PathApi
  private root: string
  private files: Files | null = null

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  async info(): Promise<WorkspaceInfo> {
    return {
      root: this.root,
      label: path.basename(this.root) || this.root,
      remote: false,
      sshHost: '',
      sep: path.sep,
      platform: process.platform,
      home: os.homedir(),
      hostname: os.hostname()
    }
  }

  private fileOps(): Files {
    // Files holds the watcher; until watching starts it is used only for its file operations.
    if (!this.files) this.files = new Files(this.root, { dirsChanged() {}, filesChanged() {}, gitChanged() {} })
    return this.files
  }

  readdir(dir: string): Promise<DirEntry[]> {
    return this.fileOps().readdir(dir)
  }

  async stat(p: string): Promise<FileStat> {
    const s = await fsp.stat(p)
    return { size: s.size, mtimeMs: s.mtimeMs, isDir: s.isDirectory() }
  }

  async readFile(p: string): Promise<Uint8Array> {
    return fsp.readFile(p)
  }

  writeFile(p: string, text: string): Promise<void> {
    return fsp.writeFile(p, text, 'utf8')
  }

  create(p: string, kind: 'dir' | 'file'): Promise<void> {
    return this.fileOps().create(p, kind)
  }

  rename(from: string, to: string): Promise<void> {
    return this.fileOps().rename(from, to)
  }

  async trash(): Promise<void> {
    throw new Error('Local files are moved to the trash by the main process')
  }

  list(): Promise<string[]> {
    return this.fileOps().list()
  }

  async search(opts: SearchOptions): Promise<SearchResult> {
    return searchFiles(await this.list(), opts)
  }

  git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', ['-C', this.root, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
        err ? reject(err) : resolve(stdout)
      )
    })
  }

  async spawnShell(cwd: string, cols: number, rows: number): Promise<SpawnedShell> {
    const { file, args, env } = shellCommand()
    const start = cwd || this.root || os.homedir()
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: start,
      env: { ...process.env, ...env, TERM_PROGRAM: 'neon-editor' } as Record<string, string>
    })
    return {
      shell: path.basename(file).replace(/\.exe$/i, ''),
      cwd: start,
      pty: {
        onData: (cb) => void proc.onData(cb),
        onExit: (cb) => void proc.onExit(({ exitCode }) => cb(exitCode)),
        write: (d) => proc.write(d),
        resize: (c, r) => proc.resize(c, r),
        kill: () => proc.kill()
      }
    }
  }

  startWatching(events: FileEvents): void {
    this.files?.dispose()
    this.files = new Files(this.root, events)
    this.files.startWatching()
  }

  acquire(holder: object, dir: string): void {
    this.fileOps().acquire(holder, dir)
  }

  release(holder: object, dir: string): void {
    this.fileOps().release(holder, dir)
  }

  releaseAll(holder: object): void {
    this.fileOps().releaseAll(holder)
  }

  setOpenFiles(): void {
    // The local watcher sees every change; nothing to poll.
  }

  dispose(): void {
    this.files?.dispose()
  }
}
