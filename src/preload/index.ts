// Preload: the only bridge between a sandboxed window and the main process.

import { contextBridge, ipcRenderer } from 'electron'

const INVOKE = new Set([
  'window:init',
  'window:new',
  'window:devtools',
  'workspace:pick',
  'workspace:open',
  'workspace:openRemote',
  'ssh:hosts',
  'shell:trash',
  'shell:reveal',
  'dialog:confirm',
  'clipboard:read',
  'clipboard:write'
])
const SEND = new Set(['window:layout'])
const LISTEN = new Set(['window:count'])

contextBridge.exposeInMainWorld('neon', {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  send(channel: string, ...args: unknown[]): void {
    if (SEND.has(channel)) ipcRenderer.send(channel, ...args)
  },
  on(channel: string, listener: (payload: unknown) => void): void {
    if (LISTEN.has(channel)) ipcRenderer.on(channel, (_event, payload) => listener(payload))
  }
})

// The Workspace Host's MessagePort arrives from the main process; hand it to the page.
ipcRenderer.on('host-port', (event) => {
  window.postMessage({ type: 'neon-host-port' }, '*', event.ports)
})
