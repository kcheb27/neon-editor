// Runs the app against sample projects and checks it end to end:
//   1. a local git project (test/smoke.cjs)
//   2. the same kind of project over SSH, served by test/sshTestServer.cjs (test/smokeRemote.cjs)
// Screenshots go to .smoke/. Exits non-zero when a check fails.

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { utils } = require('ssh2')
const { startServer } = require('./sshTestServer.cjs')

const smokeDir = path.resolve(__dirname, '../.smoke')

function makeProject(dir) {
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  write('src/app.ts', [
    "import { greet } from './lib/greet'", '', '// Entry point for the sample project', 'export class App {',
    '  private count = 0', '  constructor(private name: string) {}', '', '  run(times: number): string[] {',
    '    const out: string[] = []', '    for (let i = 0; i < times; i++) {', '      this.count += 1',
    '      out.push(greet(this.name, i))', '    }', '    return out', '  }', '}', '',
    "const app = new App('neon')", "console.log(app.run(3).join('\\n'), true, null, 42)", ''
  ].join('\n'))
  write('src/lib/greet.ts', 'export function greet(name: string, n: number): string {\n  return `hello ${name} #${n}`\n}\n')
  write('package.json', '{\n  "name": "sample",\n  "private": true\n}\n')
  write('README.md', '# Sample\n\nA **sample** project.\n')
  write('.gitignore', 'node_modules/\n')
  write('node_modules/dep/index.js', 'module.exports = 1\n')
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
  fs.appendFileSync(path.join(dir, 'src/lib/greet.ts'), '// changed\n')
  write('TODO.txt', 'notes\n')
}

function runApp(args, env) {
  return new Promise((resolve) => {
    const child = spawn(require('electron'), ['.', ...args], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, ...env },
      stdio: 'inherit'
    })
    const timer = setTimeout(() => child.kill(), 180000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}

async function main() {
  fs.rmSync(smokeDir, { recursive: true, force: true })

  // 1. Local project.
  const local = path.join(smokeDir, 'project')
  makeProject(local)
  const localCode = await runApp([local], { NEON_SMOKE: path.join(__dirname, 'smoke.cjs') })

  // 2. SSH project. Test-only credentials for a server that lives only in this process.
  const home = path.join(smokeDir, 'remote-home')
  const remoteProject = path.join(home, 'project')
  makeProject(remoteProject)
  const sshDir = path.join(smokeDir, 'ssh')
  fs.mkdirSync(sshDir, { recursive: true })
  const password = 'neon-smoke-test-only'
  const server = await startServer({ home, user: 'dev', password, hostKey: utils.generateKeyPairSync('ed25519').private })
  fs.writeFileSync(path.join(sshDir, 'config'), `Host neon-test\n  HostName 127.0.0.1\n  Port ${server.port}\n  User dev\n`)
  const env = {
    NEON_SMOKE: path.join(__dirname, 'smokeRemote.cjs'),
    NEON_SSH_DIR: sshDir,
    NEON_SMOKE_REMOTE_PROJECT: remoteProject,
    NEON_SMOKE_REMOTE_PASSWORD: password,
    SSH_AUTH_SOCK: ''
  }
  const remoteCode = await runApp(['ssh://neon-test/~/project'], env)
  await server.close()

  console.log(`[smoke] local: ${localCode === 0 ? 'passed' : 'FAILED'}, ssh: ${remoteCode === 0 ? 'passed' : 'FAILED'}`)
  process.exit(localCode || remoteCode)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
