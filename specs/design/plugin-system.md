# Design brief — plugin-system

> Derived from `specs/plugin-system.md` §8. Regenerated on every freeze — edit the spec, not
> this file.

Francois is a native desktop terminal app (Tauri 2), JetBrains Mono throughout, dark TUI
aesthetic. This feature lets a third-party plugin add UI **without ever rendering anything
itself**: the plugin returns a declarative JSON tree (`PanelSpec`) and Francois draws it with
its own components and tokens. **Everything below is Francois's design — the plugin can express
nothing but a `PanelTone` (`default | dim | accent | success | warn | error`).** There is no CSS
escape hatch, no custom color, no custom font, no custom radius, no plugin-authored animation.

Nothing here exists in the mock (`Claude Terminal.dc.html`). Every surface composes an existing
Francois language: app-shell's pane chrome and status bar, the `projects` modal shell, and the
`permission-guardrails` transcript card. Tokens are `src/styles.css` variables only.

## Screens / regions

1. **Plugin pane `[n]`** — appended to the right-hand flex column, **below** `SKILLS` (mock
   region: the right column that stacks AGENTS `[3]` / MCP SERVERS `[4]` / SKILLS `[5]`). One
   pane per active plugin that contributes a panel, each `flex: 1`, in registry order.
2. **Status-bar item** — right-aligned inside the existing 32px status bar, left of the version
   string (mock region: the status bar strip, `Claude Terminal.dc.html` lines 236–248).
3. **Plugins modal** — centered overlay, the `projects` modal shell. Two columns: installed list
   + install field (left), configuration (right).
4. **Install / update consent card** — replaces the modal's right column in place; not a nested
   overlay.
5. **Injection confirmation card** — a block inside the SESSION tab's transcript column, sitting
   in flow with the assistant/tool/permission blocks.
6. **Transcript attribution line** — a footnote beneath a user message block.
7. **Palette entries** — rows in the existing ⌘K modal; no bespoke treatment.

## Components

### A. Plugin pane

- **Pane chrome** — app-shell's shared treatment verbatim: `border-radius:5px`,
  `overflow:hidden`, `min-height:0`, background `#16171c`, 1px border `var(--border-2)` →
  `var(--accent)` when focused. Header row (`padding:9px 12px`, bottom border
  `1px solid var(--border)`): title `11px / 700 / .14em` in `var(--text-dim)` → `var(--accent)`
  when focused; right label `10px var(--text-faint)` reading `<n> · [<hotkey>]`, or `<n>` alone
  when the pane has no hotkey (only the first four plugin panes get keys `6`–`9`).
- **Body** — `.scz` scroll, `padding:8px 10px`, column `gap:4px`.
- **The ten node renderers.** This table *is* the public look of every plugin that will ever
  exist — it is a frozen, versioned vocabulary:

  | node | rendering |
  |---|---|
  | `text` | `11.5px`, color from `tone` (`--text` / `--text-faint` / `--accent` / `--success` / `--warn` / `--error`). `wrap:true` → `overflow-wrap:anywhere`; default `white-space:nowrap; text-overflow:ellipsis`. |
  | `row` | flex row, `align-items:center`, `gap` `sm`=6px / `md`=10px (default `sm`), `align` `start`/`center`/`between` → `justify-content`. |
  | `stack` | flex column, same gaps, default `sm`. |
  | `list` | column of items, each `padding:4px 6px; border-radius:3px`; hover `background:var(--bg-elevated)`. Selected (only when `selectable`) `background:var(--bg-raised)` + 2px `var(--accent)` left rail. |
  | `badge` | `9.5px`, `padding:0 6px`, `border:1px solid var(--border-2)`, `border-radius:3px`, color from `tone` (default `var(--text-dim)`). |
  | `keyhint` | `9.5px`, `padding:0 4px`, `background:var(--bg-raised)`, `border-radius:2px`, `var(--text-hint)`. |
  | `divider` | `height:1px; background:var(--border); margin:4px 0`. |
  | `action` | `11px var(--text-hint)`, `cursor:pointer`, hover `var(--accent)`; optional trailing `keyhint` chip. Undeclared `commandId` → `opacity:.45; cursor:default`. |
  | `progress` | 3px track `var(--border)`, fill `var(--accent)`, `border-radius:2px`; optional `label` at `10px var(--text-faint)` to its right. |
  | `spinner` | the app's existing `blink 1s step` glyph cycle in `var(--accent)`; optional `label` at `10.5px var(--text-faint)`. |

