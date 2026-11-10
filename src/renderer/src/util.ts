// Small DOM, path and icon helpers shared by the window's UI.

type Child = Node | string | null | undefined | false

interface Props {
  class?: string
  text?: string
  title?: string
  style?: string
  onclick?: (e: MouseEvent) => void
  [attr: string]: unknown
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = String(value)
    else if (key === 'text') el.textContent = String(value)
    else if (key === 'style') el.style.cssText = String(value)
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener)
    } else el.setAttribute(key, String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(child)
  }
  return el
}

const ICON_PATHS = {
  files: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4.2-4.2',
  git: 'M6 3v12 M18 9a3 3 0 1 0 0-6a3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6a3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9',
  remote: 'M3 4h18v12H3z M8 20h8 M12 16v4',
  chevron: 'M9 6l6 6l-6 6',
  close: 'M6 6l12 12 M18 6L6 18',
  plus: 'M12 5v14 M5 12h14',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  up: 'M12 19V5 M5 12l7-7l7 7',
  split: 'M4 4h16v16H4z M10 4v16',
  windows: 'M3 5h12v10H3z M9 9h12v10H9z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
  code: 'M8 7l-5 5l5 5 M16 7l5 5l-5 5',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z'
} as const

export type IconName = keyof typeof ICON_PATHS

export function icon(name: IconName, size = 16, strokeWidth = 1.8): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', String(strokeWidth))
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const p = document.createElementNS(ns, 'path')
  p.setAttribute('d', ICON_PATHS[name])
  svg.append(p)
  return svg
}

// ---------- paths (the platform separator is set once at startup) ----------

let SEP = '/'
let WINDOWS = false

export function setPlatform(sep: string, platform: string): void {
  SEP = sep
  WINDOWS = platform === 'win32'
}

export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return i < 0 ? trimmed : trimmed.slice(i + 1) || trimmed
}

export function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (i < 0) return p
  const dir = trimmed.slice(0, i)
  if (dir === '') return SEP // "/usr" -> "/"
  if (/^[a-zA-Z]:$/.test(dir)) return dir + SEP // "C:\Users" -> "C:\"
  return dir
}

export function join(dir: string, name: string): string {
  return /[\\/]$/.test(dir) ? dir + name : dir + SEP + name
}

const norm = (p: string): string => {
  const s = p.replace(/[\\/]+$/, '')
  return WINDOWS ? s.toLowerCase() : s
}

/** A key that compares equal for the same path (case-insensitive on Windows). */
export function pathKey(p: string): string {
  return norm(p)
}

export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b)
}

/** True when `child` is `parent` or somewhere under it. */
export function isInside(parent: string, child: string): boolean {
  const p = norm(parent)
  const c = norm(child)
  return c === p || c.startsWith(p + '/') || c.startsWith(p + '\\')
}

/** Path of `p` relative to `root`, or `p` unchanged when it is outside. */
export function relative(root: string, p: string): string {
  if (!isInside(root, p)) return p
  return p.slice(root.replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '')
}

/** Shorten a path for display: "~" for the home folder. */
export function tildify(p: string, home: string): string {
  if (home && isInside(home, p)) {
    const rest = relative(home, p)
    return rest ? `~${SEP}${rest}` : '~'
  }
  return p
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

// ---------- file type badges ----------

const BADGES: Record<string, [string, string]> = {
  ts: ['TS', '#4FD6FF'], tsx: ['TSX', '#4FD6FF'], mts: ['TS', '#4FD6FF'], cts: ['TS', '#4FD6FF'],
  js: ['JS', '#FFD866'], jsx: ['JSX', '#FFD866'], mjs: ['JS', '#FFD866'], cjs: ['JS', '#FFD866'],
  json: ['{}', '#FFC857'], jsonc: ['{}', '#FFC857'],
  rs: ['RS', '#FF9F43'], go: ['GO', '#4FD6FF'], py: ['PY', '#A6F25C'], rb: ['RB', '#FF6E6E'],
  java: ['JV', '#FF9F43'], kt: ['KT', '#B794FF'], swift: ['SW', '#FF9F43'], cs: ['C#', '#A6F25C'],
  c: ['C', '#4FD6FF'], h: ['H', '#4FD6FF'], cpp: ['C++', '#4FD6FF'], hpp: ['H++', '#4FD6FF'],
  html: ['<>', '#FF6E6E'], css: ['#', '#4FD6FF'], scss: ['#', '#FF5FA2'], less: ['#', '#B794FF'],
  md: ['MD', '#7EE7C7'], yml: ['YML', '#B794FF'], yaml: ['YML', '#B794FF'], toml: ['TML', '#B794FF'],
  xml: ['<>', '#FF9F43'], svg: ['SVG', '#FFC857'], sql: ['SQL', '#F8A5FF'],
  sh: ['$_', '#A6F25C'], bash: ['$_', '#A6F25C'], ps1: ['PS', '#4FD6FF'], bat: ['BAT', '#A6F25C'],
  lock: ['LCK', '#8A93B0'], txt: ['TXT', '#8A93B0'], log: ['LOG', '#8A93B0'],
  png: ['IMG', '#F8A5FF'], jpg: ['IMG', '#F8A5FF'], jpeg: ['IMG', '#F8A5FF'], gif: ['IMG', '#F8A5FF'],
  db: ['DB', '#FFC857'], sqlite: ['DB', '#FFC857']
}

export function fileBadge(name: string): [string, string] {
  const lower = name.toLowerCase()
  if (lower === 'dockerfile') return ['DKR', '#4FD6FF']
  if (lower.startsWith('.git')) return ['GIT', '#FF9F43']
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  return BADGES[ext] ?? ['··', '#8A93B0']
}

export const GIT_COLORS: Record<string, string> = {
  M: '#FFCB6B', A: '#A6F25C', U: '#A6F25C', D: '#FF5370', R: '#4FD6FF', C: '#FF5370'
}
