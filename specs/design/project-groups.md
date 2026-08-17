# DESIGN BRIEF — Project groups (`project-groups`)

**Goal:** the user sees one collapsible `ODO` heading holding every ODO repo and every session running
under them, instead of unrelated top-level headings — and manages that grouping in the Projects modal.

**Design system:** the existing UI kit (`src/ui/`, tokens in `src/styles.css`), per the v2 identity
(acid `#c3f53f` accent, ready green `#4fae86`, JetBrains Mono). Not mobile — a desktop app at a fixed
minimum window size. Reference: `Francois Redesign.dc.html` (pane [1] roster, turn 4) and the existing
`pj-*` chrome in `src/features/projects/projects.css`.

## Screens / views

### 1. Pane [1] roster — the group tier

**Purpose:** a second, thinner heading level above the existing per-repo headings.

Elements, top to bottom inside a group:

- **Group heading** — a *thin* row, not a card:
  - caret `▾` (expanded) / `▸` (collapsed), the same glyph pair the project heading uses
  - label, **uppercase**, at the roster's smallest type role, `--text-dim`
  - session count (sum over member projects), right of the label, dimmer still
  - **no** card surface, **no** status dot, **no** acid, **no** `+` control, no hover-reveal actions
  - the whole row is the click target; clicking toggles collapse
- **Project heading** — exactly today's row (caret, label, count, spacer, `+`), **indented one step
  (~10px)** when it sits inside a group. Ungrouped project headings and cwd-leaf headings stay at
  depth 0.
- **Session card** — unchanged, indented one further step when its project sits inside a group.

**Depth is capped at three levels.** The roster is 276px normally and **238px in split mode**; the
indentation budget is the hard constraint. Nothing may add a fourth level, and the indent step should be
the smallest that still reads as hierarchy.

**Mixed depth is the normal case, not an edge case.** A grouped `ODO` heading, an ungrouped registered
project and an unregistered repo's cwd-leaf heading are all siblings at depth 0, in the same list, at
the same time. The tree must not look like it is pretending to be uniformly two-tier — the group
heading's distinct (uppercase, thinner, action-free) treatment is what carries that.

States:
- **collapsed group** — caret `▸`, member project rows and all their cards hidden; the count still reads
  the full total, so a collapsed group tells the user what it is holding.
- **partially collapsed** — group expanded, one member project collapsed. Each level's caret is
  independent and each is remembered separately.
- **empty** — a group with no visible session is **not rendered at all**. There is no empty group
  heading, ever.
- **hover** — the same subtle row-hover the project heading uses; no new affordance appears.

### 2. Projects modal — the groups block + the Group selector

**Purpose:** the *management* surface. The roster only shows groups; everything that creates, names,
deletes or assigns them lives here.

- **Left column, below the project list:** a `GROUPS` block, styled after the existing sections.
  - one row per group: name (inline-editable on click, commit on Enter/blur, Escape reverts that row
    only) + a remove control on hover
  - `+ New group` at the bottom, styled exactly like the existing `+ New project` control
    (`--text-dim`, accent on hover)
  - group rows are **not selectable** into the right-hand config pane — a group has no config, and a
    row that selects into an empty pane is a broken promise
  - inline error line under the block, matching `pj-list-error`
- **Right column, Identity section:** a new **Group** `<select>` above or below the name field, options
  `— none —` plus every group ordered as `project_list` returns them. Commits on change; there is no
  Save button anywhere in this modal.

States: empty (`no groups yet`) · renaming (inline input) · confirming removal (typed-confirm, the same
`RemoveControl` pattern projects use) · error (inline, and the block re-reads from disk).

## Flows

1. Open ⌘K → **Projects…**. The modal shows the project list, then the `GROUPS` block below it.
2. `+ New group` → an inline name field appears in the block → type `ODO` → Enter. The row commits and
   the block repaints from a fresh `project_list`.
3. Select `ODO - Frontend` on the left → its Identity section shows **Group: — none —** → pick `ODO`.
   The change commits immediately. Repeat for `ODO - Databases`.
4. Close the modal. Pane [1] now paints `▾ ODO 7` with the two repo headings indented beneath it.
5. Click `ODO` → the whole subtree collapses to one row. It stays collapsed across a relaunch.
6. Back in the modal, remove `ODO` → typed confirm, worded to say the member **projects are kept and
   only ungrouped**. The two repos return to top level in the roster; their running sessions are
   completely unaffected — no status change, no flicker in the transcript, no pane reassignment.

**Known, accepted affordance gap:** clicking the `ODO` heading in the roster **collapses** it — it does
**not** scope the board to both repos. The title-bar switcher stays `All projects | <project>` and shows
no group entry. The group heading's action-free, non-card treatment is what has to keep it from reading
like a selectable scope.

## Data shown

Matching spec §5 exactly:

- Group heading: `ProjectGroup.name` (uppercased for display only — the stored name keeps its case) and
  a derived session count.
- Groups block row: `ProjectGroup.name`.
- Identity selector: `ProjectGroup.name` per option, valued by `ProjectGroup.id`; current value is
  `ProjectMeta.groupId` (absent ⇒ `— none —`).
- Nothing else about a group is ever displayed. `id` and `createdAt` never surface.

## Notes / constraints

- **Acid discipline:** a group heading is a repeatable roster row, so it renders **neutral** — no acid,
  no status colour. Acid stays on the one focused/singular surface in the view.
- **Font weight** caps at 600 (the design mirror's ceiling).
- **Icons** are `lucide-react` where an icon is needed; the carets stay the `▸`/`▾` glyphs, which are
  typography here and already in use.
- **Styling** is per-feature CSS + classNames — the roster tier extends
  `src/features/sessions/sidebar.css`, the modal block extends `src/features/projects/projects.css`.
  No inline `style={{}}` except for a value computed at runtime.
- **UI language:** English, lowercase-leaning to match the existing roster and modal copy.
- **Truncation:** a long group name truncates with the existing `truncate` treatment; the count must
  never be pushed out of view.