### B. Status-bar item

`10.5px`, letter-spacing `.02em`, color from `tone` (default `var(--text-dim)`), `gap:12px`
between items. An optional `badge` renders first as a bordered chip (`9.5px`, `padding:0 5px`,
`border:1px solid var(--border-2)`, `border-radius:3px`). With a `commandId` the whole item is
`cursor:pointer` and brightens to `var(--text-hint)` on hover. At most **three** items render.

### C. Plugins modal

- **Shell** — backdrop `rgba(0,0,0,.55)`; panel `#16171c`, `1px solid var(--border-2)`, radius
  6px, `width:min(860px, 94vw)`, `max-height:min(620px, 88vh)`.
- **Header** (`padding:12px 16px`, bottom border `1px solid var(--border)`) — title
  **`FRANCOIS PLUGINS`** in `11px/700/.14em var(--accent)`; right-aligned count `<n> installed`
  in `10px var(--text-faint)`. Beneath the title, one `10px var(--text-muted)` line:
  `not the same as claude code plugins — those live in the SKILLS pane`.
  **The word `FRANCOIS` in the title and that subtitle are load-bearing**: Francois already hosts
  Claude Code's own plugin ecosystem in the SKILLS pane, and these two systems must never read as
  the same thing.
- **Body** — two columns: left `260px` with a `1px solid var(--border)` right border, right
  `1fr`; both `.scz`, `min-height:0`.
- **Left list row** (`padding:8px 12px`, 46px) — name `11.5px var(--text)`; beneath it
  `<version> · <sourceKind>` in `10px var(--text-faint)`. Selected: `background:var(--bg-raised)`,
  2px `var(--accent)` left rail, name `var(--text-bright)`. Right-aligned state tags at `9px`:
  `off` (`var(--text-faint)`), `error` (`var(--error)`), `new permissions` (`var(--warn)`),
  `update` (`var(--accent)`).
- **Install field** — pinned to the bottom of the left column, full width: `var(--bg-deep)`,
  `1px solid var(--border-2)`, radius 4px, `6px 8px`, `11px`, focus border `var(--accent)`,
  placeholder `owner/repo, a github url, or an npm package`, commits on `⏎`. A
  `10px var(--text-faint)` progress line sits beneath it during resolution
  (`resolving… → downloading… → verifying… → unpacking…`).
- **Right column** (`padding:14px 16px`, `18px` group gaps). Five groups, each opening with a
  `10px/700/.14em var(--text-dim)` label:
  - **IDENTITY** — name, version, author, description; then `<kind> · <spec>` and the pinned ref
    in `10.5px var(--text-faint)`, SHA truncated to 8 chars with the full value on `title` hover.
    Right-aligned `check for updates` (`10.5px var(--text-hint)` → `var(--accent)`), becoming
    `update to <version>` once one is found.
  - **PERMISSIONS** — one row per granted capability: `✓` in `var(--success)` + the plain
    sentence. Network hosts render as `badge` chips, one per host, wrapping. When both
    read-state and network are granted, the standing warning (D · below) repeats here.
  - **ENABLEMENT** — three inline text toggles `off` / `all projects` / `these projects…`; active
    one `var(--accent)`, others `var(--text-faint)`. `these projects…` reveals a checkbox list of
    registry projects at `11px`, `max-height:120px`, `.scz`.
  - **SETTINGS** — a Francois-rendered form built from the plugin's typed setting descriptors
    (the plugin supplies no layout). Rows are label-left (`10.5px var(--text-muted)`, 140px) /
    control-right; inputs share the install-field skin. `boolean` → a `◉`/`○` toggle; `select` →
    a native select in the same skin; `secret` → a password input whose set state shows `••••••`
    plus a `clear` control in `10px var(--text-faint)` → `var(--error)`. One line under the first
    secret field: `secrets are obfuscated at rest, not encrypted against local access` in
    `10px var(--text-faint)`. A descriptor's description renders beneath its field in
    `10px var(--text-faint)`.
  - **LOG** — the plugin's last 200 output lines, `10px var(--text-muted)`,
    `white-space:pre-wrap`, `max-height:140px`, `.scz`, `background:var(--bg-deep)`,
    `padding:6px 8px`, radius 4px. Empty: `no output`.
  - **Uninstall** — bottom-right, `10.5px var(--text-muted)` → `var(--error)`. Confirming swaps
    it **in place** for `uninstall "<name>"? its settings and stored data are deleted.` in
    `10.5px var(--error)` with `cancel` / `uninstall`.

