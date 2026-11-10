// HTML preview: an editor tab showing an HTML file as a page. The page is served from
// neon-preview://<token>/... by the main process (src/main/index.ts), which reads files through
// the Workspace Host, so relative CSS, scripts and images load, it works over SSH, and open files
// show their unsaved text. It reloads shortly after you stop typing in any file it may use.

import { urlPathOf } from '../../shared/previewPath'
import { monaco } from './monacoSetup'
import { neon } from './rpc'
import type { Host } from './rpc'
import type { PageTab } from './editorArea'
import { errorMessage, toast } from './ui'
import { basename, dirname, h, icon, isInside, pathKey } from './util'

export const isHtmlFile = (p: string): boolean => /\.x?html?$/i.test(p)
export const isMarkdownFile = (p: string): boolean => /\.(md|markdown|mdown|mkd)$/i.test(p)
/** Files that can be previewed: HTML pages, and markdown (rendered by the main process). */
export const isPreviewable = (p: string): boolean => isHtmlFile(p) || isMarkdownFile(p)

const RELOAD_DELAY_MS = 400

export interface PreviewContext {
  host: Host
  /** The project's root folder: the preview's web root ("/" in the page) when the file is in it. */
  root: string
  remote: boolean
}

export class HtmlPreview {
  readonly page: PageTab
  private frame: HTMLIFrameElement
  private file: string
  private webRoot: string
  private url = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposers: (() => void)[] = []
  private visible = false
  private stale = false
  private statusEl: HTMLElement

  constructor(file: string, ctx: PreviewContext) {
    this.file = file
    // Pages often link "/css/site.css"; serve from the project root so those resolve. A file
    // outside the project (opened with Open File) gets its own folder as the root.
    this.webRoot = isInside(ctx.root, file) ? ctx.root : dirname(file)

    const markdown = isMarkdownFile(file)
    this.frame = h('iframe', {
      class: `preview-frame${markdown ? ' markdown' : ''}`,
      title: `Preview of ${basename(file)}`,
      // HTML: scripts run, but in an opaque origin, so the page cannot reach the editor.
      // Markdown: no scripts at all. Popups let web links open in the browser.
      sandbox: markdown
        ? 'allow-popups allow-popups-to-escape-sandbox'
        : 'allow-scripts allow-forms allow-modals allow-popups allow-downloads'
    }) as HTMLIFrameElement

    const reload = h('button', { class: 'icon-btn', 'aria-label': 'Reload preview', title: 'Reload' }, icon('refresh', 14, 2))
    reload.addEventListener('click', () => this.reload())
    const bar: HTMLElement[] = [h('span', { class: 'preview-path', text: file, title: file }), (this.statusEl = h('span', { class: 'preview-status' })), reload]
    if (!ctx.remote && !markdown) {
      const external = h('button', { class: 'icon-btn', 'aria-label': 'Open in browser', title: 'Open the saved file in your browser' }, icon('windows', 14, 2))
      external.addEventListener('click', () => void neon.invoke('preview:openInBrowser', file).catch((err) => toast(errorMessage(err), 'error')))
      bar.push(external)
    }
    const el = h('div', { class: 'preview' }, h('div', { class: 'preview-bar' }, ...bar), this.frame)

    this.page = {
      id: previewId(file),
      title: `Preview ${basename(file)}`,
      detail: `Preview of ${file}`,
      icon: () => icon(markdown ? 'files' : 'code', 14, 2),
      el,
      onVisible: (on) => {
        this.visible = on
        if (on && this.stale) this.reload()
      },
      onClose: () => this.dispose()
    }

    void neon
      .invoke('preview:start', this.webRoot)
      .then((token: string) => {
        const path = urlPathOf(this.webRoot, file)
        if (!path) throw new Error('The file is not under the preview folder')
        this.url = `neon-preview://${token}${path}`
        this.reload()
      })
      .catch((err) => {
        this.statusEl.textContent = `Preview failed: ${errorMessage(err)}`
      })

    // Reload when a file under the web root changes: typing in an open editor, or saves on disk.
    const watchModel = (model: monaco.editor.ITextModel): void => {
      const p = modelPath(model.uri)
      if (!isInside(this.webRoot, p)) return
      const sub = model.onDidChangeContent(() => this.schedule())
      this.disposers.push(() => sub.dispose())
    }
    for (const m of monaco.editor.getModels()) watchModel(m)
    const created = monaco.editor.onDidCreateModel(watchModel)
    this.disposers.push(() => created.dispose())
    const onFs = ({ dirs }: { dirs: string[] }): void => {
      if (dirs.some((d) => isInside(this.webRoot, d) || isInside(d, this.webRoot))) this.schedule()
    }
    ctx.host.on('fs.changed', onFs)
    this.disposers.push(() => ctx.host.off('fs.changed', onFs))
  }

  get path(): string {
    return this.file
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.visible) this.reload()
      else this.stale = true // reload when the tab is shown again
    }, RELOAD_DELAY_MS)
  }

  reload(): void {
    if (!this.url) return
    this.stale = false
    // A query string forces a fresh load; the page's own relative links are unaffected.
    this.frame.src = `${this.url}?t=${Date.now()}`
    this.statusEl.textContent = ''
  }

  private dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    for (const d of this.disposers) d()
    this.disposers = []
  }
}

const PREFIX = 'preview:'

/** Page tab id of a file's preview (saved with the layout, so previews reopen). */
export const previewId = (file: string): string => PREFIX + file

/** The file of a preview tab id, or null for other tabs. */
export const previewFile = (id: string): string | null => (id.startsWith(PREFIX) ? id.slice(PREFIX.length) : null)

/** True when two preview ids are for the same file (Windows paths ignore case). */
export const samePreview = (a: string, b: string): boolean => pathKey(a) === pathKey(b)

/**
 * The file path of an editor model. Its URI is made with monaco.Uri.file(path); uri.fsPath would
 * rewrite a Linux (SSH) path with backslashes on Windows, so rebuild it from uri.path.
 */
function modelPath(uri: monaco.Uri): string {
  const p = uri.path
  return /^\/[a-zA-Z]:/.test(p) ? p.slice(1).replace(/\//g, '\\') : p
}
