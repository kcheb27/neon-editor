// RemoteBackend against a real SSH server (test/sshTestServer.cjs) on 127.0.0.1.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, test } from 'node:test'
import ssh2 from 'ssh2'
import { CwdParser } from '../src/host/cwdParser.ts'
import { Git } from '../src/host/git.ts'
import { RemoteBackend } from '../src/host/remoteBackend.ts'
import type { Prompter, PromptRequest } from '../src/host/ssh/connection.ts'
import { makeRemoteId } from '../src/shared/workspaceId.ts'
import type { RemoteStatus } from '../src/shared/protocol.ts'

const { utils } = ssh2
const require = createRequire(import.meta.url)
const { startServer } = require('./sshTestServer.cjs')

// Test-only credentials for a server that exists only inside this test.
const USER = 'dev'
const PASSWORD = 'neon-test-only-password'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-ssh-'))
const home = path.join(tmp, 'home')
const sshDir = path.join(tmp, 'ssh')
const project = path.join(home, 'project')
let server: any
const backends: RemoteBackend[] = []

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await fn()) return true
    await wait(100)
  }
  return false
}

class TestPrompter implements Prompter {
  asked: PromptRequest[] = []
  states: RemoteStatus[] = []
  password = PASSWORD
  acceptHostKey = true
  async ask(req: PromptRequest): Promise<string | null> {
    this.asked.push(req)
    if (req.kind === 'hostkey') return this.acceptHostKey ? 'yes' : null
    if (req.kind === 'password') return this.password
    return null
  }
  status(s: RemoteStatus): void {
    this.states.push(s)
  }
}

function backend(prompter: Prompter, folder = '~/project'): RemoteBackend {
  const b = new RemoteBackend(makeRemoteId('neon-test', folder), prompter)
  backends.push(b)
  return b
}

before(async () => {
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.mkdirSync(sshDir, { recursive: true })
  fs.writeFileSync(path.join(project, 'src', 'app.ts'), "import { greet } from './greet'\nconsole.log(greet('neon'))\n")
  fs.writeFileSync(path.join(project, 'src', 'greet.ts'), 'export const greet = (n: string) => `hi ${n}`\n')
  fs.writeFileSync(path.join(project, 'README.md'), '# remote\n')
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: project, stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')

  const hostKey = utils.generateKeyPairSync('ed25519').private
  server = await startServer({ home, user: USER, password: PASSWORD, hostKey })
  fs.writeFileSync(path.join(sshDir, 'config'), `Host neon-test\n  HostName 127.0.0.1\n  Port ${server.port}\n  User ${USER}\n`)
  process.env.NEON_SSH_DIR = sshDir
  delete process.env.SSH_AUTH_SOCK
})

