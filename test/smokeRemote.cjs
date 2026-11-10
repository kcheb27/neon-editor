// Drives the real app on an SSH workspace served by test/sshTestServer.cjs (started by
// test/run-smoke.cjs). Writes screenshots to .smoke/ and fails on any unmet check.

const fs = require('node:fs')
const path = require('node:path')

const outDir = path.resolve(__dirname, '../.smoke')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`[smoke:ssh] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const js = (win, code) => win.webContents.executeJavaScript(code, true)

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

const text = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').replace(/\\u00a0/g, ' ')`

const clickRow = (win, name) =>
  js(win, `(() => { const r = [...document.querySelectorAll('.sidebar .row')].find(r => r.querySelector('.name')?.textContent === ${JSON.stringify(name)}); if (r) r.click(); return !!r })()`)

const clickButton = (win, label) =>
  js(win, `(() => { const b = [...document.querySelectorAll('.modal button')].find(b => b.textContent === ${JSON.stringify(label)}); if (b) b.click(); return !!b })()`)

async function clickEditor(win) {
  win.focus()
  const r = await js(win, `(() => { const b = document.querySelector('.editor-host .view-lines').getBoundingClientRect(); return { x: Math.round(b.left + 300), y: Math.round(b.top + 10) } })()`)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 })
  await wait(200)
}

function key(win, keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (keyCode === 'Return') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

async function shot(win, name) {
  fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
}

module.exports = async ({ BrowserWindow, createWindow }) => {
  const projectOnDisk = process.env.NEON_SMOKE_REMOTE_PROJECT
  const password = process.env.NEON_SMOKE_REMOTE_PASSWORD
  const [w1] = BrowserWindow.getAllWindows()
  w1.showInactive()
  w1.setSize(1400, 880)

  check('connecting screen shows', await waitFor(w1, `document.querySelector('.connecting-card')`))
  check('unknown host key is shown with its fingerprint', await waitFor(w1, `document.querySelector('.modal-message')?.textContent.includes('SHA256:')`))
  await shot(w1, 'ssh-hostkey')
  await clickButton(w1, 'Accept and Connect')

  check('password is asked for', await waitFor(w1, `document.querySelector('.modal input[type=password]')`))
  await js(w1, `(() => { const i = document.querySelector('.modal input'); i.value = ${JSON.stringify(password)}; return true })()`)
  await clickButton(w1, 'OK')

  check('explorer lists the remote project', await waitFor(w1, `[...document.querySelectorAll('.sidebar .row .name')].some(n => n.textContent === 'src')`, 20000))
  check('status bar shows the SSH host', await waitFor(w1, `${text('.statusbar .remote')}.includes('SSH: neon-test')`))
  check('git branch is read from the host', await waitFor(w1, `${text('.statusbar')}.includes('main') || ${text('.statusbar')}.includes('master')`))

  await clickRow(w1, 'src')
  await waitFor(w1, `[...document.querySelectorAll('.sidebar .row .name')].some(n => n.textContent === 'app.ts')`)
  await clickRow(w1, 'app.ts')
  check('remote file opens', await waitFor(w1, `${text('.view-lines')}.includes('Entry point')`))

  await clickEditor(w1)
  await w1.webContents.insertText('// edited over ssh ')
  key(w1, 'S', ['control'])
  const saved = await (async () => {
    for (let i = 0; i < 60; i++) {
      if (fs.readFileSync(path.join(projectOnDisk, 'src', 'app.ts'), 'utf8').includes('edited over ssh')) return true
      await wait(100)
    }
    return false
  })()
  check('save writes the file on the host', saved)
  check('saved tab is clean again', await waitFor(w1, `!document.querySelector('.tab.on.dirty')`, 4000))

  // Terminal on the host, with its tree following cd.
  check('remote terminal starts', await waitFor(w1, `${text('.xterm-rows')}.trim().length > 0`, 20000))
  check('terminal badge names the host', await waitFor(w1, `document.querySelector('.mini .host-badge')?.textContent === 'neon-test'`))
  check('mini tree starts at the project', await waitFor(w1, `document.querySelector('.mini-path')?.textContent.endsWith('project')`, 10000))
  await wait(800)
  w1.focus()
  await js(w1, `document.querySelector('.xterm-helper-textarea')?.focus()`)
  await w1.webContents.insertText('cd src')
  key(w1, 'Return')
  check('mini tree follows cd on the host', await waitFor(w1, `document.querySelector('.mini-path')?.textContent.endsWith('src') && [...document.querySelectorAll('.mini .row .name')].some(n => n.textContent === 'app.ts')`, 10000))

  // A file changed on the host shows up in the explorer through polling.
  fs.writeFileSync(path.join(projectOnDisk, 'src', 'from-host.ts'), 'export {}\n')
  check('a file created on the host appears', await waitFor(w1, `[...document.querySelectorAll('.sidebar .row .name')].some(n => n.textContent === 'from-host.ts')`, 8000))

  await js(w1, `document.querySelectorAll('.activity')[1].click()`)
  await js(w1, `(() => { const i = document.querySelector('.search-box input'); i.value = 'greet'; i.dispatchEvent(new Event('input')); return true })()`)
  check('search runs on the host', await waitFor(w1, `document.querySelectorAll('.result-line').length >= 2`, 10000))
  await shot(w1, 'ssh-window1')

  // A second window shares the connection: no new prompts.
  const w2 = createWindow()
  w2.showInactive()
  w2.setSize(1100, 760)
  check('second window opens without asking again', await waitFor(w2, `document.querySelectorAll('.sidebar .row').length >= 2 && !document.querySelector('.modal')`, 15000))
  check('second window shows the same host', await waitFor(w2, `${text('.statusbar .remote')}.includes('SSH: neon-test')`))
  await shot(w2, 'ssh-window2')

  const failed = results.filter((r) => !r.ok)
  console.log(`[smoke:ssh] ${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) throw new Error(`${failed.length} SSH smoke checks failed`)
}
