import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { parseGrepOutput, buildPattern } from '../src/host/search.ts'
import { resolveTarget, splitTarget } from '../src/host/ssh/config.ts'
import { checkKnownHosts, fingerprint, keyType } from '../src/host/ssh/knownHosts.ts'
import { shq, shqPath } from '../src/host/ssh/quote.ts'
import { makeRemoteId, parseRemoteId, workspaceLabel } from '../src/shared/workspaceId.ts'

function fakeKey(type: string, body: string): Buffer {
  const t = Buffer.from(type)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(t.length)
  return Buffer.concat([len, t, Buffer.from(body)])
}

test('workspace ids: round trip for home, absolute and root paths', () => {
  for (const [host, p, expected] of [
    ['devbox', '~', '~'],
    ['devbox', '~/proj', '~/proj'],
    ['me@example.com:2222', '/srv/app/', '/srv/app'],
    ['devbox', '/', '/']
  ]) {
    const id = makeRemoteId(host, p)
    assert.deepEqual(parseRemoteId(id), { host, path: expected }, id)
  }
  assert.equal(parseRemoteId('C:\\code\\app'), null)
  assert.equal(workspaceLabel(makeRemoteId('devbox', '/srv/app'), (x) => x), 'devbox: app')
})

test('ssh config: Host blocks, first value wins, wildcards and defaults', () => {
  const config = `
User everyone
Host devbox
  HostName 10.0.0.5
  Port 2222
  IdentityFile ~/.ssh/devbox_key
  ProxyJump bastion
Host *.internal !secret.internal
  User ops
Host *
  User fallback
  IdentityFile ~/.ssh/common
`
  const dev = resolveTarget('devbox', config)
  assert.equal(dev.hostName, '10.0.0.5')
  assert.equal(dev.port, 2222)
  assert.equal(dev.user, 'everyone') // the option before any Host block applies first
  assert.equal(dev.proxyJump, 'bastion')
  assert.ok(dev.identityFiles[0].endsWith('devbox_key'))
  assert.ok(dev.identityFiles[1].endsWith('common'))

  assert.equal(resolveTarget('db.internal', 'Host *.internal\n User ops\n').user, 'ops')
  assert.notEqual(resolveTarget('secret.internal', 'Host *.internal !secret.internal\n User ops\n').user, 'ops')

  const typed = resolveTarget('alice@example.com:2200', config)
  assert.equal(typed.user, 'alice')
  assert.equal(typed.port, 2200)
  assert.equal(typed.hostName, 'example.com')
  assert.deepEqual(splitTarget('[::1]:22'), { user: undefined, host: '::1', port: 22 })
})

test('known_hosts: match, unknown, changed, hashed names, non-standard port, revoked', () => {
  const key = fakeKey('ssh-ed25519', 'AAAA-real')
  const other = fakeKey('ssh-ed25519', 'BBBB-other')
  const rsa = fakeKey('ssh-rsa', 'CCCC')
  const b64 = key.toString('base64')
  assert.equal(keyType(key), 'ssh-ed25519')
  assert.match(fingerprint(key), /^SHA256:[A-Za-z0-9+/]+$/)

  assert.equal(checkKnownHosts(`devbox ssh-ed25519 ${b64}\n`, 'devbox', 22, key), 'match')
  assert.equal(checkKnownHosts('', 'devbox', 22, key), 'unknown')
  assert.equal(checkKnownHosts(`devbox ssh-ed25519 ${b64}\n`, 'devbox', 22, other), 'changed')
  assert.equal(checkKnownHosts(`devbox ssh-rsa ${rsa.toString('base64')}\n`, 'devbox', 22, key), 'unknown')
  assert.equal(checkKnownHosts(`[devbox]:2222 ssh-ed25519 ${b64}\n`, 'devbox', 2222, key), 'match')
  assert.equal(checkKnownHosts(`devbox ssh-ed25519 ${b64}\n`, 'devbox', 2222, key), 'unknown')
  assert.equal(checkKnownHosts(`@revoked devbox ssh-ed25519 ${b64}\n`, 'devbox', 22, key), 'revoked')

  const salt = randomBytes(20)
  const hashed = `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update('devbox').digest('base64')}`
  assert.equal(checkKnownHosts(`${hashed} ssh-ed25519 ${b64}\n`, 'devbox', 22, key), 'match')
  assert.equal(checkKnownHosts(`${hashed} ssh-ed25519 ${b64}\n`, 'other', 22, key), 'unknown')
})

test('shell quoting survives quotes, spaces and tildes', () => {
  assert.equal(shq('plain/path-1.txt'), 'plain/path-1.txt')
  assert.equal(shq("it's here"), `'it'\\''s here'`)
  assert.equal(shq(''), "''")
  assert.equal(shqPath('~/my dir'), `~/'my dir'`)
  assert.equal(shqPath('/abs/x'), '/abs/x')
})

test('grep output: git grep and grep formats, columns found again', () => {
  const pattern = buildPattern({ query: 'greet', regex: false, caseSensitive: false })
  const out = 'src/app.ts\x001\x00import { greet } from "./greet" // greet\n./lib/g.ts\x0012:  return greet()\n'
  const r = parseGrepOutput(out, (rel) => `/root/${rel.replace(/^\.\//, '')}`, pattern)
  assert.equal(r.files, 2)
  assert.deepEqual(
    r.matches.map((m) => [m.path, m.line, m.col]),
    [
      ['/root/src/app.ts', 1, 10],
      ['/root/src/app.ts', 1, 26], // inside "./greet"
      ['/root/src/app.ts', 1, 36],
      ['/root/lib/g.ts', 12, 10]
    ]
  )
})
