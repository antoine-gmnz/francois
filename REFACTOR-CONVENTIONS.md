# Refactor conventions — READ THIS FIRST (temporary file, deleted when the refactor lands)

You are one of several agents migrating components onto shared foundations that ALREADY EXIST.
Do not rebuild them. Do not edit them. Import them.

## Prime directive

**No behavior change. No visual change.** This is a structural cleanup. If a refactor would
alter what the user sees or how the app behaves, don't do it — report it instead. There is NO
React component-testing setup in this project (vitest only, node env, no jsdom, no testing
library). Do NOT add one and do NOT add dependencies. That means `tsc` and the existing logic
tests CANNOT catch a JSX-level regression — so keep component edits mechanical and conservative.
Prefer a faithful move over a clever rewrite.

## What already exists

### `src/ui/` — shared primitives (import, don't reimplement)

```ts
Modal({ onClose, width, align?: 'top'|'center' = 'top',
        closeOnBackdropClick? = false, closeOnEscape? = false, children })
ModalHeader({ children })  ModalBody({ children })  ModalFooter({ children })
StatusDot({ color, size? = 8, pulsing? = false, className? })
PanelHeader({ title, count, paneKey, focused })
ListRow({ selected? = false, hovered? = false, className?, children, ...HTMLAttributes<HTMLDivElement> })
HintBar({ items: { key: string; label: string }[] })
Chip({ selected? = false, danger? = false, onClick?, children, className? })
ChipGroup<T>({ options: { value: T; label: ReactNode; danger?: boolean }[], value, onChange })
BadgePill({ children, className? })
EmptyPane({ children, className? })
Button({ variant?: 'primary'|'ghost' = 'ghost', className?, disabled?, ...ButtonHTMLAttributes })
```

⚠ **`Modal` defaults `closeOnEscape` and `closeOnBackdropClick` to `false`, but every current
call site behaves as `true`.** You MUST pass them explicitly or you will silently break
Escape-to-close. Nothing will catch this for you. (The defaults are `false` on purpose: `Modal`
uses capture-phase `stopPropagation`, so a call site running its own Escape/Enter handler would
otherwise have its keys swallowed. If your call site has its own keydown handler, check for
double-handling.)

### `src/lib/` — shared logic

```ts
useMounted(): MutableRefObject<boolean>                       // src/lib/hooks/useMounted.ts
useDismiss(ref, { onEscape?, onOutsideClick?, enabled? })     // src/lib/hooks/useDismiss.ts
useElapsedClock(active: boolean, intervalMs = 1000): number   // src/lib/hooks/useElapsedClock.ts
useTimedError(): { error, setError, schedule }                // src/lib/hooks/useTimedError.ts
useHydratedSubscription<E,D>({ enabled, subscribe, fetchInitial, isRelevant,
                               shouldBuffer?, onHydrated, onEvent, onError, deps })
runGuardedAction<T>(fn, { setBusy?, setError?, schedule?, errorMs?, isResolved?, log? })
mergeSorted<T>(list, item, keyOf)                             // src/lib/merge-sorted.ts
abbreviate(cwd, home)                                         // src/lib/path.ts
ipc<T>(cmd, args?)                                            // now exported from src/lib/api.ts
```

The store was split into slices (`src/lib/sessionsStore.ts`, `layoutStore.ts`, `agentTabStore.ts`,
`remoteStore.ts`, `overviewStore.ts`, `usageStore.ts`, `projectsStore.ts`, `theme.ts`) but
`useStore` from `src/lib/store.ts` is UNCHANGED in shape — keep importing it exactly as before.

### `src/styles.css` — tokens + utility classes

Token scales now exist: `--space-*` and `--font-size-*` (suffix IS the pixel value, e.g.
`--space-8` = 8px, `--font-size-12-5` style naming for decimals), `--radius-xs|sm|base|md|lg|xl|2xl`,
`--shadow-modal|-popover-lg|-popover|-dropdown|-card|-card-sm|-bar`. All existing color tokens are
unchanged.

Utility classes available:
```
.truncate
.list-row  .list-row--selected  .list-row--hovered
.status-dot  .status-dot--pulsing
.form-error   .badge-pill   .empty-pane   .is-disabled
.chip  .chip--selected  .chip--danger
.btn  .btn--primary  .btn--ghost
.modal-backdrop  .modal-panel  .modal-header  .modal-body  .modal-footer
.panel-header  .panel-header--focused
.hint-bar  .hint-bar__key
```

## Your job, per file

1. **Delete the local `const C = {...}` token-alias object.** Every file has one (or `T`/`M`).
   It maps CSS custom properties to short JS names purely to enable inline styling. It is the
   root cause of the 573 inline styles. Kill it.

2. **Migrate static `style={{}}` to CSS classes.** ~85-90% of inline styles are static layout
   (`display:flex`, `padding`, `gap`, `border`, literal `fontSize`) that never depends on props
   or state. Use the utility classes above where they fit; otherwise put feature-specific rules
   in **a new file `src/features/<feature>/<feature>.css`** which you create and import from your
   component (`import './<feature>.css'`). DO NOT edit `src/styles.css` — other agents share it
   and you will conflict. Use `var(--…)` tokens, never raw hex or magic px.

3. **Keep genuinely dynamic styles inline.** A percentage width, a status-driven color, a
   computed grid-template — these stay. Roughly 55 across the codebase are legitimately dynamic.
   Prefer setting a CSS custom property on the element over a full style object where it reads
   better.

4. **Replace duplicated markup with the `src/ui/` primitives.**

5. **Extract components and hooks** as directed in your specific assignment. Keep extracted
   components in the same feature folder. No barrel files — import modules directly.

