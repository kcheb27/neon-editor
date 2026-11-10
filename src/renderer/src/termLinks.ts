// Finding file paths in terminal output, e.g. "src/app.ts:12:5" from a compiler error, so they
// can be clicked. Pure functions (no DOM), unit-tested in test/termLinks.test.ts.

export interface PathMatch {
  /** 0-based index of the match in the line. */
  index: number
  /** The matched text, including any :line:col suffix. */
  text: string
  /** The path part only. */
  path: string
  line?: number
  col?: number
}

// A path: optional root ("/", "C:\", "~/", "./", "../"), then segments, then a file name with an
// extension, then an optional location: ":12", ":12:5", "(12,5)" or "(12)".
const PATH_RE =
  /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,12}(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/g

/** Paths in one line of terminal text. URLs are left to the URL link handler. */
export function findPaths(text: string): PathMatch[] {
  const out: PathMatch[] = []
  PATH_RE.lastIndex = 0
  for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
    const index = m.index
    const before = text.slice(0, index)
    // Part of a URL (scheme://host/path) or an email address: not a file.
    const word = text.slice(before.search(/\S*$/), index + m[0].length)
    if (word.includes('://') || before.endsWith('@')) continue
    // Inside a longer word, e.g. "foo=bar.js" is fine but "abc.def.ghi" mid-token is not useful.
    if (index > 0 && /[\w.]/.test(text[index - 1])) continue
    let path = m[0]
    const loc = path.match(/(?::\d+(?::\d+)?|\(\d+(?:,\s*\d+)?\))$/)
    if (loc) path = path.slice(0, -loc[0].length)
    // An email address ("me@example.com"); "@" is only allowed in folders like node_modules/@scope.
    if (path.includes('@') && !/[\\/]/.test(path)) continue
    // A version or number ("1.5", "v20.11.1"): an all-digit "extension" is not a file type.
    if (/\.\d+$/.test(path)) continue
    const line = Number(m[1] ?? m[3]) || undefined
    const col = Number(m[2] ?? m[4]) || undefined
    out.push({ index, text: m[0], path, line, col })
  }
  return out
}

/** True for "/x", "C:\x", "C:/x" and UNC "\\server\share". */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

/**
 * Resolves `p` against the shell's folder `cwd` (and `home` for "~"), in the style of `cwd`:
 * backslashes for a Windows folder, forward slashes otherwise. Collapses "." and "..".
 */
export function resolvePath(cwd: string, p: string, home: string): string {
  let full: string
  if (p === '~' || /^~[\\/]/.test(p)) full = home + p.slice(1)
  else if (isAbsolutePath(p)) full = p
  else full = `${cwd.replace(/[\\/]+$/, '')}/${p}`
  const windows = /^[a-zA-Z]:[\\/]/.test(full) || full.startsWith('\\\\')
  const sep = windows ? '\\' : '/'
  const prefixMatch = full.match(/^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]?|\/)/)
  const prefix = prefixMatch ? prefixMatch[0].replace(/[\\/]/g, sep) : ''
  const parts: string[] = []
  for (const part of full.slice(prefixMatch ? prefixMatch[0].length : 0).split(/[\\/]+/)) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return prefix + parts.join(sep)
}
