// Connection from this window to its Workspace Host, and the bridge to the main process.

import type { WireMessage } from '../../shared/protocol'

interface NeonBridge {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (payload: any) => void): void
}

export const neon: NeonBridge = (window as unknown as { neon: NeonBridge }).neon

type Listener = (args: any) => void

export class Host {
  private port: MessagePort
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, Set<Listener>>()

  constructor(port: MessagePort) {
    this.port = port
    port.onmessage = (event) => {
      const msg = event.data as WireMessage
      if (msg.t === 'res') {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (!p) return
        if (msg.ok) p.resolve(msg.r)
        else p.reject(new Error(msg.e))
      } else if (msg.t === 'evt') {
        for (const fn of this.listeners.get(msg.m) ?? []) fn(msg.a)
      }
    }
  }

  call<T = any>(method: string, args: unknown = {}): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.port.postMessage({ t: 'req', id, m: method, a: args } satisfies WireMessage)
    })
  }

  /** Fire-and-forget: no reply is sent. */
  notify(method: string, args: unknown = {}): void {
    this.port.postMessage({ t: 'req', id: -1, m: method, a: args } satisfies WireMessage)
  }

  on(method: string, fn: Listener): void {
    let set = this.listeners.get(method)
    if (!set) this.listeners.set(method, (set = new Set()))
    set.add(fn)
  }
}

/** Resolves with the host connection once the main process has delivered its port. */
export function waitForHostPort(): Promise<Host> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== window || event.data?.type !== 'neon-host-port' || !event.ports[0]) return
      window.removeEventListener('message', onMessage)
      resolve(new Host(event.ports[0]))
    }
    window.addEventListener('message', onMessage)
  })
}
