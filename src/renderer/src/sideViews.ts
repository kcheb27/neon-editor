// Sidebar views other than the Explorer: Search, Source Control, Remote.

import type { GitStatus, RemoteStatus, SearchMatch, SearchResult, SshHostEntry } from '../../shared/protocol'
import type { Host } from './rpc'
import { neon } from './rpc'
import { errorMessage } from './ui'
import { basename, debounce, dirname, fileBadge, GIT_COLORS, h, icon, relative } from './util'

type Open = (path: string, line?: number, col?: number) => void

export class SearchView {
  readonly el: HTMLElement
  readonly input: HTMLInputElement
  private host: Host
  private root: string
  private open: Open
  private regex = false
  private caseSensitive = false
  private results: HTMLElement
  private summary: HTMLElement
  private runId = 0

  constructor(host: Host, root: string, open: Open) {
    this.host = host
    this.root = root
    this.open = open
    this.input = h('input', { placeholder: 'Search', 'aria-label': 'Search in files', spellcheck: 'false' })
    const caseBtn = h('button', { class: 'toggle', text: 'Aa', title: 'Match case', 'aria-pressed': 'false' })
    const regexBtn = h('button', { class: 'toggle', text: '.*', title: 'Use regular expression', 'aria-pressed': 'false' })
    const flip = (btn: HTMLButtonElement, key: 'regex' | 'caseSensitive'): void => {
      btn.addEventListener('click', () => {
        this[key] = !this[key]
        btn.classList.toggle('on', this[key])
        btn.setAttribute('aria-pressed', String(this[key]))
        void this.run()
      })
    }
    flip(caseBtn, 'caseSensitive')
    flip(regexBtn, 'regex')
    this.summary = h('div', { class: 'note', style: 'font-size:12px' })
    this.results = h('div', { style: 'display:flex;flex-direction:column' })
    const runSoon = debounce(() => void this.run(), 250)
    this.input.addEventListener('input', runSoon)
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.run()
    })
    this.el = h(
      'div',
      { class: 'view-body' },
      h('div', { class: 'search-box' }, this.input, caseBtn, regexBtn),
      this.summary,
      this.results
    )
  }

  focus(): void {
    this.input.focus()
    this.input.select()
  }

  async run(): Promise<void> {
    const query = this.input.value
    const id = ++this.runId
    if (!query) {
      this.summary.textContent = ''
      this.results.replaceChildren()
      return
    }
    this.summary.textContent = 'Searching…'
    let res: SearchResult
    try {
      res = await this.host.call<SearchResult>('search.run', { query, regex: this.regex, caseSensitive: this.caseSensitive })
    } catch (err) {
      if (id === this.runId) {
        this.summary.textContent = errorMessage(err)
        this.results.replaceChildren()
      }
      return
    }
    if (id !== this.runId) return // a newer search started
    const n = res.matches.length
    this.summary.textContent = n
      ? `${n}${res.truncated ? '+' : ''} result${n === 1 ? '' : 's'} in ${res.files} file${res.files === 1 ? '' : 's'}`
      : 'No results'
    const byFile = new Map<string, SearchMatch[]>()
    for (const m of res.matches) {
      let list = byFile.get(m.path)
      if (!list) byFile.set(m.path, (list = []))
      list.push(m)
    }
    const rows: HTMLElement[] = []
    for (const [file, matches] of byFile) {
      const [badge, color] = fileBadge(basename(file))
      const rel = relative(this.root, dirname(file))
      rows.push(
        h(
          'div',
          { class: 'result-file', title: file },
          h('span', { style: `font:600 9.5px var(--mono);color:${color};min-width:24px`, text: badge }),
          h('span', { text: basename(file) }),
          h('span', { class: 'muted', text: rel })
        )
      )
      for (const m of matches) {
        const offset = m.col - 1 > 200 ? m.col - 1 - 40 : 0 // the host trims very long lines the same way
        const at = m.col - 1 - offset
        const text = m.text
        // Keep the match in view in a narrow sidebar: show at most ~16 characters before it.
        const before = text.slice(0, at).trimStart()
        const lead = before.length > 16 ? `…${before.slice(-16)}` : before
        const row = h(
          'button',
          { class: 'result-line', title: `${basename(file)}:${m.line}  ${text.trim()}` },
          lead,
          h('mark', { text: text.slice(at, at + m.len) }),
          text.slice(at + m.len)
        )
        row.addEventListener('click', () => this.open(file, m.line, m.col))
        rows.push(row)
      }
    }
    this.results.replaceChildren(...rows)
  }
}

export class GitView {
  readonly el: HTMLElement
  private root: string
  private open: Open
  private body: HTMLElement
  onRefresh: () => void = () => {}

