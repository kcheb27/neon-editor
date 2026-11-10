// Terminals. Each one is a shell owned by the Workspace Host (a local pty, or a pty on the
// SSH host). The host reads the shell's current directory out of the output stream so a
// file tree can follow it.

import type { TermCreated } from '../shared/protocol'
import type { PtyLike, SpawnedShell } from './backend.ts'
import { CwdParser } from './cwdParser.ts'

export interface TermOwner {
  send(method: string, args: unknown): void
}

interface Term {
  id: number
  proc: PtyLike
  owner: TermOwner
  cwd: string
  parser: CwdParser
}

export type ShellSpawner = (cwd: string, cols: number, rows: number) => Promise<SpawnedShell>

export class Terminals {
  private terms = new Map<number, Term>()
  private nextId = 1
  private defaultCwd: string
  private spawn: ShellSpawner
  private windowsPaths: boolean

  constructor(defaultCwd: string, spawn: ShellSpawner, windowsPaths: boolean) {
    this.defaultCwd = defaultCwd
    this.spawn = spawn
    this.windowsPaths = windowsPaths
  }

  setDefaultCwd(cwd: string): void {
    this.defaultCwd = cwd
  }

  /**
   * Start a shell. `other` runs it somewhere other than the workspace's own machine (a local
   * shell in an SSH workspace); it then starts in its own default folder, not the workspace's.
   */
  async create(
    owner: TermOwner,
    cwd: string | undefined,
    cols: number,
    rows: number,
    other?: { spawn: ShellSpawner; windowsPaths: boolean }
  ): Promise<TermCreated> {
    const spawn = other?.spawn ?? this.spawn
    const startDir = cwd || (other ? '' : this.defaultCwd)
    const { pty, shell, cwd: actualCwd } = await spawn(startDir, Math.max(cols, 20), Math.max(rows, 5))
    const id = this.nextId++
    const term: Term = { id, proc: pty, owner, cwd: actualCwd, parser: new CwdParser(other?.windowsPaths ?? this.windowsPaths) }
    this.terms.set(id, term)

    pty.onData((data) => {
      const report = term.parser.feed(data)
      if (report && report.path !== term.cwd) {
        term.cwd = report.path
        term.owner.send('term.cwd', { id, cwd: report.path, host: report.host })
      }
      term.owner.send('term.data', { id, data })
    })
    pty.onExit((exitCode) => {
      if (this.terms.delete(id)) term.owner.send('term.exit', { id, exitCode })
    })
    return other ? { id, shell, cwd: actualCwd, local: true } : { id, shell, cwd: actualCwd }
  }

  input(id: number, data: string): void {
    this.terms.get(id)?.proc.write(data)
  }

  resize(id: number, cols: number, rows: number): void {
    const term = this.terms.get(id)
    if (!term || cols < 2 || rows < 1) return
    try {
      term.proc.resize(cols, rows)
    } catch {
      // the process may have just exited
    }
  }

  kill(id: number): void {
    const term = this.terms.get(id)
    if (!term) return
    this.terms.delete(id)
    try {
      term.proc.kill()
    } catch {
      // already gone
    }
  }

  killOwnedBy(owner: TermOwner): void {
    for (const term of [...this.terms.values()]) {
      if (term.owner === owner) this.kill(term.id)
    }
  }

  dispose(): void {
    for (const id of [...this.terms.keys()]) this.kill(id)
  }
}
