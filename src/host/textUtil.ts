// Text helpers for the Workspace Host. Buffers always hold "\n" line endings in memory;
// the file's original line ending and BOM are restored on save.

export type Eol = '\n' | '\r\n'

export interface DecodedText {
  text: string
  eol: Eol
  bom: boolean
}

export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

export function decodeText(bytes: Uint8Array): DecodedText {
  let raw = new TextDecoder('utf-8').decode(bytes)
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  let crlf = 0
  let lf = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 10) {
      if (i > 0 && raw.charCodeAt(i - 1) === 13) crlf++
      else lf++
    }
  }
  const eol: Eol = crlf > lf ? '\r\n' : '\n'
  const text = raw.replace(/\r\n?/g, '\n')
  return { text, eol, bom }
}

export function encodeText(text: string, eol: Eol, bom: boolean): string {
  const body = eol === '\n' ? text : text.replace(/\n/g, '\r\n')
  return bom ? '﻿' + body : body
}

/** Smallest single replacement that turns `a` into `b` (common prefix and suffix kept). */
export function diffRange(a: string, b: string): { start: number; deleteCount: number; insert: string } {
  const max = Math.min(a.length, b.length)
  let start = 0
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--
    endB--
  }
  return { start, deleteCount: endA - start, insert: b.slice(start, endB) }
}
