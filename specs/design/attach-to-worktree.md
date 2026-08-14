# DESIGN BRIEF — Attach a session to an existing worktree (`attach-to-worktree`)

**Goal:** from New Session, see every existing git worktree of the chosen repo and open the session
directly in one of them — without creating a branch, a directory, or anything else.

**Design system:** the existing UI kit (`src/ui/`) + tokens in `src/styles.css`. Identity v2 —
accent acid `#c3f53f` (one live thing per view), ready green `#4fae86`. Sources of truth:
`Francois Redesign.dc.html` (shell, turn 4) and `Francois Design System v2.dc.html`. Desktop-only
app — not mobile-first; the responsive axis is **window resize**, not breakpoints.

## Screens / views

Exactly one surface. Nothing outside it changes.

- **New Session modal → WORKTREE group** — pick how (and whether) this session gets its own checkout.
  - **Chip row** — two mutually exclusive chips replacing today's single one:
    `Isolate in worktree` · `Attach to existing`. Selected chip carries the accent treatment
    (`Chip selected`); clicking the selected chip returns to neither-selected. The `✓ ` prefix on the
    selected chip stays as it is today. Hint line under the row changes with the mode:
    neither → `runs this session in its own git worktree` · create → unchanged ·
    attach → `opens this session in a worktree that already exists`.
  - **`Attach to existing` — disabled state.** When the repo has no linked worktrees the chip is
    dimmed and inert, with the hint `no other worktrees in this repo` in the error/muted tone (not
    red — it is a fact, not a failure). `Isolate in worktree` is unaffected.
  - **Picker** (attach mode only, replaces the branch / base-ref / path-preview block) — a bordered,
    vertically scrollable list, `max-height` ≈ 5 rows, internal scroll (`className="scz"`, the
    modal's existing scrollbar treatment). Reuse `ListRow` from the UI kit.
    - **Row**: two lines. Line 1 — the **label** in mono: the branch name, or `HEAD @ 1a2b3c4` for a
      detached tree (`HEAD @ ?` when the sha is unknown). Line 2 — the **path** in mono, one size
      down, muted, **left-truncated** (`direction: rtl; text-align: left` + `nowrap/ellipsis` — the
      same treatment as the FR-9 path preview and the FR-13 branch chip), full value in `title`.
    - **Annotation** (right-aligned on line 1, small caps or muted small text):
      `in use by "<session name>"` · `locked` · `directory missing`. Multiple join with ` · `.
    - **States**: default · hover (row background lift) · **selected** (accent left-edge or
      background, matching how selected rows read elsewhere in the app) · **disabled** (prunable —
      dimmed, no hover, not clickable).
  - **Caution line** — appears under the picker only while the selected row is `in use by`:
    `two sessions in one worktree share a checkout — their DIFF and commits will mix`, in the warn
    tone (`var(--warn)`, bare — no dead fallback value). One line, no icon, no dismissal.
  - **Resolved cwd line** — dim, mono, read-only, under the picker (and under the caution line when
    both show): the selected row's path, left-truncated, full value in `title`. It is the answer to
    "where will this session actually run", since the modal's own DIRECTORY field keeps showing the
    **source repo**.
  - **States** for the group as a whole: absent (cwd is not a repo) · loading (probe in flight — the
    picker keeps its last rows, Create is blocked; no spinner, no layout shift) · empty (chip
    disabled) · error (probe failed — same as loading: last rows kept, Create blocked).

## Flows

1. User opens New Session and picks a directory that is a git repo.
2. The WORKTREE chip row appears with both chips (the second dimmed if there is nothing to attach to).
3. User clicks **Attach to existing** → the branch / base-ref / preview block is replaced by the
   picker, already populated from the probe that ran on the directory change.
4. User clicks a row. It becomes selected; if the NAME field is still empty and untouched it fills
   with the row's label; the resolved cwd line appears below.
5. If that row is already in use, the caution line appears. The row stays selected and Create stays
   enabled — this is a warning, not a gate.
6. **Create session** → the session opens in that directory. No branch is created, no directory is
   created, no fetch runs.
7. In the session: the sidebar card and status bar carry the branch chip (or `HEAD @ 1a2b3c4`).
   **No** "nothing came along" banner — Francois did not create this tree and claims nothing about it.

Variation: changing the DIRECTORY field at any point clears the selection and empties the picker for
the moment it takes to re-probe; Create is blocked until a row is picked again.

## Responsive

Desktop window resize only.

- **Narrow window** — the modal card already caps at `calc(100vh - 118px - 24px)` with an internally
  scrolling body; the picker's own `max-height` must live inside that, so the group never pushes the
  Cancel / Create buttons off-screen (the round-8 regression on `session-worktree`). Row paths
  left-truncate rather than wrap — the meaningful tail is the worktree name.
- **Wide window** — the modal does not grow; the picker keeps its max height and the extra width goes
  to the path, revealing more of it.

## Data shown

Per row (from `WorktreeListEntry`, spec §5): `branch` → the label, or `HEAD @ <7 chars of head>` when
`detached`; `path` → line 2 and the `title`; `locked` → annotation; `prunable` → `directory missing`
+ disabled. `in use by` is derived in the frontend from the live session roster, not from the entry.

Nothing else. Deliberately **not** shown: dirty file counts, ahead/behind, last-commit subject — each
costs a git invocation per tree on a debounced path (spec §2 non-goals).

## Notes / constraints

- **Copy is English** (`ui_language: English`), lowercase-sentence style matching the modal's existing
  hints; no terminal punctuation on hint lines.
- **Icons** are `lucide-react` imported by name, inheriting `currentColor` — tone set in CSS, never a
  `color` prop. A branch glyph on the row label is optional and must match the FR-13 chip's glyph.
- **Styling** is `src/features/sessions/new-session-modal.css` (BEM-lite, extending the existing
  `worktree-field__*` block); no inline `style={{}}` except for a runtime-computed value. Font-weight
  ceiling 600.
- **Accent discipline**: the selected row and the selected chip are the same live thing. Do not let
  both compete — the chip's selected state is the mode, the row's is the target; if they read as two
  accents at once, drop the row to a neutral selected background with an accent left edge.
- **Keyboard**: the picker is reachable by Tab and navigable with `↑`/`↓`, `Enter` selects. Disabled
  rows are skipped. Follow `useRowCursorClamp`'s existing behaviour in the sidebar list.
- **Empty is not an error.** A repo with no linked worktrees, and a failed `git worktree list`, look
  identical to the user: the chip is simply dimmed. Neither shows a red state.
