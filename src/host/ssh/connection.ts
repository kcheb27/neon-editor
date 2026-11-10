// One SSH connection to a host, shared by everything in the workspace. Handles auth (agent,
// keys, keyboard-interactive, password), host key checks, ProxyJump (one hop), keep-alives
// and reconnecting after a drop.

import * as fs from 'node:fs'
import ssh2 from 'ssh2'
import type { AnyAuthMethod, AuthenticationType, Client, ClientChannel, ConnectConfig, ParsedKey, SFTPWrapper } from 'ssh2'
import type { Duplex } from 'node:stream'
import type { RemoteStatus } from '../../shared/protocol'
import { resolveFromDisk, sshDir } from './config.ts'
import type { SshTarget } from './config.ts'
import { addKnownHost, checkKnownHosts, fingerprint, keyType, readKnownHosts } from './knownHosts.ts'

export interface PromptRequest {
  kind: 'password' | 'passphrase' | 'keyboard' | 'hostkey'
  title: string
  message: string
  /** Show what is typed (keyboard-interactive prompts that are not secrets). */
  echo?: boolean
}

export interface Prompter {
  /** Ask the user. Resolves null when they cancel. For 'hostkey', any non-null answer accepts. */
  ask(req: PromptRequest): Promise<string | null>
  status(s: RemoteStatus): void
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

// ssh2 is CommonJS: Node's ESM loader only offers its default export.
const { utils } = ssh2

const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'
const MAX_BACKOFF_MS = 30_000

function agentPath(): string | null {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
  if (process.platform === 'win32') {
    try {
      fs.statSync(WINDOWS_AGENT_PIPE)
      return WINDOWS_AGENT_PIPE
    } catch {
      return null
    }
  }
  return null
}

class Cancelled extends Error {}


export class SshConnection {
  readonly targetName: string
  private target: SshTarget
  private prompter: Prompter
  private client: Client | null = null
  private sftpChannel: Promise<SFTPWrapper> | null = null
  private connecting: Promise<Client> | null = null
  private everConnected = false
  private disposed = false
  private backoff = 1000
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private jump: SshConnection | null = null
  /** Kept in memory only, so a dropped connection can come back without asking again. */
  private rememberedPassword: string | null = null
  private rememberedPassphrases = new Map<string, string>()
  private lastError = ''
  private authCancelled = false
  private reconnectListeners = new Set<() => void>()
  private dropListeners = new Set<() => void>()

  constructor(target: string, prompter: Prompter) {
    this.targetName = target
    this.target = resolveFromDisk(target)
    this.prompter = prompter
  }

  get user(): string {
    return this.target.user
  }

  onReconnect(fn: () => void): void {
    this.reconnectListeners.add(fn)
  }

  onDrop(fn: () => void): void {
    this.dropListeners.add(fn)
  }

  /** The connected client, connecting first if needed. */
  ensure(): Promise<Client> {
    if (this.disposed) return Promise.reject(new Error('Connection closed'))
    if (this.client) return Promise.resolve(this.client)
    if (!this.connecting) {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer)
        this.retryTimer = null
      }
      this.prompter.status({ state: this.everConnected ? 'reconnecting' : 'connecting', detail: this.target.hostName, latencyMs: null })
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  /** Try again now (after a failure, or to skip the backoff wait). */
  retry(): Promise<Client> {
    this.backoff = 1000
    return this.ensure()
  }

  private async connect(): Promise<Client> {
    const t = this.target
    let sock: Duplex | undefined
    if (t.proxyJump) {
      this.jump = this.jump ?? new SshConnection(t.proxyJump, this.prompter)
      sock = await this.jump.forward(t.hostName, t.port)
    }

    const client = new ssh2.Client()
    let hostKeyProblem = ''
    this.authCancelled = false
    const config: ConnectConfig = {
      host: t.hostName,
      port: t.port,
      username: t.user,
      sock,
      readyTimeout: 30_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        const result = checkKnownHosts(readKnownHosts(sshDir()), t.hostName, t.port, key)
        if (result === 'match') return verify(true)
        if (result === 'changed' || result === 'revoked') {
          hostKeyProblem =
            `The host key for ${t.hostName} has changed (${keyType(key)} ${fingerprint(key)}). ` +
            'This could mean someone is intercepting the connection, or the server was reinstalled. ' +
            'If you expect the change, remove the old key from known_hosts and try again.'
          return verify(false)
        }
        this.prompter
          .ask({
            kind: 'hostkey',
            title: this.targetName === t.hostName ? `Unknown host ${t.hostName}` : `Unknown host ${this.targetName} (${t.hostName})`,
            message: `The authenticity of host "${t.hostName}" can't be established.\n${keyType(key)} key fingerprint is ${fingerprint(key)}.\nOnly continue if you recognise this fingerprint.`
          })
          .then((answer) => {
            if (answer === null) {
              hostKeyProblem = 'Host key not accepted.'
              return verify(false)
            }
            try {
              addKnownHost(sshDir(), t.hostName, t.port, key)
            } catch (err) {
              console.error('[ssh] could not update known_hosts:', err)
            }
            verify(true)
          })
          .catch(() => verify(false))
      },
      // ssh2 accepts `false` from the handler to mean "no more methods"; its types do not say so.
      authHandler: this.authHandler() as unknown as ConnectConfig['authHandler']
    }

