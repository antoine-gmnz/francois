# DESIGN BRIEF — Split session (`split-session`)

> The "spec return" for `specs/split-session.md` §8. Francois is a **native desktop app** — there is no
> mobile breakpoint; the only responsive axis is the desktop window's own resize.
>
> **Source of truth:** `Francois Redesign.dc.html` → turn 5 (*Keeping several sessions open at once*),
> variant **5b — Split**, drawn at 1280×800. Variants 5a (open tabs) and 5c (attention stack) are
> **out of scope** — do not draw them.

**Goal:** keep two live sessions on screen at once, so a permission card in one can be answered while
the other keeps streaming edits — with an unambiguous signal of which one the keyboard is talking to.

**Design system:** the v2 identity (`Francois Design System v2.dc.html`) and the shipped UI kit
(`src/ui/`, tokens in `src/styles.css`). Acid `--accent` means *the live thing* — **one per view**: in
split that is the **focused pane**, and nothing else in the main area may take it. "Ready/alive" green
is `--success`, never the accent; "needs you" is `--attn`.

## Screens / views

One screen: the app shell in **split state**. Everything below is a delta from the shipped
single-pane shell.

- **Titlebar** (`src/features/usage/UsageBar.tsx`) — unchanged except two things:
  - the quota cluster's label reads **`focused · <session name>`** (`var(--font-size-11)`,
    `--text-muted`) instead of the bare session name, and the meter + `105.2K/1M` readout follow the
    **focused** session;
  - after the cluster: a `1px × 18px` `--border-2` divider, then a **layout segmented control** —
    a 2px-padded pill (`--bg-deep`, `1px solid var(--border-2)`, `--radius-input`) holding two 24×18px
    buttons: **`▯` single** and **`▯▯` split**. The on button is `--bg-hover-2` + `--accent`; the off
    button is `--text-faint` → `--text-2` on hover. Disabled: `--text-disabled`, `cursor: default`,
    `title` explaining why (fewer than two sessions in scope, or All-projects scope).
- **Sessions roster** (`src/features/sessions/`) — same card vocabulary, narrowed to **238px** and one
  notch denser (card padding `10px 11px 10px 14px`, name `var(--font-size-13)`). Two additions:
  - **pane badges** on the two paned rows, right-aligned in the name row, `var(--font-size-9-5)` mono,
    `--radius-chip`, `padding: 1px 5px`: `left` = `--text-hint` on `--bg-hover-2`, `right` = `--accent`
    on `--accent-soft-bg`.
  - the accent left rail (2px) marks only the **focused** side's row; the other paned row keeps the
    raised card treatment but a status-coloured rail.
  - **Open in right pane** joins `SessionContextMenu` above **Rename**, with a `Columns2`
    (`lucide-react`) glyph.
- **Main pane** — a `1fr 1fr` grid, `gap: var(--space-12)`, two **session panes**.
- **Right column** — folds to a **46px icon rail** (`--bg-panel`, `1px solid var(--border-2)`,
  `--radius-card`, `padding: var(--space-8) 0`, `gap: var(--space-8)`, centred): one 30×30px button per
  pane ([3] agents, [4] mcp, [5] skills, [6] workflows), `--bg-hover` on `1px solid var(--border-emphasis)`,
  `--radius-card`, glyph `var(--font-size-12)` `--text-2`; hover `--bg-hover-2` / `--border-focus`.
  Each carries its pane's count as a small badge, and its `title` is the pane name + its number key.
  Counts are scoped to the **focused** session.

### Session pane — the new component

Vertical stack in a `--radius-card` card: **header** · **tab strip** · **body** · **composer**.

- **Header** — `padding: 10px var(--space-12)`, bottom `1px solid var(--border)`. Left to right:
  `StatusDot` (6px, pulsing while working) · session name (`var(--font-size-13)`, truncating) ·
  either the **`focus` chip** or a status label · spacer · context tokens (`105.2K`, mono
  `var(--font-size-10-5)`, `--text-dim`) · **`⤢` promote** (`--text-faint` → `--text-2` on hover,
  `title: "Expand to full width"`).
  - **`focus` chip** — mono `var(--font-size-10)`, `--bg-app` on `--accent`, `--radius-chip`,
    `padding: 1px 5px`. Only on the focused pane.
  - **status label** — on the unfocused pane only, in place of the chip: `waiting on you` (`--attn`),
    `working`, `done`, etc., `var(--font-size-11)`.
- **Tab strip** — `padding: var(--space-6) var(--space-8)`, `gap: var(--space-2)`, bottom
  `1px solid var(--border)`. Three text tabs — **Session · Diff · Shell** — each `padding: 4px 9px`,
  `--radius-pill`, `var(--font-size-11-5)`. This is a *sub*-level: it must read as subordinate to the
  main tab strip it replaces, so no uppercase, no letter-spacing, no accent underline.
  - active tab: weight 600, `--text-bright` on `--bg-hover-2` (focused pane) / `--text-2` on
    `--bg-raised` (unfocused pane).
  - idle tab: `--text-hint` (focused) / `--text-muted` (unfocused).
  - disabled-looking tab (no session): `--text-faint` / `--text-disabled`.
  - **Diff badge** — the existing count pill, `--radius-pill`, `padding: 0 5px`, mono
    `var(--font-size-9-5)`: `--bg-app` on `--accent` when the pane is focused, `--text-hint` on
    `--bg-hover-2` when it is not. The badge is the one place the unfocused pane may carry colour.
