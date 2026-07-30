---
id: mac-text-selection
title: Fix broken text selection & copy in the SESSION transcript on macOS
status: shipped
created: 2026-07-30
depends_on: [conversation-view]
reviewed_base: 1490f8561db8f846f579a15bb7cdc200621283c4
reviewed_digest: 55a6cfeee4a795d3
---

# Fix broken text selection & copy in the SESSION transcript on macOS

## 1. Summary

Text selection and clipboard copy in the SESSION tab transcript are broken on macOS:
click-drag over transcript content produces no highlight, and Cmd+C copies nothing.
This is a regression — it worked before. It is confirmed macOS-only (Windows/Linux are
unaffected). This is a restoration of existing, previously-working behavior, not new UI.

Prior investigation (see `specs/reports/mac-text-selection-brainstorm.md`) found the
frontend code path that should enable this — `ConversationView.tsx`'s transcript
container explicitly sets `userSelect: 'text', cursor: 'auto'` to override the global
`body { user-select: none }` chrome rule — is present and unchanged; no global
`mousedown`/`keydown` handler intercepts events over the transcript; no custom
drag-region CSS exists (the app uses native window decorations). Root cause is therefore
unconfirmed but most likely sits below the React tree: a WKWebView (macOS's Tauri
webview engine) behavior, possibly surfaced by a silent `wry`/Tauri dependency update in
`Cargo.lock`, or a native webview configuration difference from Windows (WebView2) and
Linux (WebKitGTK) — both of which still work.

## 2. Goals & non-goals

- **Goals:**
  - Drag-to-select highlights transcript text on macOS.
  - Cmd+C copies the active transcript selection to the system clipboard on macOS.
  - Standard OS selection conventions (double-click word, triple-click paragraph/line)
    work in the transcript.
  - Windows and Linux transcript selection/copy remain unaffected (regression guard).
- **Non-goals:**
  - SHELL tab (xterm.js) selection — separate selection model, not touched here.
  - DIFF view selection.
  - Any visual/UX redesign of selection appearance beyond native OS/webview rendering.

## 3. User stories / flows

1. User drags across rendered transcript text (user message, assistant text, code
   block, markdown) → text highlights with the OS selection color as the drag proceeds.
2. User double-clicks a word → that word is selected. Triple-click → the containing
   paragraph/line is selected.
3. With an active selection, user presses Cmd+C (macOS) / Ctrl+C (Windows/Linux) →
   selected text is placed on the system clipboard as plain text.
4. While the user holds a selection, new assistant tokens stream in below it
   (`assistant.delta` appends elsewhere in the transcript) → the existing selection is
   undisturbed.

## 4. Functional requirements

- **FR-1**: Click-drag over transcript content produces a visible text highlight on
  macOS.
- **FR-2**: Cmd+C with an active transcript selection copies the selected text to the
  system clipboard on macOS.
- **FR-3**: Double-click selects a word; triple-click selects the containing
  paragraph/line — standard OS convention, verified on macOS and at least one of
  Windows/Linux.
- **FR-4**: A live transcript selection is not cleared by unrelated re-renders (e.g.
  streaming `assistant.delta` appends elsewhere in the transcript).
- **FR-5**: Regression guard — Windows and Linux transcript selection + copy behavior
  is unchanged after this fix ships.

**Implementer note:** root cause is unconfirmed. Investigate both the frontend
CSS/webview rendering path and, if that proves insufficient, core-side webview
configuration (`src-tauri`) for a macOS-specific cause. Start with the cheap, zero-risk
check: add an explicit `WebkitUserSelect: 'text'` alongside the existing
`userSelect: 'text'` in `ConversationView.tsx`'s transcript container style, since
WKWebView has a documented history of needing the `-webkit-` prefix that the current
CSS omits. If that alone doesn't resolve it, check `src-tauri/Cargo.lock` history
(`git log -p -- src-tauri/Cargo.lock | grep -i wry`) for a version change coinciding
with when this broke, and check for any macOS-specific `WebviewWindowBuilder` config in
`src-tauri` that could affect text selection/event handling.

## 5. API contract

None. This feature is presentation-only — no IPC channel, event, or contract type is
added, changed, or removed.

## 6. Data & state

None. No new state is owned by this feature; no persistence changes.

## 7. Edge cases & errors

- A selection spanning multiple blocks (e.g. user message → assistant reply) copies
  concatenated plain text with no markdown/HTML formatting artifacts.
- Selecting inside a rendered code block does not trigger any code-block-specific
  action (e.g. a "copy code" affordance, if one exists elsewhere) — plain text
  selection wins inside the block.
- If `navigator.clipboard` is unavailable in a restricted webview context, no JS
  error/console warning is thrown — matches the existing swallow pattern in
  `RemoteControlBadge.tsx`.

## 8. Design brief

No new screens or components. Restores native OS text-selection/highlight behavior on
the existing SESSION transcript — visual appearance is whatever the OS/webview renders
natively for `::selection`, already implied by `Claude Terminal.dc.html`. No separate
`specs/design/mac-text-selection.md` brief authored.

## 9. Acceptance criteria

- [ ] FR-1: On macOS, click-drag over transcript text (user message, assistant text,
      code block) shows a visible highlight.
- [ ] FR-2: On macOS, Cmd+C after selecting transcript text copies it to the clipboard
      (verified by pasting elsewhere).
- [ ] FR-3: Double-click selects a word; triple-click selects a paragraph/line, verified
      on macOS and at least one of Windows/Linux.
- [x] FR-4: Selecting text in the transcript while an assistant response streams in
      below does not clear the selection. (verified: reducer/compactBlocks reference-
      stability unit tests, confirmed accurate against the real implementation by
      /review 2026-07-30)
- [ ] FR-5: Windows and/or Linux transcript selection + copy still works after the fix
      (no regression).

## Remediation

(Five rounds appended 2026-07-30 by a buggy review-fix-loop workflow were removed —
its diff-staging step ran `git diff main` instead of `git diff HEAD`, which on this
branch pulled the already-shipped session-worktree feature into the "diff to review"
and produced repeated false CRITICAL scope-contamination findings against this
feature's own staged diff files. No source file belonging to mac-text-selection or
session-worktree was modified by those rounds — confirmed via `git status` showing
only the original three-file diff.)

### 2026-07-30

- [x] MEDIUM · src/features/agents/AgentView.tsx:187 · quality (incomplete fix) · This container is a byte-for-byte structural twin of the SESSION transcript container fixed in this diff — same comment ("the transcript is CONTENT — copying out of it must work"), same `userSelect: 'text'` + `cursor: 'auto'` pattern, same `Block` component rendering per-agent transcript content — and is therefore susceptible to the identical documented WKWebView unprefixed-`user-select` bug this spec fixes for SESSION. Apply `TRANSCRIPT_TEXT_SELECT_STYLE` (import from `conversation-blocks.ts`, or hoist it to a shared location if `AgentView` shouldn't import from the `conversation` feature folder) at `AgentView.tsx:187`. — fixed: imported `TRANSCRIPT_TEXT_SELECT_STYLE` from `../conversation/conversation-blocks`, spread in place of the bare `userSelect: 'text'` at `AgentView.tsx:188`.
