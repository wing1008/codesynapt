# Controls

## Mouse / pointer

| Action | Effect |
|---|---|
| **Click** a node | Select it (highlight in graph, context panel update) |
| **Double-click** a node | Open the inspector with full file content |
| **Click** empty space | Clear selection |
| **Right-click** a node | Open context menu (plugin items appear here) |
| **Drag** background | Orbit camera around the graph (vertical drag now passes through poles) |
| **Drag** a node | Move that node (the rest of the simulation responds) |
| **Scroll up** | Zoom in — anchored on cursor position (point under cursor stays put) |
| **Scroll down** | Zoom out — drifts back toward center (Obsidian-style) |
| **Idle for 4 s** | Camera slowly auto-rotates around focus target; any input cancels |

## Topbar buttons

| Button | Action |
|---|---|
| 📂 | Open folder |
| ↻ | Refresh current folder (`F5`) |
| 🗂 | Toggle file tree panel (`T`) |
| ❚❚ | Pause / resume layout (`Space`) |
| ⊕ | Recenter camera (`R`) |
| 📊 | Toggle stats panel (`S`) |
| ◀ | Toggle right rail (`M`) |
| `EN` / `한` | **Toggle language** (Korean ↔ English, persisted) |
| 📝 | **AI work** — files changed this session, with diff view |
| 🧭 | **Guided tour** — auto-generated walkthrough of entry points + hubs |
| ⏱ | **Time-lapse** — slider replays git history (file birth times) |
| ⚙ | Settings panel (`Ctrl/Cmd+,`) |

## Keyboard shortcuts

### Global

| Key | Action |
|---|---|
| `Ctrl+O` / `Cmd+O` | Open folder |
| `Ctrl+W` / `Cmd+W` | Close current folder (back to welcome screen) |
| `Esc` | Cascading dismiss — closes dialog, then inspector, then settings, then clears selection or filter (in that priority order) |
| `Ctrl+,` / `Cmd+,` | Toggle settings panel |
| `Space` | Pause / resume layout simulation |

### Search and focus

| Key | Action |
|---|---|
| `/` or `Ctrl+F` / `Cmd+F` | Focus search box |
| `Enter` (in search box) | Jump to first match (if any) |
| `Esc` (in search box) | Clear search |

### View

| Key | Action |
|---|---|
| `R` | Recenter camera on whole graph |
| `S` | Toggle stats panel |
| `M` | Toggle minimap |
| `T` | Toggle file tree panel |
| `1` / `2` / `3` | Restore saved camera view |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Save current camera view to slot |

### Inspector

| Key | Action (when inspector is open) |
|---|---|
| `Esc` | Close inspector |
| Click an edge row | Jump to that file |

## Settings dialog

When the project info dialog is open:

| Key | Action |
|---|---|
| `Enter` (in single-line input) | Save |
| `Esc` | Close (asks to confirm if you've typed anything) |
| `Tab` | Move to next field |

## Drag and drop

- **Drag a folder** onto the window → opens that folder
- **Drag a file** onto the window → opens its parent directory (we
  assume that's what you meant)
- **Drag multiple items** → only the first is used

Drag-drop is desktop only — it won't work in the browser dev server.

## Accessibility notes

- All buttons and clickable elements are keyboard-focusable
- `Esc` is reserved as the universal "dismiss" affordance
- Status changes (selection, scan progress) are announced via toasts
  with `role="status"`
- Theme contrast: the four dark themes all pass WCAG AA; the
  Daylight theme passes WCAG AAA for primary text

For more on accessibility, see the
[UX guidelines for plugin authors](../plugin-api/docs/types/theme.md#dark-vs-light-themes)
which apply to the app itself as well.

## Right-click menu

What appears in the right-click menu depends on context:

### On a graph node

- **Open file** — opens in default editor (`shell.openPath`)
- **Reveal in Finder/Explorer**
- **Copy path** to clipboard
- **Mark as active** / **Unmark**
- **Add to pipeline →** (submenu of your pipelines)
- Plugin items (each appears with its plugin's icon)

### On the canvas background

Currently no right-click action on empty space. Reserved for future.

## Discovering shortcuts in-app

Settings → Help → Show keyboard shortcuts displays this reference
as an overlay (planned for v0.12).
