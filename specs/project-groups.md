---
id: project-groups
title: Project groups
status: shipped
branch: feat/project-groups
created: 2026-08-17
depends_on: [projects, sessions-sidebar, session-engine, app-shell]
loop_pass: 0
loop_phase:
reviewed_base: 206f50dcdab809934a0667a3c8425d07b60b80cb
reviewed_digest: 5dad23b6fda119cb
design_files: []
---

# Project groups

## 1. Summary

A Francois project is a **checkout**; the unit the user works at is the **product**. ODO is one product
across several repos (`ODO - Frontend`, `ODO - Databases`) that today are unrelated rows in a flat
registry and unrelated top-level headings in the pane [1] roster. This feature adds a **group** — a
named parent over projects — persisted in the projects registry, managed in the Projects modal, and
rendered as a second tier in the roster tree (`ODO` → `ODO - Frontend` → session cards). A group is
*only* an organising tier: it carries no session defaults, no standards, and is not a scope.

## 2. Goals & non-goals

**Goals**
- A `ProjectGroup` entity persisted alongside projects; a project belongs to at most one group.
- Group create / rename / delete + membership assignment, in the Projects modal.
- A group tier in the roster tree, with collapse at both levels, over a **mixed-depth** list.

**Non-goals** (each decided, not overlooked)
- **Group scoping in the title-bar switcher.** The switcher stays `All projects | <project>`; a group
  is not a scope. Widening `activeProjectId` to `all | group | project` would touch
  `filterSessionsByProject`, the OVERVIEW auto-switch, `newInGroup` and `useRowCursorClamp` — more than
  the tree itself. The affordance gap is real and accepted: clicking `ODO` collapses, it does not scope.
- **`+` on a group heading** — no non-arbitrary member repo to pick. Project rows keep their own `+`.
- **Group-level session defaults** (model / effort / permission mode / runtime / account / profile). A
  group carries none — the project already owns those (`2026-08-17 · ui`, two registries, one owner).
- **Group-level standards** fanned into member repos' `CLAUDE.md`. A candidate follow-up feature; this
  spec does not reopen it.
- **Multi-repo sessions** (`claude --add-dir`, N-repo DIFF). A redesign of the session↔filesystem
  relationship, not a registry field.
- Groups do not appear in the roster when no member project has a session; no OVERVIEW rollup by group;
  no new IPC domain and no event channel.
- Groups **never nest**.

## 3. User stories / flows

1. **Create + assign.** ⌘K → Projects… → the left column's `+ New group` → inline name field → Enter
   creates `ODO`. Selecting `ODO - Frontend` on the left shows a **Group** selector in its Identity
   section; picking `ODO` commits immediately (no Save). Same for `ODO - Databases`.
2. **Read the roster.** Pane [1] now paints `▾ ODO  7` with `▾ ODO - Frontend  4` and
   `▾ ODO - Databases  3` indented under it, session cards indented under those. An unregistered repo's
   sessions still key on their cwd leaf and stay top-level, as a sibling of `ODO`.
3. **Collapse.** Clicking `ODO` collapses the whole subtree — project rows and their cards — and it
   persists across relaunch. Clicking `ODO - Frontend` collapses only that repo's cards. The keyboard
   cursor (`j`/`k`) walks only visible cards, in painted order.
4. **Unassign / delete.** Setting a project's group to `— none —` pops it back to top-level in the
   roster. Deleting `ODO` (typed confirm, as for a project) clears `groupId` on every member; their
   sessions are untouched and their rows reappear at top level mid-session.

## 4. Functional requirements

**Entity & persistence (core)**
- **FR-1** A `ProjectGroup` is `{ id, name, createdAt }`. `id` is uuid-v4, minted by the core.
- **FR-2** Groups persist in the **existing** `projects.json` in the app data dir, as a sibling
  `groups` array of the `projects` array, written by the same atomic whole-document write.
- **FR-3** A document with **no** `groups` key loads as an empty group list and is not an error; a
  single undeserializable group entry is skipped, not fatal — mirroring FR-3 of `projects`. `version`
  stays `1`.
- **FR-4** `name` is trimmed, 1–`MAX_GROUP_NAME_LENGTH` (80) chars, and is **not unique** — mirroring
  projects FR-6. Groups are keyed by id everywhere.
- **FR-5** `project_list` returns groups ordered by `createdAt` asc, then `name` asc (case-insensitive,
  plain lowercase comparison — matching the projects tie-break byte-for-byte).
- **FR-6** `ProjectMeta`/`Project` gains `groupId?: GroupId`. Absent ⇒ ungrouped. A project belongs to
  at most one group; the field is a scalar, never an array.