    const started = Date.now()
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          client.removeListener('ready', onReady)
          reject(err)
        }
        const onReady = (): void => {
          client.removeListener('error', onError)
          resolve()
        }
        client.once('ready', onReady)
        client.once('error', onError)
        client.connect(config)
      })
    } catch (err) {
      client.end()
      const message =
        hostKeyProblem ||
        (this.authCancelled ? 'Cancelled' : err instanceof Error ? friendlyError(err, t) : String(err))
      this.lastError = message
      this.prompter.status({ state: 'failed', detail: message, latencyMs: null })
      if (this.everConnected && !hostKeyProblem && message !== 'Cancelled') this.scheduleRetry()
      throw new Error(message)
    }

    this.client = client
    this.sftpChannel = null
    this.backoff = 1000
    const reconnected = this.everConnected
    this.everConnected = true
    this.prompter.status({ state: 'connected', detail: t.hostName, latencyMs: Date.now() - started })

    const lost = (): void => {
      if (this.client !== client) return
      this.client = null
      this.sftpChannel = null
      for (const fn of this.dropListeners) fn()
      if (this.disposed) return
      this.prompter.status({ state: 'reconnecting', detail: `Connection to ${t.hostName} lost`, latencyMs: null })
      this.scheduleRetry()
    }
    client.on('close', lost)
    client.on('error', (err) => {
      console.error('[ssh] connection error:', err.message)
      lost()
    })
    if (reconnected) for (const fn of this.reconnectListeners) fn()
    return client
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.ensure().catch(() => {
        // connect() already reported and scheduled the next try
      })
    }, delay)
  }

  /** Auth order: agent, key files, then keyboard-interactive and password (asking the user). */
  private authHandler(): (left: AuthenticationType[] | null, partial: boolean | null, next: (m: AnyAuthMethod | false) => void) => void {
    const t = this.target
    const username = t.user
    const queue: (() => Promise<AnyAuthMethod | null>)[] = []
    const agent = agentPath()
    if (agent) queue.push(async () => ({ type: 'agent', username, agent }))
    for (const file of t.identityFiles) {
      queue.push(async () => {
        let data: Buffer
        try {
          data = fs.readFileSync(file)
        } catch {
          return null
        }
        let parsed = utils.parseKey(data)
        if (!(parsed instanceof Error)) return { type: 'publickey', username, key: first(parsed) }
        if (!/encrypted|passphrase/i.test(parsed.message)) return null
        const remembered = this.rememberedPassphrases.get(file)
        if (remembered) {
          parsed = utils.parseKey(data, remembered)
          if (!(parsed instanceof Error)) return { type: 'publickey', username, key: first(parsed) }
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          const pass = await this.prompter.ask({
            kind: 'passphrase',
            title: `Passphrase for ${file}`,
            message: attempt ? 'Wrong passphrase. Try again.' : `Enter the passphrase for key ${file}`
          })
          if (pass === null) return null
          parsed = utils.parseKey(data, pass)
          if (!(parsed instanceof Error)) {
            this.rememberedPassphrases.set(file, pass)
            return { type: 'publickey', username, key: first(parsed) }
          }
        }
        return null
      })
    }
    queue.push(async () => ({
      type: 'keyboard-interactive',
      username,
      prompt: (_name, instructions, _lang, prompts, finish) => {
        void (async () => {
          const answers: string[] = []
          for (const p of prompts) {
            const isSecret = !p.echo
            if (isSecret && this.rememberedPassword && /password/i.test(p.prompt)) {
              answers.push(this.rememberedPassword)
              continue
            }
            const a = await this.prompter.ask({
              kind: 'keyboard',
              title: `${username}@${t.hostName}`,
              message: [instructions, p.prompt].filter(Boolean).join('\n'),
              echo: p.echo
            })
            if (a === null) return finish([])
            if (isSecret && /password/i.test(p.prompt)) this.rememberedPassword = a
            answers.push(a)
          }
          finish(answers)
        })()
      }
    }))
    let passwordTries = 0
    const passwordStep = async (): Promise<AnyAuthMethod | null> => {
      if (this.rememberedPassword && passwordTries === 0) {
        passwordTries++
        return { type: 'password', username, password: this.rememberedPassword }
      }
      if (passwordTries >= 3) return null
      const pw = await this.prompter.ask({
        kind: 'password',
        title: `${username}@${t.hostName}`,
        message: passwordTries ? 'Permission denied. Enter the password again.' : `Password for ${username}@${t.hostName}`
      })
      passwordTries++
      if (pw === null) throw new Cancelled('Cancelled')
      this.rememberedPassword = pw
      return { type: 'password', username, password: pw }
    }
    for (let i = 0; i < 4; i++) queue.push(passwordStep)

    let index = 0
    return (left, _partial, next) => {
      const run = async (): Promise<void> => {
        while (index < queue.length) {
          const step = queue[index++]
          let method: AnyAuthMethod | null
          try {
            method = await step()
          } catch (err) {
            if (err instanceof Cancelled) {
              this.rememberedPassword = null
              this.authCancelled = true
              return next(false)
            }
            throw err
          }
          if (!method) continue
          // The server lists what it still accepts; agent and keys both use "publickey".
          const wanted = method.type === 'agent' ? 'publickey' : method.type
          if (left && !left.includes(wanted as AuthenticationType)) continue
          return next(method)
        }
        next(false)
      }
      run().catch(() => next(false))
    }
  }

  /** Open a TCP tunnel through this host (used as the socket for a ProxyJump target). */
  async forward(host: string, port: number): Promise<Duplex> {
    const client = await this.ensure()
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)))
    })
  }

  async exec(command: string, input?: string): Promise<ExecResult> {
    const client = await this.ensure()
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) return reject(err)
        const out: Buffer[] = []
        const errOut: Buffer[] = []
        let code = 0
        stream.on('data', (d: Buffer) => out.push(d))
        stream.stderr.on('data', (d: Buffer) => errOut.push(d))
        stream.on('exit', (c: number | null) => {
          code = c ?? 0
        })
        stream.on('close', () =>
          resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8'), code })
        )
        if (input !== undefined) stream.end(input)
        else stream.end()
      })
    })
  }

  /** Start a command with a terminal attached (for interactive shells). */
  async execPty(command: string, cols: number, rows: number): Promise<ClientChannel> {
    const client = await this.ensure()
    return new Promise((resolve, reject) => {
      client.exec(
        command,
        { pty: { term: 'xterm-256color', cols, rows, width: 0, height: 0 }, env: { TERM_PROGRAM: 'neon-editor' } },
        (err, stream) => (err ? reject(err) : resolve(stream))
      )
    })
  }

  async sftp(): Promise<SFTPWrapper> {
    const client = await this.ensure()
    if (!this.sftpChannel) {
      this.sftpChannel = new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) {
            this.sftpChannel = null
            return reject(err)
          }
          sftp.on('close', () => {
            if (this.client === client) this.sftpChannel = null
          })
          resolve(sftp)
        })
      })
    }
    return this.sftpChannel
  }

  get connected(): boolean {
    return !!this.client
  }

  get error(): string {
    return this.lastError
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.client?.end()
    this.client = null
    this.jump?.dispose()
  }
}

function first(parsed: ParsedKey | ParsedKey[]): ParsedKey {
  return Array.isArray(parsed) ? parsed[0] : parsed
}

function friendlyError(err: Error & { code?: string; level?: string }, t: SshTarget): string {
  const where = `${t.hostName}:${t.port}`
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return `Could not find host ${t.hostName}`
  if (err.code === 'ECONNREFUSED') return `Connection refused by ${where}. Is the SSH server running?`
  if (err.code === 'ETIMEDOUT' || /timed out/i.test(err.message)) return `Timed out connecting to ${where}`
  if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') return `Cannot reach ${where}`
  if (err.level === 'client-authentication' || /authentication methods failed/i.test(err.message)) {
    return `Permission denied for ${t.user}@${t.hostName}`
  }
  return err.message
}
