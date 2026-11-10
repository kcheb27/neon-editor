import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'
import { mimeOf, parseManifest, resolvePluginFile, safeRelative } from '../src/main/pluginManifest.ts'

const dir = path.resolve('plugins', 'demo')
const manifest = (neon: unknown, extra: Record<string, unknown> = {}) => ({ name: 'demo', version: '1.2.3', neon, ...extra })
const screen = { id: 'main', title: 'Demo', entry: 'ui/index.html' }

test('a valid manifest gives the plugin and its screens', () => {
  const r = parseManifest(manifest({ apiVersion: 1, screens: [{ ...screen, icon: 'icon.svg' }] }, { displayName: 'Demo Plugin' }), dir)
  assert.ok('plugin' in r)
  assert.deepEqual(r.plugin, {
    id: 'demo',
    name: 'Demo Plugin',
    version: '1.2.3',
    dir,
    screens: [{ location: 'sidebar', id: 'main', title: 'Demo', entry: 'ui/index.html', icon: 'icon.svg' }]
  })
})

test('manifests that cannot load explain why', () => {
  const err = (json: unknown) => {
    const r = parseManifest(json, dir)
    assert.ok('error' in r, JSON.stringify(json))
    return r.error
  }
  assert.match(err({ name: 'Bad Name!', neon: { apiVersion: 1, screens: [screen] } }), /lowercase/)
  assert.match(err({ name: 'demo' }), /no "neon" section/)
  assert.match(err(manifest({ apiVersion: 2, screens: [screen] })), /API version 2/)
  assert.match(err(manifest({ apiVersion: 1, screens: [] })), /no screens/)
  assert.match(err(manifest({ apiVersion: 1, screens: [{ ...screen, entry: '../../evil.html' }] })), /inside the plugin folder/)
  assert.match(err(manifest({ apiVersion: 1, screens: [{ ...screen, entry: 'C:\\evil.html' }] })), /inside the plugin folder/)
  assert.match(err(manifest({ apiVersion: 1, screens: [{ ...screen, id: '' }] })), /id is missing/)
  assert.match(err(manifest({ apiVersion: 1, screens: [{ ...screen, location: 'panel' }] })), /location must be/)
})

test('plugin files cannot be read from outside the plugin folder', () => {
  assert.equal(resolvePluginFile(dir, '/ui/index.html'), path.join(dir, 'ui', 'index.html'))
  assert.equal(resolvePluginFile(dir, '/ui/my%20file.js'), path.join(dir, 'ui', 'my file.js'))
  assert.equal(resolvePluginFile(dir, '/../secret.txt'), null)
  assert.equal(resolvePluginFile(dir, '/ui/%2e%2e/%2e%2e/secret.txt'), null)
  assert.equal(resolvePluginFile(dir, '/ui/..%5c..%5csecret.txt'), null)
  assert.equal(resolvePluginFile(dir, '/%E0%A4%A'), null) // malformed escape
  assert.equal(resolvePluginFile(dir, '/'), null)
  assert.equal(safeRelative('./a/b.js'), 'a/b.js')
  assert.equal(safeRelative('/etc/passwd'), null)
})

test('plugin files are served with a content type', () => {
  assert.match(mimeOf('a/index.html'), /^text\/html/)
  assert.match(mimeOf('x.JS'), /^text\/javascript/)
  assert.equal(mimeOf('icon.svg'), 'image/svg+xml')
  assert.equal(mimeOf('blob.bin'), 'application/octet-stream')
})

test('the example plugin in examples/plugins is valid', () => {
  const exampleDir = path.resolve('examples/plugins/todo-board')
  const r = parseManifest(JSON.parse(fs.readFileSync(path.join(exampleDir, 'package.json'), 'utf8')), exampleDir)
  assert.ok('plugin' in r, 'error' in r ? r.error : '')
  for (const s of r.plugin.screens) {
    assert.ok(fs.existsSync(path.join(exampleDir, s.entry)), `missing ${s.entry}`)
    if (s.icon.endsWith('.svg')) assert.ok(fs.existsSync(path.join(exampleDir, s.icon)), `missing ${s.icon}`)
  }
})

test('the API script for plugin screens is valid JavaScript', async () => {
  const vm = await import('node:vm')
  const { PLUGIN_API_JS } = await import('../src/main/pluginApi.ts')
  assert.doesNotThrow(() => new vm.Script(PLUGIN_API_JS))
})