- **FR-7** `project_assign_group` sets or clears `groupId`. A `groupId` naming an unknown group is
  rejected with `GROUP_NOT_FOUND` — the core re-validates at this entry point and does not trust the
  frontend's list (`2026-08-17 · security`).
- **FR-8** `project_remove_group` deletes the group, then clears `groupId` on every member project
  **best-effort, after the delete commits** (`2026-08-17 · data` applies verbatim). A sweep failure is
  logged and never fails the call.
- **FR-9** Removing a group changes **no** session state: no `session.meta` is emitted, no session is
  relinked or stopped. (Contrast `project_remove`, which does relink sessions.)
- **FR-10** Every group mutation persists the whole registry atomically and rolls the in-memory state
  back on a persist failure, so memory and disk always agree.

**Roster tree (frontend, pure)**
- **FR-11** `src/features/sessions/roster-groups.ts` builds a **two-tier, mixed-depth** node list from
  sessions + projects + groups. Top level holds group nodes and ungrouped project/path nodes as
  siblings; a group node holds only project nodes.
- **FR-12** A group node appears only when at least one of its member projects has a visible session.
  Groups are never enumerated from the registry into the roster.
- **FR-13** Ordering inherits today's rule: a node appears where its **first** session does. A grouped
  project's first session promotes its **group** to that position; within a group, project nodes are
  likewise ordered by their first session. Sessions keep their incoming order.
- **FR-14** A group node's count is the sum of its member project nodes' session counts.
- **FR-15** Collapse gains a second key space, `group:<groupId>`, alongside the existing
  `project:<projectId>` / `path:<leaf>` keys in the same persisted record
  (`francois.collapsedRosterGroups`). The record is a flat string set, so an existing stored record
  loads **unchanged — no migration and no state loss**.
- **FR-16** Collapsing a group hides its project rows *and* their session cards. A project's own
  collapsed state is remembered independently and restored when its group re-expands.
- **FR-17** The flatten used by the keyboard cursor walks the painted order and skips a collapsed
  group's **entire subtree**; group and project headings are **not** cursor targets (unchanged from
  today — headings toggle by click only). The cursor therefore indexes a flat session list whose
  members sit at varying depths, and nothing about depth may enter that index.
- **FR-18** Every function above is pure and unit-tested, with explicit cases for: a group whose
  members are interleaved with ungrouped projects, a project whose `groupId` names a group not yet
  resolved (registry in flight — the project stays top-level rather than joining an anonymous group),
  and a group all of whose members are collapsed.

**Projects modal (frontend)**
- **FR-19** The left column gains a **groups** block under the project list: each group as a row with
  inline rename, plus `+ New group`. Group rows are not selectable into the right-hand config pane —
  a group has no config.
- **FR-20** Each group row carries a remove control using the same typed-confirm pattern as
  `RemoveControl` for projects, worded to state that member projects are kept and only ungrouped.
- **FR-21** The right-hand **Identity** section gains a **Group** `<select>` listing `— none —` plus
  every group, committing on change (no Save button — FR-35 of `projects`). It stays enabled when the
  root is missing, like the rest of Identity (projects FR-38).
- **FR-22** Every group mutation re-reads `project_list` and repaints from the response, never from
  the request (projects FR-32). Errors render inline in the groups block.

**Roster rendering**
- **FR-23** A group heading is a *thin* row: caret, uppercase label, session count. No card surface, no
  status dot, **no acid** — a repeatable roster row renders neutral (`2026-08-17 · ui`).
- **FR-24** Project headings inside a group are indented one step (~10px); their session cards indent
  one further. Group heading + project heading + card is the depth ceiling — the roster is 238px wide
  in split mode and nothing may add a fourth level.
- **FR-25** No `+` on a group heading. Project headings keep theirs, unchanged.

## 5. API contract

Extends the **existing `project` domain**. Per `2026-08-04 · api`, this **rewrites `contract/projects.ts`
in place** — there is **no** `contract/project-groups.ts`. No new domain, no event channel.

