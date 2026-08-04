---
id: titlebar-project-switcher
title: Title-bar project switcher
status: shipped
created: 2026-07-31
depends_on: [projects, design-refresh, usage-bar, overview, agent-tab, app-shell]
reviewed_base: dcc7bfb66ddf9b747c4ceeca59063f6c53997ce9
reviewed_digest: 7d81b22b65f639b2
---

# Title-bar project switcher

## 1. Summary

The title bar's brand cluster ends in a button that prints an abbreviated **path** (`● ~\dev\francois ▾`)
and whose `▾` caret opens the Projects **modal** — a caret that promises a menu it does not have. Meanwhile
the real control it imitates, `ProjectSwitcher`, has been commented out of pane [1] since the design refresh
(`Sidebar.tsx:159`, commit `8688cc2`), leaving `setActiveProjectId` with **no caller in the codebase** — project
scoping is currently unreachable from the UI. This feature re-sites the existing `ProjectSwitcher` into that
title-bar button: the label becomes the project **name** (or `All projects`), and the `▾` opens the switcher's
own dropdown, which restores board scoping. One working control replaces one broken one. No new IPC, no new
data, no registry change.

## 2. Goals & non-goals

**Goals**
- The title-bar button reads `switcherLabel(active)` — the project name, or `All projects` when unscoped.
- Its `▾` opens the existing `ProjectSwitcher` dropdown; selecting a row sets `activeProjectId`, which already
  drives the board filter and the OVERVIEW auto-switch.
- Restore reachability of project scoping (`setActiveProjectId` regains a caller).
- The full path survives as the button's `title` tooltip.
- Delete the dead pane [1] mount; there is exactly **one** project control in the app.

**Non-goals**
- No keyboard shortcut and no new palette commands for switching scope (**decided**: mouse-only, as today).
  The palette's existing `manage-projects` command (`paletteCommands.ts:240`) is untouched.
- No project count badge in the title bar (**decided**: dropped — the `<count> · [1]` grammar it mirrored in
  pane [1] does not exist up there).
- No two-tier button (bright name + dim parent path). **Decided, eyes open**: this moves the active project's
  root into a tooltip. For a tool that runs `bypassPermissions` sessions, "which directory may this agent write
  to" leaves the always-visible surface. Accepted because per-session `cwd` is still on every sidebar card
  (`SessionListBody.tsx:160`) and the tooltip is one hover away. Recorded here so a reviewer reads it as a
  trade, not an oversight.
- No restoration of the pane [1] switcher.
- No change to project naming/editing/defaulting, no registry migration, no change to the Projects modal.
- No new IPC and no contract change.

## 3. User stories / flows

