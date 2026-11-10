// Quoting for commands run by a POSIX shell on the SSH host.

/** Quote one argument for sh/bash/zsh. */
export function shq(arg: string): string {
  if (arg === '') return "''"
  if (/^[A-Za-z0-9_\-+=.,/:@%]+$/.test(arg)) return arg
  // Close the quote, add an escaped quote, reopen: it's -> 'it'\''s'
  return `'${arg.replace(/'/g, "'\\''")}'`
}

/** Quote a path that may start with "~/", keeping the tilde unquoted so the shell expands it. */
export function shqPath(p: string): string {
  if (p === '~') return '~'
  if (p.startsWith('~/')) return `~/${shq(p.slice(2))}`
  return shq(p)
}

export function shJoin(args: string[]): string {
  return args.map(shq).join(' ')
}
