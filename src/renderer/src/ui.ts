// Shared overlays: quick pick (command palette, quick open), text prompts, context menus, toasts.

import { h } from './util'

export interface PickItem<T = unknown> {
  label: string
  description?: string
  keybinding?: string
  value: T
}

/** Subsequence match. Returns a score (higher is better) and the matched positions, or null. */
export function fuzzy(query: string, text: string): { score: number; hits: number[] } | null {
  if (!query) return { score: 0, hits: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const hits: number[] = []
  let score = 0
  let ti = 0
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    if (ch === ' ') continue
    const found = t.indexOf(ch, ti)
    if (found < 0) return null
    const prev = hits[hits.length - 1]
    score += found === prev + 1 ? 6 : 1 // consecutive letters
    if (found === 0 || /[\\/._\-\s]/.test(t[found - 1])) score += 4 // start of a word
    hits.push(found)
    ti = found + 1
  }
  score -= t.length * 0.02 // prefer shorter labels
  return { score, hits }
}

function highlight(label: string, hits: number[]): HTMLElement {
  const span = h('span', { class: 'label' })
  const set = new Set(hits)
  let run = ''
  let bold = false
  const flush = (): void => {
    if (!run) return
    span.append(bold ? h('b', { text: run }) : run)
    run = ''
  }
  for (let i = 0; i < label.length; i++) {
    const isHit = set.has(i)
    if (isHit !== bold) {
      flush()
      bold = isHit
    }
    run += label[i]
  }
  flush()
  return span
}

let closeActive: (() => void) | null = null

interface QuickOptions<T> {
  placeholder: string
  title?: string
  value?: string
  /** Text to match against; defaults to the label. */
  matchOn?: (item: PickItem<T>) => string
  /** Free text mode: Enter returns the typed text instead of an item. */
  freeText?: boolean
  max?: number
  /**
   * Items that depend on the typed text (e.g. the folder a typed path points into). Return null
   * to use the fixed items; otherwise the items to show and the part of the text to match them on.
   */
  dynamic?: (query: string) => { items: PickItem<T>[] | Promise<PickItem<T>[]>; filter: string } | null
  /**
   * Called when an item is chosen (Enter, click, or Tab). Return new text to put in the box and
   * stay open (e.g. to go into a folder), or null to finish with the item. Tab never finishes.
   */
  descend?: (item: PickItem<T>) => string | null
}

function quick<T>(items: PickItem<T>[], opts: QuickOptions<T>): Promise<PickItem<T> | string | null> {
  closeActive?.()
  const previousFocus = document.activeElement as HTMLElement | null
  return new Promise((resolve) => {
    const input = h('input', { placeholder: opts.placeholder, 'aria-label': opts.placeholder, spellcheck: 'false' })
    input.value = opts.value ?? ''
    const list = h('div', { class: 'quick-list', role: 'listbox' })
    const box = h('div', { class: 'quick', role: 'dialog' }, opts.title ? h('div', { class: 'title', text: opts.title }) : null, input, list)
    const backdrop = h('div', { class: 'quick-backdrop' })
    let shown: { item: PickItem<T>; hits: number[] }[] = []
    let index = 0

    const finish = (result: PickItem<T> | string | null): void => {
      backdrop.remove()
      box.remove()
      closeActive = null
      previousFocus?.focus?.()
      resolve(result)
    }
    closeActive = () => finish(null)

    const render = (): void => {
      list.replaceChildren()
      if (opts.freeText) return
      if (shown.length === 0) {
        list.append(h('div', { class: 'quick-empty', text: 'No matching results' }))
        return
      }
      shown.forEach(({ item, hits }, i) => {
        const row = h(
          'button',
          { class: `quick-item${i === index ? ' on' : ''}`, role: 'option', tabindex: '-1', onclick: () => choose(item) },
          highlight(item.label, hits),
          h('span', { class: 'desc', text: item.description ?? '' }),
          item.keybinding ? h('span', { class: 'kb', text: item.keybinding }) : null
        )
        row.addEventListener('mousemove', () => {
          if (index !== i) {
            index = i
            render()
          }
        })
        list.append(row)
      })
      ;(list.children[index] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
    }

    let request = 0
    const filter = (): void => {
      const dyn = opts.dynamic?.(input.value)
      if (dyn) {
        const mine = ++request
        void Promise.resolve(dyn.items).then(
          (found) => mine === request && apply(found, dyn.filter.trim(), (it) => it.label),
          () => mine === request && apply([], '', (it) => it.label)
        )
        return
      }
      request++
      apply(items, input.value.trim(), opts.matchOn ?? ((it: PickItem<T>) => it.label))
    }
    const apply = (source: PickItem<T>[], q: string, matchOn: (it: PickItem<T>) => string): void => {
      const scored: { item: PickItem<T>; hits: number[]; score: number }[] = []
      for (const item of source) {
        const text = matchOn(item)
        const m = fuzzy(q, text)
        if (!m) continue
        // Hits are positions in `text`; only highlight when matching on the label itself.
        const hits = text === item.label ? m.hits : (fuzzy(q, item.label)?.hits ?? [])
        scored.push({ item, hits, score: m.score })
      }
      if (q) scored.sort((a, b) => b.score - a.score)
      shown = scored.slice(0, opts.max ?? 200)
      index = 0
      render()
    }

    /** Choose an item: go into it (stay open with new text) or finish with it. */
    const choose = (item: PickItem<T>, tab = false): void => {
      const next = opts.descend?.(item) ?? null
      if (next !== null) {
        input.value = next
        filter()
      } else if (!tab) finish(item)
    }

    input.addEventListener('input', filter)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(null)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (opts.freeText) finish(input.value)
        else if (shown[index]) choose(shown[index].item)
      } else if (e.key === 'Tab' && opts.descend && shown[index]) {
        e.preventDefault()
        choose(shown[index].item, true)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!shown.length) return
        index = (index + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length
        render()
      }
    })
    backdrop.addEventListener('mousedown', () => finish(null))
    document.body.append(backdrop, box)
    filter()
    input.focus()
    if (opts.value) input.select()
  })
}

