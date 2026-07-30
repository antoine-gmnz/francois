# Command palette

The command palette is Francois's app-wide ⌘K/Ctrl+K overlay: a text input over a filterable
list of commands, with an optional second filtered list ("secondary step") for commands that
need one more pick — a model, an installed skill, a running agent. It is a pure frontend
feature: it owns no IPC channels of its own, and running a command means invoking the owning
feature's own channel, or opening that feature's own overlay.

## Opening the palette

`⌘K` on macOS / `Ctrl+K` on Windows and Linux opens the palette from anywhere in the app,
including while the SHELL tab's terminal has focus — app-shell owns the single global,
capture-phase keydown listener for this chord and dispatches into the palette's
`togglePalette()`. The palette itself installs no competing listener. The same
`togglePalette()` function backs the status bar's "⌘K commands" hint.

On open, the palette:

- captures whichever element currently has focus, so it can be restored on close,
- moves DOM focus to its own input (this is what stops a stray keystroke from reaching, say,
  a hidden xterm textarea),
- and always starts fresh: empty query, top-level list, first row selected — regardless of
  how the palette was last closed.

Closing works the same way in reverse. `Esc` is app-shell's `dismiss` binding: if the palette
is in a secondary step, it pops back to the top level (query and selection reset, palette
stays open); if it's already at the top level, it performs a full close and restores focus.
Clicking the backdrop always performs a full close, regardless of level, since that's a direct
mouse interaction on the palette's own DOM rather than something routed through app-shell.

## Fuzzy command matching

Filtering is a case-insensitive **ordered-subsequence match**, not fuzzy scoring or
Levenshtein distance: a query matches an entry's name (or, in a secondary step, an item's
label) if every character of the query appears in that string in order, though not
necessarily contiguously. Typing `df` therefore matches "**D**iff-**f**iles" but so does
anything else where `d` precedes `f`.

Ranking uses the match's **position**: scanning the string left to right and greedily
consuming query characters in order, the index at which the first character of the query was
consumed is that entry's match position. Results are sorted by match position ascending, ties
broken alphabetically. An empty query is a special case — it isn't ranked at all, and instead
returns every enabled command in registration order (or, in a secondary step, item-array
order).

Typing resets the selected row to index 0. Arrow-key navigation doesn't touch the query and
doesn't reset selection.

## The command registry

Every other UI feature registers its commands into the palette at bootstrap, before first
paint, via `registerPaletteCommand(cmd)`. A command has an `id`, a glyph, a name, an optional
dynamic `hint`, an optional `enabled(ctx)` predicate, and a `run(ctx)` that must return
synchronously — either `void` (the palette closes) or a `SecondaryStep` (the palette enters
secondary mode: a placeholder, a filtered item list, and an `onPick(id)`).

A command is shown in the top-level list only if `enabled` is absent or returns `true` for the
live `PaletteContext` (the active session id and the active session's running-agent count,
recomputed fresh on every render pass while the palette is open). Disabled commands are
omitted entirely — never shown grayed out.

Seven built-in commands ship in the app, registered in this fixed order (the order an empty
query displays):

| order | command | owning feature | hint | what it does |
|---|---|---|---|---|
| 1 | New session | sessions-sidebar | `spin up in cwd` | opens sessions-sidebar's own new-session modal |
| 2 | Switch model | session-engine | `sonnet · opus · haiku` | secondary step over the model catalog, then `session:switchModel` |
| 3 | Attach MCP server | mcp-panel | `from registry` | opens mcp-panel's own attach flow |
| 4 | Run skill | skills-panel | `browse installed` | secondary step over installed skills, then `skills:run` |
| 5 | View diff | app-shell | `{n} file{s} changed` | switches the main tab to DIFF (toggles back to SESSION if already there) |
| 6 | Compact context | session-engine | `{used} → summary` | fire-and-forget `session:compact` |
| 7 | Kill agent | agents-panel | `select running` | secondary step over running agents, then `agents:kill` |

The registry is open beyond these seven: any feature can register additional commands, and
they're filtered, ranked, and run identically to the built-ins once registered. Agents-panel,
for example, registers an eighth command, "New agent", that opens its own new-agent modal.
The usage bar registers a "Refresh usage limits" command that drives the same
`app:refreshUsage` channel as clicking the bar itself.

