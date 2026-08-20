---
id: roster-group-tier
title: Roster group tier
status: shipped
branch: feat/roster-group-tier
created: 2026-08-20
depends_on: [project-groups, sessions-sidebar, projects, app-shell]
reviewed_base: 893a1f3248e4e0d4617f1fc6b241faeedba8332f
reviewed_digest: 596ce19acac6f0b8
design_files: []
---

# Roster group tier

## 1. Summary

Inside every state band of the pane [1] roster (WAITING ON YOU · RUNNING · IDLE · ARCHIVED), cluster
sessions under their project's **group** — `ODO`, `Perso`, `elsewhere` — as a collapsible innermost
tier. The grouping data already exists end-to-end (`ProjectGroup`, `ProjectMeta.groupId`, the Rust
registry, the Projects modal); design 12b regrouped the roster by state and deleted the tier that
painted it, so a hand-assigned group is currently invisible. This feature is **paint only**: no core,
no IPC, no contract change. State-first ordering, the state bands, their order and their collapse
record are all untouched.

## 2. Goals & non-goals

- **Goals**
  - A group tier nested inside **every** state band, uniformly.
  - Headings ordered alphabetically, `elsewhere` (ungrouped) always last.
  - **Suppression**: a band whose sessions all fall in one group paints **no** heading.
  - Per-(state, group) collapse, persisted, independent of the state band's own record.
  - `j`/`k` walks cards only; a heading is never a cursor stop.
- **Non-goals**
  - Prefix/pattern auto-assignment of projects to groups — it would miss `ODO - Reviewer` (root
    `/Users/enzo/dev`, no prefix) and silently reclassify on rename. The hand-assigned `groupId` is
    strictly better information.
  - Group CRUD — the Projects modal (`project-groups`) already owns create/rename/assign/delete.
  - A group scope in the title-bar switcher — suppression already makes the tier vanish under a
    single-project scope.
  - Any change to the row's project tag: `ODO - Frontend` renders verbatim (accepted redundancy).
  - Any change to the state bands, their order, their labels or their collapse record.
  - Group grouping anywhere else — OVERVIEW, fleet board, agent tabs.
  - Any core / IPC / contract change; any Rust file.

## 3. User stories / flows

1. **Reading a mixed fleet.** 8 projects in 2 groups. IDLE holds 5 sessions across both. The band
   paints `ODO 3` then `Perso 2`, each heading at the rows' own indent, rows unchanged beneath it.
2. **Quieting a family.** The user clicks the `Perso` heading inside IDLE. Its 2 rows collapse; the
   IDLE band heading still reads `5`; `ODO` inside IDLE and `Perso` inside RUNNING are unaffected.
   Relaunching the app restores exactly that one collapsed tier.
3. **Nothing to tell apart.** WAITING holds one session, from ODO. No heading is painted — the band
   renders exactly as it does today. A second session arrives from Perso: two headings appear.
4. **Keyboard.** `j`/`k` steps card to card down the painted order, skipping every heading and every
   card inside a collapsed tier. The cursor stays on its session as the session moves between bands
   (already shipped: `deriveRowCursor`, `8d63e13`).
5. **Ungrouped only.** A fleet where no project has a group paints no headings anywhere — the tier is
   invisible until the user assigns a group in the Projects modal.

## 4. Functional requirements

**Resolution & order**

- **FR-1** A session's tier resolves `SessionMeta.projectId` → `ProjectMeta.groupId` →
  `ProjectGroup`. A miss at **any** hop (no `projectId`, project not in the registry, no `groupId`,
  `groupId` naming no group) resolves to the ungrouped tier. Total — never throws, never `undefined`.
- **FR-2** Tier key is `group:<groupId>` for a resolved group and `group:none` for ungrouped. The
  ungrouped label is `elsewhere`, matching `roster-groups.ts`'s existing `UNGROUPED_LABEL`.
- **FR-3** Within a band, headings are ordered by group **name**, case-insensitive ascending, with
  ties broken by `groupId` ascending; `group:none` is **always last** regardless of name.
- **FR-4** Two groups sharing a name paint **two adjacent headings**, one per `groupId`, each with its
  own collapse slot — a heading maps to exactly one group, never to a name.
- **FR-5** Sessions keep their incoming fleet order inside a tier — no second sort is invented.
- **FR-6** A tier with no sessions in this band is never painted (it cannot be constructed).
- **FR-7 (suppression)** A band whose sessions all resolve to **one** tier key paints **no** heading:
  its rows render directly under the state heading, exactly as today. This applies when that single
  tier is `group:none` too — no exception.
- **FR-8** The tier applies uniformly to all four state bands. There is no per-band opt-out and no
  grouping toggle.

**Collapse**

- **FR-9** A tier's collapse slot is `gtier:<stateKey>:<groupKey>` (e.g.
  `gtier:state:idle:group:7f3a…`), so the same group collapses independently in each band.
- **FR-10** Default is **expanded**: absence from the record means expanded, in every band. The record
  is therefore a plain set of collapsed slots — no tri-state, no per-tier default table.
