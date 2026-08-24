# DESIGN BRIEF — Session settings sheet — one form, two modes (`session-settings-sheet`)

> §8 of `specs/session-settings-sheet.md`, standalone. Source of truth: design turn **15a** in
> `Francois Redesign.dc.html` (project `a4b15728-147c-4932-b83c-f60a5fc60db7`) — *"One form, two
> modes"*. This brief is the **applied** reading of 15a: the mock is drawn in the pre-9a acid
> `#c3f53f`; everything below names the repo's tokens instead (`--accent: #9cb45f`). Where 15a and
> the flat treatment (9a) disagree on a stroke, 15a wins — it is the later turn.

**Goal:** a user opens one form to see and change everything about a session — before it exists, or
mid-turn — and can tell at a glance what they have changed and when it will take effect.

**Design system:** the existing UI kit (`src/ui/`) — `Modal` / `ModalHeader` / `ModalBody` /
`ModalFooter`, `Chip`, `ChipGroup`, `Button`, `StatusDot`. Tokens from `src/styles.css`. Desktop
only; there is no mobile viewport. Styling is per-feature CSS + classNames
(`src/features/sessions/session-settings.css`), BEM-lite, no inline `style`.

## Screens / views

### One component, two headers

480px wide modal, scrollable body, fixed foot. The **field order is identical in both modes** — that
is the whole idea. What differs is which rows are still decidable.

- **Create mode** — headed `› new session` (the `›` in `--accent`) with a right-aligned
  *defaults from `<project>`* in `--text-faint` mono.
  1. `PROJECT` (select, flex 1) + `NAME` (text) — one row. Under it, a mono `runs in <cwd>` line.
  2. `MODEL` (select, flex 1) + `EFFORT` (segmented, fixed 176px) — one row.
  3. `ACCOUNT` — avatar square, label, `<n>% left`, caret. Sub-line *from project defaults* when
     inherited.
  4. `PROFILE` — select; absent when no profile exists.
  5. `RUNTIME` — `native` / `wsl` segmented + the distro name; Windows only. Hint line under it.
  6. — 1px `--border-emphasis` rule —
  7. `PERMISSIONS` — 4 chips (`ask` · `accept edits` · `plan` · `bypass`); the selected mode's
     consequence renders under the row. `bypass` alone hovers/selects into the danger tone.
  8. `RESPONSE` — 4 chips (`default` · `concise` · `explanatory` · `learning`); same hint treatment.
     **Non-default is the only state that tints**, matching the collapsed run chip.
  9. `GIT` — a pill switch + *allow git commands*, with a hint under it.
  10. — 1px rule —
  11. Worktree block — *Isolate in a worktree* switch, *attach to existing…* link, then `BRANCH` +
      `BASE` on one row and the resolved path in mono under them.
  - Foot: `⏎ create` hint · spacer · **Cancel** (ghost) · **Create session** (accent-filled).

- **Edit mode** — headed by the session's `StatusDot` in its roster tone, the session name
  (`--text-strong`), `ses_xxxx` (`--text-faint` mono) and the word `settings` (`--text-faint`).
  1. **`▣ FIXED AT SPAWN`** block (below).
  2. `NAME` — live.
  3. `MODEL` + `EFFORT` — one row, live.
  4. — rule —
  5. `PERMISSIONS` · `RESPONSE` · `GIT` — live, identical to create.
  - No worktree block, no `PROJECT`, no `ACCOUNT`, no `PROFILE`, no `RUNTIME` row — those live in
    the fixed block.
  - Foot: the change counter + timing line · spacer · *Set as project default* · **Cancel** ·
    **Apply**.

### `▣ FIXED AT SPAWN`

A recessed `--bg-deep` block, `border-radius: 7px`, `10px 12px 11px`. Not four disabled inputs — a
disabled input still reads as clickable and costs a full row to say nothing.

- Heading: `▣` glyph + `FIXED AT SPAWN`, both `--text-faint`, 10.5px mono, `.12em` tracking.
- Body: mono 11px `label / value` rows, 6px gap. Label column fixed 62px, `--text-faint`; value
  `--text-hint`. Rows, in order, each omitted when its value is absent:
  `project` · `worktree` (`⑂ <branch>` + a `--text-faint` `from <base>`) · `path` (single line,
  ellipsised from the **left** so the leaf survives, full value in `title`) · `runtime`
  (`wsl · Ubuntu-24.04`) · `account` · `profile`.
- Foot: a 1px `--border-emphasis` top rule, then *"The checkout and the runtime are decided when the
  session starts."* (11px, `--text-faint`) against a right-aligned **New session from these ↗** in
  `--accent`, hovering to `--accent-bright`.

### The changed-row treatment (edit mode only)

Edit mode is a **diff, not a form**. A row whose value differs from the session's current one gets,
all four together:

- its label lit from `--text-faint` to `--text-hint`;
- a 5px round `--accent` dot beside the label, `title="changed"`;
- `box-shadow: inset 0 0 0 1px var(--accent-soft-edge)` on the control itself;
- a mono 10.5px `--text-dim` `was <old value>` line, 5px under the control.

