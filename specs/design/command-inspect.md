# DESIGN BRIEF — Command inspect (`command-inspect`)

> §8 of `specs/command-inspect.md`, standalone. Source of truth: design turn **16a**
> ("Unfolds in place") in `Francois Redesign.dc.html` — project
> `a4b15728-147c-4932-b83c-f60a5fc60db7`. Turn **16b** (docked inspector) is the variant NOT chosen;
> do not import anything from it.

**Goal:** the user clicks a tool row in the SESSION transcript and sees the record behind its
summary — the exact invocation, where and under what runtime it ran, how long it took, and its
output — without leaving the transcript or losing their place in it.

**Design system:** the flat treatment (design turn 9a) governs. No 1px strokes, no shadows on
anything in flow — separation comes from tonal steps in the surfaces. Removing a rule means adding a
surface. The record's own tiers, from the mock: rail line `#1d222b`, open-row fill `#141922`, record
body `#08090c`, record header `#11141a`, sub-strips `#0c0e12`.

## Screens / views

Exactly one surface — an **unfoldable record inside the SESSION transcript's step rail**. No modal,
no overlay, no portal, no new tab. It is a sibling of the row it belongs to, in the same rail column,
so the rail's vertical line runs unbroken past it.

### 1. Tool row (the trigger) — three states

- **Inert** — no record exists. Byte-identical to today: glyph · uppercase tool label · summary ·
  meta chips. No chevron, no pointer cursor, no hover fill.
- **Closed, expandable** — hover fills the row `#101319` and reveals a dim `open` word plus a `⌄`
  chevron in the right-hand slot, after the meta chips. **The disclosure shares the meta chips' grid
  cell** — it is not a fifth column and never a second line. A row is the same height expandable,
  open or inert; the chevron's width is reserved even while it is invisible, so hovering does not
  shift the chips beside it.
- **Open** — row fill `#141922`, summary text brightens to `#f2f4f8`, chevron rotates 180°. The
  summary and meta chips **stay** — the row does not become a header; it keeps being the row.

Row grid, unchanged from the mock: `16px glyph · 46px tool label · 1fr summary · auto meta`.
Tool label is 9.5px, `letter-spacing:.14em`, uppercase. Bash glyph `⌗` on `#c9a2d8`, label
`#a184ac`. Edit glyph `✎` on `#6f9fd8`, label `#5d798f`.

### 2. The record — four bands, top to bottom

- **Header** (`#11141a`, 7px/11px padding, 9.5px mono). Segments, `·`-separated by 10px gaps, each
  omitted entirely when its field is absent:
  `bash` (uppercase, `letter-spacing:.14em`, `#8b6f96`) · the input's own `description` when it
  carried one, in its own capitalisation and a shade brighter than its neighbours (`--text-dim`) —
  it answers the question the tool name raises, and sits before the cwd because the cwd is where the
  step ran rather than what it was for · cwd (`#6b7385`) · `wsl · Ubuntu-22.04`
  (`#5d798f`) · then right-aligned: `12:06:41 · 4.2s` (`#6b7385`) · outcome. Outcome is `exit N`
  when known, `failed` when errored without a code, and **absent** on success — coloured `#d48b84`.
- **The `$` line** (10px/11px padding, 12.5px mono). `$` in `#586c30`; the command wraps in the
  remaining width, executable segment `#e8ecf3`, arguments `#d6dae2`. Right-aligned: `copy` and
  `shell ↗` as 10.5px `#565e6e` words, `#c3c9d4` on hover. **`re-run` is not built** — do not draw
  it. A generic (non-Bash) step replaces this whole band with pretty-printed input JSON on the
  output body's terminal metrics, and shows **no actions**. Its indentation is the whole shape of it,
  so it is `pre-wrap`: leading whitespace survives, and a value too wide for the band wraps.
- **Output strip** (`#0c0e12`, 5px/11px, 9.5px). `OUTPUT` uppercase `#565e6e`, then
  `214 lines · 8.1 KB` in normal case. When the runtime separates the streams, `12 on stderr` sits
  right-aligned in `#d48b84`; otherwise that chip does not exist.
