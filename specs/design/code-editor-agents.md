# DESIGN BRIEF — Code editor, agent-aware (`code-editor-agents`)

**Goal:** in the Code tab, the user hands code to a session, sees what agents changed and who changed it, reviews against HEAD, and never types into a file an agent is rewriting.

**Design system:** Figma "Redesign · Graphite & Signal" (`YEY4c6AiWq1bKYuaju9qdV`, page `124:2`). Draw onto the v1 frames **45 · Code / Editor** (`252:25850`) and the light twin **L45** (`252:34292`). Tokens from `src/styles.css`. Colour carries state only: **cyan `--state-running`** = a live session acting now, **violet `--state-attention`** = blocked on you, **blue `--state-info`** = modified, everything else neutral graphite. Desktop app: no mobile layout. The window minimum is 720px.

## Screens / views

All new pieces live inside the existing Code tab (Explorer 288px + Editor) and the SESSION composer.

- **Gutter comment affordance.** A 14px `+` in the gutter, between the line numbers and the change markers, shown on hover of a line only. Neutral `--text-muted`, `--text-primary` on hover. It must not cover the v1 3px change markers.
- **Inline comment box (Monaco view zone).** It opens under the line and spans the editor width.
  - Contents: a textarea (Geist 12.5, `--bg-input`, radius 6), placeholder "Comment for a session…", the hint `⏎ add · Esc cancel` in Geist Mono 11 `--text-faint`, and the target session name at the right.
  - States: empty (⏎ inert) · typing · target-ambiguous (the ⏎ opens the picker).
- **Target picker.** A floating popover anchored to the selection or comment box, with a shadow (it is a floating layer).
  - Groups: "On this root" (sessions whose cwd = root) above "Other sessions" (each row shows its root label as a tag).
  - Row: status dot (cyan if running) + session name + branch in Geist Mono 11.
  - The last pick is pre-highlighted. Keyboard ↑/↓/⏎/Esc.
  - Empty state: "No session to send to".
- **Added confirmation.** A transient 4s pill at the bottom-right of the editor area: "Added to <session> · **Open**". Neutral, no colour.
- **Line flash.** The changed lines get a `--state-running` background at ~18% alpha, fading to 0 over 1.5s. Reduced motion: hold 1.5s, then cut. Full line width, behind the text.
- **Session chip (tabs + explorer rows).** A small chip (≈16px tall, Geist Mono 10.5) with the session's short name or initials. It sits **left of** the git letter (`M`/`A`), which keeps its colour and position.
  - Live: cyan outline/fill while that session's turn is running and editing the file.
  - Settled: neutral `--bg-raised` / `--text-muted`.
  - Tooltip "<session> · edited 3m ago". On tabs it sits before the dirty dot / ×.
- **Review toggle + inline diff.**
  - A **Review** ghost toggle on the tab strip, beside **Open in VS Code**. Its active state uses the selected treatment. It is hidden for untracked or too-large files.
  - The editor becomes Monaco's inline diff: removed lines on a red tint, added lines on a green tint, the v1 syntax theme kept.
  - Per hunk, a **Revert** action appears on hover at the hunk's top-right (Sm ghost button with an undo icon).
  - Disabled state while locked, with the tooltip "Locked while <session> is editing".
- **Lock strip.** 32px, full editor width, under the tab strip / breadcrumb, above the editor.
  - Contents: session chip (cyan) · "orbit-api is working on this file · read-only until its turn ends" (Geist 12, `--text-secondary`) · `+N` when several sessions hold it · **Unlock anyway** (Sm secondary button, right).
  - Background is the cyan tint (it is the live thing, not a request for the user). The lock icon is lucide `Lock`.
  - Can stack with the v1 violet "Changed on disk" bar: the lock strip goes on top.
- **Composer context-chip strip (SESSION tab).** A row of chips above the composer input, wrapping to at most 2 lines and then scrolling.
  - Chip, collapsed: kind icon (selection `TextSelect` / comment `MessageSquare` / revert `Undo2`) + `src/auth.ts:12–40` in Geist Mono 11 + `×`.
  - Expanded on click: a card with the snippet read-only (Geist Mono 12, max 8 lines then scroll, "(first 400 of N lines)" when cut) and the note as an editable textarea.
  - Count "3 items will be sent with your message" in `--text-faint`.
  - The 20-chip limit message appears inline.

## Flows

1. Select → ⌘L → (one same-root session) the chip lands, the confirmation shows → **Open** jumps to the session, where the strip shows the chip.
2. Hover a line → `+` → comment box → ⏎ → chip.
3. Several or zero sessions on the root → the picker → pick → chip.
4. Agent edits the open file → the lines flash, the tab and row chips turn cyan, the lock strip appears → turn ends → the strip disappears and the chips go neutral.
5. Review → hover a hunk → Revert → the hunk disappears, the file saves → the last toucher's composer gains a revert chip "I reverted this change."
6. Transcript Edit row path (underlined on hover, link style) → Code tab at the file and line.

## Data shown

The session name, branch and status (`SessionMeta`). The path is shown relative to the root, with line ranges `start–end`. The chip kind, snippet and note. The relative time of the last edit. The `+N` count of extra lock holders.

## Notes / constraints

- Copy in English. Font weight ≤ 600. No inline styles except runtime-computed tints.
- Draw every new element in dark and light (L45).
- Accessibility:
  - The lock strip is announced via `aria-live=polite`.
  - Keyboard: picker fully navigable; chip `×` reachable by Tab; Unlock anyway focusable.
  - The flash must not be the only signal. The chip carries the attribution.
- Focus: ⌘L and the comment box must not trigger app single-key shortcuts (v1 FR-14 guard).
