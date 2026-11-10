// Reads OpenSSH client config (~/.ssh/config): Host blocks, the options the editor uses,
// and Include of plain file names. Match blocks are skipped.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SshHostEntry } from '../../shared/protocol'

export interface SshTarget {
  /** What the user typed or picked: an alias or user@host[:port]. */
  target: string
  hostName: string
  user: string
  port: number
  identityFiles: string[]
  identitiesOnly: boolean
  proxyJump: string | null
}

interface Block {
  patterns: string[]
  options: [string, string][]
}

/** Folder holding config and known_hosts. Tests point NEON_SSH_DIR at a temporary folder. */
export function sshDir(): string {
  return process.env.NEON_SSH_DIR || path.join(os.homedir(), '.ssh')
}

function tokenize(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|([^\s=]+)/g
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2])
  return out
}

export function parseConfig(text: string, readInclude?: (file: string) => string | null): Block[] {
  const blocks: Block[] = [{ patterns: ['*'], options: [] }] // options before any Host apply to all
  let current = blocks[0]
  let depth = 0
  const visit = (src: string): void => {
    for (const raw of src.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const [key, ...values] = tokenize(line)
      if (!key) continue
      const k = key.toLowerCase()
      if (k === 'host') {
        current = { patterns: values, options: [] }
        blocks.push(current)
      } else if (k === 'match') {
        current = { patterns: [], options: [] } // never matches
        blocks.push(current)
      } else if (k === 'include' && readInclude && depth < 8) {
        depth++
        for (const file of values) {
          const content = readInclude(file)
          if (content !== null) visit(content)
        }
        depth--
      } else {
        current.options.push([k, values.join(' ')])
      }
    }
  }
  visit(text)
  return blocks
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
  return re.test(value)
}

function blockMatches(block: Block, host: string): boolean {
  let matched = false
  for (const p of block.patterns) {
    if (p.startsWith('!')) {
      if (globMatch(p.slice(1), host)) return false
    } else if (globMatch(p, host)) matched = true
  }
  return matched
}

/** Split "user@host:port" into parts. A bare alias comes back as { host }. */
export function splitTarget(target: string): { user?: string; host: string; port?: number } {
  let rest = target.trim()
  let user: string | undefined
  const at = rest.lastIndexOf('@')
  if (at > 0) {
    user = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }
  let port: number | undefined
  const bracket = /^\[(.+)\]:(\d+)$/.exec(rest)
  if (bracket) {
    rest = bracket[1]
    port = Number(bracket[2])
  } else {
    const colon = /^([^:]+):(\d+)$/.exec(rest)
    if (colon) {
      rest = colon[1]
      port = Number(colon[2])
    }
  }
  return { user, host: rest, port }
}

function expand(value: string, vars: { home: string; host: string; user: string; localUser: string }): string {
  let v = value
  if (v === '~' || v.startsWith('~/')) v = vars.home + v.slice(1)
  return v.replace(/%([dhru%])/g, (_m, c: string) =>
    c === 'd' ? vars.home : c === 'h' ? vars.host : c === 'r' ? vars.user : c === 'u' ? vars.localUser : '%'
  )
}

export function resolveTarget(target: string, configText: string, readInclude?: (file: string) => string | null): SshTarget {
  const parts = splitTarget(target)
  const blocks = parseConfig(configText, readInclude)
  const first = new Map<string, string>()
  const identity: string[] = []
  for (const block of blocks) {
    if (!blockMatches(block, parts.host)) continue
    for (const [k, v] of block.options) {
      if (k === 'identityfile') identity.push(v)
      else if (!first.has(k)) first.set(k, v)
    }
  }
  const home = os.homedir()
  const localUser = os.userInfo().username
  const hostName = first.get('hostname')?.replace(/%h/g, parts.host) ?? parts.host
  const user = parts.user ?? first.get('user') ?? localUser
  const port = parts.port ?? Number(first.get('port') ?? 22)
  const vars = { home, host: hostName, user, localUser }
  const defaults = ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((f) => path.join(sshDir(), f))
  const proxy = first.get('proxyjump')
  return {
    target,
    hostName,
    user,
    port: Number.isFinite(port) ? port : 22,
    identityFiles: identity.length ? identity.map((f) => expand(f, vars)) : defaults,
    identitiesOnly: first.get('identitiesonly')?.toLowerCase() === 'yes',
    proxyJump: proxy && proxy.toLowerCase() !== 'none' ? proxy.split(',')[0].trim() : null
  }
}

function readIncludeFrom(dir: string): (file: string) => string | null {
  return (file) => {
    const full = file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : path.isAbsolute(file) ? file : path.join(dir, file)
    if (/[*?]/.test(full)) return null // glob includes are not supported
    try {
      return fs.readFileSync(full, 'utf8')
    } catch {
      return null
    }
  }
}

export function readConfigText(): string {
  try {
    return fs.readFileSync(path.join(sshDir(), 'config'), 'utf8')
  } catch {
    return ''
  }
}

export function resolveFromDisk(target: string): SshTarget {
  return resolveTarget(target, readConfigText(), readIncludeFrom(sshDir()))
}

/** Concrete Host aliases (no wildcards) from ~/.ssh/config, for the host picker. */
export function listHosts(): SshHostEntry[] {
  const text = readConfigText()
  const blocks = parseConfig(text, readIncludeFrom(sshDir()))
  const seen = new Set<string>()
  const out: SshHostEntry[] = []
  for (const block of blocks) {
    for (const p of block.patterns) {
      if (/[*?!]/.test(p) || seen.has(p)) continue
      seen.add(p)
      const t = resolveTarget(p, text, readIncludeFrom(sshDir()))
      out.push({ alias: p, hostName: t.hostName, user: t.user, port: t.port })
    }
  }
  return out
}