```ts
// ---------- new entity ----------
export type GroupId = string; // uuid-v4

export interface ProjectGroup {
  id: GroupId;
  /** Trimmed, 1–MAX_GROUP_NAME_LENGTH. NOT unique (FR-4). */
  name: string;
  createdAt: number; // epoch ms
}

export const MAX_GROUP_NAME_LENGTH = 80;

// ---------- ProjectMeta gains one field ----------
export interface ProjectMeta {
  // … existing fields unchanged …
  /** FR-6: the group this project belongs to; absent ⇒ ungrouped. */
  groupId?: GroupId;
}

// ---------- francois:project:list — CHANGED RESPONSE SHAPE ----------
export interface ProjectRegistrySnapshot {
  /** Ordered by lastUsedAt desc, then name asc (projects FR-5) — unchanged. */
  projects: ProjectMeta[];
  /** Ordered by createdAt asc, then name asc (FR-5). */
  groups: ProjectGroup[];
}
/** WAS `ProjectMeta[]`. Every caller of project_list must be updated. */
export type ProjectListData = ProjectRegistrySnapshot;
export type ProjectListResponse = Result<ProjectListData>;
// A missing/empty/corrupt projects.json yields { projects: [], groups: [] } and is
// NOT an error (projects FR-3 / FR-3 here). ok:false codes: 'INTERNAL'.

// ---------- francois:project:createGroup → project_create_group ----------
export interface ProjectCreateGroupRequest {
  /** Trimmed, 1–MAX_GROUP_NAME_LENGTH. */
  name: string;
}
/** ok:false codes: 'INVALID_INPUT' | 'INTERNAL' */
export type ProjectCreateGroupResponse = Result<ProjectGroup>;

// ---------- francois:project:renameGroup → project_rename_group ----------
export interface ProjectRenameGroupRequest {
  groupId: GroupId;
  name: string;
}
/** ok:false codes: 'GROUP_NOT_FOUND' | 'INVALID_INPUT' | 'INTERNAL' */
export type ProjectRenameGroupResponse = Result<ProjectGroup>;

// ---------- francois:project:removeGroup → project_remove_group ----------
export interface ProjectRemoveGroupRequest {
  groupId: GroupId;
}
/**
 * Deletes the group, then clears groupId on every member — best-effort, AFTER the
 * delete commits (FR-8). Emits nothing; touches no session (FR-9).
 * ok:false codes: 'GROUP_NOT_FOUND' | 'INTERNAL'
 */
export type ProjectRemoveGroupResponse = Result<null>;

// ---------- francois:project:assignGroup → project_assign_group ----------
export interface ProjectAssignGroupRequest {
  projectId: ProjectId;
  /** null CLEARS the membership (must be explicit null, not an omitted key). */
  groupId: GroupId | null;
}
/** ok:false codes: 'PROJECT_NOT_FOUND' | 'GROUP_NOT_FOUND' | 'INTERNAL' */
export type ProjectAssignGroupResponse = Result<ProjectMeta>;
```

**`ErrorCode`** (`contract/common.ts`) gains **`GROUP_NOT_FOUND`**.

**Roster types** (owned by `src/features/sessions/roster-groups.ts`, not the contract):

```ts
/** The existing RosterGroup, renamed for the tier it now occupies. */
export interface RosterProjectNode {
  key: string;              // `project:<id>` | `path:<leaf>` — unchanged key space
  label: string;
  projectId: string | null;
  sessions: SessionMeta[];
}
export interface RosterGroupNode {
  key: string;              // `group:<groupId>`
  label: string;
  groupId: string;
  projects: RosterProjectNode[];
  /** FR-14: sum over `projects`. */
  sessionCount: number;
}
export type RosterNode = RosterGroupNode | RosterProjectNode;
export function isGroupNode(n: RosterNode): n is RosterGroupNode;

/** Replaces groupSessionsByRepo as the entry point (which stays as its repo-tier pass). */
export function buildRoster(
  sessions: readonly SessionMeta[],
  projects: readonly ProjectMeta[],
  groups: readonly ProjectGroup[],
): RosterNode[];

/** FR-17: painted order, skipping a collapsed group's whole subtree. */
export function flattenGroups(nodes: readonly RosterNode[], collapsed?: ReadonlySet<string>): SessionMeta[];
```

## 6. Data & state

- **Core**: `ProjectRegistry` state gains `groups: Mutex<Vec<ProjectGroup>>` (or a widened document
  struct); `parse_registry` reads the `groups` key defensively and `save_to` writes
  `{ version: 1, projects, groups }`. `Project` gains `#[serde(default, skip_serializing_if = "Option::is_none")] group_id: Option<String>`
  — absent must serialize as an **omitted key**, never `null`.
- **Frontend**: `projectsStore` gains `groups: ProjectGroup[]` + `setGroups`, fed by the same
  `project_list` call that already feeds `projects`. No new fetch site.
- **Derived**: the roster node list (`useMemo` over sessions + projects + groups). Nothing about
  groups is persisted in the frontend except the collapse record (FR-15).

## 7. Edge cases & errors

