// Monaco setup: web workers, the Neon Night theme, and richer token colors.

import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

export { monaco }

self.MonacoEnvironment = {
  getWorker(_id: string, label: string): Worker {
    if (label === 'json') return new JsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  }
}

// ---------- Neon Night ----------

export const palette = {
  bgEditor: '#14161F',
  bgChrome: '#10121A',
  bgRaised: '#1C1F2B',
  lineHighlight: '#1A1D29',
  selection: '#2A3350',
  fg: '#E4E7F2',
  muted: '#8A93B0',
  accent: '#7C5CFF',
  keyword: '#FF5FA2',
  func: '#4FD6FF',
  type: '#FFC857',
  string: '#A6F25C',
  number: '#FF9F43',
  constant: '#B794FF',
  param: '#F8A5FF',
  property: '#7EE7C7',
  tag: '#FF6E6E',
  attribute: '#FFD866',
  regex: '#2EE6A6',
  operator: '#9AA7D0',
  comment: '#7A86A8',
  error: '#FF5370',
  warning: '#FFCB6B',
  info: '#59C2FF'
}

const hex = (c: string): string => c.slice(1)

function defineTheme(): void {
  const p = palette
  const rule = (token: string, color: string, fontStyle?: string): monaco.editor.ITokenThemeRule => ({
    token,
    foreground: hex(color),
    ...(fontStyle ? { fontStyle } : {})
  })
  monaco.editor.defineTheme('neon-night', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      rule('', p.fg),
      rule('identifier', p.fg),
      rule('comment', p.comment, 'italic'),
      rule('keyword', p.keyword, 'bold'),
      rule('string', p.string),
      rule('string.escape', p.regex),
      rule('regexp', p.regex),
      rule('number', p.number),
      rule('type', p.type),
      rule('namespace', p.type),
      rule('entity.name.function', p.func),
      rule('predefined', p.func),
      rule('variable.property', p.property),
      rule('variable', p.param),
      rule('constant', p.constant),
      rule('delimiter', p.operator),
      rule('operator', p.operator),
      rule('annotation', p.attribute, 'italic'),
      rule('tag', p.tag),
      rule('metatag', p.tag),
      rule('attribute.name', p.attribute, 'italic'),
      rule('attribute.value', p.string),
      // CSS
      rule('attribute.name.css', p.property),
      rule('attribute.value.number.css', p.number),
      rule('attribute.value.unit.css', p.number),
      rule('attribute.value.hex.css', p.constant),
      // JSON and YAML keys
      rule('string.key.json', p.property),
      rule('string.value.json', p.string),
      rule('keyword.json', p.constant),
      rule('type.yaml', p.property),
      rule('key', p.property),
      // Markdown
      rule('keyword.md', p.keyword, 'bold'),
      rule('string.link.md', p.func),
      rule('strong', p.type, 'bold'),
      rule('emphasis', p.param, 'italic'),
      rule('variable.md', p.regex),
      rule('variable.source.md', p.regex)
    ],
    colors: {
      'editor.background': p.bgEditor,
      'editor.foreground': p.fg,
      'editor.lineHighlightBackground': p.lineHighlight,
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': p.selection,
      'editor.inactiveSelectionBackground': '#222A42',
      'editor.selectionHighlightBackground': '#2A335080',
      'editor.findMatchBackground': '#7C5CFF99',
      'editor.findMatchHighlightBackground': '#7C5CFF44',
      'editorCursor.foreground': p.fg,
      'editorLineNumber.foreground': '#5F6886',
      'editorLineNumber.activeForeground': p.fg,
      'editorIndentGuide.background1': '#22263A',
      'editorIndentGuide.activeBackground1': '#3A4160',
      'editorWhitespace.foreground': '#2E3450',
      'editorBracketHighlight.foreground1': '#FFD700',
      'editorBracketHighlight.foreground2': '#DA70D6',
      'editorBracketHighlight.foreground3': '#4FC3F7',
      'editorBracketHighlight.foreground4': '#FFD700',
      'editorBracketHighlight.foreground5': '#DA70D6',
      'editorBracketHighlight.foreground6': '#4FC3F7',
      'editorBracketMatch.background': '#2A3350',
      'editorBracketMatch.border': '#7C5CFF',
      'editorError.foreground': p.error,
      'editorWarning.foreground': p.warning,
      'editorInfo.foreground': p.info,
      'editorWidget.background': p.bgRaised,
      'editorWidget.border': '#2A3350',
      'editorSuggestWidget.background': p.bgRaised,
      'editorSuggestWidget.selectedBackground': p.selection,
      'editorHoverWidget.background': p.bgRaised,
      'editorGutter.background': p.bgEditor,
      'minimap.background': p.bgEditor,
      'scrollbarSlider.background': '#8A93B033',
      'scrollbarSlider.hoverBackground': '#8A93B055',
      'scrollbarSlider.activeBackground': '#8A93B077',
      'input.background': p.bgRaised,
      'input.border': '#2A3350',
      focusBorder: p.accent,
      'list.hoverBackground': p.bgRaised,
      'list.activeSelectionBackground': p.selection,
      'menu.background': p.bgRaised,
      'menu.selectionBackground': p.selection
    }
  })
}

