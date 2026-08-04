# DESIGN BRIEF — Open in VS Code (`open-in-vscode`)

> The "spec return". Paste into the design tool (Claude Design). Standalone version of
> `specs/open-in-vscode.md` §8. Visual source of truth: `Francois Redesign.dc.html` +
> `Francois Design System v2.dc.html` (where they disagree with `Claude Terminal.dc.html`, the
> redesign wins).

**Goal:** open the directory a session actually works in — plain checkout, worktree, or WSL — in the
editor the user already has installed, in one click from the sidebar row.

**Design system:** the existing UI kit (`src/ui/`) and the existing `.context-menu` block in
`src/features/sessions/sidebar.css`. Tokens from `src/styles.css`. JetBrains Mono throughout.
**This is a fixed-size desktop app, not a responsive web page** — there is no mobile breakpoint.

## Screens / views

### 1 — Sidebar row context menu, default state (modified)

The existing `.context-menu` popup on a pane [1] session row. Today its default state holds two
items: `Rename session`, `Remove session`.

- Elements: **one `Open in <label>` item per detected editor**, inserted **above** `Rename session`.
  Labels come from the core: `Open in VS Code`, `Open in VS Code Insiders`, `Open in Cursor`,
  `Open in Windsurf`. Same `.context-menu__item` treatment as the existing items — 13px, identical
  row padding, identical hover background.
- **No glyph, no icon, no divider** between the open group and the rename/remove pair. The menu is
  three or four short rows; a rule would make it read heavier than it is, and an icon column would
  force the two existing items to grow one.
- Ordering rationale, unchanged from `session-rename`: non-destructive actions read first, the
  destructive one stays last where the eye lands least by accident. The open items are the most
  frequent action, so they take the top.
- Each item carries the launcher's absolute path as its `title` (native tooltip) — the only place
  `EditorInfo.path` is ever shown, and the one hint available to a user wondering *which* install
  will open.
- States:
  - **one to four open items** — the common case, exactly what is installed.
  - **no open items** — the menu is **byte-identical to today's**. Nothing dimmed, nothing
    explained, no empty-state copy. A user with no VS Code family editor must not be told about a
    feature that cannot work for them.
  - **hover** on any item — the existing hover treatment, no variation.
  - **unresolved** — the detection call has not returned yet (first menu open of the app run, a few
    milliseconds). Renders exactly as the no-open-items state. **No spinner, no skeleton, no
    placeholder row**: a shimmer inside a two-row menu is more disruptive than a menu that gains a
    row on the next open.

### 2 — Context menu, error state (reused as-is)

A failed launch reuses the **existing** `.context-menu__error` line — the same one the remove flow
already uses — rendering the core's `error.message` verbatim.

- No new colour, no icon, no retry button, no toast. The user reopens the menu and clicks again.
- The confirm state of the remove flow is **untouched** and never offers an open item: once the user
  is answering "remove this?", a second escape route is noise.

## Flows

**A — plain project.** Right-click a session row → the menu opens with `Open in VS Code` at the top
→ click → the menu closes immediately and the editor window appears. Nothing in Francois changes:
no status flip, no badge, no row highlight, no confirmation. The launch is invisible in the app,
which is correct — the feedback is the editor window itself.

**B — several editors.** Two installed ⇒ two rows, in the fixed order VS Code · VS Code Insiders ·
Cursor · Windsurf. No submenu, no picker modal, no remembered default: the choice is made by
clicking, every time.

**C — worktree session.** Identical menu, identical click. The editor opens on the worktree
directory. **There is deliberately no second item for the source repo** and no hint that a worktree
is involved — the session card and status bar already carry the branch chip.

**D — WSL session.** Identical menu, identical click. The editor opens a Remote-WSL window. **The
menu never mentions WSL, remote, or the distro** — routing is the core's job, and surfacing it would
ask the user to reason about something they already decided when they picked the directory.

**E — failure.** Click → the menu stays open and swaps to the error line → click anywhere to dismiss.

## Responsive

The context menu is already position-clamped to the window (existing behaviour). Adding up to four
rows makes it taller, so the existing clamp must keep the last row (`Remove session`) on-screen when
a row near the bottom of a tall sidebar is right-clicked — the same rule that applies today, now
exercised harder. Item labels never wrap and never truncate: the longest is
`Open in VS Code Insiders`, which the menu's existing width comfortably carries.

## Data shown

- **`EditorInfo.label`** per detected editor, composed into `Open in <label>` — from
  `session:editorList` (spec §5).
- **`EditorInfo.path`** as the item's native `title` tooltip only.
- **`error.message`** verbatim on failure, in the existing error line.
- Nothing else. No path preview, no distro name, no editor version, no icon, no session cwd.

## Notes / constraints

- **Copy is English and sentence-cased**, matching the menu's existing voice: `Open in VS Code`,
  alongside `Rename session` / `Remove session`.
- **Absence over explanation.** The frozen decision is that an undetected editor produces *no* UI —
  matching `session-worktree` FR-1, where the worktree control is absent rather than disabled on a
  non-git directory. Do not design a "VS Code not found — install the `code` command" affordance.
- **Accessibility / focus**: the open items join the menu's existing keyboard and focus behaviour
  with no exception. Escape closes the menu as today.
- **Motion**: none added. The menu's existing open/close transition covers everything; a launch has
  no progress worth animating.
- **Acid restraint** (design system v2, "one live thing per view"): the open items are ordinary menu
  rows in default text colour. The accent `#c3f53f` is **not** used here — nothing about launching
  an editor is the live thing in the view.
