import assert from 'node:assert/strict'
import test from 'node:test'
import type { PtyLike } from '../src/host/backend.ts'
import { Terminals } from '../src/host/terminals.ts'

function fakeSpawner(shell: string, calls: string[]) {
  return async (cwd: string) => {
    calls.push(cwd)
    const pty: PtyLike = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }
    return { pty, shell, cwd: cwd || `/home/${shell}` }
  }
}

const owner = { send() {} }

test('a terminal on another machine uses that machine\'s shell and its own start folder', async () => {
  const remoteCalls: string[] = []
  const localCalls: string[] = []
  const terms = new Terminals('/srv/project', fakeSpawner('bash', remoteCalls), false)

  const remote = await terms.create(owner, undefined, 80, 24)
  assert.deepEqual(remote, { id: 1, shell: 'bash', cwd: '/srv/project' })

  const local = await terms.create(owner, undefined, 80, 24, { spawn: fakeSpawner('powershell', localCalls), windowsPaths: true })
  assert.deepEqual(local, { id: 2, shell: 'powershell', cwd: '/home/powershell' })

  assert.deepEqual(remoteCalls, ['/srv/project'])
  assert.deepEqual(localCalls, [''], 'the workspace folder belongs to another machine, so this shell must not get it')
})
