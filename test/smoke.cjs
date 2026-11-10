// Drives the real app (run via `npm run smoke`): two windows on one project, shared editing,
// terminal cwd tracking. Writes screenshots to .smoke/ and exits non-zero on a failed check.

const fs = require('node:fs')
const path = require('node:path')

const outDir = path.resolve(__dirname, '../.smoke')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function js(win, code) {
  return win.webContents.executeJavaScript(code, true)
}

async function waitFor(win, expr, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      if (await js(win, `!!(${expr})`)) return true
    } catch {}
    await wait(100)
  }
  return false
}

const clickRow = (win, name) =>
  js(win, `(() => { const r = [...document.querySelectorAll('.sidebar .row')].find(r => r.querySelector('.name')?.textContent === ${JSON.stringify(name)}); if (r) r.click(); return !!r })()`)

async function shot(win, name) {
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG())
}

async function typeInto(win, selector, text) {
  await js(win, `document.querySelector(${JSON.stringify(selector)})?.focus()`)
  win.webContents.insertText(text)
}

async function clickEditor(win) {
  win.focus()
  const r = await js(win, `(() => { const b = document.querySelector('.editor-host .view-lines').getBoundingClientRect(); return { x: Math.round(b.left + 300), y: Math.round(b.top + 10) } })()`)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await wait(200)
}

async function pressEnter(win) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
}


module.exports = async ({ BrowserWindow, createWindow }) => {
  const [w1] = BrowserWindow.getAllWindows()
  w1.showInactive() // hidden windows do not repaint, so screenshots would be stale
  w1.setSize(1400, 880)

  check('window 1 shows the explorer', await waitFor(w1, `document.querySelectorAll('.sidebar .row').length >= 4`))
  check('git status colors the modified file',
    (await clickRow(w1, 'src')) && (await waitFor(w1, `[...document.querySelectorAll('.row')].some(r => r.textContent.includes('lib'))`)) &&
    (await clickRow(w1, 'lib')) && (await waitFor(w1, `[...document.querySelectorAll('.row')].some(r => r.querySelector('.name')?.textContent === 'greet.ts' && r.querySelector('.git')?.textContent === 'M')`)))
  check('untracked file is marked U', await waitFor(w1, `[...document.querySelectorAll('.row')].some(r => r.querySelector('.name')?.textContent === 'TODO.txt' && r.querySelector('.git')?.textContent === 'U')`))
  check('ignored folder is dimmed', await waitFor(w1, `[...document.querySelectorAll('.row.ignored')].some(r => r.textContent.includes('node_modules'))`))

  await clickRow(w1, 'app.ts')
  check('file opens in window 1', await waitFor(w1, `document.querySelector('.tab.on')?.textContent.includes('app.ts') && (document.querySelector('.view-lines')?.innerText ?? '').replace(/ /g, ' ').includes('Entry point')`))

  // Terminal: started automatically, its tree should follow `cd`.
  check('terminal starts', await waitFor(w1, `document.querySelector('.xterm-rows')?.innerText.trim().length > 0`, 20000))
  await wait(1500)
  check('mini tree is rooted at the project', await waitFor(w1, `document.querySelector('.mini-path')?.textContent.endsWith('project')`))
  await typeInto(w1, '.xterm-helper-textarea', 'cd src')
  await pressEnter(w1)
  check('mini tree follows `cd src`', await waitFor(w1, `document.querySelector('.mini-path')?.textContent.endsWith('src') && [...document.querySelectorAll('.mini .row .name')].some(n => n.textContent === 'app.ts')`, 10000))

  await shot(w1, 'window1')

  // Second window for the same project.
  const w2 = createWindow()
  w2.showInactive()
  w2.setSize(1100, 760)
  check('window 2 loads', await waitFor(w2, `document.querySelectorAll('.sidebar .row').length >= 4`))
  check('window chip shows 2 windows', await waitFor(w1, `document.querySelector('.window-chip')?.textContent.includes('of 2')`))
  await clickRow(w2, 'src')
  await waitFor(w2, `[...document.querySelectorAll('.row .name')].some(n => n.textContent === 'app.ts')`)
  await clickRow(w2, 'app.ts')
  check('file opens in window 2', await waitFor(w2, `(document.querySelector('.view-lines')?.innerText ?? '').replace(/ /g, ' ').includes('Entry point')`))

  // Type in window 1, see it in window 2.
  await clickEditor(w1)
  await w1.webContents.insertText('// typed in window 1 ')
  check('typing lands in window 1', await waitFor(w1, `(document.querySelector('.view-lines')?.innerText ?? '').replace(/ /g, ' ').includes('typed in window 1')`, 3000))
  check('edit in window 1 shows in window 2', await waitFor(w2, `(document.querySelector('.view-lines')?.innerText ?? '').replace(/ /g, ' ').includes('typed in window 1')`))
  check('both windows mark the tab unsaved', (await waitFor(w1, `document.querySelector('.tab.on.dirty')`)) && (await waitFor(w2, `document.querySelector('.tab.on.dirty')`)))

  // Undo from window 2 removes window 1's edit everywhere.
  await clickEditor(w2)
  w2.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] })
  w2.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] })
  check('undo in window 2 undoes the shared edit', await waitFor(w1, `!(document.querySelector('.view-lines')?.innerText ?? '').replace(/ /g, ' ').includes('typed in window 1')`))
  check('undo back to saved text clears unsaved state', await waitFor(w1, `!document.querySelector('.tab.on.dirty')`, 3000))

  await shot(w2, 'window2')

  // Quick open and the palette.
  await js(w1, `document.querySelector('.command-center button').click()`)
  check('quick open lists files', await waitFor(w1, `document.querySelectorAll('.quick-item').length >= 3`))
  await shot(w1, 'quickopen')
  await js(w1, `document.querySelector('.quick-backdrop')?.dispatchEvent(new MouseEvent('mousedown'))`)

  // Search view.
  await js(w1, `document.querySelectorAll('.activity')[1].click()`)
  await typeInto(w1, '.search-box input', 'greet')
  check('search finds matches', await waitFor(w1, `document.querySelectorAll('.result-line').length >= 2`, 8000))
  await shot(w1, 'search')

  const failed = results.filter((r) => !r.ok)
  console.log(`[smoke] ${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) throw new Error(`${failed.length} smoke checks failed`)
}
