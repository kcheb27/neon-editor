// Plugin manifests: reading package.json and resolving a plugin's files safely.
// No Electron imports here so it can be unit-tested with plain Node.

import * as path from 'node:path'
import type { PluginInfo, PluginScreen } from '../shared/protocol'

/** The plugin API version this build provides. A plugin asks for one in "neon.apiVersion". */
export const PLUGIN_API_VERSION = 1

// Plugin ids become the host part of neon-plugin://<id>/ URLs, so keep them URL-safe.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** A path inside the plugin folder: relative, forward slashes, no "..", no drive letters. */
export function safeRelative(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return null
  const clean = p.replace(/\\/g, '/').replace(/^\.\//, '')
  if (clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) return null
  if (clean.split('/').some((part) => part === '..' || part === '')) return null
  return clean
}

export function parseManifest(json: unknown, dir: string): { plugin: PluginInfo } | { error: string } {
  const where = path.basename(dir)
  if (!json || typeof json !== 'object') return { error: `${where}: package.json is not an object` }
  const m = json as Record<string, any>
  const id = typeof m.name === 'string' ? m.name.toLowerCase() : ''
  if (!ID_RE.test(id)) return { error: `${where}: "name" must be lowercase letters, digits and dashes` }
  const neon = m.neon
  if (!neon || typeof neon !== 'object') return { error: `${id}: package.json has no "neon" section` }
  if (neon.apiVersion !== PLUGIN_API_VERSION) {
    return { error: `${id}: needs plugin API version ${neon.apiVersion}, this build provides ${PLUGIN_API_VERSION}` }
  }
  const screens: PluginScreen[] = []
  for (const [i, s] of (Array.isArray(neon.screens) ? neon.screens : []).entries()) {
    const sid = typeof s?.id === 'string' ? s.id : ''
    const entry = safeRelative(s?.entry)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sid)) return { error: `${id}: screens[${i}].id is missing or invalid` }
    if (!entry) return { error: `${id}: screens[${i}].entry must be a relative path inside the plugin folder` }
    const icon = typeof s.icon === 'string' ? s.icon : ''
    screens.push({
      id: sid,
      title: typeof s.title === 'string' && s.title ? s.title : sid,
      entry,
      icon: /\.(svg|png)$/i.test(icon) ? (safeRelative(icon) ?? '') : icon
    })
  }
  if (!screens.length) return { error: `${id}: "neon.screens" lists no screens` }
  return {
    plugin: {
      id,
      name: typeof m.displayName === 'string' && m.displayName ? m.displayName : id,
      version: typeof m.version === 'string' ? m.version : '0.0.0',
      dir,
      screens
    }
  }
}

/** Absolute path of a file requested as neon-plugin://<id>/<urlPath>, or null if it escapes the folder. */
export function resolvePluginFile(pluginDir: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  const rel = safeRelative(decoded.replace(/^\/+/, ''))
  if (!rel) return null
  const root = path.resolve(pluginDir)
  const full = path.resolve(root, rel)
  return full.startsWith(root + path.sep) ? full : null
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
}

export function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}
