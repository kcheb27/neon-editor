// Renders build/splash.html to build/splash.bmp: the image the portable exe shows while it
// unpacks (electron-builder "portable.splashImage" must be a .bmp). Needs Playwright and Python 3
// with Pillow. Run: node scripts/make-splash.cjs
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { chromium } = require('playwright')

;(async () => {
  const dir = path.resolve(__dirname, '../build')
  const png = path.join(dir, 'splash.png')
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 480, height: 270 }, deviceScaleFactor: 1 })
  await page.goto('file://' + path.join(dir, 'splash.html'))
  await page.screenshot({ path: png })
  await browser.close()
  execFileSync('python3', ['-c', 'import sys; from PIL import Image; im = Image.open(sys.argv[1]).convert("RGB"); im.save(sys.argv[2])', png, path.join(dir, 'splash.bmp')])
  require('node:fs').rmSync(png)
  console.log('wrote build/splash.bmp')
})()
