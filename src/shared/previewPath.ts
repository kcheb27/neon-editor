// Paths for the HTML preview: a page at neon-preview://<token>/<path relative to the root>
// requests its CSS, scripts and images by URL; these map them back to files under the root.
// Works for Windows and POSIX roots (a project may be local or on an SSH host).

const isWindowsRoot = (root: string): boolean => /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\')

/**
 * The file for URL path `urlPath` ("/css/site.css") under `root`, or null if it would leave the
 * root. A path ending in "/" means that folder's index.html.
 */
export function fileUnder(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  if (decoded === '' || decoded.endsWith('/')) decoded += 'index.html'
  const parts: string[] = []
  for (const part of decoded.split(/[\\/]+/)) {
    if (!part || part === '.') continue
    if (part === '..') return null // never climb out, even if it would come back in
    if (isWindowsRoot(root) && /^[a-zA-Z]:$/.test(part)) return null
    parts.push(part)
  }
  if (!parts.length) return null
  const sep = isWindowsRoot(root) ? '\\' : '/'
  return root.replace(/[\\/]+$/, '') + sep + parts.join(sep)
}

/** The URL path ("/a/b.html") of `file` under `root`, or null if it is not under it. */
export function urlPathOf(root: string, file: string): string | null {
  const win = isWindowsRoot(root)
  const norm = (p: string): string => (win ? p.replace(/\//g, '\\').toLowerCase() : p)
  const r = root.replace(/[\\/]+$/, '')
  const sep = win ? '\\' : '/'
  if (!norm(file).startsWith(norm(r + sep))) return null
  const rel = file.slice(r.length + 1).split(/[\\/]+/)
  return '/' + rel.map(encodeURIComponent).join('/')
}
