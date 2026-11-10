# Neon Editor

A desktop code editor built from the *Custom Code Editor* requirements and design docs:
Electron + Monaco, one shared **Workspace Host** process per project, any number of windows
per project (one per monitor), a terminal whose file tree follows its working directory,
and the **Neon Night** dark theme.

## Run it

```bash
npm install
npm start                 # build, then open the last project (or a welcome screen)
npx electron . <folder>   # open a specific folder (after a build)
npx electron . ssh://devbox/~/project   # open a folder on an SSH host
npm run dev               # development mode with hot reload for the window UI
```

Checks:

```bash
npm test          # unit tests, plus the SSH backend against a local test SSH server
npm run typecheck
npm run smoke     # drives the real app on a local and an SSH project; screenshots go to .smoke/
```

## What works

| Area | Status |
| --- | --- |
| Explorer sidebar | Lazy tree, git colors (M/A/U/D, ignored dimmed), new/rename/delete to trash, live refresh from a file watcher, resizable, Ctrl+B |
| Editor | Monaco with tabs, breadcrumbs, minimap, rainbow brackets, find/replace, multi-cursor, go to line/symbol, syntax checks for TS/JS/JSON/CSS/HTML |
| Multi-window | Ctrl+Shift+N opens another window on the same project. The same file in two windows is one buffer: typing, unsaved state and undo/redo are shared. Each window's position, monitor and layout are restored, and windows saved on a disconnected monitor move to the primary display |
| Terminal | Real shells (PowerShell on Windows, `$SHELL` elsewhere), several at once, Ctrl+` |
| Terminal file tree | A mini Explorer per terminal that follows `cd` (shell integration via OSC 633/7), browse up without losing your place, "Back to cwd", watches folders outside the project only while shown |
| Search | Ctrl+Shift+F across the project, regex and match case, honors .gitignore |
| Quick open / palette | Ctrl+P fuzzy file search, Ctrl+Shift+P commands |
| Git | Branch, ahead/behind and changed files in the status bar and Source Control view |
| SSH workspaces | "Connect to SSH Host…" (welcome screen, Remote view, palette, or click the status bar). Reads `~/.ssh/config` (Host, HostName, User, Port, IdentityFile, ProxyJump with one hop, Include). Auth by ssh-agent (including the Windows OpenSSH agent), key files (asks for passphrases), keyboard-interactive and password. Host keys are checked against `known_hosts`: unknown keys show their fingerprint for approval, changed keys are refused. Explorer, editing, search, git status and terminals all run on the host, and all windows of the project share one connection. If the connection drops it reconnects with backoff without asking again, and unsaved edits stay in the editor |
| Safety | Unsaved files survive closing a window while another window shows them; closing the last window asks to save; line endings and BOM are preserved |

## Not built yet

- **SSH, compared with the design doc.** There's no Rust agent yet, so SSH projects use the
  design's fallback: SFTP for files, commands for git, search and file lists, polling every
  2 s for changes. Terminals do not survive a dropped connection, a save made while
  disconnected fails (the text stays unsaved in the editor), and there is no 3-way merge.
  Port forwarding, nested `ssh` browsing from a local terminal, and SSH certificates are not
  built. Tested against a local test server (`test/sshTestServer.cjs`), not yet a real Linux `sshd`.
- Language servers (go to definition, rename, real type errors). TypeScript semantic errors
  are switched off for now, because without a language server every import looks missing.
- Git staging, commits and diff views. Use the terminal for those for now.
- Split editors, dragging tabs between windows, settings UI, keybinding editor, extensions,
  debugger.
- zsh/fish shell integration (bash and PowerShell report their folder today).
- Project search is plain Node; the design calls for ripgrep.

## Layout

```
src/main      window manager, per-project Workspace Host processes, saved window layouts
src/host      Workspace Host: shared Yjs buffers, file watcher, git, search, terminals
src/host/ssh  SSH connection, ~/.ssh/config, known_hosts, shell quoting
              (localBackend.ts and remoteBackend.ts implement backend.ts)
src/preload   the only bridge from a sandboxed window to the main process
src/renderer  the window UI: explorer, editor tabs, terminal panel, search, palette
src/shared    message types used by all three
test/         unit tests and the smoke script
```