- **Output body** (`#08090c`, 9px/11px, `white-space:pre`). The last 15 lines of the captured slice,
  **set as terminal output rather than as prose**: the SHELL tab's own metrics — `--font-mono`,
  12.5px, `--terminal-line-height` (1.35), `tab-size: 8`, foreground `--text-bright` — so a log reads
  at the same rhythm and keeps the same columns whether it is live or recalled. Colour comes from the
  captured bytes: the ANSI SGR sequences in them are resolved (`features/conversation/ansi.ts`) onto
  the **same sixteen tokens `features/shell/xterm-theme.ts` hands xterm**, so the mock's hand-drawn
  failure markers / error messages / dim scaffolding are what the tool's own escape codes produce,
  not a re-tint the record invents. Bytes carrying no colour stay on the plain foreground.
  256-colour and truecolour, which no token names, arrive as a literal `rgb()` on the span.
- **Fold footer** (`#0c0e12`, 7px/11px, 10.5px `#565e6e`). Left: `187 earlier lines folded` —
  or, when the capture cap bit, `27 lines dropped at capture`. Next to it, `show all` in `#8b93a3`,
  `#c3f53f` on hover; it is one-way and disappears once used. **The mock's right-aligned
  `esc to close` is dropped** — there is no keyboard path; the rotated chevron carries closing.

## Flows

1. Hover an expandable row → fill + `open ⌄` appear.
2. Click → row goes to its open state; the record slides in beneath it. A one-line dim
   `loading…` occupies the record's place until the fetch resolves (typically imperceptible).
3. Read. `show all` expands the body to the full captured slice, in place, pushing the rest of the
   transcript down.
4. `copy` → the invocation on the clipboard, with a brief confirmation on the word itself.
5. `shell ↗` → the main pane switches to SHELL and the command appears at the prompt, **uncommitted**;
   the caret sits after it and nothing has run.
6. Click the row again → record removed, transcript returns to its exact prior height.
7. Opening a second record leaves the first open — both scroll normally.
8. On error, the record's place holds one dim sentence instead of the bands; the row stays open.

## Responsive

Desktop-only surface; the app's window floor is 720px (ranked-topbar 11c). The record inherits the
transcript column's width and never has its own. The `$` line and the header **wrap** rather than
crop — a mid-string crop of a path or a command is the exact failure the ranked topbar was rebuilt to
remove. **Nothing in the record scrolls horizontally** — the output body and the input JSON wrap too
(`pre-wrap`, so the leading whitespace that carries a log's structure survives, plus `anywhere` for
the unbroken path or hash wider than the band). This departs from the mock deliberately: the record
is read in the flow of the transcript, and a horizontal scrollbar there asks the reader to drag a
band sideways to find out why a command failed, with no hint anything was to the right at all.

## Data shown

Every value comes from `StepDetail` in `contract/command-inspect.ts` (spec §5) and nothing is
synthesized: `tool` (lowercased), `cwd`, `runtime` + `distro`, `startedAt` (as wall clock),
`endedAt − startedAt` (as duration), `exitCode` / `isError` (as outcome), `body.command.command`,
`body.command.description` (in the header), `body.inputJson`, `output.text`, `output.totalLines`, `output.totalBytes`, `output.droppedLines`,
`output.stderrLines`.

## Notes / constraints

- **Copy is in English** (`ui_language: English`): `open`, `copy`, `shell ↗`, `output`, `show all`,
  `N earlier lines folded`, `N lines dropped at capture`, `failed`, `exit N`.
- **No accent.** The acid/olive accent means *the live thing*, one per view — a record is not live,
  so nothing in it is accent-coloured except `show all` on hover.
- **Per-feature CSS, no inline `style={{}}`** — `src/features/conversation/` owns the stylesheet;
  BEM-lite class names. Icons from `lucide-react` inheriting `currentColor`; the chevron is
  typography (`⌄`), not an icon.
- **Absent ≠ empty.** Every optional field that is absent removes its element entirely — never a
  placeholder, a dash, or a greyed-out chip. A claude-code Bash step legitimately shows no exit
  number and no stderr count, and must not look broken for it.
- **No focus ring, no tabindex** on the row — the surface is deliberately mouse-only, so it must not
  advertise a keyboard affordance it does not honour.