export async function pick<T>(items: PickItem<T>[], opts: QuickOptions<T>): Promise<T | null> {
  const result = await quick(items, opts)
  return result && typeof result !== 'string' ? result.value : null
}

/** Ask for a line of text. Resolves null when cancelled or left empty. */
export async function ask(title: string, value = '', selectStem = false): Promise<string | null> {
  const promise = quick<null>([], { placeholder: title, title, value, freeText: true })
  if (selectStem && value) {
    // Select the name without its extension, as VS Code does for renames.
    const input = document.querySelector<HTMLInputElement>('.quick input')
    const dot = value.lastIndexOf('.')
    if (input && dot > 0) input.setSelectionRange(0, dot)
  }
  const result = await promise
  return typeof result === 'string' && result.trim() ? result.trim() : null
}

// ---------- context menu ----------

export type MenuEntry = { label: string; run: () => void } | 'separator'

export function showMenu(x: number, y: number, entries: MenuEntry[]): void {
  closeActive?.()
  const menu = h('div', { class: 'menu', role: 'menu' })
  const backdrop = h('div', { class: 'quick-backdrop' })
  const close = (): void => {
    menu.remove()
    backdrop.remove()
    closeActive = null
  }
  closeActive = close
  for (const entry of entries) {
    if (entry === 'separator') menu.append(h('hr'))
    else
      menu.append(
        h('button', {
          role: 'menuitem',
          text: entry.label,
          onclick: () => {
            close()
            entry.run()
          }
        })
      )
  }
  backdrop.addEventListener('mousedown', close)
  backdrop.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    close()
  })
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close()
  })
  document.body.append(backdrop, menu)
  const r = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`
  ;(menu.querySelector('button') as HTMLButtonElement | null)?.focus()
}

// ---------- toasts ----------

let toastBox: HTMLElement | null = null

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })
    document.body.append(toastBox)
  }
  const el = h('div', { class: `toast ${kind}`, text: message })
  toastBox.append(el)
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000)
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------- modal dialogs (passwords, host keys) ----------

export interface ModalOptions {
  title: string
  message: string
  /** Show a text field: 'password' hides what is typed. */
  input?: 'password' | 'text'
  buttons: string[]
  /** Monospace message (fingerprints). */
  mono?: boolean
}

/** Resolves with the button pressed (index) and the field's text. The last button is Cancel. */
export function modal(opts: ModalOptions): Promise<{ button: number; value: string }> {
  closeActive?.()
  const previousFocus = document.activeElement as HTMLElement | null
  return new Promise((resolve) => {
    const field = opts.input
      ? h('input', { type: opts.input, 'aria-label': opts.title, autocomplete: 'off', spellcheck: 'false' })
      : null
    const backdrop = h('div', { class: 'modal-backdrop' })
    const box = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
      h('div', { class: 'modal-title', text: opts.title }),
      h('div', { class: `modal-message${opts.mono ? ' mono' : ''}`, text: opts.message }),
      field
    )
    const finish = (button: number): void => {
      backdrop.remove()
      box.remove()
      closeActive = null
      previousFocus?.focus?.()
      resolve({ button, value: field?.value ?? '' })
    }
    const cancel = opts.buttons.length - 1
    const row = h('div', { class: 'modal-buttons' })
    opts.buttons.forEach((label, i) => {
      const b = h('button', { class: i === 0 ? 'btn' : 'btn ghost', text: label })
      b.addEventListener('click', () => finish(i))
      row.append(b)
    })
    box.append(row)
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(cancel)
      } else if (e.key === 'Enter' && (field ? document.activeElement === field : true)) {
        e.preventDefault()
        finish(0)
      }
    })
    closeActive = () => finish(cancel)
    document.body.append(backdrop, box)
    ;(field ?? (row.firstChild as HTMLElement)).focus()
  })
}
