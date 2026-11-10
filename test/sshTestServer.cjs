// A small SSH server for tests only. It listens on 127.0.0.1, accepts one user with a
// test-only password, serves files over SFTP, and runs commands and shells with Git Bash
// (Windows) or /bin/sh. Paths are Git Bash style ("/c/Users/..."), so the same path works
// for SFTP and for commands.

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { Server, utils } = require('ssh2')

const { OPEN_MODE, STATUS_CODE } = utils.sftp
const WINDOWS = process.platform === 'win32'
const BASH = process.env.NEON_TEST_BASH || (WINDOWS ? 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' : '/bin/bash')

const { execFileSync } = require('node:child_process')
const CYGPATH = WINDOWS ? path.join(path.dirname(BASH), 'cygpath.exe') : null

// Git Bash mounts some Windows folders elsewhere (the Temp folder shows up as /tmp), so the
// server asks cygpath how bash sees the home folder and maps paths under it both ways.
const mounts = [] // [remotePrefix, localPrefix]

function learnMount(local) {
  if (!WINDOWS) return
  const remote = execFileSync(CYGPATH, ['-u', local], { encoding: 'utf8' }).trim()
  mounts.push([remote.replace(/\/$/, ''), local.replace(/[\\/]$/, '')])
}

/** Remote (bash) path -> local Windows path. */
function toLocal(p) {
  if (!WINDOWS) return p
  for (const [remote, local] of mounts) {
    if (p === remote || p.startsWith(remote + '/')) return local + p.slice(remote.length).replace(/\//g, '\\')
  }
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p)
  if (!m) return p
  return `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`
}

/** Local Windows path -> remote (bash) path. */
function toRemote(p) {
  if (!WINDOWS) return p
  for (const [remote, local] of mounts) {
    const lower = p.toLowerCase()
    if (lower === local.toLowerCase() || lower.startsWith(local.toLowerCase() + '\\')) {
      return remote + p.slice(local.length).replace(/\\/g, '/')
    }
  }
  const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(p)
  if (!m) return p.replace(/\\/g, '/')
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.replace(/\/$/, '') || '/'
}

function attrsOf(st) {
  return {
    mode: st.mode,
    uid: 0,
    gid: 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  }
}

function errStatus(err) {
  if (err && err.code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) return STATUS_CODE.PERMISSION_DENIED
  return STATUS_CODE.FAILURE
}

/**
 * Start the server. Returns { port, hostKeyLine(name), close(), dropAll() }.
 * `home` is a local folder used as the user's home directory.
 */
function startServer({ home, user, password, hostKey }) {
  learnMount(home)
  const remoteHome = toRemote(home)
  const clients = new Set()

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => {})
    client.on('authentication', (ctx) => {
      if (ctx.username !== user) return ctx.reject()
      if (ctx.method === 'password') return ctx.password === password ? ctx.accept() : ctx.reject(['password'])
      ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        let ptyInfo = null
        let ptyProc = null
        const env = {}
        session.on('pty', (accept, _reject, info) => {
          ptyInfo = info
          accept && accept()
        })
        session.on('env', (accept, _reject, info) => {
          env[info.key] = info.val
          accept && accept()
        })
        session.on('window-change', (accept, _reject, info) => {
          if (ptyProc) ptyProc.resize(info.cols, info.rows)
          accept && accept()
        })
        session.on('exec', (accept, _reject, info) => {
          const stream = accept()
          const childEnv = { ...process.env, HOME: home, ...env, SHELL: '/usr/bin/bash' }
          if (ptyInfo) {
            const pty = require('node-pty')
            ptyProc = pty.spawn(BASH, ['-c', info.command], {
              name: ptyInfo.term || 'xterm-256color',
              cols: ptyInfo.cols || 80,
              rows: ptyInfo.rows || 24,
              cwd: home,
              env: childEnv
            })
            ptyProc.onData((d) => stream.write(d))
            stream.on('data', (d) => ptyProc && ptyProc.write(d.toString('utf8')))
            ptyProc.onExit(({ exitCode }) => {
              ptyProc = null
              stream.exit(exitCode)
              stream.end()
            })
            stream.on('close', () => ptyProc && ptyProc.kill())
            return
          }
          const child = spawn(BASH, ['-c', info.command], { cwd: home, env: childEnv, windowsHide: true })
          child.stdout.pipe(stream, { end: false })
          child.stderr.pipe(stream.stderr, { end: false })
          stream.on('data', (d) => child.stdin.write(d))
          stream.on('end', () => child.stdin.end())
          child.on('close', (code) => {
            stream.exit(code ?? 0)
            stream.end()
          })
          child.on('error', () => {
            stream.exit(127)
            stream.end()
          })
        })
        session.on('sftp', (accept) => serveSftp(accept(), remoteHome))
      })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      const pub = utils.parseKey(hostKey).getPublicSSH()
      resolve({
        port,
        hostKeyLine: () => `[127.0.0.1]:${port} ${utils.parseKey(hostKey).type} ${pub.toString('base64')}`,
        /** Cut every connection, as a network drop would. */
        dropAll: () => {
          for (const c of clients) c.end()
        },
        close: () =>
          new Promise((r) => {
            for (const c of clients) c.end()
            server.close(() => r())
          })
      })
    })
  })
}