1. **Read the scope.** The user glances at the title bar. Unscoped it reads `● All projects ▾`; scoped to
   Francois it reads `● Francois ▾`. Hovering shows the full root (or the active session's cwd when unscoped).
2. **Scope the board.** Click the button → dropdown opens under it, left-aligned: `All projects`, then one row
   per project (name bright, abbreviated root dim, `missing` tag when the root is gone), `✦` on the selected
   row, a divider, then `Manage projects…`. Click `Francois` → dropdown closes, the button reads `● Francois ▾`,
   the session board filters to that project, the main tab is left alone.
3. **Widen back.** Click the button → `All projects` → the board shows every session, every agent tab closes,
   and the main tab switches to OVERVIEW (unchanged behaviour, `App.tsx:120-128`).
4. **Manage.** Click the button → `Manage projects…` → dropdown closes, Projects modal opens. On close the
   registry is re-read, so a rename or a new project is reflected in the label and the dropdown.
5. **Dismiss.** `Escape` or a click outside closes the dropdown without changing scope.

## 4. Functional requirements

- **FR-1** `ProjectSwitcher` renders inside `UsageBar`'s `.titlebar-brand` cluster, replacing the current
  `.titlebar-path` button. It is the **only** project control in the app.
- **FR-2** The component file stays at `src/features/projects/ProjectSwitcher.tsx` and is *imported* by
  `UsageBar` (PIPELINE §Code layout — group by feature). It is **not** inlined into `features/usage/`.
- **FR-3** The button label is `switcherLabel(active)` — the project `name`, else `All projects`. It truncates
  with the existing `.truncate` rule; the name (not the meter) gives way. `MAX_PROJECT_NAME_LENGTH` is 80, so
  the button's `max-width: 320px` cap stays and the label ellipsizes inside it.
- **FR-4** The button renders **unconditionally** — the old `rawPath &&` guard is dropped. With zero projects
  registered it reads `● All projects ▾` and its dropdown offers `All projects` + `Manage projects…`, which is
  the entry point for registering the first one.
- **FR-5** The leading dot reflects the scoped project's `rootExists`: `--success` when it exists,
  `--danger` when it is missing, `--text-muted` on `All projects`. A new pure helper
  `switcherDotTone(project: ProjectMeta | null): 'ok' | 'missing' | 'none'` in `projects.ts` decides this;
  the component maps the tone to a modifier class.
- **FR-6** The button's `title` is the existing fallback chain, unchanged:
  `activeProject?.root ?? activeSession?.cwd ?? home`, run through `displayWslCwd(…) ?? …` as today so a WSL
  path renders in its own form. A new pure helper
  `switcherTooltip(project, sessionCwd, home): string` in `projects.ts` owns the chain; `UsageBar` passes
  `home` and the active session's `cwd` down as props (the switcher does not reach into `sessions` itself).
- **FR-7** Clicking the button toggles the dropdown (it no longer opens the Projects modal directly). The
  dropdown is unchanged from the pane [1] version: `buildSwitcherRows` order, `✦` mark, `missing` tag,
  `abbreviateRoot`, the `role="listbox"` scopes, the divider, and `Manage projects…` as a sibling `role="button"`.
- **FR-8** The project **count** element (`.pjsw-spacer` + `.pjsw-count`) is removed from the toggle.
- **FR-9** The dropdown anchors under the button, `left: 0`, sized to its own content (min 260px, max 420px) —
  it no longer stretches `left:0; right:0` to a full-width strip. `z-index: 40` is retained; the panel must
  clear the usage meters and the grid below.
- **FR-10** `Escape` and outside-click dismiss the dropdown (existing `useDismiss`).
- **FR-11** The registry re-read moves with the component: `projectList()` on every dropdown open and whenever
  `projectsOpen` goes false (whose first run doubles as the mount fetch). Since `UsageBar` is always mounted,
  this is the app's project-registry load.
- **FR-12** The dead `{/* <ProjectSwitcher home={home} /> */}` line at `Sidebar.tsx:159` is deleted, along with
  the now-unused import and the `home` prop on `Sidebar` **iff** nothing else in `Sidebar` uses it (it does —
  `SessionListBody` takes `home` — so the prop stays; only the comment and import go).
- **FR-13** Selecting `All projects` keeps its existing side effects verbatim (**decided**): `clearAgentTabs()`
  then `setMainTab('overview')` in `App.tsx:120-128`. No change to that effect.
- **FR-14** The toggle's CSS **moves** from `usage.css` to `projects.css`: the `.titlebar-path`,
  `.titlebar-path--hover`, `.titlebar-path-dot`, `.titlebar-path-text`, `.titlebar-path-caret` rules are cut
  from `usage.css` and re-declared in `projects.css` under a title-bar section, keeping their names so
  `design-refresh` §8's references still resolve. `UsageBar` keeps `.titlebar-brand`, `.titlebar-logo`,
  `.titlebar-wordmark`. No orphan `pjsw-*` toggle rules are left in `projects.css` styling markup that no
  longer exists (`.pjsw-toggle*`, `.pjsw-glyph*`, `.pjsw-label`, `.pjsw-spacer`, `.pjsw-count`, `.pjsw-root`'s
  strip assumptions).
- **FR-15** `.titlebar-path-text` uses `var(--font-ui)` (it names a project now, not a path) and
  `var(--text-2)`; the accent-when-filtered treatment of the old `.pjsw-label` is dropped — the dot carries
  scope state (FR-5).
- **FR-16** No motion is added to the title bar (`usage-bar` FR-25: the strip has none). The dropdown's
  existing `dropIn 90ms` animation is on the **panel**, not the bar, and is retained.

## 5. API contract

**No contract change.** This feature adds no IPC channel, no event, and no type — `contract/titlebar-project-switcher.ts`
is **not** created. Every value it needs is already in the frontend store, and the two IPC calls it makes are
existing ones, reused verbatim:

- `francois:project:list` → `projectList(): Promise<Result<ProjectMeta[]>>` (`src/lib/api.ts`), already
  specced in `specs/projects.md` §5. Fields read: `id`, `name`, `root`, `rootExists`.
- No write IPC: `activeProjectId` is frontend-only state persisted to `localStorage` under
  `ACTIVE_PROJECT_STORAGE_KEY` (`projects` FR-26).

The only new **module-internal** interface is two pure helpers exported from `src/features/projects/projects.ts`:

```ts
/** FR-5 — which tone the title-bar dot wears. */
export type SwitcherDotTone = 'ok' | 'missing' | 'none';
export function switcherDotTone(project: ProjectMeta | null): SwitcherDotTone;

/** FR-6 — the button's `title`: scoped root, else the active session's cwd, else home. */
export function switcherTooltip(
  project: ProjectMeta | null,
  sessionCwd: string | null,
  home: string,
): string;
```

and the component's widened props:

```ts
export default function ProjectSwitcher(props: { home: string; sessionCwd: string | null }): JSX.Element;
```

## 6. Data & state

- **Core (Rust)**: none. Untouched.
- **Frontend store (read)**: `projects: ProjectMeta[]`, `activeProjectId: ProjectId | null`, `sessions`,
  `activeSessionId`, `projectsOpen`.
- **Frontend store (write)**: `setProjects` (after each `projectList`), `switchProject` (row click —
  persists the scope AND lands inside it, projects FR-39; it superseded the bare `setActiveProjectId`
  this row used to call), `setProjectsOpen` (`Manage projects…`).
- **Local component state**: `open` (dropdown), `hover` (toggle).
- **Derived**: `active = projects.find(p => p.id === activeProjectId) ?? null`; `rows = buildSwitcherRows(...)`;
  `label = switcherLabel(active)`; `tone = switcherDotTone(active)`; `tooltip = switcherTooltip(...)`.
- **Removed state**: `UsageBar`'s `pathHover`, `rawPath`, `pathLabel`, and its `setProjectsOpen` subscription
  all move into (or are replaced by) the switcher.

## 7. Edge cases & errors

1. **`projectList` fails.** `safeCall` swallows it; `setProjects` is not called, so the last-known list stands.
   The button keeps its current label. No error UI in the title bar (unchanged from pane [1]).
2. **Scoped project's root is missing.** Label still shows the name; the dot goes `--danger` (FR-5); the
   dropdown row wears the `missing` tag and dim name. Scoping is *not* auto-cleared.
3. **Scoped project removed via the modal.** On modal close the re-read runs; `reconcileActiveProjectId`
   (`projectsStore.ts:25`) drops the dangling id to `null`, which fires FR-13's OVERVIEW effect. Label falls
   back to `All projects`.
4. **Zero projects registered.** FR-4 — `● All projects ▾` (dot `--text-muted`), dropdown = `All projects` +
   `Manage projects…`.
5. **Very long project name (up to 80 chars).** The label ellipsizes inside the button's `max-width: 320px`;
   the usage meters must not be pushed or wrapped. Verify at the narrowest supported window width.
6. **Deep root path in a dropdown row.** Existing `.pjsw-row-root { max-width: 52% }` + `.truncate` already cap
   it; the name is the last thing to truncate.
7. **Dropdown clipped by the window edge.** The button sits at the far left of the bar, so a `left: 0` anchor
   cannot overflow the right edge at any supported width. No flip logic is specified.
8. **Dropdown vs. the grid below.** The panel is absolutely positioned with `z-index: 40` and must render over
   the sidebar and main pane, not inside the bar's `overflow` — verify `.usage-bar` does not clip it.
9. **Drag region.** *Not a risk*: there is no `data-tauri-drag-region` anywhere in `src/`; the usage bar sits
   below the native OS caption (`usage.css:6`). No click is eaten. Recorded so no one re-opens it.
10. **Modal open while the dropdown is open.** `Manage projects…` closes the dropdown before opening the modal;
    the two are never both on screen.
11. **`home` empty.** `abbreviateRoot` and `abbreviate` already no-op on an empty `home`, returning raw paths.

## 8. Design brief

One screen: the title bar (`UsageBar`'s `.titlebar-brand`). The path button becomes the project switcher —
`● Francois ▾` / `● All projects ▾`, 24px tall, `--bg-hover` fill in a `--border-emphasis` outline,
`max-width: 320px`, the label in `--font-ui`/`--text-2` and the dot carrying scope state (green / red / muted).
Its dropdown is the existing `pjsw-*` panel, re-anchored `left: 0` under the button and sized to its own
content instead of stretching a 26px sidebar strip. Desktop-only; no mobile consideration.

> full brief: `specs/design/titlebar-project-switcher.md`

## 9. Acceptance criteria

- [ ] The title-bar button shows the active project's **name**, or `All projects` when unscoped (FR-3).
- [ ] Clicking it opens a dropdown — not the Projects modal (FR-7).
- [ ] The dropdown lists `All projects` + every project with `✦` on the selected row, `missing` tags, and a
      `Manage projects…` action below a divider (FR-7).
- [ ] Selecting a project filters the session board to it and leaves the main tab alone (FR-7, `projects` FR-26).
- [ ] Selecting `All projects` clears the filter, closes agent tabs, and switches to OVERVIEW (FR-13).
- [ ] `Manage projects…` opens the Projects modal; closing it refreshes the label and the list (FR-11).
- [ ] `Escape` and outside-click dismiss the dropdown without changing scope (FR-10).
- [ ] Hovering the button shows the full root / session cwd / home (FR-6).
- [ ] The dot is green for an existing root, red for a missing one, muted on `All projects` (FR-5).
- [ ] With zero projects the button reads `All projects` and the dropdown still offers `Manage projects…` (FR-4).
- [ ] An 80-char project name ellipsizes without displacing or wrapping the usage meters (§7 #5).
- [x] `ProjectSwitcher.tsx` still lives in `src/features/projects/` and is imported by `UsageBar` (FR-2).
- [x] `Sidebar.tsx` has no `ProjectSwitcher` comment or import left; `grep -r ProjectSwitcher src/features/sessions`
      returns nothing (FR-12).
- [x] `usage.css` has no `.titlebar-path*` rules; `projects.css` has them and no orphan `.pjsw-toggle*`,
      `.pjsw-glyph*`, `.pjsw-label`, `.pjsw-spacer`, `.pjsw-count` rules (FR-14).
- [x] `npm test` covers `switcherDotTone` (all three tones) and `switcherTooltip` (project root / session cwd /
      home fallback, and the WSL form) in `projects.test.ts`. **Honest note**: these two helpers are the only
      genuinely new logic — the rest of this feature is wiring and CSS relocation, and no test surface should be
      invented for it.
- [x] `npx tsc --noEmit` is clean.

## Remediation

### cohorte-cycle round 1

(none — see questions in the workflow result)
</content>