### D. Install / update consent card

Replaces the modal's right column. `padding:16px`, column `gap:14px`. Header `INSTALL PLUGIN`
(or `UPDATE PLUGIN`) in `11px/700/.14em var(--accent)`.

- **Identity block** — name `13px var(--text-bright)`; `version · author` in
  `10.5px var(--text-faint)`; description `11.5px var(--text)`; source line
  `<kind> · <spec> @ <ref>` in `10.5px var(--text-muted)` (full ref, `overflow-wrap:anywhere`)
  and the humanized unpacked size.
- **Capabilities block** — `THIS PLUGIN CAN` in `10px/700/.14em var(--warn)`, then one row per
  capability: a `⚠` in `var(--warn)` + the sentence in `11.5px var(--text)`:
  - `read your sessions, projects, diffs and agent activity`
  - `ask to send prompts to your sessions — every one needs your approval`
  - `reach the network, limited to the domains below`

  Network hosts follow as `badge` chips at `10px var(--text-hint)`, one per host, wrapping,
  **verbatim and unabbreviated**.
- **The standing warning** — shown whenever read-state **and** network are both present:
  `a plugin that can both read your state and reach the network can send what it reads there.
  only install plugins you trust.` — `11px var(--warn)`, `line-height:1.6`, in a box with
  `background:var(--accent-soft-bg)`, `border-left:2px solid var(--warn)`, `padding:8px 10px`,
  radius 3px. This is the most important text in the feature: the sandbox prevents a plugin from
  touching the machine, but it cannot prevent a plugin from sending what the user let it read.
- **Update diff** (update flow only) — added capabilities and added hosts render with a leading
  `+` in `var(--warn)`; already-granted ones dim to `var(--text-faint)`. A widening update adds
  `this update asks for more than you granted` in `11px var(--warn)`.
- **Actions** — right-aligned, `gap:14px`, `11px`: `cancel` (`var(--text-muted)`) and
  `install` / `update` (`var(--accent)` → `var(--accent-bright)`). Inert while in flight
  (`opacity:.7`).

### E. Injection confirmation card (SESSION transcript)

Structurally the `permission-guardrails` approval card, with a **different left rail so the two
can never be confused** — a permission ask is a *stop*; a plugin injection is an *outside voice*.

- **Container** `.picard` — `background:var(--bg-deep)`, `border:1px solid var(--border)`,
  `border-radius:4px`, `padding:10px 12px`. Pending adds
  `border-left:2px solid var(--hue-purple)`.
- **Header row** — `PLUGIN` label (`9.5px .08em var(--text-faint)`), the plugin chip
  (`<name>`, `9.5px`, `color:var(--hue-purple)`, `border:1px solid var(--border-2)`,
  `border-radius:3px`, `padding:0 6px`), then the resolved note `— approved` / `— denied` /
  `— expired` at `9.5px`, colored by state.
- **Intent line** — `wants to send this prompt to this session`, `11px var(--text-dim)`,
  `margin-top:8px`.
- **Prompt box** `.picard-prompt` — the exact text the plugin wants to send:
  `background:var(--bg-app); border:1px solid var(--border); padding:8px;
  white-space:pre-wrap; overflow-wrap:anywhere; max-height:220px; overflow-y:auto;
  font-size:11.5px; color:var(--text-bright); margin-top:6px;`. It scrolls **inside its box**,
  never the transcript. **This box is the entire point of the card** — it is never truncated with
  an ellipsis, never collapsed behind a "show more", and never summarized. The user has to be
  able to read exactly what a plugin is about to make their agent do.
