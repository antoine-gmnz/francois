# Keyboard shortcuts

Francois is keyboard-first throughout, with full mouse support alongside every binding below.

::: info When single-key shortcuts are suspended
All single-key shortcuts (`1`–`5`, `d`, `t`, `o`, `w`, `n`, `a`, `/`, `⏎`, `[`, `]`) are
suspended while you're typing in any text input or while the SHELL terminal has focus — so
typing "not" into the composer never opens tabs. `⌘K`/`Ctrl+K` always works, everywhere.
:::

## Global

| Key | Action |
| --- | --- |
| `1`–`5` | Focus sessions sidebar / main pane / agents / MCP servers / skills |
| `d` | Toggle the DIFF tab (press again to return to SESSION) |
| `t` | Toggle the SHELL tab (press again to return to SESSION) |
| `o` | Toggle the OVERVIEW tab (press again to return to SESSION) |
| `w` | Close the active agent tab (no-op on the built-in tabs) |
| `n` | New session |
| `a` | New agent (when a session is active) |
| `[` / `]` | Show / hide the left / right column |
| `⌘K` / `Ctrl+K` | Toggle the command palette |
| `esc` | Dismiss the command palette or an open modal |

## In the sessions sidebar (pane `[1]` focused)

| Key | Action |
| --- | --- |
| `/` | Open the session filter |
| `↑` `↓` | Move the keyboard cursor through the list |
| `⏎` | Select the session under the cursor |
| `esc` | Clear / close the filter |

## Inside the SESSION composer

| Key | Action |
| --- | --- |
| `⏎` | Send |
| `⇧⏎` | Newline without sending |
| `⌃C` | Interrupt the running turn (only when nothing in the composer is selected — `⌃C` with a selection still copies it; macOS `⌘C` is untouched either way) |
| `/` | Open the slash-command menu (at the start of the input) |
| `↑` `↓` (menu open) | Move the slash-menu selection |
| `⏎` (menu open) | Run the highlighted command |
| `⇥` (menu open) | Complete the highlighted command's name |
| `esc` (menu open) | Dismiss the menu |

## Inside the command palette

| Key | Action |
| --- | --- |
| Type | Fuzzy-filters the command list live |
| `↑` `↓` | Move the highlighted command (wraps at both ends) |
| `⏎` | Run the highlighted command |
| `esc` | From a secondary step (e.g. Switch model), go back to the top level; from the top level, dismiss — clicking the backdrop also dismisses |

## In the agents panel (pane `[3]` focused)

| Key | Action |
| --- | --- |
| `↑` `↓` | Move between agent cards |
| `⏎` | Expand / collapse the selected card's activity trail |
| `x` | Kill the selected running agent |

## In the skills panel (pane `[5]` focused)

| Key | Action |
| --- | --- |
| `/` | Filter the skills list |

## Inside SHELL

| Key | Action |
| --- | --- |
| `⌃C` | Interrupt the running foreground process |
| `⌃L` | Clear the screen |

Everything else you type is forwarded to the underlying PTY exactly as a normal terminal would
receive it — including `esc`, which the terminal swallows.

## Inside DIFF

| Key | Action |
| --- | --- |
| `←` `→` | Cycle through the changed-file chips |
| `s` | Stage all |
| `c` | Commit |

See [Diff & shell](/guide/diff-and-shell) for what each of these panes actually does, and
[Command palette](/guide/command-palette) for the full command registry `⌘K` searches.