  constructor(root: string, open: Open) {
    this.root = root
    this.open = open
    this.body = h('div', { style: 'display:flex;flex-direction:column;gap:2px' })
    this.el = h('div', { class: 'view-body' }, this.body)
  }

  render(status: GitStatus | null): void {
    if (!status) {
      this.body.replaceChildren(h('div', { class: 'note', text: 'Reading git status…' }))
      return
    }
    if (!status.repo) {
      this.body.replaceChildren(h('div', { class: 'note', text: 'This folder is not a git repository, or git is not installed.' }))
      return
    }
    const changes = Object.entries(status.files)
      .filter(([, code]) => code !== '!')
      .sort(([a], [b]) => a.localeCompare(b))
    const sync = [status.ahead ? `${status.ahead} to push` : '', status.behind ? `${status.behind} to pull` : ''].filter(Boolean).join(', ')
    const rows: HTMLElement[] = [
      h(
        'div',
        { class: 'note', style: 'display:flex;align-items:center;gap:6px;color:var(--fg)' },
        icon('git', 14, 2),
        h('b', { text: status.branch || '(detached)' }),
        sync ? h('span', { class: 'muted', text: `· ${sync}` }) : null
      ),
      h('div', { class: 'section-title', style: 'padding:0;height:28px', text: `Changes (${changes.length})` })
    ]
    if (!changes.length) rows.push(h('div', { class: 'note', text: 'No changes. The working tree is clean.' }))
    for (const [file, code] of changes) {
      const rel = relative(this.root, dirname(file))
      const row = h(
        'button',
        { class: 'change', title: file },
        h('span', { class: 'name' }, basename(file), ' ', h('span', { class: 'muted', style: 'font-size:12px', text: rel })),
        h('span', { style: `color:${GIT_COLORS[code] ?? 'inherit'};font-weight:600;width:14px;text-align:center`, text: code })
      )
      if (code !== 'D') row.addEventListener('click', () => this.open(file))
      rows.push(row)
    }
    rows.push(
      h(
        'div',
        { class: 'note', style: 'margin-top:12px;font-size:12px' },
        'Staging, commits and diffs are not built yet. Use the terminal for those for now.'
      )
    )
    this.body.replaceChildren(...rows)
  }
}

export class RemoteView {
  readonly el: HTMLElement
  private current: string
  private connect: (host?: string) => void
  private statusEl: HTMLElement
  private listEl: HTMLElement

  /** `current` is this workspace's SSH host, or '' for a local workspace. */
  constructor(current: string, connect: (host?: string) => void) {
    this.current = current
    this.connect = connect
    this.statusEl = h('div', { class: 'note' })
    this.listEl = h('div', { class: 'host-list' })
    const add = h('button', { class: 'btn ghost', text: 'Connect to SSH Host…' })
    add.addEventListener('click', () => connect())
    this.el = h(
      'div',
      { class: 'view-body' },
      this.statusEl,
      h('div', {}, add),
      h('div', { class: 'section-title', style: 'padding:0;height:28px', text: 'Hosts in ~/.ssh/config' }),
      this.listEl
    )
    this.setStatus(null)
    void this.loadHosts()
  }

  async loadHosts(): Promise<void> {
    const hosts = (await neon.invoke('ssh:hosts').catch(() => [])) as SshHostEntry[]
    if (!hosts.length) {
      this.listEl.replaceChildren(h('div', { class: 'note', text: 'No hosts found. Add Host entries to ~/.ssh/config, or connect with user@host.' }))
      return
    }
    this.listEl.replaceChildren(
      ...hosts.map((host) => {
        const on = host.alias === this.current
        const row = h(
          'button',
          { class: 'host-row', title: on ? 'This window is connected to this host' : `Open a folder on ${host.alias}` },
          h('span', { class: `dot${on ? ' on' : ''}` }),
          h('span', { class: 'grow' }, host.alias, ' ', h('span', { class: 'muted', style: 'font-size:12px', text: `${host.user}@${host.hostName}${host.port !== 22 ? `:${host.port}` : ''}` }))
        )
        row.addEventListener('click', () => this.connect(host.alias))
        return row
      })
    )
  }

  setStatus(status: RemoteStatus | null): void {
    if (!this.current) {
      this.statusEl.textContent = 'This window shows files on this computer. Connect to a host to open a folder over SSH.'
      return
    }
    const state = status?.state ?? 'connecting'
    const text: Record<string, string> = {
      connecting: `Connecting to ${this.current}…`,
      connected: `Connected to ${this.current}${status?.latencyMs ? ` (connected in ${status.latencyMs} ms)` : ''}.`,
      reconnecting: `Reconnecting to ${this.current}… Your unsaved changes are kept.`,
      failed: `Not connected to ${this.current}: ${status?.detail ?? ''}`
    }
    this.statusEl.textContent = text[state]
  }
}
