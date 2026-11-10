// Markdown preview: renders a .md file to a full HTML page, served by the HTML preview's
// neon-preview:// protocol. Relative images and links to other .md files resolve through the
// same protocol; web links open in the browser. No scripts run (CSP and the frame's sandbox).

import { Marked } from 'marked'

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const marked = new Marked({
  gfm: true,
  renderer: {
    // Web links open in the browser (a new window, which the app hands to the system browser);
    // relative links stay in the preview, so links between .md files work.
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens)
      const external = /^(https?:|mailto:)/i.test(href)
      const t = title ? ` title="${escapeHtml(title)}"` : ''
      return `<a href="${escapeHtml(href)}"${t}${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`
    }
  }
})

const STYLE = `
:root { color-scheme: dark; }
html { background: #14161f; }
body { margin: 0 auto; max-width: 860px; padding: 28px 40px 60px; color: #e4e7f2;
  font: 15px/1.65 Inter, 'Segoe UI', system-ui, sans-serif; word-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.6em 0 0.6em; font-weight: 600; }
h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid #2a3350; margin-top: 0.4em; }
h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid #2a3350; }
h3 { font-size: 1.25em; }
p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
a { color: #4fd6ff; text-decoration: none; }
a:hover { text-decoration: underline; }
code { font: 0.88em 'JetBrains Mono', Consolas, monospace; background: #1c1f2b; padding: 0.15em 0.4em; border-radius: 4px; }
pre { background: #10121a; border: 1px solid #2a3350; border-radius: 6px; padding: 12px 16px; overflow: auto; line-height: 1.5; }
pre code { background: none; padding: 0; font-size: 0.86em; }
blockquote { border-left: 3px solid #7c5cff; margin-left: 0; padding: 0 1em; color: #a9b1cc; }
table { border-collapse: collapse; display: block; overflow: auto; }
th, td { border: 1px solid #2a3350; padding: 6px 12px; }
th { background: #1c1f2b; font-weight: 600; }
tr:nth-child(2n) td { background: #171a24; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid #2a3350; margin: 2em 0; }
li + li { margin-top: 0.25em; }
li > input[type=checkbox] { margin: 0 0.4em 0 -1.3em; vertical-align: middle; }
ul:has(> li > input[type=checkbox]) { list-style: none; }
`

export function isMarkdownFile(p: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(p)
}

/** A complete HTML page for markdown `source`. */
export function markdownPage(source: string, title: string): string {
  const body = marked.parse(source.replace(/^﻿/, ''), { async: false }) as string
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob: https: http:; script-src 'none'; object-src 'none'; style-src 'self' 'unsafe-inline' https:">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head><body>
${body}
</body></html>`
}