- **FR-11** The record persists to `localStorage` under `francois.collapsedRosterGroupTiers`, its own
  key space. Absent, non-array or malformed JSON ⇒ empty set (everything expanded); non-string entries
  are dropped. Reads and writes never throw out of the module.
- **FR-12** The state-band record (`francois.collapsedStateGroups`) and this one are independent:
  neither read nor write touches the other. A collapsed band hides its tiers wholesale without
  changing their slots.
- **FR-13** A suppressed heading (FR-7) has no toggle and writes nothing. A slot persisted while the
  heading existed is honoured again if the heading reappears.
- **FR-14** Slots for deleted or renamed-away groups are never read and never garbage-collected —
  consistent with `2026-08-17 · data` (the delete sweep covers registries, not view state).

**Painting**

- **FR-15** A heading is a thin row: caret (`▾` expanded / `▸` collapsed), the group name, the count.
  Neutral text, **no accent, no status dot, no tint** — the state heading above it owns the colour.
- **FR-16** The heading sits at the **rows' own indent**; rows do **not** indent further. The tier
  reads by weight and vertical rhythm (`project-groups` FR-24 caps the roster at three levels).
- **FR-17** The heading count is the sessions in that tier in that band, whether collapsed or not.
- **FR-18** The state band's own count is unchanged — every session in the band, across all tiers.
- **FR-19** Clicking anywhere on the heading toggles it. No `+`, no context menu, no other affordance.
- **FR-20** No motion when a session moves between bands or tiers.

**Keyboard**

- **FR-21** The flattened painted order walks bands in `STATE_ORDER`, then tiers in FR-3 order, then
  sessions in FR-5 order — skipping a collapsed band's tiers and a collapsed tier's sessions entirely.
  It is the single source for `j`/`k` indices and for the `roster-row--cursor` index.
- **FR-22** A heading is never a cursor stop and is not reachable by `j`/`k`; cards inside a collapsed
  tier are not reachable either.
- **FR-23** The project scope and the `/` filter apply **before** bucketing, unchanged — the tier only
  ever partitions sessions the roster was already going to paint.

## 5. API contract

**No contract change and no IPC verb.** `groupId` and `ProjectGroup` already cross the boundary via
`project_list` (`contract/projects.ts`), and `SessionMeta.projectId` via `contract/common.ts`. Nothing
is added to `contract/`, and no Rust file is touched.

The feature's interface is a frontend-internal pure module,
`src/features/sessions/group-tier.ts`, mirroring the shape of `state-groups.ts`:

```ts
import type { SessionMeta } from '../../../contract/common';
import type { ProjectGroup, ProjectMeta } from '../../../contract/projects';
import type { RosterStateNode } from './state-groups';

/** FR-2. `group:<groupId>` | `group:none`. */
export const UNGROUPED_TIER_KEY = 'group:none';
export const UNGROUPED_TIER_LABEL = 'elsewhere';

/** FR-1. Total: any unresolved hop yields the ungrouped tier. */
export function tierOf(
  session: SessionMeta,
  projects: readonly ProjectMeta[],
  groups: readonly ProjectGroup[],
): { key: string; label: string };

export interface RosterGroupTier {
  /** FR-9. `gtier:<stateKey>:<groupKey>` — the collapse slot. */
  key: string;
  /** FR-2. `group:<groupId>` | `group:none`. */
  groupKey: string;
  label: string;
  sessions: SessionMeta[];
}

/** FR-3/FR-4/FR-6/FR-7. Returns `null` when the band resolves to a single tier
 *  (suppressed — the caller paints `node.sessions` flat). */
export function groupTiersOf(
  node: RosterStateNode,
  projects: readonly ProjectMeta[],
  groups: readonly ProjectGroup[],
): RosterGroupTier[] | null;

/** Attaches FR-7-aware tiers to each band, for both the painter and the flatten. */
export function withGroupTiers(
  nodes: readonly RosterStateNode[],
  projects: readonly ProjectMeta[],
  groups: readonly ProjectGroup[],
): RosterStateNode[];   // each node gains `tiers: RosterGroupTier[] | null`

// ---- collapse record (FR-10/FR-11) ----
export const COLLAPSED_TIERS_KEY = 'francois.collapsedRosterGroupTiers';
export function parseCollapsedTiers(raw: string | null): Set<string>;
export function loadCollapsedTiers(): Set<string>;
export function persistCollapsedTiers(keys: ReadonlySet<string>): void;
```

Two **additive** amendments to `src/features/sessions/state-groups.ts`:

- `RosterStateNode` gains `tiers?: RosterGroupTier[] | null` (absent ⇒ no tier, paint flat).
- `flattenStateGroups(nodes, collapsedStates, collapsedTiers?)` gains a third optional parameter and
  walks `node.tiers` when present (FR-21). Existing two-argument callers and tests keep their meaning.

## 6. Data & state

- **Derived, per render**: the tier of each session, the tier list per band, the suppression verdict,
  the flattened painted order. Nothing is cached beyond `useMemo` on `(inScope, projects, groups)`.
