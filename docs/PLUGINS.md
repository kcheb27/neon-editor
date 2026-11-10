# Plugins

A plugin adds **screens** to Neon Editor. A screen is either a sidebar view or a full-size
editor tab (next to your files), with its own icon in the activity bar and "Open" commands in the
command palette (Ctrl+Shift+P). Any sidebar screen can also be opened as an editor tab, from the
expand button in its header. A screen is plain
HTML, CSS and JavaScript, and works with the workspace through the `neon` API, whether the
workspace is local or over SSH.

Plugins live outside the app, so the app still ships as a single exe.

## Where plugins go

The app looks for one folder per plugin in:

| Folder | Use |
|---|---|
| `%APPDATA%\neon-editor\plugins\` | Per user. Survives replacing the exe. **Plugins: Open Plugins Folder** opens it. |
| `plugins\` next to `neon-editor.exe` | Travels with the portable exe, e.g. on a USB stick. |
| Folders in `NEON_PLUGINS_DIR` | Development. Separate several with `;` on Windows, `:` elsewhere. |

After adding or changing a plugin, run **Plugins: Reload Plugins**. **Plugins: Show Load
Problems** lists plugins that failed to load, and why.

## A plugin

```
my-plugin/
  package.json
  screen.html
  icon.svg        (optional)
```

`package.json`:

```json
{
  "name": "my-plugin",
  "displayName": "My Plugin",
  "version": "1.0.0",
  "neon": {
    "apiVersion": 1,
    "screens": [
      { "id": "main", "title": "My Screen", "icon": "icon.svg", "entry": "screen.html" },
      { "id": "report", "title": "My Report", "entry": "report.html", "location": "editor" }
    ]
  }
}
```

- `name`: lowercase letters, digits and dashes. It is the plugin's id.
- `neon.apiVersion`: must be `1` for this version of the app.
- `screens[].entry`: an HTML file inside the plugin folder.
- `screens[].location`: `"sidebar"` (default) for a sidebar view, or `"editor"` for a full-size
  editor tab. Editor tabs that were open are reopened when the window is.
- `screens[].icon`: an `.svg` or `.png` in the plugin folder (24×24), a built-in icon name
  (`files`, `search`, `git`, `remote`, `code`, `folder`, `windows`, `split`, `refresh`), or
  leave it out to show the title's first letter.

`screen.html` loads the API with one script tag:

```html
<script src="/_neon/api.js"></script>
<script>
  neon.ready.then(async () => {
    const ws = await neon.workspace()
    document.body.textContent = `Hello from ${ws.label}`
  })
</script>
```

A complete example is in [`examples/plugins/todo-board`](../examples/plugins/todo-board), with
two screens: a sidebar **TODO Board** that lists TODO/FIXME comments (click to open) and keeps
shell commands you can run in a terminal, and a full-size **Project Overview** editor tab with
file counts by type, git status and changed files. Copy the folder into your plugins folder to
try it.

## The `neon` API

Every call returns a Promise. Paths can be absolute, or relative to the workspace root.

| Call | Result |
|---|---|
| `neon.ready` | Resolves once the screen is connected (theme applied). |
| `neon.workspace()` | `{ root, label, remote, sshHost, sep, platform }` |
| `neon.fs.readdir(path?)` | `[{ name, kind: 'file' \| 'dir' }]`; the workspace root if no path |
| `neon.fs.list()` | Every file path in the workspace (honours .gitignore) |
| `neon.fs.readText(path)` | File contents as text (as saved on disk) |
| `neon.fs.writeText(path, text)` | Writes the file; open editors with no unsaved changes update |
| `neon.search(query, { regex, caseSensitive })` | `{ matches: [{ path, line, col, len, text }], files, truncated }` |
| `neon.git.status()` | `{ repo, branch, ahead, behind, files: { [path]: 'M' \| 'A' \| 'D' \| 'U' \| ... } }` |
| `neon.editor.open(path, line?, col?)` | Opens the file in the editor |
| `neon.editor.activeFile()` | Path of the active editor tab, or `null` |
| `neon.terminal.run(command, { target? })` | Opens a terminal and runs the command. `target`: omit for the workspace's machine, `'local'` for this machine, or an SSH host |
| `neon.ui.toast(message, 'info' \| 'error')` | Shows a notification |
| `neon.ui.ask(prompt, initialValue?)` | Text input; resolves the text or `null` |
| `neon.ui.confirm(message, buttons?)` | Resolves the label of the chosen button |
| `neon.commands.list()` / `neon.commands.run(id)` | The command palette's commands |
| `neon.screens.open(id, { location? })` | Opens another screen of this plugin, in the sidebar or as an editor tab (`'sidebar'` / `'editor'`; default: the screen's own) |
| `neon.storage.get(key)` / `neon.storage.set(key, value)` | Small JSON storage for this plugin (1 MB). `set(key, null)` deletes |
| `neon.on(event, fn)` | Subscribe; returns an unsubscribe function |

Events for `neon.on`:

| Event | Data |
|---|---|
| `show` / `hide` | The screen became visible / hidden (sidebar view shown, or its tab selected) |
| `files-changed` | `{ dirs }`: folders whose contents changed |
| `git-changed` | The new git status |
| `active-file` | `{ path }`: the active editor tab changed (`null` when no file tab is active) |

A screen open in the sidebar and as an editor tab runs as two separate pages. Share state
between them with `neon.storage`.

### Styling

The page starts with the editor's look (background, text, buttons, inputs). Theme colours are
available as CSS variables: `--neon-bg`, `--neon-bg-raised`, `--neon-bg-input`, `--neon-fg`,
`--neon-muted`, `--neon-accent`, `--neon-border`, `--neon-error`, `--neon-warning`,
`--neon-success`, `--neon-font`, `--neon-mono`.

### What a screen can and cannot do

A screen runs in a sandboxed frame: it can run scripts and use the `neon` API, but it cannot
reach the editor's own page, Node.js, or the other plugins. It can load files from its own
plugin folder and fetch from the internet.

The `neon` API itself is powerful: it can read and write workspace files and run commands in a
terminal. **Only install plugins you trust**, as you would with any program.

Plugins should be plain JavaScript (bundle libraries into the plugin folder). Native modules are
not supported.