function serveSftp(sftp, remoteHome) {
  const handles = new Map()
  let next = 1
  const newHandle = (value) => {
    const id = next++
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(id)
    handles.set(id, value)
    return buf
  }
  const getHandle = (buf) => (buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : undefined)
  const dropHandle = (buf) => buf.length === 4 && handles.delete(buf.readUInt32BE(0))
  const resolvePath = (p) => {
    if (!p || p === '.') return remoteHome
    if (!p.startsWith('/')) return path.posix.join(remoteHome, p)
    return path.posix.normalize(p)
  }

  sftp.on('REALPATH', (id, p) => {
    const full = resolvePath(p)
    sftp.name(id, [{ filename: full, longname: full, attrs: {} }])
  })
  const statHandler = (follow) => (id, p) => {
    try {
      const st = follow ? fs.statSync(toLocal(resolvePath(p))) : fs.lstatSync(toLocal(resolvePath(p)))
      sftp.attrs(id, attrsOf(st))
    } catch (err) {
      sftp.status(id, errStatus(err))
    }
  }
  sftp.on('STAT', statHandler(true))
  sftp.on('LSTAT', statHandler(false))
  sftp.on('FSTAT', (id, handle) => {
    const h = getHandle(handle)
    if (!h || h.type !== 'file') return sftp.status(id, STATUS_CODE.FAILURE)
    try {
      sftp.attrs(id, attrsOf(fs.fstatSync(h.fd)))
    } catch (err) {
      sftp.status(id, errStatus(err))
    }
  })
  sftp.on('OPEN', (id, filename, flags, attrs) => {
    let mode = ''
    const write = flags & OPEN_MODE.WRITE
    const read = flags & OPEN_MODE.READ
    if (flags & OPEN_MODE.APPEND) mode = read ? 'a+' : 'a'
    else if (write) mode = flags & OPEN_MODE.TRUNC ? (read ? 'w+' : 'w') : flags & OPEN_MODE.CREAT ? (read ? 'w+' : 'w') : 'r+'
    else mode = 'r'
    if (flags & OPEN_MODE.EXCL) mode = mode.replace('w', 'wx')
    try {
      const fd = fs.openSync(toLocal(resolvePath(filename)), mode, attrs && attrs.mode ? attrs.mode & 0o777 : 0o644)
      sftp.handle(id, newHandle({ type: 'file', fd }))
    } catch (err) {
      sftp.status(id, err.code === 'EEXIST' ? STATUS_CODE.FAILURE : errStatus(err))
    }
  })
  sftp.on('READ', (id, handle, offset, length) => {
    const h = getHandle(handle)
    if (!h || h.type !== 'file') return sftp.status(id, STATUS_CODE.FAILURE)
    const buf = Buffer.alloc(length)
    const n = fs.readSync(h.fd, buf, 0, length, offset)
    if (n === 0) return sftp.status(id, STATUS_CODE.EOF)
    sftp.data(id, buf.subarray(0, n))
  })
  sftp.on('WRITE', (id, handle, offset, data) => {
    const h = getHandle(handle)
    if (!h || h.type !== 'file') return sftp.status(id, STATUS_CODE.FAILURE)
    fs.writeSync(h.fd, data, 0, data.length, offset)
    sftp.status(id, STATUS_CODE.OK)
  })
  sftp.on('CLOSE', (id, handle) => {
    const h = getHandle(handle)
    if (h && h.type === 'file') fs.closeSync(h.fd)
    dropHandle(handle)
    sftp.status(id, STATUS_CODE.OK)
  })
  sftp.on('OPENDIR', (id, p) => {
    const local = toLocal(resolvePath(p))
    try {
      const names = fs.readdirSync(local)
      sftp.handle(id, newHandle({ type: 'dir', local, names, done: false }))
    } catch (err) {
      sftp.status(id, errStatus(err))
    }
  })
  sftp.on('READDIR', (id, handle) => {
    const h = getHandle(handle)
    if (!h || h.type !== 'dir') return sftp.status(id, STATUS_CODE.FAILURE)
    if (h.done) return sftp.status(id, STATUS_CODE.EOF)
    h.done = true
    const list = []
    for (const name of h.names) {
      try {
        const st = fs.lstatSync(path.join(h.local, name))
        list.push({ filename: name, longname: name, attrs: attrsOf(st) })
      } catch {
        // vanished
      }
    }
    if (!list.length) return sftp.status(id, STATUS_CODE.EOF)
    sftp.name(id, list)
  })
  sftp.on('MKDIR', (id, p) => {
    try {
      fs.mkdirSync(toLocal(resolvePath(p)))
      sftp.status(id, STATUS_CODE.OK)
    } catch (err) {
      sftp.status(id, errStatus(err))
    }
  })
  sftp.on('RENAME', (id, from, to) => {
    try {
      if (fs.existsSync(toLocal(resolvePath(to)))) return sftp.status(id, STATUS_CODE.FAILURE)
      fs.renameSync(toLocal(resolvePath(from)), toLocal(resolvePath(to)))
      sftp.status(id, STATUS_CODE.OK)
    } catch (err) {
      sftp.status(id, errStatus(err))
    }
  })
  sftp.on('REMOVE', (id, p) => {
    try {
      fs.unlinkSync(toLocal(resolvePath(p)))
      sftp.status(id, STATUS_CODE.OK)
    } catch (err) {
      sftp.status(id, errStatus(err))
    }
  })
  sftp.on('RMDIR', (id, p) => {
    try {
      fs.rmdirSync(toLocal(resolvePath(p)))
      sftp.status(id, STATUS_CODE.OK)
    } catch (err) {
      sftp.status(id, errStatus(err))
    }
  })
  sftp.on('SETSTAT', (id) => sftp.status(id, STATUS_CODE.OK))
  sftp.on('FSETSTAT', (id) => sftp.status(id, STATUS_CODE.OK))
}

module.exports = { startServer, toLocal, toRemote }