- **Persisted (new, frontend-only)**: `localStorage['francois.collapsedRosterGroupTiers']` — a JSON
  array of collapsed slot strings. This is the feature's only new state anywhere.
- **Read-only inputs**: `useStore(s => s.projects)` and `useStore(s => s.groups)` (already in
  `Sidebar.tsx` for `project-groups` FR-11), plus the in-scope session list.
- **Core state**: none. No Rust file, no `projects.json` field, no session field.

## 7. Edge cases & errors

| # | Case | Behaviour |
|---|---|---|
| 1 | Session with no `projectId` | `elsewhere` tier (FR-1). |
| 2 | `projectId` set, project not yet resolved (`project_list` in flight) | `elsewhere` until it resolves; the tier repaints when it does. No flicker guard, no placeholder heading. |
| 3 | `groupId` names a group absent from the registry | `elsewhere` (FR-1) — never a heading with an empty label. |
| 4 | Two groups with the same name | Two adjacent headings, own slots (FR-4). |
| 5 | Every session in a band shares one group | No heading; rows flat (FR-7). |
| 6 | Every session in a band is ungrouped | No heading (FR-7, no exception). |
| 7 | Single-project title-bar scope | Every session shares one tier ⇒ suppressed everywhere; the roster is byte-identical to today. |
| 8 | `/` filter narrows a band to one group | The heading disappears while the filter holds and returns when it is cleared — suppression is derived, not sticky. |
| 9 | Malformed / non-array collapse JSON | Empty set — everything expanded (FR-11). Never throws. |
| 10 | `localStorage` unavailable or quota-full | Read yields an empty set, write is swallowed; the tier still works for the session, just does not persist. |
| 11 | Group deleted while a tier is collapsed | Its members fall to `elsewhere` on the next `project_list`; the stale slot is never read (FR-14). |
| 12 | Cursored session's tier is collapsed | The session leaves the flat order; `deriveRowCursor` falls back to index-then-active-then-0, unchanged (`8d63e13`). |
| 13 | Band collapsed | Its tiers are not painted and not walked; their slots are untouched (FR-12). |
| 14 | Band holds one group but many sessions | Suppressed — suppression counts distinct tiers, never sessions. |

No user-facing error state exists: every input degrades to `elsewhere` or to expanded, and there is no
fallible call in the feature.

## 8. Design brief

> full brief: `specs/design/roster-group-tier.md`

Pane [1] only. A group heading is a **thin row at the rows' own indent** — caret, group name, count —
in neutral roster-label tone: no accent, no status dot, no tint, no card surface, no `+`. It is
visually quieter than the state heading above it (which keeps its dot and its amber/accent label) and
heavier than a row's own text. Rows beneath do **not** indent (`project-groups` FR-24: three levels
max); the tier reads by weight and by the vertical space above the heading. Flat treatment applies —
no stroke, no shadow; separation is the heading's own spacing, not a rule. No motion on regroup.

`design_files: []` is deliberate and follows the existing precedent (`2026-08-13 · design`): a
collapsible heading row reusing `roster-state__head`'s established metrics inside existing pane chrome
does not warrant fresh Claude Design mockups.

## 9. Acceptance criteria

- [ ] With 2 groups open, each state band paints its group headings alphabetically with `elsewhere`
      last, and rows under them are unchanged (FR-1, FR-2, FR-3, FR-5, FR-15, FR-16).
- [ ] A band whose sessions all share one group — including all-ungrouped, and including any band
      under a single-project scope — paints no heading (FR-7, cases 5–7).
- [ ] Two groups sharing a name paint two headings that collapse independently (FR-4, FR-9).
- [ ] Collapsing `Perso` inside IDLE leaves `ODO`/IDLE and `Perso`/RUNNING expanded, leaves the IDLE
      band count unchanged, and survives a relaunch (FR-9, FR-10, FR-11, FR-17, FR-18).
- [ ] Collapsing a state band hides its tiers and changes no tier slot; expanding restores them
      exactly (FR-12).
- [ ] `j`/`k` steps card to card, never stopping on a heading and never entering a collapsed tier
      (FR-21, FR-22).
- [ ] A corrupt or absent `francois.collapsedRosterGroupTiers` yields an all-expanded roster with no
      thrown error (FR-11, case 9).
- [x] Unit tests cover `tierOf` resolution (all four miss paths), FR-3 ordering incl. the duplicate-name
      tiebreak, the suppression verdict, the flatten walk across collapsed bands and tiers, and the
      collapse-record parse/persist round-trip.
- [x] `npx tsc --noEmit` and `npm test` are green; `git diff --stat` touches no file under `src-tauri/`
      or `contract/`.

## Remediation

### 2026-08-20 — review round 1 (frontend, verdict SHIP)

- 2026-08-20 — 2 findings, all fixed (dense `.roster-group__head` indent parity with `.roster-row`; `role="button"` + `aria-expanded` on `GroupHeading`).

Deferred (out of scope, not re-dispatched): LOW · `src/features/sessions/StateRosterBody.tsx:161` · `StateHeading`'s clickable div also lacks `aria-expanded`/keyboard activation — predates this feature.
