// Plugins: folders with a package.json that add screens to the workbench.
//
// The app ships as one exe and cannot change its own files, so plugins live beside it:
//   - %APPDATA%\neon-editor\plugins\<plugin>\      (per user, survives exe updates)
//   - <folder of the exe>\plugins\<plugin>\         (travels with a portable exe)
// A screen is an HTML page served from its plugin folder at neon-plugin://<id>/<path> and shown
// in a sandboxed iframe. It talks to the editor only through the window's message bridge
// (src/renderer/src/plugins.ts), using the small API in PLUGIN_API_JS below.

import { app, protocol } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { PluginInfo, PluginList } from '../shared/protocol'
import { mimeOf, parseManifest, resolvePluginFile } from './pluginManifest'
import { PLUGIN_API_JS } from './pluginApi'

export const PLUGIN_SCHEME = 'neon-plugin'

export const PREVIEW_SCHEME = 'neon-preview'

/**
 * Registers the app's own URL schemes: plugin files and the HTML preview. Must run before the
 * app is ready, and only once (a later call would replace this list).
 */
export function registerSchemes(): void {
  const privileges = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  protocol.registerSchemesAsPrivileged([
    { scheme: PLUGIN_SCHEME, privileges },
    { scheme: PREVIEW_SCHEME, privileges }
  ])
}

export function pluginFolders(): string[] {
  const folders = [path.join(app.getPath('userData'), 'plugins')]
  // The portable exe unpacks to a temp folder; this variable names the folder it was started from.
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(process.execPath) : '')
  if (exeDir) folders.push(path.join(exeDir, 'plugins'))
  // Development: point at a folder of plugins being worked on.
  if (process.env.NEON_PLUGINS_DIR) folders.push(...process.env.NEON_PLUGINS_DIR.split(path.delimiter).filter(Boolean))
  return [...new Set(folders.map((f) => path.resolve(f)))]
}

let current: PluginList = { plugins: [], errors: [], folders: [] }

/** Scan the plugin folders again. The first plugin with a given id wins. */
export function scanPlugins(): PluginList {
  const folders = pluginFolders()
  const plugins: PluginInfo[] = []
  const errors: string[] = []
  for (const folder of folders) {
    let names: string[]
    try {
      names = fs.readdirSync(folder, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      continue // folder does not exist
    }
    for (const name of names.sort()) {
      const dir = path.join(folder, name)
      let json: unknown
      try {
        json = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      } catch (err) {
        errors.push(`${name}: could not read package.json (${err instanceof Error ? err.message : String(err)})`)
        continue
      }
      const r = parseManifest(json, dir)
      if ('error' in r) errors.push(r.error)
      else if (plugins.some((p) => p.id === r.plugin.id)) errors.push(`${r.plugin.id}: also found in ${dir}; using the first one`)
      else plugins.push(r.plugin)
    }
  }
  current = { plugins, errors, folders }
  return current
}

export function listPlugins(): PluginList {
  return current
}

/** Serve plugin files. Call once the app is ready. */
export function handlePluginProtocol(): void {
  protocol.handle(PLUGIN_SCHEME, async (request) => {
    const url = new URL(request.url)
    const plugin = current.plugins.find((p) => p.id === url.hostname)
    const headers = { 'access-control-allow-origin': '*', 'cache-control': 'no-cache' }
    if (!plugin) return new Response('Unknown plugin', { status: 404, headers })
    if (url.pathname === '/_neon/api.js' || url.pathname.endsWith('/_neon/api.js')) {
      return new Response(PLUGIN_API_JS, { headers: { ...headers, 'content-type': 'text/javascript; charset=utf-8' } })
    }
    const file = resolvePluginFile(plugin.dir, url.pathname)
    if (!file) return new Response('Bad path', { status: 400, headers })
    try {
      const body = await fs.promises.readFile(file)
      return new Response(body, { headers: { ...headers, 'content-type': mimeOf(file) } })
    } catch {
      return new Response('Not found', { status: 404, headers })
    }
  })
}

// ---------- per-plugin storage: a small JSON file each ----------

const MAX_STORAGE = 1024 * 1024

function storageFile(id: string): string | null {
  if (!current.plugins.some((p) => p.id === id)) return null
  return path.join(app.getPath('userData'), 'plugin-data', `${id}.json`)
}

export function storageGet(id: string): Record<string, unknown> {
  const file = storageFile(id)
  if (!file) return {}
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

export function storageSet(id: string, key: string, value: unknown): void {
  const file = storageFile(id)
  if (!file) throw new Error(`Unknown plugin ${id}`)
  const data = storageGet(id)
  if (value === undefined || value === null) delete data[key]
  else data[key] = value
  const text = JSON.stringify(data)
  if (text.length > MAX_STORAGE) throw new Error('Plugin storage is limited to 1 MB')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
