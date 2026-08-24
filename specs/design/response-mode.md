# DESIGN BRIEF — Response mode (`response-mode`)

> The "spec return". §8 of `specs/response-mode.md`, standalone.
> `design_files: []` stays empty: this adds a section inside existing chrome, matching
> `session-permission-mode`, `attach-to-worktree`, `multiple-shells` and `self-update`.

**Goal:** tell the model how to write back — concise, explanatory or teaching — on any session, any
runtime, without recreating it.

**Design system:** the existing kit. Flat treatment (turn 9a): no 1px strokes, no shadows in flow;
separation is tonal. Palette: olive accent `#9cb45f` = *the live thing*; amber `#d0a45c` = *come
here*. Neither applies here — the response mode is never urgent and never the one live thing, so it
renders in the panel's ordinary tones. No new tokens.

## Screens / views

### 1. Run chip panel — new **Response** section (`RunChip.tsx`, `run-chip.css`)

The 11c panel today is: readouts → **Model** (with effort inside the selected row) → `run-chip__rule`
→ **Permissions** → foot (*Applies from the next turn* · *Set as project default*). This adds a third
section between Permissions and the foot.

- **Elements**
  - `run-chip__rule` — the same 1-value divider already used between Model and Permissions.
  - `run-chip__head` — label `Response`, hint `this session` (mirroring the Permissions head's
    `this session`, not the Model head's `/model` — there is no slash command for this, and there
    will not be one).
  - `run-chip__group` with four `run-chip__option` rows in `RESPONSE_MODE_OPTIONS` order:
    `default` · `concise` · `explanatory` · `learning`. Each row is the existing shape —
    `run-chip__dot` marker, `run-chip__option-label`, `run-chip__option-hint` carrying the mode's
    one-line consequence.
  - Radio semantics, exactly like Permissions: one mode is always in force, so there is no "off".
  - **No danger tone.** No response mode is risky, so no row is tinted and no row carries a note.
    This is the visual difference from the Permissions section, and it is the point: tint means
    consequence.
- **States**
  - *current* — `run-chip__option--on` + `run-chip__dot--on`, hint replaced by `current` (matching the
    Model rows' treatment).
  - *busy session* — unchanged; every row stays enabled. The foot's *Applies from the next turn* is the
    only timing copy; do not add a second line.
  - *error* — the panel stays open and renders the failure inline via the existing `useTimedError`
    slot; no row moves, no optimistic marker.
- **Ordering rationale** — last of the three because it is the least consequential: model decides what
  runs, permissions decide what it may do, response decides how it reads back.

### 2. Run chip face (collapsed)

- Today: model label · effort · permission `short`, with `bypass` tinted.
- Adds: the response mode's `short` (`concise` · `explain` · `learn`) **only when the mode is not
  `default`** — the same rule the topbar applies to the model chip. On `default` the face is byte-for-byte
  what it is today, so the common case never widens the row.
- Placement: last in the face's cluster, after the permission `short`. It is `flex-shrink: 0` like the
  rest of the run cluster and is **not** added to `src/app/topbar.ts`'s drop order — it belongs to a
  control already ranked there.

### 3. New Session modal — Response field (`NewSessionModal.tsx`)

- A `ChipGroup` in the same treatment as the existing permission-mode chips, labelled `Response`,
  placed directly under them.
- Four chips from the same `RESPONSE_MODE_OPTIONS` table; `default` selected unless the project's
  `ProjectDefaults.responseMode` says otherwise.
- No hint text under the group — the chip labels carry it, and the field is not the place to teach
  four modes. The run chip panel is where the hints live.

## Flows

1. User clicks the run chip → panel opens → scrolls to **Response** → clicks `concise`.
2. The row's marker moves; the panel stays open; the face gains `concise`.
3. Nothing else changes until the next turn.
4. (Optional) User clicks **Set as project default** in the foot — the same action, now also carrying
   the response mode. Its `title` copy extends to say so.

## Responsive

Desktop only (Tauri window, `minWidth: 720`). The panel is a fixed-width floating layer and does not
reflow; adding a fourth section makes it taller, not wider. At 720 the panel's existing readouts block
already states what the bar dropped — the response mode is not one of those readouts, because it is a
setting rather than a reading.

## Data shown

From `SessionMeta.responseMode` and `RESPONSE_MODE_OPTIONS` only (spec §5):

| where | value |
|---|---|
| panel row label | `option.label` |
| panel row hint | `option.hint`, or `current` on the selected row |
| chip face | `option.short`, suppressed on `default` |
| New Session chip | `option.label` |

The directive text is **never** shown anywhere. It is core-owned and does not cross the IPC boundary
(spec FR-6).

## Notes / constraints

- Copy in English, lowercase mode names — matching `PERMISSION_MODE_OPTIONS`' `default` / `plan` /
  `accept edits` / `bypass`.
- Every string comes from `contract/response-mode.ts`; no component hard-codes a mode name (FR-13).
- Keyboard: the section inherits the panel's existing dismissal (`useDismiss` — outside click and
  `Escape`). No bare-letter global key opens it.
- Accessibility: rows keep `role="menuitemradio"`-equivalent semantics used by the Permissions rows;
  the panel's `aria-label` widens from `model and permissions` to `model, permissions and response`.
