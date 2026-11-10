// Workspace identifiers: a local folder path, or "ssh://<host>/<path>" for a folder on an
// SSH host. <host> is an ssh config alias or user@host[:port]; <path> may start with "~".

export interface RemoteId {
  host: string
  path: string
}

const PREFIX = 'ssh://'

export function isRemoteId(id: string): boolean {
  return id.startsWith(PREFIX)
}

export function parseRemoteId(id: string): RemoteId | null {
  if (!isRemoteId(id)) return null
  const rest = id.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const host = decodeURIComponent(rest.slice(0, slash))
  let path = rest.slice(slash + 1)
  if (path === '' || path === '~') path = '~'
  else if (!path.startsWith('~')) path = '/' + path
  path = path.replace(/\/+$/, '') || '/'
  return { host, path }
}

export function makeRemoteId(host: string, path: string): string {
  const p = path.trim() || '~'
  const clean = p === '~' || p.startsWith('~/') ? p : '/' + p.replace(/^\/+/, '')
  // "/" itself is written as "ssh://host//" so it does not read back as "~".
  const tail = clean === '/' ? '/' : clean.replace(/^\//, '')
  return `${PREFIX}${encodeURIComponent(host)}/${tail}`
}

/** Short label for titles and lists. */
export function workspaceLabel(id: string, basename: (p: string) => string): string {
  const r = parseRemoteId(id)
  if (!r) return basename(id)
  const name = r.path === '~' ? '~' : r.path.split('/').filter(Boolean).pop() ?? '/'
  return `${r.host}: ${name}`
}
