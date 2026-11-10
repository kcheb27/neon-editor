// File system access and watching for one workspace.

import { execFile } from 'node:child_process'
import { watch, promises as fsp } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import * as path from 'node:path'
import type { DirEntry } from '../shared/protocol'

const FLUSH_MS = 150
const MAX_LIST = 50000
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'target', '.next', '.venv', '__pycache__'])

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export interface FileEvents {
  /** Folders whose direct children may have changed. */
  dirsChanged(dirs: string[]): void
  /** Files whose content may have changed. */
  filesChanged(files: string[]): void
  /** Something under .git changed (branch switch, commit, stage). */
  gitChanged(): void
}

export class Files {
  private root: string
  private events: FileEvents
  private rootWatcher: FSWatcher | null = null
  private pendingDirs = new Set<string>()
  private pendingFiles = new Set<string>()
  private pendingGit = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** Watches on folders outside the workspace, held while a terminal file tree shows them. */
  private extra = new Map<string, { watcher: FSWatcher; holders: Map<object, number> }>()
  private listCache: Promise<string[]> | null = null

  constructor(root: string, events: FileEvents) {
    this.root = root
    this.events = events
  }

  async readdir(dir: string): Promise<DirEntry[]> {
    const dirents = await fsp.readdir(dir, { withFileTypes: true })
    const entries: DirEntry[] = []
    for (const d of dirents) {
      let isDir = d.isDirectory()
      if (d.isSymbolicLink()) {
        try {
          isDir = (await fsp.stat(path.join(dir, d.name))).isDirectory()
        } catch {
          isDir = false // dangling link
        }
      }
      entries.push({ name: d.name, kind: isDir ? 'dir' : 'file' })
    }
    entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1
    )
    return entries
  }

  async create(target: string, kind: 'dir' | 'file'): Promise<void> {
    if (kind === 'dir') {
      await fsp.mkdir(target)
    } else {
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, '', { flag: 'wx' }) // fails if it already exists
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      await fsp.access(to)
    } catch {
      await fsp.rename(from, to)
      return
    }
    throw new Error(`"${path.basename(to)}" already exists`)
  }

  private queue(file: string): void {
    this.pendingDirs.add(path.dirname(file))
    this.pendingFiles.add(file)
    this.listCache = null
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const dirs = [...this.pendingDirs]
      const files = [...this.pendingFiles]
      const git = this.pendingGit
      this.pendingDirs.clear()
      this.pendingFiles.clear()
      this.pendingGit = false
      if (dirs.length) this.events.dirsChanged(dirs)
      if (files.length) this.events.filesChanged(files)
      if (git || files.length) this.events.gitChanged()
    }, FLUSH_MS)
  }

  startWatching(): void {
    try {
      this.rootWatcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const name = filename.toString()
        const first = name.split(/[\\/]/)[0]
        if (first === '.git') {
          // Only these mean "status may have changed"; everything else under .git is noise.
          if (/^\.git[\\/](HEAD|index|refs[\\/].*|MERGE_HEAD|ORIG_HEAD)$/.test(name) && !name.endsWith('.lock')) {
            this.pendingGit = true
            this.queue(path.join(this.root, '.git'))
          }
          return
        }
        this.queue(path.join(this.root, name))
      })
      this.rootWatcher.on('error', () => {})
    } catch (err) {
      console.error('[host] could not watch workspace:', err)
    }
  }

  /** Watch a folder outside the workspace for as long as `holder` needs it. */
  acquire(holder: object, dir: string): void {
    if (isInside(this.root, dir)) return
    let entry = this.extra.get(dir)
    if (!entry) {
      let watcher: FSWatcher
      try {
        watcher = watch(dir, (_event, filename) => {
          if (filename) this.queue(path.join(dir, filename.toString()))
        })
        watcher.on('error', () => {})
      } catch {
        return
      }
      entry = { watcher, holders: new Map() }
      this.extra.set(dir, entry)
    }
    entry.holders.set(holder, (entry.holders.get(holder) ?? 0) + 1)
  }

  release(holder: object, dir: string): void {
    const entry = this.extra.get(dir)
    if (!entry) return
    const n = (entry.holders.get(holder) ?? 0) - 1
    if (n > 0) entry.holders.set(holder, n)
    else entry.holders.delete(holder)
    if (entry.holders.size === 0) {
      entry.watcher.close()
      this.extra.delete(dir)
    }
  }

  releaseAll(holder: object): void {
    for (const [dir, entry] of [...this.extra]) {
      if (!entry.holders.has(holder)) continue
      entry.holders.delete(holder)
      if (entry.holders.size === 0) {
        entry.watcher.close()
        this.extra.delete(dir)
      }
    }
  }

  /** Every file in the workspace (absolute paths), honoring .gitignore when it is a git repo. */
  list(): Promise<string[]> {
    if (!this.listCache) {
      this.listCache = this.gitList().catch(() => this.walkList())
    }
    return this.listCache
  }

  private gitList(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', this.root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) return reject(err)
          const files = stdout.split('\0').filter(Boolean).slice(0, MAX_LIST)
          resolve(files.map((f) => path.join(this.root, f)))
        }
      )
    })
  }

  private async walkList(): Promise<string[]> {
    const out: string[] = []
    const stack = [this.root]
    while (stack.length && out.length < MAX_LIST) {
      const dir = stack.pop()!
      let dirents
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const d of dirents) {
        if (d.isDirectory()) {
          if (!SKIP_DIRS.has(d.name)) stack.push(path.join(dir, d.name))
        } else if (d.isFile()) {
          out.push(path.join(dir, d.name))
        }
      }
    }
    return out.sort()
  }

  dispose(): void {
    this.rootWatcher?.close()
    for (const entry of this.extra.values()) entry.watcher.close()
    this.extra.clear()
  }
}
