# Keyboard shortcuts

Francois is keyboard-first throughout, with full mouse support alongside every binding below.

## Global

| Key | Action |
| --- | --- |
| `1`–`5` | Focus sessions sidebar / main pane / agents / MCP servers / skills |
| `↑` `↓` | Navigate the focused pane |
| `⏎` | Open / commit the current selection |
| `/` | Filter sessions |
| `n` | New session |
| `a` | New agent |
| `d` | Toggle DIFF tab (focuses the main pane) |
| `t` | Toggle SHELL tab (focuses the main pane) |
| `[` / `]` | Show / hide the left / right column |
| `⌘K` / `Ctrl+K` | Open the command palette |
| `esc` | Dismiss the command palette or an open modal |

## Inside the SESSION composer

| Key | Action |
| --- | --- |
| `⏎` | Send |
| `⇧⏎` | Newline without sending |
| `⌃C` | Interrupt the running turn (only when nothing in the composer is selected — `⌃C` with a selection still copies it; macOS `⌘C` is untouched either way) |
| `/` | Open the slash-command menu |
| `↑` `↓` (menu open) | Move the slash-menu selection |
| `⏎` (menu open) | Run the highlighted command |
| `⇥` (menu open) | Complete the highlighted command's name |
| `esc` (menu open) | Dismiss the menu |

## Inside the command palette

| Key | Action |
| --- | --- |
| Type | Fuzzy-filters the command list live |
| `↑` `↓` | Move the highlighted command |
| `⏎` | Run the highlighted command |
| `esc` | Dismiss — clicking the backdrop does the same |

## Inside SHELL

| Key | Action |
| --- | --- |
| `⌃C` | Interrupt the running foreground process |
| `⌃L` | Clear the screen |

Everything else you type is forwarded to the underlying PTY exactly as a normal terminal would
receive it.

## Inside DIFF

| Key | Action |
| --- | --- |
| `s` | Stage all |
| `c` | Commit |

See [Diff & shell](/guide/diff-and-shell) for what each of these panes actually does, and
[Command palette](/guide/command-palette) for the full command registry `⌘K` searches.
