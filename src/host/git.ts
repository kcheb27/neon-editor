// Git status for the workspace, read by running the user's own `git` (locally or on the SSH host).

import type { GitStatus } from '../shared/protocol'
import type { PathApi } from './backend.ts'
import { parsePorcelainV2 } from './gitParse.ts'

const NONE: GitStatus = { repo: false, branch: '', ahead: 0, behind: 0, files: {} }

export class Git {
  private run: (args: string[]) => Promise<string>
  private path: PathApi
  private root: () => string
  private toplevel: string | null | undefined
  private running: Promise<GitStatus> | null = null

  /** `run` executes git in the workspace folder and resolves with stdout. */
  constructor(run: (args: string[]) => Promise<string>, pathApi: PathApi, root: () => string) {
    this.run = run
    this.path = pathApi
    this.root = root
  }

  /** The repository's top folder, or null when the workspace is not in a repository. */
  async findToplevel(): Promise<string | null> {
    if (this.toplevel === undefined) {
      try {
        // Work out the top folder from where the workspace sits inside the repository, rather
        // than trusting --show-toplevel: that resolves symlinks (and on Windows-hosted git
        // returns C:/ paths), so its paths may not match the ones the editor uses.
        const prefix = (await this.run(['rev-parse', '--show-prefix'])).trim()
        const up = prefix.split('/').filter(Boolean).map(() => '..')
        this.toplevel = this.path.resolve(this.root(), ...up)
      } catch {
        this.toplevel = null // not a repository, or git is not installed
      }
    }
    return this.toplevel
  }

  private async read(): Promise<GitStatus> {
    const top = await this.findToplevel()
    if (!top) return NONE
    let out: string
    try {
      out = await this.run(['status', '--porcelain=v2', '--branch', '-z', '--ignored'])
    } catch {
      this.toplevel = undefined // maybe .git was removed; look again next time
      return NONE
    }
    const parsed = parsePorcelainV2(out)
    const files: Record<string, string> = {}
    for (const e of parsed.entries) files[this.path.resolve(top, e.path)] = e.code
    return { repo: true, branch: parsed.branch, ahead: parsed.ahead, behind: parsed.behind, files }
  }

  /** Current status. Calls made while a read is running share its result. */
  status(): Promise<GitStatus> {
    if (!this.running) {
      this.running = this.read().finally(() => {
        this.running = null
      })
    }
    return this.running
  }
}
