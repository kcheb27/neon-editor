import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileUnder, urlPathOf } from '../src/shared/previewPath.ts'

test('preview URLs map to files under the root and never outside it', () => {
  assert.equal(fileUnder('/home/pi/site', '/css/site.css'), '/home/pi/site/css/site.css')
  assert.equal(fileUnder('/home/pi/site/', '/'), '/home/pi/site/index.html')
  assert.equal(fileUnder('/home/pi/site', '/docs/'), '/home/pi/site/docs/index.html')
  assert.equal(fileUnder('/home/pi/site', '/my%20page.html'), '/home/pi/site/my page.html')
  assert.equal(fileUnder('C:\\Users\\me\\site', '/img/logo.png'), 'C:\\Users\\me\\site\\img\\logo.png')
  assert.equal(fileUnder('/home/pi/site', '/../secret.txt'), null)
  assert.equal(fileUnder('/home/pi/site', '/a/%2e%2e/%2e%2e/secret'), null)
  assert.equal(fileUnder('/home/pi/site', '/a/..%5c..%5csecret'), null)
  assert.equal(fileUnder('C:\\site', '/C:/Windows/win.ini'), null)
  assert.equal(fileUnder('/home/pi/site', '/%E0%A4%A'), null)
})

test('files get URL paths relative to the root', () => {
  assert.equal(urlPathOf('/home/pi/site', '/home/pi/site/index.html'), '/index.html')
  assert.equal(urlPathOf('/home/pi/site', '/home/pi/site/a b/c.html'), '/a%20b/c.html')
  assert.equal(urlPathOf('C:\\Users\\me\\site', 'C:\\Users\\me\\site\\docs\\x.html'), '/docs/x.html')
  assert.equal(urlPathOf('C:\\Users\\me\\site', 'c:\\users\\me\\site\\x.html'), '/x.html')
  assert.equal(urlPathOf('/home/pi/site', '/home/pi/other/x.html'), null)
  assert.equal(urlPathOf('/home/pi/site', '/home/pi/site2/x.html'), null)
})