after(async () => {
  for (const b of backends) b.dispose()
  await server?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('first connection asks about the host key, then for the password, and records the key', async () => {
  const prompter = new TestPrompter()
  const b = backend(prompter)
  const info = await b.info()
  assert.equal(info.remote, true)
  assert.equal(info.sshHost, 'neon-test')
  assert.ok(info.root.endsWith('/home/project'), info.root)
  assert.equal(info.label, 'neon-test: project')
  assert.deepEqual(prompter.asked.map((a) => a.kind), ['hostkey', 'password'])
  assert.match(prompter.asked[0].message, /SHA256:/)
  assert.match(fs.readFileSync(path.join(sshDir, 'known_hosts'), 'utf8'), /^\[127\.0\.0\.1\]:\d+ ssh-ed25519 /)
  assert.equal(prompter.states.at(-1)?.state, 'connected')
})

test('a known host is not asked about again', async () => {
  const prompter = new TestPrompter()
  await backend(prompter).info()
  assert.deepEqual(prompter.asked.map((a) => a.kind), ['password'])
})

test('a changed host key is refused', async () => {
  const good = fs.readFileSync(path.join(sshDir, 'known_hosts'), 'utf8')
  const other = utils.parseKey(utils.generateKeyPairSync('ed25519').private) as any
  fs.writeFileSync(path.join(sshDir, 'known_hosts'), `[127.0.0.1]:${server.port} ssh-ed25519 ${other.getPublicSSH().toString('base64')}\n`)
  try {
    const prompter = new TestPrompter()
    await assert.rejects(backend(prompter).info(), /host key .* has changed/i)
    assert.ok(!prompter.asked.some((a) => a.kind === 'password'), 'must not send a password to an impostor')
  } finally {
    fs.writeFileSync(path.join(sshDir, 'known_hosts'), good)
  }
})

test('a wrong password is asked again, and cancelling reports Cancelled', async () => {
  const prompter = new TestPrompter()
  let calls = 0
  prompter.ask = async (req) => {
    prompter.asked.push(req)
    if (req.kind !== 'password') return null
    calls++
    return calls === 1 ? 'wrong' : null
  }
  await assert.rejects(backend(prompter).info(), /Cancelled/)
  assert.equal(calls, 2)
  assert.match(prompter.asked[1].message, /again/i)
})

test('a missing folder gives a clear error', async () => {
  await assert.rejects(backend(new TestPrompter(), '/c/definitely/not/here').info(), /Folder not found/)
})

test('files: list, read, write, create, rename and trash over SFTP', async () => {
  const b = backend(new TestPrompter())
  const { root } = await b.info()
  const entries = await b.readdir(root)
  assert.deepEqual(entries.filter((e) => e.name !== '.git'), [
    { name: 'src', kind: 'dir' },
    { name: 'README.md', kind: 'file' }
  ])
  const readme = `${root}/README.md`
  assert.equal(Buffer.from(await b.readFile(readme)).toString(), '# remote\n')
  await b.writeFile(readme, '# remote\nedited\n')
  assert.equal(fs.readFileSync(path.join(project, 'README.md'), 'utf8'), '# remote\nedited\n')
  assert.deepEqual(fs.readdirSync(project).filter((n) => n.includes('neon-')), [], 'no temp files left behind')

  await b.create(`${root}/notes.txt`, 'file')
  await assert.rejects(b.create(`${root}/notes.txt`, 'file'), /already exists/)
  await b.create(`${root}/docs`, 'dir')
  await b.rename(`${root}/notes.txt`, `${root}/docs/notes.txt`)
  assert.ok(fs.existsSync(path.join(project, 'docs', 'notes.txt')))
  await assert.rejects(b.rename(`${root}/README.md`, `${root}/src`), /already exists/)

  await b.trash(`${root}/docs/notes.txt`)
  assert.ok(!fs.existsSync(path.join(project, 'docs', 'notes.txt')))
  const trashed = fs.readdirSync(path.join(home, '.local/share/Trash/files'))
  assert.ok(trashed.some((n) => n.startsWith('notes.txt.')), trashed.join(','))
})

test('list, search and git run as commands on the host', async () => {
  const b = backend(new TestPrompter())
  const { root } = await b.info()
  const files = await b.list()
  assert.ok(files.includes(`${root}/src/app.ts`), files.join('\n'))
  assert.ok(!files.some((f) => f.includes('/.git/')))

  const res = await b.search({ query: 'greet', regex: false, caseSensitive: true })
  const where = res.matches.map((m) => `${path.posix.basename(m.path)}:${m.line}:${m.col}`).sort()
  assert.deepEqual(where, ['app.ts:1:10', 'app.ts:1:26', 'app.ts:2:13', 'greet.ts:1:14'])
  const rx = await b.search({ query: 'gr[e]+t\\(', regex: true, caseSensitive: true })
  assert.deepEqual(rx.matches.map((m) => `${path.posix.basename(m.path)}:${m.line}`), ['app.ts:2'])
  assert.equal((await b.search({ query: "it's not there", regex: false, caseSensitive: false })).matches.length, 0)

  const git = new Git((args) => b.git(args), b.path, () => root)
  const status = await git.status()
  assert.equal(status.repo, true)
  assert.equal(status.files[`${root}/README.md`], 'M') // edited in the previous test
})

test('a remote shell reports its folder after cd', async () => {
  const b = backend(new TestPrompter())
  const { root } = await b.info()
  const shell = await b.spawnShell(root, 100, 30)
  const parser = new CwdParser(false)
  let cwd = ''
  let output = ''
  shell.pty.onData((d) => {
    output += d
    const r = parser.feed(d)
    if (r) cwd = r.path
  })
  assert.ok(await until(() => cwd === root), `first prompt should report ${root}; got "${cwd}"\n${output.slice(-400)}`)
  shell.pty.write('cd src\r')
  assert.ok(await until(() => cwd === `${root}/src`), `after cd: "${cwd}"`)
  let exited = false
  shell.pty.onExit(() => {
    exited = true
  })
  shell.pty.write('exit\r')
  assert.ok(await until(() => exited))
})

test('a terminal on another SSH host (no folder given) starts in its home folder', async () => {
  // How the Workspace Host opens a terminal on a host other than the workspace's.
  const b = backend(new TestPrompter(), '~')
  const shell = await b.spawnShell('', 100, 30)
  const parser = new CwdParser(false)
  let cwd = ''
  shell.pty.onData((d) => {
    const r = parser.feed(d)
    if (r) cwd = r.path
  })
  const expected = fs.realpathSync(home)
  assert.ok(await until(() => cwd === expected || cwd === home), `expected ${home}; got "${cwd}"`)
  assert.equal(shell.cwd, cwd)
  shell.pty.write('exit\r')
})

test('polling notices files added on the host, even in the same second', async () => {
  const b = backend(new TestPrompter())
  const { root } = await b.info()
  const changed: string[] = []
  b.startWatching({ dirsChanged: (d) => changed.push(...d), filesChanged() {}, gitChanged() {} })
  await b.readdir(`${root}/src`)
  await wait(300)
  fs.writeFileSync(path.join(project, 'src', 'added.ts'), 'x')
  assert.ok(await until(() => changed.includes(`${root}/src`), 7000), `changed: ${changed.join(',')}`)
})

test('the connection comes back after a drop without asking again', async () => {
  const prompter = new TestPrompter()
  const b = backend(prompter)
  const { root } = await b.info()
  const asked = prompter.asked.length
  server.dropAll()
  assert.ok(await until(() => prompter.states.some((s) => s.state === 'reconnecting')), 'reports reconnecting')
  assert.ok(await until(() => prompter.states.at(-1)?.state === 'connected', 10000), 'reconnects')
  assert.equal(prompter.asked.length, asked, 'the remembered password is reused')
  assert.equal(Buffer.from(await b.readFile(`${root}/src/app.ts`)).toString().split('\n')[0], "import { greet } from './greet'")
})

