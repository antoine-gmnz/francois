# DESIGN BRIEF — GitHub CI logs (`github-ci-logs`)

**Goal:** from a PR or commit on the GitHub page, see what a CI job is doing step by step and read
the failing step's log without leaving Francois.

**Design system:** Graphite & Signal (Figma `YEY4c6AiWq1bKYuaju9qdV`; tokens in `src/styles.css`).
Colour is state only: `--state-running` (cyan) live, `--state-danger` failed/error lines, `--warn`
warnings, `--state-success` passed glyphs; everything else graphite. Geist UI, Geist Mono for step
numbers, durations and log text. Dark default + light twin. Reuse `src/ui` (`Button`, `Modal`,
`Orbit`, `Icon`) and the existing `pull-card` chrome. Desktop app, no mobile layout.

## Screens / views

- **PR detail → Checks card (rebuilt)** — left column of PR detail, same position and card chrome.
  - Head: rollup chip · spacer · count line `3 passed · 1 failed · 1 running` (faint; the failed
    term uses danger text, the running term running text).
  - Check row (collapsed, 32px): caret `▸` (Actions jobs only, 12px slot kept for alignment on
    others) · state glyph (Orbit when pending) · name · spacer · right slot:
    - running: `› Run tests · 1m12s` (faint, step name truncates first, elapsed in mono)
    - failed: summary in danger text + duration
    - passed/skipped: duration faint
    - non-Actions: ghost `Open on GitHub` (sm)
  - Expanded job (caret `▾`, row gets `--bg-selected`): an indented block (left rule `--line-subtle`,
    16px indent) with a 28px sub-header `CI / test (ubuntu)` · `attempt 2` tag when >1 · ghost
    `Open on GitHub`, then step rows (26px): glyph · step number (mono, faint, 2ch) · name · duration.
    Running step: Orbit + cyan elapsed. Failed step: danger glyph + danger-text name. Skipped: 50%
    opacity. Queued: hollow dot. Clickable steps get a hover fill and a `›`; non-clickable ones on a
    running job show `log when the job finishes` faint on hover/focus.
  - Open step log: recessed panel (`--bg-input`) directly under its step row, full card width minus
    the indent, max-height 420px, own scrollbar.
    - Toolbar (24px, sticky): `Step 5 · Run tests` · spacer · Copy icon (tooltip → "Copied") ·
      `Open on GitHub` icon-link.
    - Dropped-lines notice (when capped): one faint line under the toolbar,
      `Showing the last 5,000 of 12,431 lines · Open on GitHub for the full log`.
    - Lines: 12px mono, 18px line height, gutter of right-aligned line numbers (faint, not selectable),
      text wraps off (horizontal scroll). `error` lines: danger tint background at ~12% + danger text
      marker `✕` in gutter; `warning`: `--warn` tint; `command` lines faint; groups as one row
      `▸ <title> · n lines` (caret toggles), the group containing the first error opens by default.
    - Opens scrolled so the first error sits ~5 lines from the top; no error → scrolled to bottom.
    - States: loading (faint "Loading log…" in the panel, 80px tall) · not ready ("Log available
      when the job finishes") · gone ("GitHub no longer keeps this log" + Open on GitHub) · too large
      ("Log too large to show (> 32 MiB)" + Open on GitHub) · error (message + Retry) · whole-job
      fallback (toolbar reads `Full job log`).
  - Danger footer (existing): spark icon · first failure summary · spacer · ghost **Re-run failed**
    (new, when eligible) · primary **Fix in a new session** (while the excerpt fetch runs, the button
    shows an inline Orbit and is disabled, max 5 s).
- **Re-run confirm (Modal, small)** — title "Re-run failed jobs?", body lists the workflow names and
  failed job count, buttons Cancel · primary `Re-run`. Inline danger text on error; `Re-run` shows
  Orbit while calling.
- **Commit detail → Checks on this commit (side card)** — same rows and expansion, compact (step
  durations may drop below 280px width). Clicking a step opens a **wide Modal** (min(960px, 90vw) ×
  70vh) holding the same log panel (toolbar becomes the modal header, `job › step`).

## Flows

1. Open a PR with a red check → first failed job expanded, failed step log open at the first error.
2. Running check → collapsed row names the current step; expand → steps tick live (5 s); job ends
   red → its failed step opens by itself (unless the user already opened a step in it).
3. Fix in a new session → brief spinner → session starts with the excerpt in the first message.
4. Re-run failed → confirm → checks flip to running, live polling resumes.

## Data shown

`CheckRun` (name, state, durationMs, summary, detailsUrl, jobId, runId, startedAt), `CheckJob`
(name, workflowName, runAttempt, steps[number, name, state, startedAt, durationMs], htmlUrl),
`StepLog` (lines[n, text, kind], totalLines, droppedLines, firstErrorLine) — spec §5.

## Notes / constraints

- Keyboard: rows and steps are focusable; Enter/Space toggles/opens; the log panel is focusable for
  scroll keys; Esc closes the commit-detail modal. Caret state exposed via `aria-expanded`.
- Copy is English. No bare-letter shortcuts added (decision 2026-08-04 ui).
- Per-feature CSS: new classes live in `src/features/github/ci-logs.css` (BEM-lite `ci-job`,
  `ci-step`, `ci-log`); no inline styles; font-weight ≤ 600.
- Light twin: tints computed with `color-mix` against the theme's surface, never hard-coded hex.