| # | Case | Behaviour |
|---|---|---|
| 1 | `projects.json` predates groups (no `groups` key) | Loads with `groups: []`; unaffected projects. No migration write. |
| 2 | A group entry fails to deserialize | Skipped; the rest load. Members referencing it fall through to #3. |
| 3 | A project's `groupId` names a group not in the list | The project renders **top-level** (FR-18). No error, no auto-clear — the delete sweep owns clearing. |
| 4 | `project_list` still in flight | Groups are `[]`, so every project renders top-level; the tree re-forms when it lands. Group collapse keys survive, since the record is opaque. |
| 5 | Rename to empty/whitespace/over-80 | `INVALID_INPUT`, inline in the groups block; the row reverts to the persisted name. |
| 6 | Assign to a group deleted in another window | `GROUP_NOT_FOUND`; the modal re-reads `project_list` and the selector repaints. |
| 7 | Delete a group with live sessions under its members | Succeeds. Projects pop back to top-level mid-session; no session state changes (FR-9). |
| 8 | Sweep fails after a successful delete | Delete stands, logged. The dangling `groupId` renders as #3 and is cleared on the next assign. |
| 9 | Persist failure on any mutation | The in-memory change is rolled back and the call returns `INTERNAL` (FR-10). |
| 10 | Every member project of a visible group is filtered out (`/` filter, project scope) | The group node is not emitted (FR-12) — no empty heading. |
| 11 | Collapse record holds a `group:<id>` for a deleted group | Ignored; a stale key is harmless and is never pruned. |

## 8. Design brief

Two touched surfaces, both inside existing chrome:

- **Pane [1] roster** — a new thin group heading above project headings: caret (`▾`/`▸`), uppercase
  label at the roster's smallest type role, session count, **no** card surface, **no** status dot, **no**
  acid, **no** `+`. Project headings and their cards each indent one step under it (~10px); three levels
  is the ceiling at 238px in split.
- **Projects modal** — a groups block below the left-column project list (rows with inline rename +
  typed-confirm remove, and `+ New group`, styled after `NewProjectControl`), and a **Group** `<select>`
  added to the right-hand Identity section.

> full brief: `specs/design/project-groups.md`

`design_files: []` stays empty — an addition inside existing modal and roster chrome does not warrant
fresh Claude Design mockups, matching `attach-to-worktree` / `collapse-right-column` / `multiple-shells`
(`2026-08-13 · design`).

## 9. Acceptance criteria

- [x] A `projects.json` written before this feature loads with no error, no rewrite, and every project
      ungrouped (FR-2, FR-3).
- [ ] Creating, renaming and deleting a group from the Projects modal round-trips through disk and
      survives a relaunch (FR-1, FR-4, FR-19, FR-20).
- [ ] Assigning a project to a group, then to `— none —`, is reflected in the roster on the next
      `project_list` without a relaunch (FR-7, FR-21, FR-22).
- [x] Two projects in one group render under a single group heading whose count is their sum, with an
      unregistered repo's sessions as a top-level sibling (FR-11, FR-12, FR-13, FR-14).
- [ ] Collapsing a group hides both member project rows and all their cards; re-expanding restores each
      project's own collapsed state; both survive a relaunch (FR-15, FR-16).
- [x] `j`/`k` walks only visible cards in painted order across a mixed-depth tree, and skips a collapsed
      group's whole subtree (FR-17).
- [x] Deleting a group with running sessions ungroups its projects and leaves every session's status,
      transcript and pane assignment untouched (FR-8, FR-9).
- [x] `project_assign_group` with an unknown `groupId` returns `GROUP_NOT_FOUND` even when the frontend
      believed the group existed (FR-7).
- [x] `npm test` covers `buildRoster` / `flattenGroups` for every case in FR-18; `cargo test` covers the
      groups round-trip, the no-`groups`-key read, the delete sweep, and the rollback on persist failure.
- [x] The title-bar switcher is unchanged — still `All projects | <project>`, with no group entry.

## Remediation

- 2026-08-17 — review round 1: 4 findings (1 CRITICAL, 1 HIGH, 1 MEDIUM, 1 LOW), all fixed
  — core: the two `ProjectRegistry` mutexes merged into one `Mutex<RegistryDocument>` (single lock
  per mutation, `persist_registry`/`persist_groups` replaced by a lock-free
  `persist(app, projects, groups)`), plus `commit_with_rolls_back_groups_on_a_persist_failure`
  covering the groups rollback; frontend: `ProjectGroupsState` dropped in favour of the contract's
  `ProjectsState`, and the inline `style` on the Group `<select>` replaced by `.pj-input--unset`.