- **Meta line** — `→ session <name> · expires in <mm:ss>`, `10.5px var(--text-faint)`,
  `margin-top:6px`; the countdown ticks once per second while pending.
- **Action row** (pending only) — right-aligned, `gap:14px`, `11px`, `cursor:pointer`:
  `approve` (`var(--success)` → `var(--success-bright)`), `deny` (`var(--error)` →
  `var(--error-bright)`). Inert while in flight.
- **Resolved note** — when approved into a busy session, `queued · #<n>` at
  `10.5px var(--text-faint)`, `margin-top:6px`.

### F. Transcript attribution

A user message block that originated from a plugin renders one extra line **beneath** its text:
`↳ via plugin <pluginName>` in `10.5px var(--text-faint)`, `margin-top:4px`, ellipsized. No chip,
no color, no icon — a footnote, not a decoration. It is permanent: it survives reload, `--resume`,
and uninstalling the plugin, because it is a record of what happened.

### G. Palette entries

The existing `PaletteCommand` row, unchanged: the contribution's glyph (default `⌁`) in the 16px
glyph column, its title as the name, and **the plugin's name as the right-aligned hint** in
`var(--text-faint)` — so every plugin row is attributed without a bespoke treatment. Disabled rows
use the palette's existing disabled state.

## States

**Plugin pane**
- *loading* (first render, no cached spec) — centered `10.5px var(--text-faint)` line `rendering…`
- *empty* (`nodes: []`) — `no content`, same treatment
- *populated* — the node tree
- *list selection* — one item with `background:var(--bg-raised)` + 2px `var(--accent)` left rail
- *error* — two lines: `plugin error` in `var(--error)` `11px`, then the message in
  `10.5px var(--text-muted)` (`overflow-wrap:anywhere`, max 4 lines then ellipsis), plus a
  `retry` action in `10.5px var(--text-hint)` → `var(--accent)`
- *consent pending* — `new permissions — review to re-enable` in `var(--warn)` with a `review…`
  action opening the modal
- *focused / unfocused* — accent vs `var(--border-2)` chrome border; accent vs `var(--text-dim)`
  header title
- *truncated* — a trailing `⟨panel truncated⟩` text node in `warn` tone
- *invalid node* — a single dim `⟨invalid node⟩` placeholder in place of that node only; siblings
  render normally

**Modal** — no plugins (left `no plugins installed` in `11px var(--text-faint)`; right blank but
for `install one from github or npm using the field below` in `10.5px var(--text-muted)`) ·
resolving · consent card shown · list with a selection · selected plugin in each of `off` /
`all projects` / `these projects…` · update available · update available and widening
(`new permissions` tag) · consent pending · error · uninstall-confirm open · secrets unreadable
(`stored secrets could not be read`) · registry reset (`the plugin registry was reset — a backup
is at plugins.json.bak`).

**Injection card** — pending · in-flight (`opacity:.7`) · approved (`--success` rail) · approved
and queued · denied (`--error` rail) · expired (whole card `opacity:.55`).

**Status item** — present · with badge · clickable (hover) · absent.

**Settings field** — unset · set · secret set (`••••••` + `clear`) · invalid (inline
`10.5px var(--error)` beneath the field, matching the permissions editor).

## Interactions

- **Focus a plugin pane** — click anywhere in its chrome, or press its number key (`6`–`9`, first
  four plugin panes only). Focus recolors the chrome border and the header title. The status bar's
  `focus:` label reads the plugin id.
- **Navigate a selectable list** — `↑`/`↓` move the selection while the pane is focused; clamped,
  no wrap. `⏎` fires the **first `action` node in document order inside the selected item**.
- **Fire an action** — click, or `⏎` on the selected list item. The action is inert (and dimmed to
  `opacity:.45`) if it names a command the plugin never declared.
- **Open the modal** — ⌘K → `Manage plugins`.
- **Install** — type a source into the install field, `⏎` → progress line → consent card replaces
  the right column → `install` commits, `cancel` discards. A newly installed plugin is **off**;
  install is not activation.
- **Enable** — pick `off` / `all projects` / `these projects…` in ENABLEMENT. Switching the
  sidebar's project filter immediately adds or removes panes, palette commands, status items, and
  refresh timers.
