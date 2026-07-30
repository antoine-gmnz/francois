# DESIGN BRIEF — Session attachments (`session-attachments`)

> The "spec return". Paste into the design tool (see `PIPELINE.md` §design). This is §8 of
> `specs/session-attachments.md`, standalone.

**Goal:** Hand a file or a screenshot to a running session without leaving the composer — drop it,
paste it, or pick it — and see at a glance what is riding along with the next message.

**Design system:** use the existing UI kit (`src/`, tokens in `src/styles.css`). The visual source of
truth is `Claude Terminal.dc.html` + `screenshots/`. This is a **native desktop terminal app** —
JetBrains Mono throughout, dense, keyboard-first, no rounded-card web idiom. Nothing here is a new
screen: one overlay and two additions to the SESSION tab's existing composer footer.

## Screens / views

### 1. Composer footer — the primary surface

The existing footer row in `ConversationView.tsx` is a single flex line:
`[› glyph] [textarea] [⌃C interrupt · ⌘K palette]`, `padding: 10px 14px`,
`border-top: 1px solid var(--border)`. Two additions, no relayout of what is there.

- **`+` attach button** — sits **left of the `›` glyph**, same 13px optical size, `--text-muted`
  resting, `--accent` on hover, `--text-disabled` when the composer is disabled. Square hit area,
  no border, no background. Tooltip: *"Attach files"*. It must read as a sibling of `›`, not as a
  web-style icon button — no pill, no circle.
- **Chips row** — a wrapping row **above** the textarea, inside the same footer block, `gap: 6px`,
  `margin-bottom: 8px`, only rendered when at least one image chip exists.

- **Chip** — height ~28px, `background: var(--bg-raised)`, `1px solid var(--border)`,
  `border-radius: 3px` (the app's sharp radius, not a pill), `padding: 0 6px 0 3px`, contents in a
  6px-gap row:
  - 22×22 thumbnail, `object-fit: cover`, `border-radius: 2px`
  - filename, 11px, `--text-dim`, middle-truncated at ~18 characters
  - `×`, 11px, `--text-faint` resting → `--text-bright` on hover
  - States: **resting** · **hover** (border → `--border-2`) · **thumbnail loading** (flat
    `--bg-hover` block, no spinner) · **thumbnail failed** (a dim `▣` glyph in the 22px slot —
    the chip must never disappear because an image failed to decode)

  Only `kind: 'image'` attachments get a chip. Non-image files live purely as `@path` text in the
  textarea — that split is deliberate and must not be "fixed" by giving files chips too.

### 2. Drop overlay — SESSION tab

Purpose: make the whole tab an unmissable drop target during a drag.

- Covers the entire SESSION tab region (transcript + composer), above all content.
- `background: rgba(15, 16, 21, 0.82)` over the tab, `2px dashed var(--accent)` inset by 8px.
- Centered label, 13px, `--accent-bright`: **"Drop files to attach"**, with a 11px `--text-dim`
  second line: *"images become chips · other files become @paths"*.
- States: **hidden** (no drag) · **active** (any dragover carrying files) · **rejecting** — if the
  drag carries only directory entries, the border and label switch to `--error` / `--error-bright`
  and the label reads **"Folders can't be attached"**.
- Appears on the first `dragenter` and must survive dragging over child elements without flicker.

### 3. Refusal line

One line rendered where the existing `sendError` line renders (same slot, same 11px, `--error`),
auto-clearing after 4s, matching the existing error affordance exactly. Copy is concrete about the
number: *"payload.zip is 24 MB — the limit is 10 MB."* · *"Folders can't be attached — drop the
files instead."* Multiple refusals in one drop collapse to one line: *"3 files skipped — 2 too
large, 1 folder."*

### 4. Command palette entry

**"Clear project attachments"** in the existing ⌘K list, with the app's standard destructive
confirmation step. On completion the palette reports one dim line: *"Removed 14 files (32 MB)."*
Zero-case: *"No attachments to clear."*

## Flows

1. **Paste a screenshot** — focus composer → ⌘V → chip appears in the chips row and
   `@.francois/attachments/a3f9c1e2/pasted-20260730-142530.png` is inserted at the caret → type
   context → Enter. Chips row empties on send.
2. **Drop files** — drag over the SESSION tab → overlay fades in (~120ms) → release → overlay out,
   refs appended at the caret in drop order, image chips appear.
3. **Pick** — click `+` → native OS dialog (multi-select) → same result as a drop. Cancel: nothing
   changes, no flash, no error.
4. **Remove** — click a chip's `×` → the chip and its `@path` text both vanish in the same frame.
   Or select the `@path` text and delete it → the chip vanishes on the next render. Both paths must
   feel identical in outcome; the text is the truth and the chip is the mirror.

## Responsive

Desktop-only app, but the composer must survive a narrow window and a tall chips row:

- **Narrow (≤ 720px tab width)** — chips wrap to multiple lines; filenames truncate harder (~10
  chars). The `+` button never collapses into a menu.
- **Many chips** — the chips row caps at ~3 lines then scrolls internally (`overflow-y: auto`), so
  the textarea never gets pushed off-screen. The textarea's existing `maxHeight: 130` is unchanged.
- **Overlay** — always fills the tab region, never the whole window (the sidebar and status bar stay
  visible and legible so the user keeps their bearings mid-drag).

## Data shown

Per chip, from `Attachment` (spec §5.1): `name` (truncated), the thumbnail rendered from
`storedPath`, and `refPath` as the chip's `title` tooltip. `bytes` appears only in refusal copy.
Nothing else from the type is surfaced — `id`, `state`, `copied`, `originPath`, and `createdAt` are
internal.

## Notes / constraints

- **UI language: English** (`PIPELINE.md` → `ui_language`).
- **Paste must not regress.** ⌘V with only text on the clipboard is the common case and must behave
  exactly as it does today. Any visual feedback on paste-attach must not fire on a text paste.
- **The `@path` is visible and that is intended.** The textarea is the single source of truth
  (spec FR-10), so the path cannot be hidden. It is kept short by design — the attachments directory
  uses an 8-character session prefix, not a full uuid — but do not design around hiding it.
- **Accessibility** — the `+` button needs an `aria-label`; each chip's `×` needs
  `aria-label="Remove <name>"`. The chips row is reachable by keyboard after the textarea, and the
  drop overlay is decorative (`aria-hidden`) since every drop has a keyboard-reachable equivalent
  in `+`.
- **Motion** — overlay fade 120ms ease-out; chips appear with no animation (instant, terminal-like).
  Nothing bounces, nothing slides.
- **Do not** add a progress bar: files are capped at 10 MiB and copies are effectively instant.