6. **Replace long if/else-if chains and ternary ladders with lookup maps / dispatch tables**
   keyed on the discriminator, as directed in your assignment.

7. **Fix cryptic names**: `s`/`x` → `session`, `a` → `agent`, `f` → `file`, `g` → `group`,
   `b` → `block`, `u` → `unsub`, `ae` → `activeEl`, `h`/`l` → `hunk`/`line`, `C` → gone.
   Leave `e` alone for DOM events. DO rename caught errors to `err` in files that use `e` for
   both an event and an error.

8. **Write tests for any pure logic you extract** (vitest, colocated `.test.ts`). Project
   convention is strict TDD. Pure functions only — do not attempt to render components.

## Known gaps — do NOT force these

These were deliberately left uncovered by the foundation agents. Respect that:

- **`ListRow` does not fit `AgentsPanel.tsx`'s agent Card** — its resting background is
  `--bg-panel` (not transparent) and selection is a left accent border, not a raised fill.
  Genuinely different; leave it as its own component.
- **`PanelHeader` has no actions slot**, so it does NOT fit `McpPanel`'s header (which has an
  inline "+" attach affordance) or `Sidebar`'s header. Only `AgentsPanel` and `SkillsPanel`.
- **`useHydratedSubscription` does NOT fit `DiffView.tsx:143-171`.** DiffView subscribes before
  its first fetch specifically to count and swallow that fetch's own echo (`pendingEchoRef`) and
  coalesces concurrent refreshes (`summaryInFlightRef`/`refreshQueuedRef`). Forcing it in drops
  that guarantee. Leave DiffView's effect alone structurally.
- **`useMounted` does NOT fit `App.tsx`'s diff-count effect or `McpPanel`'s `DetailPopover`.**
  Those need a guard fresh per *effect run* (deps `[activeSessionId]` / `[sessionId, name]`), not
  per component lifetime. Using the shared hook there lets a stale promise from the previous
  session/server apply after a switch. Keep their local guards.
- **There is no `OutlineTag` primitive** for the bordered scope/kind tags produced by
  `SkillsPanel.tsx:19-31` (`badgeStyle`) and `McpPanel.tsx:40-52` (`scopeBadge`). These are
  non-interactive outline tags, visually distinct from the filled `BadgePill`. Convert them to a
  local CSS class in your feature stylesheet; do not shoehorn them into `Button` or `BadgePill`.
- `abbreviate` in `src/lib/path.ts` keeps the `!cwd` guard that `Sidebar.tsx`'s local copy
  dropped. Use the shared one; the divergence is unreachable in practice.

### Added after Phase 2 executed (found by the migration agents)

- **`Modal` only fits `AgentsPanel` and `SkillsPanel`.** `PermissionsModal` and `ProjectsModal`
  need a CSS-expression width (`min(720px, 92vw)` / `min(860px, 94vw)`) that the `number`-typed
  `width` prop cannot express, plus a `maxHeight` it has no slot for; their panel border token,
  radius, shadow, and backdrop alpha also differ. `PaletteView` dismisses on `onMouseDown` where
  `Modal` uses `onClick`. Keep those local.
- **`Modal` takes an optional `className`** for the backdrop. Use it if your call site's original
  `z-index` was not 20 — `.modal-backdrop` fixes 20, which is *below* the sidebar context menu (30)
  and the mcp/remote/model-picker popovers (40). `SkillsPanel` passes `.skills-modal-backdrop` to
  keep its original 50.
- **`EmptyPane` is `flex: 1` only** — no `flex-direction`, `gap`, or `height`. It does not fit a
  gapped full-height column (`OverviewView`'s `EmptyState`) or a placeholder inside a non-flex
  `overflow:auto` parent (`DiffView`), where `flex: 1` is inert and the pane collapses.
- **`.list-row--hovered` is `--bg-elevated`**, but `SkillsPanel` rows hover to `--bg-panel` and
  `ProjectSwitcher` rows to `--bg-hover`. Adopt `ListRow` for `selected` and override hover locally
  rather than accepting the token change.
- **`.form-error` does not match `ConversationView`'s send-error banner** despite what the comment
  at `styles.css:791` says: the banner is `6px 10px`, the utility `8px 10px`. Keep a local class.
- The `sessions` folder's `SessionListBody` / `SessionContextMenu` / `FilterInput` and the
  `useRowCursorClamp` / `useSessionFleetSync` / `useSidebarKeyboard` hooks are **imported nowhere**
  yet — Phase 4c wires them in. `sidebar.css` already provides the classes they assume.

## Hard constraints

- Touch ONLY the files listed in your assignment. Other agents are editing other files
  concurrently. When you run `npx tsc --noEmit`, IGNORE errors in files you do not own — verify
  only that YOUR files are clean.
- Do NOT edit `src/styles.css`, `src/ui/**`, `src/lib/hooks/**`, `src/lib/store.ts` or the slice
  files, or anything under `src-tauri/`.
- No new dependencies. No CSS-in-JS. No barrel files. TypeScript strict. Files under ~1000 lines.
- Do NOT run `git commit`, `git push`, `git checkout`, or `git reset`.
- Move code; do not rewrite logic. If you find a bug, LEAVE IT and report it.

## Verify before reporting

- `npx tsc --noEmit` — your files clean.
- `npm test` — all green. The suite total grows as agents add tests; what matters is **zero
  failures** and that no pre-existing test was modified or deleted to make it pass.
- Report: files touched, inline-style count before/after (`grep -c "style={{" <file>`), what you
  extracted, what you replaced with a dispatch table, anything you deliberately left alone and
  why, and any bug you found.
