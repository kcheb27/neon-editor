import assert from 'node:assert/strict'
import { test } from 'node:test'
import { basename, dirname, isInside, join, pathKey, setPlatform } from '../src/renderer/src/util.ts'

// One window can show a Windows workspace and a terminal tree on a Linux SSH host (or the
// reverse), so the helpers must follow each path's own style, not the workspace's.
for (const [sep, platform] of [['\\', 'win32'], ['/', 'linux']] as const) {
  test(`path helpers handle both styles (workspace on ${platform})`, () => {
    setPlatform(sep, platform)
    // POSIX paths, e.g. a tree on an SSH host
    assert.equal(join('/home/pi', 'src'), '/home/pi/src')
    assert.equal(dirname('/home'), '/')
    assert.equal(dirname('/home/pi/src'), '/home/pi')
    assert.notEqual(pathKey('/home/pi/Src'), pathKey('/home/pi/src'), 'POSIX is case-sensitive')
    assert.ok(isInside('/home/pi', '/home/pi/src/a.ts'))
    // Windows paths, e.g. a local terminal tree in an SSH workspace
    assert.equal(join('C:\\Users\\me', 'src'), 'C:\\Users\\me\\src')
    assert.equal(join('C:\\', 'Users'), 'C:\\Users')
    assert.equal(dirname('C:\\Users'), 'C:\\')
    assert.equal(dirname('C:\\Users\\me\\src'), 'C:\\Users\\me')
    assert.equal(pathKey('C:\\Users\\Me'), pathKey('c:\\users\\me'), 'Windows is case-insensitive')
    assert.ok(isInside('C:\\Users\\me', 'C:\\Users\\me\\src'))
    assert.equal(basename('C:\\Users\\me\\a.ts'), 'a.ts')
    assert.equal(basename('/home/pi/a.ts'), 'a.ts')
  })
}
