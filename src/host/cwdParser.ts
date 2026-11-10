// Finds "current directory" reports in terminal output.
//
// Shells with shell integration print an invisible escape sequence at every prompt:
//   OSC 633 ; P ; Cwd=<path> ST     (our PowerShell script, same format VS Code uses)
//   OSC 7 ; file://<host>/<path> ST (bash, zsh, fish, most Linux and macOS setups)
//   OSC 9 ; 9 ; <path> ST           (Windows Terminal convention)

const OSC = /\x1b\](633;P;Cwd=|9;9;|7;)([^\x07\x1b]*)(?:\x07|\x1b\\)/g
const MAX_CARRY = 4096

export interface CwdReport {
  path: string
  /** Hostname from an OSC 7 URL; empty when the sequence does not carry one. */
  host: string
}

function unescape633(value: string): string {
  return value.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_m, lit: string, hex: string | undefined) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : lit
  )
}

function fixWindowsPath(p: string): string {
  // "/C:/Users/x" -> "C:\Users\x", and an upper-case drive letter so paths compare equal.
  let out = p
  if (/^\/[a-zA-Z]:/.test(out)) out = out.slice(1)
  if (/^[a-zA-Z]:/.test(out)) out = out[0].toUpperCase() + out.slice(1).replace(/\//g, '\\')
  if (/^[A-Z]:$/.test(out)) out += '\\'
  return out
}

export function parseReport(kind: string, payload: string, windows: boolean): CwdReport | null {
  let path = ''
  let host = ''
  if (kind === '7;') {
    const m = /^file:\/\/([^/]*)(\/.*)$/.exec(payload)
    if (!m) return null
    host = m[1]
    try {
      path = decodeURIComponent(m[2])
    } catch {
      path = m[2]
    }
  } else if (kind === '9;9;') {
    path = payload.replace(/^"(.*)"$/, '$1')
  } else {
    path = unescape633(payload)
  }
  if (!path) return null
  if (windows || /^\/?[a-zA-Z]:[\\/]/.test(path)) path = fixWindowsPath(path)
  return { path, host }
}

export class CwdParser {
  private carry = ''
  private windows: boolean

  constructor(windows: boolean) {
    this.windows = windows
  }

  /** Feed one chunk of terminal output. Returns the last directory reported in it, if any. */
  feed(chunk: string): CwdReport | null {
    const data = this.carry + chunk
    let last: CwdReport | null = null
    let consumed = 0
    OSC.lastIndex = 0
    for (let m = OSC.exec(data); m; m = OSC.exec(data)) {
      const report = parseReport(m[1], m[2], this.windows)
      if (report) last = report
      consumed = OSC.lastIndex
    }
    // A sequence can be split across chunks: keep an unfinished tail for the next call.
    const rest = data.slice(consumed)
    const open = rest.lastIndexOf('\x1b')
    this.carry = open >= 0 && rest.length - open <= MAX_CARRY ? rest.slice(open) : ''
    return last
  }
}
