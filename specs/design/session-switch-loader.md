# DESIGN BRIEF — Session switch loader (`session-switch-loader`)

**Goal:** the user switches to a session and sees the *shape* of a transcript arriving, instead of a
blank column that reads as a hang.

**Design system:** existing UI kit — `src/` components, tokens from `src/styles.css`. Desktop only
(Tauri window, `minWidth: 720`); no mobile breakpoints.

**Source of truth:** design turn **18a — TRANSCRIPT LOADING**, *"The blank beat after a session
switch"*, in `Francois Redesign.dc.html`
(`https://claude.ai/design/p/a4b15728-147c-4932-b83c-f60a5fc60db7?file=Francois+Redesign.dc.html`).
The repo-root mirror is **stale** — it ends at turn 9. The extracted section is `.design-turn18a.html`
at the repo root (gitignored). Variant **18b** in the same section is explicitly out of scope.

---

## Screens / views

### SESSION pane · transcript hydrating

The existing session pane, unchanged above the transcript column. Only three things are new.

**1 · The hydrating hairline** — between the tab segment and the transcript column, full width.

- Height `2px`. Track `#131720` (a step below `--bg-canvas`, no border).
- Thumb: `30%` of the track width, fill `--accent` (`#9cb45f`), no radius.
- Motion: `creep 1.5s ease-in-out infinite`, `translateX(-100%) → translateX(320%)`.
- Under `prefers-reduced-motion: reduce`: static 30% fill, no animation.
- This is the **only** motion in the pane besides the composer caret.

**2 · The skeleton stack** — inside the existing scroll container, `padding: 18px 18px 16px`,
`display: flex; flex-direction: column; justify-content: flex-end; gap: 20px`. Bottom-pinned, because
hydration lands bottom-pinned.

Exactly **two turns**, in `JetBrains Mono` metrics:

- **Older turn** — `opacity: .55`.
- **Latest turn** — `opacity: 1`.

Each turn is a `grid-template-columns: 20px 1fr` with `column-gap: 12px`.

- Gutter glyph: literal `›` for a user turn (`13px`), `⏺` for an assistant turn (`9px`).
  Colour `#232833` on the older turn, `--border-emphasis` (`#2d333f`) on the latest.
- **Header strip** (both roles): a short bar, then a `1px` rule in `#15181e` filling the middle, then
  a second short bar. User: `26×8` + `24×8`. Assistant: `52×8` (+ a `30×8` on the latest) + `22×8`.
- **Body lines**, `9–11px` tall, radius `2–3px`:
  - older user: one line at `64%` × `10px`
  - older assistant: `100%`, `47%`
  - latest user: one line at `71%` × `11px`
  - latest assistant: `100%`, `94%`, `58%`
- **Tool rail** — latest assistant turn only. `padding-left: 14px` with an absolutely positioned `1px`
  vertical rule in `#1d222b`. Three rows on `grid-template-columns: 12px 40px 1fr 52px`,
  `column-gap: 10px`: an `11×11` square `#232833`, a `40px` bar `#232833`, a name bar `#1e222a` at
  `56% / 73% / 41%`, and a trailing `52px` bar `#1a1e26`.
- After the rail, two more body lines at `88%` and `34%`.

**Bar fill ramp**, stepping darker with depth — reuse the nearest existing token where one matches and
introduce **no new token**: `#2d333f` (`--border-emphasis`) · `#2b303a` · `#262b34` · `#252a34` ·
`#242932` · `#20242c` · `#1c2028` · `#1d2129` · `#1b1f27`.

**No shimmer, no pulse, no fade-loop on any bar.** They are static fills. This matches the precedent
already documented at the top of `cloud-sessions.css` — a skeleton that moves reads as activity
happening in the thing it stands for, and the thing actually happening is the hairline.

**3 · The composer, while hydrating** — same geometry, two copy changes.

- Placeholder: **"restoring transcript — you can start typing"** in `--text-faint` (`#565e6e`),
  `12.5px`, followed by a `▌` caret in `--accent` on `blink 1.1s steps(1,end) infinite` (the keyframe
  already exists in `src/styles.css`).
- Hint bar, `10px` `--text-faint`, keycaps in `--text-dim` (`#8b93a3`):
  `⏎ send when ready` · `esc back to previous session` · right-aligned
  **"reading last 200 of the session"**. The `200` is `RENDER_WINDOW`, interpolated — never typed.
- The input is **not** disabled and gains no disabled treatment.

### States

- **below threshold** (<140ms) — none of the above renders. The column is empty, as today.
- **loading** — hairline + skeleton + composer copy, as above.
- **known-empty** — a session with `contextUsedTokens === 0`, or with no `SessionMeta`: none of the
  above renders at any elapsed time. Blank column until the `WelcomeBlock`.
- **error** — `hydrationError` wins; the existing centred error text replaces everything.
- **resolved** — skeleton and hairline unmount; the real turns paint at the same bottom-pinned
  position, with no scroll jump and no composer-height change.

## Flows

1. User clicks a session in pane [1] that is not one of the three `SessionViewHost` holds.
2. Chrome paints instantly (it needs no transcript). Transcript column empty.
3. `t = 140ms` → hairline and skeleton fade in together; composer copy swaps.
4. User may type, paste, attach and send throughout — behaviour identical to a hydrated pane.
5. Transcript resolves → skeleton bars are replaced in place by real turns; copy reverts.

Warm switch (held session) and fast switch (<140ms) skip steps 3–5 entirely.

## Responsive

Desktop only. The skeleton lives inside the existing transcript column and inherits its width; body
lines are percentage-width so they reflow with the pane. Nothing here participates in the ranked
topbar drop order (`src/app/topbar.ts`), and nothing is added to it.

## Data shown

Nothing from the network. The only real value on screen is `RENDER_WINDOW` (`200`) in the hint bar.
Everything else is fixed geometry. Any meter this pane renders that it cannot resolve while unhydrated
shows an em dash `—`, never `0` — a zero meaning "not known yet" is a wrong reading, not a missing one.

## Notes / constraints

- **Copy is English** (`ui_language: English`), lowercase, and uses the em dash the rest of the app
  uses — `restoring transcript — you can start typing`, not a colon.
- **No new token, no new glyph, no asset, no dependency.** Every colour above resolves to a `var()` in
  `src/styles.css` or is a one-off fill in the ramp; the glyphs `›`, `⏺`, `▌`, `⏎` are already in use.
- **Styling is `conversation.css` + classNames** — a `conv-skel*` / `conv-hydrating-bar` block. No
  inline `style={{}}`; the bar-width percentages are the one legitimate exception only if they end up
  computed, which they should not — write them as CSS.
- **`font-weight` caps at 600** (webview-hardening decision). Nothing here needs weight at all.
- **Accent budget**: the accent appears twice in this state — the hairline thumb and the composer
  caret. Both are *the live thing*, and both disappear on `hydrated`, so the one-acid-per-view rule
  holds for the settled pane.
- **Accessibility**: the skeleton is decorative. Mark the stack `aria-hidden="true"` and give the
  hairline `role="progressbar"` with no `aria-valuenow` (indeterminate) and an accessible name of
  `restoring transcript`.