Reverting to the original value clears all four. Old values render with the same vocabulary the
control uses — `was Opus 4.6`, `was ask`, `was off`.

### States

- **empty** — n/a; the sheet always has a subject.
- **loading** — edit mode with the model catalog still in flight: `MODEL` shows the session's
  current model, unopenable; every other row is live. Never a blocking spinner over the sheet.
- **error** — the verb's `AppError.message` renders in the foot above the buttons, `--danger`, and
  the sheet stays open with the draft intact.
- **success** — the sheet closes. No toast.
- **busy session** — visually identical. **Nothing is disabled because a turn is running.**

## Flows

1. Run chip clicked (or `⌘,` / `Ctrl+,`, or roster context-menu **Settings…**, or the palette entry)
   → sheet opens in edit mode, focus on the first live control.
2. User changes 2 fields → each lights (dot + label + tint + `was …`); the foot's counter reads
   `2 changes` and the timing line names only the deferred ones.
3. **Apply** → one round-trip, sheet closes, the session row's run chip updates from the emitted
   `session.meta`.
4. **New session from these ↗** → the same modal instance swaps to create mode, every carried value
   pre-filled, worktree controls reset, header re-reads `› new session`.
5. `Escape` / backdrop with unsaved changes → one inline confirm strip in the foot
   (*discard changes?* · Keep editing · Discard); **Cancel** always discards without it.

## Responsive

Not a viewport question — the modal is 480px fixed on every window size (the shell's `minWidth` is
720). The only elastic behaviour is **inside** it:

- The body scrolls (`.scz` scrollbar treatment, `--border-emphasis` thumb); the header and foot are
  fixed.
- `PROJECT`/`NAME` and `MODEL`/`EFFORT` never wrap: the left field is `flex: 1; min-width: 0` and
  truncates; `EFFORT` is `flex: 0 0 176px`.
- The `path` line in `FIXED AT SPAWN` is the one string allowed to ellipsise, and it does so from
  the left.
- `EFFORT` renders **no track at all** when the model advertises no levels — the row collapses to
  `MODEL` at full width rather than showing an empty segmented control.

## Data shown

Every value comes from `SessionMeta` (contract `common.ts`) plus the project/account/model
registries the modal already reads. Matches spec §5.

| Row | Source | Editable in edit mode |
|---|---|---|
| status dot · name · `ses_xxxx` | `status`, `name`, `id` | name only |
| `project` | `projectId` → registry name | no |
| `worktree` | `worktree.branch`, `worktree.baseRef` | no |
| `path` | `cwd` (or `worktree.path`) | no |
| `runtime` | `runtime` + WSL distro | no |
| `account` | `accountId` → account label | no |
| `profile` | `profile.name` | no |
| `MODEL` | `model` + the account's catalog | **yes** |
| `EFFORT` | `effort` + `model.efforts` | **yes** |
| `PERMISSIONS` | `permissionMode` + `PERMISSION_MODE_OPTIONS` | **yes** |
| `RESPONSE` | `responseMode` + `RESPONSE_MODE_OPTIONS` | **yes** |
| `GIT` | `allowGit` (new on `SessionMeta`) | **yes** |
| foot counter | derived `dirtyKeys.length` | — |
| foot timing | derived from `dirtyKeys ∩ NEXT_TURN_KEYS` + `SETTING_LABELS` | — |

The foot's timing line names **only the deferred fields** — *"model and response apply from the next
turn"* — and is **absent entirely** when every change is immediate (`name`, `allowGit`). Never a
blanket claim.

## Notes / constraints

- **Copy is English**, sentence case in hints and prose, `UPPERCASE` mono for field labels only.
- **Tokens, not hex.** `--bg-panel` modal chrome, `--bg-raised` filled controls, `--bg-deep` for the
  fixed block and the foot, `--border-emphasis` for the two rules and the scroll thumb, `--accent`
  for the change dot / the ↗ link / the Apply fill, `--accent-soft-edge` for the changed-control
  inset, `--accent-dim` acceptable for the counter, `--text-faint` → `--text-hint` →
  `--text-strong` for the label / value / input ramp.
- **Accent budget.** 15a puts the accent on three things at once (dot, ↗ link, Apply). That is
  inside one modal, which is the "one focused surface" the 2026-08-17 `ui` rule allows; the roster
  and topbar behind it keep theirs.
- **The 1px inset on a changed control is deliberate** and the only stroke this feature adds — a
  tonal step cannot carry "this one differs" when the row beside it uses the same fill.
- **Accessibility.** Every group is a labelled fieldset; the changed dot is decorative and carries
  `title="changed"` with the `was …` line as the real, readable signal. `Escape` never destroys work
  silently. Focus order follows the visual order exactly.
- **Reuse before building.** `ProjectField`, `NameField`, `ModelField`, `AccountField`,
  `ProfileField`, `WorktreeField`, `ChipGroup`, `Chip` and `Modal` all exist; the new components are
  the `FIXED AT SPAWN` block, the changed-row wrapper and the foot.