- **Edit settings** — inline, committing on blur or `⏎`. A secret field that already has a value
  shows `••••••`; leaving it untouched preserves the stored value (a form round-trip cannot erase
  a token). `clear` empties it.
- **Update** — `check for updates` → `update to <version>` → if the update asks for more than was
  granted, the consent card reappears with the additions marked `+` in `var(--warn)`; cancelling
  keeps the current pinned version running.
- **Approve / deny an injection** — click `approve` or `deny` on the transcript card. The row goes
  inert while in flight, then the card resolves in place. A pending card counts down and resolves
  itself to `expired` at zero.
- **Hover** — pane list items raise to `var(--bg-elevated)`; actions and modal controls brighten to
  `var(--accent)` (destructive ones to `var(--error)`).

## Visual notes

- **Tokens only** — `--bg-app #0f1015`, `--bg-deep #131419`, `--bg-panel #191b21`,
  `--bg-elevated #1b1d23`, `--bg-raised #20222a`, `--border #24262d`, `--border-2 #2a2c33`,
  `--text-bright #dfe2e8`, `--text #c4c7ce`, `--text-hint #a9adb6`, `--text-dim #868a93`,
  `--text-muted #6b7079`, `--text-faint #565a63`, `--accent #c8a15a`,
  `--accent-bright #d8b878`, `--accent-soft-bg #3a3325`, `--warn #c2b06a`,
  `--success #7fa07a`, `--success-bright #9dbb98`, `--error #c46b62`,
  `--error-bright #d68f86`, `--hue-purple #9a86c4`. Pane background `#16171c` (the right
  column's existing panel fill).
- **Typography** — JetBrains Mono only. `9px` (state tags), `9.5px` (badges, keyhints, card
  header labels), `10px` (pane count label, group labels, descriptions, log), `10.5px` (status
  bar, meta lines, secondary controls), `11px` (pane titles, actions, warnings), `11.5px`
  (`text` nodes, prompt box, list row names), `13px` (consent card plugin name).
  Letter-spacing: `.02em` (status text), `.08em` (card header labels), `.14em` (pane titles,
  group labels, modal title).
- **Spacing / radii** — pane body `padding:8px 10px`, node gap 4px; `row`/`stack` gaps 6px (`sm`)
  and 10px (`md`); list item `padding:4px 6px`; modal groups `18px` apart; radii 2px (keyhint),
  3px (badge, list item, warning box), 4px (cards, inputs), 5px (pane chrome), 6px (modal panel).
- **Motion — deliberately almost none.** The only animation in the entire feature is the
  `spinner` node, reusing the app's existing `blink 1s step` glyph cycle. No pulse, no fade, no
  slide, no transition on the consent card, the injection card, or the modal. A plugin cannot
  request motion, and Francois does not add any: a surface hosting third-party content should not
  draw the eye on its own schedule.
- **The `PanelTone` mapping is the whole plugin color API** — `default` → `--text`, `dim` →
  `--text-faint`, `accent` → `--accent`, `success` → `--success`, `warn` → `--warn`, `error` →
  `--error`. Six values. There is no seventh, and no plugin-supplied hex anywhere.

## Resize / responsive

- Plugin panes share the right column's flex behavior (`flex: 1` each, `min-height: 0`, `.scz`
  body). More panes means each is shorter; none collapse below their header.
- `text` nodes without `wrap` ellipsize (`white-space:nowrap; text-overflow:ellipsis`); with
  `wrap` they wrap (`overflow-wrap:anywhere`). Long `badge` / `keyhint` / title values are
  truncated **by the core** before they ever reach the DOM, never by CSS alone.
- The modal caps at `min(860px, 94vw)` / `min(620px, 88vh)`; its two columns scroll
  independently (`.scz`, `min-height:0`). The consent card scrolls within the right column; the
  host chip list wraps rather than truncating — every allowlisted domain must stay readable.
- The injection card spans the transcript column and wraps; its prompt box scrolls internally at
  `max-height:220px` and never scrolls the transcript.
- Status items ellipsize, and are **dropped past three** rather than wrapping or growing the
  32px status bar.
- Title bar (44px) and status bar (32px) stay fixed height regardless of window size, unchanged
  by this feature.