// ---------- more colorful tokens ----------
// Monaco's built-in grammars color every identifier the same. These extra rules pick out
// function calls, property access and constants so they get their own hues. Parameters
// need a language server (semantic tokens) and are not colored yet.

const IDENT = '[a-zA-Z_$][\\w$]*'

function vivid(lang: any): any {
  const state = lang.tokenizer.common ? 'common' : 'root'
  const callAction = Array.isArray(lang.keywords)
    ? { cases: { '@keywords': 'keyword', '@default': 'entity.name.function' } }
    : 'entity.name.function'
  const extra = [
    [/(?:true|false|null|undefined|NaN|None|True|False|nil)\b/, 'constant.language'],
    [/\.\.+/, 'delimiter'],
    [new RegExp(`(\\.)(${IDENT})(?=\\s*\\()`), ['delimiter', 'entity.name.function']],
    [new RegExp(`(\\.)(${IDENT})`), ['delimiter', 'variable.property']],
    [new RegExp(`${IDENT}(?=\\s*\\(|!\\()`), callAction],
    [/[A-Z][A-Z0-9_]+\b(?![.(<\w])/, 'constant']
  ]
  return { ...lang, tokenizer: { ...lang.tokenizer, [state]: [...extra, ...lang.tokenizer[state]] } }
}

const DEFINITIONS: Record<string, () => Promise<{ language: any }>> = {
  typescript: () => import('monaco-editor/languages/definitions/typescript/typescript.js'),
  javascript: () => import('monaco-editor/languages/definitions/javascript/javascript.js'),
  python: () => import('monaco-editor/languages/definitions/python/python.js'),
  rust: () => import('monaco-editor/languages/definitions/rust/rust.js'),
  go: () => import('monaco-editor/languages/definitions/go/go.js'),
  java: () => import('monaco-editor/languages/definitions/java/java.js'),
  csharp: () => import('monaco-editor/languages/definitions/csharp/csharp.js'),
  cpp: () => import('monaco-editor/languages/definitions/cpp/cpp.js'),
  c: () => import('monaco-editor/languages/definitions/cpp/cpp.js'),
  kotlin: () => import('monaco-editor/languages/definitions/kotlin/kotlin.js'),
  swift: () => import('monaco-editor/languages/definitions/swift/swift.js')
}

function enrichGrammars(): void {
  for (const [id, load] of Object.entries(DEFINITIONS)) {
    monaco.languages.onLanguage(id, async () => {
      try {
        // Let Monaco finish registering its own grammar first, so ours is the one that stays.
        await monaco.editor.colorize('', id, {})
        const { language } = await load()
        monaco.languages.setMonarchTokensProvider(id, vivid(language))
      } catch (err) {
        console.warn(`[theme] could not enrich ${id} grammar:`, err)
      }
    })
  }
}

// ---------- editor ----------

export function setupMonaco(): void {
  defineTheme()
  enrichGrammars()

  // Without a language server, the built-in TypeScript service only sees open files and
  // would flag every import as missing. Report syntax errors only until LSP support lands.
  const ts = monaco.typescript
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false })
    defaults.setCompilerOptions({
      target: ts.ScriptTarget.ESNext,
      jsx: ts.JsxEmit.Preserve,
      allowNonTsExtensions: true,
      allowJs: true
    })
  }

  void document.fonts.ready.then(() => monaco.editor.remeasureFonts())
}

export function createEditor(container: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  return monaco.editor.create(container, {
    model: null,
    theme: 'neon-night',
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
    fontSize: 14,
    lineHeight: 21,
    fontLigatures: false,
    padding: { top: 8 },
    minimap: { enabled: true, renderCharacters: false },
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true, highlightActiveIndentation: true },
    renderLineHighlight: 'all',
    smoothScrolling: true,
    scrollBeyondLastLine: true,
    cursorBlinking: 'smooth',
    stickyScroll: { enabled: false },
    fixedOverflowWidgets: true,
    'semanticHighlighting.enabled': true
  })
}
