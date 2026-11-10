// Parser for `git status --porcelain=v2 --branch -z`.

export interface ParsedStatus {
  branch: string
  ahead: number
  behind: number
  /** Paths are relative to the repository root, with forward slashes. */
  entries: { path: string; code: string }[]
}

function codeFor(xy: string): string {
  if (xy.includes('D')) return 'D'
  if (xy[0] === 'A') return 'A'
  if (xy.includes('R')) return 'R'
  return 'M'
}

/** Drop the first `n` space-separated fields and return the rest (the path may contain spaces). */
function after(record: string, n: number): string {
  let idx = 0
  for (let i = 0; i < n; i++) {
    idx = record.indexOf(' ', idx) + 1
    if (idx === 0) return ''
  }
  return record.slice(idx)
}

export function parsePorcelainV2(out: string): ParsedStatus {
  const result: ParsedStatus = { branch: '', ahead: 0, behind: 0, entries: [] }
  const records = out.split('\0')
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    const kind = rec[0]
    if (kind === '#') {
      if (rec.startsWith('# branch.head ')) result.branch = rec.slice(14)
      else if (rec.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(rec)
        if (m) {
          result.ahead = Number(m[1])
          result.behind = Number(m[2])
        }
      }
    } else if (kind === '1') {
      result.entries.push({ path: after(rec, 8), code: codeFor(rec.slice(2, 4)) })
    } else if (kind === '2') {
      result.entries.push({ path: after(rec, 9), code: 'R' })
      i++ // the next record is the original path
    } else if (kind === 'u') {
      result.entries.push({ path: after(rec, 10), code: 'C' })
    } else if (kind === '?') {
      result.entries.push({ path: rec.slice(2).replace(/\/$/, ''), code: 'U' })
    } else if (kind === '!') {
      result.entries.push({ path: rec.slice(2).replace(/\/$/, ''), code: '!' })
    }
  }
  return result
}