- **Body** — the existing `ConversationView` / `DiffView` / `ShellTabView`, unchanged, at half width.
  Everything inside must survive ~470px: transcript rows, tool-call rows (`✎ path  +61 −8`), permission
  cards and question cards all keep their existing layout and simply wrap/truncate.
- **Composer** — the existing composer on the focused pane. On the unfocused pane it is replaced by an
  **inert strip**: `--bg-elevated`, `1px solid var(--border-2)`, `--radius-input`, a `--text-disabled`
  `›` and the text **`click to focus this pane`** (`var(--font-size-12-5)`, `--text-disabled`),
  `cursor: text`, **no** `⏎` hint. It must not read as a disabled input — it reads as an invitation.

### States

- **Focused pane** — 2px `--accent` top rule flush to the card's top edge, `1px solid var(--border-focus)`
  border plus a soft `0 0 0 1px rgba(195,245,63,.18)` accent halo, `--bg-panel` background, name
  `--text-bright` weight 600, live composer.
- **Unfocused pane** — no top rule, no halo, `1px solid var(--border-2)`, `--bg-elevated` background,
  name `--text-2` weight 500, inert composer. It is **dimmer, never greyed out** — its transcript keeps
  streaming and must stay fully legible.
- **Unfocused pane needing attention** — its status dot and label go `--attn`; the permission card
  inside keeps its full amber treatment (`--bg` `#1d1a14`-equivalent, `1px solid` amber edge) and its
  **Allow / Always / Deny** buttons look and read exactly as in a focused pane. Answering it is a
  two-click path (focus, then Allow) and the design must not make it look like one click.
- **Empty pane** — no session: the existing `EmptyPaneMessage` treatment, centred.
- **Not split** — everything above is absent; the shell is pixel-identical to today.

## Flows

1. Click **`▯▯`** → the main pane splits; the current session stays **left** and keeps its tab, the
   most recently active other session opens **right** on SESSION. Left stays focused. The roster
   narrows 276 → 238px and the right column folds 296 → 46px in the same transition.
2. The right pane shows `waiting on you`. Click anywhere in it → the accent rule, `focus` chip, live
   composer, titlebar quota and rail counts all move right, and the left pane dims. Click **Allow**.
3. Right-click a roster row → **Open in right pane** → it lands right and takes focus.
4. Click **`⤢`** on either pane (or **`▯`**) → split ends, that pane's session and tab become the
   single main pane, the roster widens back to 276px and the right column unfolds to 296px.
5. `]` while split → the right column toggles between the 46px rail and the full 296px column; the two
   panes narrow to absorb it. `[` still hides the roster outright.

## Responsive

Desktop only; the axis is window width.

- **1280px** (the drawn size) — `238 | 1fr | 46`, panes ≈470px each.
- **Wider** — both panes share the extra width equally; nothing reflows.
- **Narrower** — the panes keep shrinking. Below roughly 900px of main-pane width the content is
  cramped by design: **no automatic unsplit and no min-width guard**. Show what a ~350px pane looks
  like so the truncation rules (session name, tool-call paths, diff badge) are decided rather than
  discovered.

## Data shown

Per pane: session status dot + status, session name, context tokens (`105.2K`), diff count, and the
active tab's own body. Titlebar: `focused · <name>` + that session's usage meter and `<used>/<limit>`.
Roster rows: unchanged, plus the `left` / `right` badge. The rail: one count per pane, focused-session
scoped. No new data — every value already exists in `contract/common.ts` / `contract/fleet-board.ts`.

## Notes / constraints

- **UI language: English.** Copy is exactly: `focused · <name>`, `focus`, `click to focus this pane`,
  `Open in right pane`, `left`, `right`, `Expand to full width`.
- **One accent per view.** In split, the accent belongs to the focused pane (rule, chip, halo, its diff
  badge, its roster rail). The unfocused pane may not carry `--accent` anywhere.
- **Never let a keystroke land in the wrong session** — that is the whole point of the inert composer.
  The focused/unfocused contrast must survive a glance at arm's length, in both themes.
- **Themes**: light and dark both ship. Verify the unfocused pane stays legible in light mode, where
  "dimmer" has much less headroom than on the near-black dark surface.
- **Icons are `lucide-react`**, inheriting `currentColor` — the `▯ ▯▯` control, the `⤢` promote and the
  rail glyphs. `▯`/`▯▯`/`⤢` in the mock are stand-ins; propose the real lucide glyphs
  (`Square`/`Columns2`, `Maximize2`).
- **Accessibility**: focus follows click, so every pane needs a visible keyboard-independent focus
  signal — the accent rule is that signal and must not be the *only* one (the `focus` chip carries it
  in text too). Buttons in the segmented control need `aria-pressed` and real `title`s.
