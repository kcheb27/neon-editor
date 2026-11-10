// Host key checking against OpenSSH's known_hosts file, including hashed entries.

import { createHash, createHmac } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export type HostKeyResult = 'match' | 'unknown' | 'changed' | 'revoked'

/** The name known_hosts uses: "host" on port 22, otherwise "[host]:port". */
export function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/** Key type ("ssh-ed25519", ...) from a raw SSH public key blob. */
export function keyType(raw: Buffer): string {
  if (raw.length < 4) return ''
  const len = raw.readUInt32BE(0)
  return raw.subarray(4, 4 + len).toString('ascii')
}

export function fingerprint(raw: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')
}

function patternMatches(pattern: string, name: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|')
    if (!salt || !hash) return false
    const digest = createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64')
    return digest === hash
  }
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
  return re.test(name)
}

function hostListMatches(list: string, name: string): boolean {
  let matched = false
  for (const p of list.split(',')) {
    if (p.startsWith('!')) {
      if (patternMatches(p.slice(1), name)) return false
    } else if (patternMatches(p, name)) matched = true
  }
  return matched
}

export function checkKnownHosts(text: string, host: string, port: number, raw: Buffer): HostKeyResult {
  const name = knownHostsName(host, port)
  const type = keyType(raw)
  const b64 = raw.toString('base64')
  let sameTypeOtherKey = false
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    let fields = trimmed.split(/\s+/)
    let marker = ''
    if (fields[0].startsWith('@')) {
      marker = fields[0]
      fields = fields.slice(1)
    }
    const [hosts, t, key] = fields
    if (!hosts || !t || !key || !hostListMatches(hosts, name)) continue
    if (marker === '@revoked') {
      if (key === b64) return 'revoked'
      continue
    }
    if (marker === '@cert-authority') continue // certificates are not supported
    if (t !== type) continue
    if (key === b64) return 'match'
    sameTypeOtherKey = true
  }
  return sameTypeOtherKey ? 'changed' : 'unknown'
}

export function readKnownHosts(dir: string): string {
  try {
    return fs.readFileSync(path.join(dir, 'known_hosts'), 'utf8')
  } catch {
    return ''
  }
}

export function addKnownHost(dir: string, host: string, port: number, raw: Buffer): void {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'known_hosts')
  let prefix = ''
  try {
    const existing = fs.readFileSync(file, 'utf8')
    if (existing && !existing.endsWith('\n')) prefix = '\n'
  } catch {
    // new file
  }
  fs.appendFileSync(file, `${prefix}${knownHostsName(host, port)} ${keyType(raw)} ${raw.toString('base64')}\n`)
}