Two commands resolve to a secondary step whose data must already be sitting in memory the
moment `run` is called, since `run` can't return a promise: "Run skill" reads skills-panel's
existing installed-skills cache, and "Kill agent" reads agents-panel's existing per-session
agent map. "Switch model" is the one exception with no natural pre-existing cache, so
session-engine fetches the (static) model catalog once at its own bootstrap and serves `run`
from that.

Commands that resolve to a secondary step never chain into a further step — picking an item
always closes the palette. Commands that delegate to another feature's own overlay (New
session, Attach MCP server) return `void` and let that overlay grab its own focus on mount.

Every command closes the palette **optimistically**, before its delegated call resolves. If
the call resolves `{ ok: false }`, or rejects outright, the command surfaces a toast — a
small, app-wide notification that auto-dismisses after 4 seconds or on click — since the
palette is already gone by the time the failure is known.

## Keyboard navigation inside the palette

Because the palette's filter field is a real, focusable text input, app-shell's global
shortcuts are suspended while it has focus — so arrow keys, Enter, character keys, and
Backspace are free for the palette's own local handling without colliding with any global
binding.

| key | top level | secondary step |
|---|---|---|
| `↓` / `↑` | move selection down/up, wrapping at both ends | same |
| mouse hover | moves selection to the hovered row | same |
| `⏎` / row click | runs the selected command's `run(ctx)` | invokes `onPick(item.id)` for the selected item |
| type | filters and re-ranks the list, resets selection to row 0 | same, against item labels |
| `Backspace` (query non-empty) | edits the query normally | same |
| `Backspace` (query already empty) | — | pops back to the top level |
| `Esc` | performs a full close, restores prior focus | pops back to the top level (query and selection reset) |

An empty filtered result — no matching commands, or a secondary step whose source list is
legitimately empty (e.g. no installed skills) — renders a plain "no matching commands" row
instead of an empty list.

## The usage bar

Directly under the native window title bar sits a second, always-visible strip: the usage
bar. It shows the same plan-limit meters the Claude Code CLI reports for `/usage` — an
account-level fact, not a session-level one, so it looks identical no matter which session is
selected and never disappears when no session exists.

The bar renders every meter the core returns, in the order the core returned them, with no
client-side filtering or relabeling. Each meter is a label, a track/fill bar, and a percent:
below 80% used it renders in the accent color, at 80% or above it turns error-red. Hovering a
meter shows a native tooltip with the full label and its exact reset text, verbatim from the
CLI (no parsing, reformatting, or localization).

Meters observed in practice include a **current session** meter and a **current week**
meter broken out per model — matching the same breakdown `/usage` prints in the transcript
(`Current session: 42% used · resets Jul 22, 5:29pm (Europe/Paris)`).

The bar's trailing slot always shows something — it doubles as the click target for a manual
refresh — combining cache freshness and the session limit's reset countdown, joined by `·`,
e.g. `updated 2m ago · resets in 4h 12m`. It degrades gracefully: no meters yet means freshness
alone; no successful probe yet means the reset text alone (since pairing a live countdown with
"never" would be self-contradictory); neither means "never". The countdown is derived from the
first meter whose label matches `/session/i`, falling back to the first meter if none does, so
a renamed or single-meter plan still reads sensibly; an unparseable reset string renders
verbatim as "resets `<text>`" rather than guessing.

Refreshing happens automatically — once at app startup, every 5 minutes thereafter, and 15
seconds after any session's turn ends (coalescing multiple sessions finishing at once into a
single probe) — and can also be triggered manually by clicking the meter region, or via the
command palette's own "Refresh usage limits" command, for a keyboard-only path to the same
`app:refreshUsage` channel. At most one probe is ever in flight; a click while one is running
is a no-op, and the meters stay visibly dimmed to make that honest rather than a dead click.

If the CLI is missing, unauthenticated, or its output format drifts so nothing parses, the bar
degrades to an error affordance (`⚠ usage unavailable`, or just the glyph if stale meters are
still on screen) instead of blanking, throwing, or popping a modal — clicking it retries. The
usage bar is chrome, not a focusable pane: it never appears in the `1`-`5` pane cycle and takes
no focus ring.
