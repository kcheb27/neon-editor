// Project-wide text search. A plain Node implementation for now; the design calls for
// ripgrep, which can replace `searchFiles` without changing its callers.

import { promises as fsp } from 'node:fs'
import type { SearchMatch, SearchResult } from '../shared/protocol'
import { isBinary } from './textUtil.ts'

const MAX_FILE_BYTES = 1024 * 1024
const MAX_MATCHES = 2000
const MAX_LINE = 240

export interface SearchOptions {
  query: string
  regex: boolean
  caseSensitive: boolean
}

export function buildPattern(opts: SearchOptions): RegExp {
  const source = opts.regex ? opts.query : opts.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(source, opts.caseSensitive ? 'g' : 'gi')
}

export function searchText(file: string, text: string, pattern: RegExp, out: SearchMatch[], limit: number): void {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i]
    pattern.lastIndex = 0
    for (let m = pattern.exec(line); m && out.length < limit; m = pattern.exec(line)) {
      if (m[0].length === 0) {
        pattern.lastIndex++
        continue
      }
      // Keep the match visible when the line is very long.
      const from = m.index > MAX_LINE - 40 ? m.index - 40 : 0
      out.push({
        path: file,
        line: i + 1,
        col: m.index + 1,
        len: m[0].length,
        text: line.slice(from, from + MAX_LINE)
      })
    }
  }
}

export async function searchFiles(files: string[], opts: SearchOptions): Promise<SearchResult> {
  const pattern = buildPattern(opts) // throws on an invalid regular expression
  const matches: SearchMatch[] = []
  let fileCount = 0
  for (const file of files) {
    if (matches.length >= MAX_MATCHES) break
    try {
      const stat = await fsp.stat(file)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
      const bytes = await fsp.readFile(file)
      if (isBinary(bytes)) continue
      const before = matches.length
      searchText(file, bytes.toString('utf8'), pattern, matches, MAX_MATCHES)
      if (matches.length > before) fileCount++
    } catch {
      // unreadable or deleted mid-search: skip
    }
  }
  return { matches, files: fileCount, truncated: matches.length >= MAX_MATCHES }
}

/**
 * Parse `git grep -n -z` ("path\0line\0text") or `grep -rnZ` ("path\0line:text") output.
 * Columns are found again with the JavaScript pattern; when the remote tool's regex dialect
 * matched a line the JavaScript pattern does not, the whole line is reported at column 1.
 */
export function parseGrepOutput(
  out: string,
  resolve: (rel: string) => string,
  pattern: RegExp,
  limit = MAX_MATCHES
): SearchResult {
  const matches: SearchMatch[] = []
  const files = new Set<string>()
  for (const record of out.split('\n')) {
    if (matches.length >= limit) break
    const nul = record.indexOf('\0')
    if (nul <= 0) continue
    const m = /^(\d+)[\0:]([\s\S]*)$/.exec(record.slice(nul + 1))
    if (!m) continue
    const file = resolve(record.slice(0, nul))
    const line = Number(m[1])
    const text = m[2].replace(/\r$/, '')
    const before = matches.length
    const found: SearchMatch[] = []
    searchText(file, text, pattern, found, limit - matches.length)
    for (const f of found) matches.push({ ...f, line })
    if (matches.length === before) matches.push({ path: file, line, col: 1, len: 0, text: text.slice(0, MAX_LINE) })
    files.add(file)
  }
  return { matches, files: files.size, truncated: matches.length >= limit }
}
