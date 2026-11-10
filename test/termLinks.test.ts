import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findPaths, resolvePath } from '../src/renderer/src/termLinks.ts'

const paths = (line: string) => findPaths(line).map(({ path, line: l, col }) => [path, l, col])

test('finds file paths with locations in compiler and test output', () => {
  assert.deepEqual(paths('src/app.ts:12:5 - error TS2322: Type mismatch'), [['src/app.ts', 12, 5]])
  assert.deepEqual(paths('  at run (/home/pi/project/lib/run.js:40:13)'), [['/home/pi/project/lib/run.js', 40, 13]])
  assert.deepEqual(paths('src\\main.cs(14,9): error CS1002'), [['src\\main.cs', 14, 9]])
  assert.deepEqual(paths('File "./tools/build.py", line 3'), [['./tools/build.py', undefined, undefined]])
  assert.deepEqual(paths('modified:   README.md'), [['README.md', undefined, undefined]])
  assert.deepEqual(paths('C:\\Users\\me\\proj\\index.ts:3'), [['C:\\Users\\me\\proj\\index.ts', 3, undefined]])
  assert.deepEqual(paths('see ~/notes/todo.txt and ../other/a.json'), [['~/notes/todo.txt', undefined, undefined], ['../other/a.json', undefined, undefined]])
})

test('ignores URLs, emails and version numbers', () => {
  assert.deepEqual(paths('open https://example.com/docs/page.html now'), [])
  assert.deepEqual(paths('mail me@example.com'), [])
  assert.deepEqual(paths('node v20.11.1 and 1.5 seconds'), [])
})

test('resolves paths against the shell folder in its own style', () => {
  assert.equal(resolvePath('/home/pi/project', 'src/app.ts', '/home/pi'), '/home/pi/project/src/app.ts')
  assert.equal(resolvePath('/home/pi/project/src', '../lib/x.js', '/home/pi'), '/home/pi/project/lib/x.js')
  assert.equal(resolvePath('/home/pi/project', './a/./b.ts', '/home/pi'), '/home/pi/project/a/b.ts')
  assert.equal(resolvePath('/anywhere', '~/notes/t.txt', '/home/pi'), '/home/pi/notes/t.txt')
  assert.equal(resolvePath('/x', '/etc/hosts.conf', '/home/pi'), '/etc/hosts.conf')
  assert.equal(resolvePath('C:\\Users\\me\\proj', 'src/app.ts', 'C:\\Users\\me'), 'C:\\Users\\me\\proj\\src\\app.ts')
  assert.equal(resolvePath('C:\\Users\\me\\proj', '..\\other\\b.ts', 'C:\\Users\\me'), 'C:\\Users\\me\\other\\b.ts')
  assert.equal(resolvePath('/', 'a.txt', '/root'), '/a.txt')
})
