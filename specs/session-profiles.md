---
id: session-profiles
title: Session profiles
status: shipped
branch: feat/session-profiles
created: 2026-08-17
depends_on: [session-engine, sessions-sidebar, projects, session-welcome, command-palette, durable-sessions, multi-account]
loop_pass: 0
loop_phase:
reviewed_base: 4d7cbbc00284e0fc80bca612a97394aa700dd64d
reviewed_digest: 876a2e9dfbc3ffb5
design_files: []
---

# Session profiles

## 1. Summary

Named, user-owned **session profiles** — a system prompt, model, effort, permission mode and raw
extra CLI args bundled under a name — so a role-carrying shell alias becomes a first-class thing
inside Francois. Today Francois builds its own `claude` argv (`src-tauri/src/session/turn.rs`) and
exposes only model, effort, permission mode, runtime and worktree: there is no way to give a session
a system prompt, and no way to pass a flag Francois does not itself model, so role-driven work falls
back to the terminal — outside the fleet, the transcript, the diff view and the agent panes. A
profile is a **reusable identity**: pick it once, get the same doctrine in every repo, visible on the
session, persisted across a reopen.

## 2. Goals & non-goals

- **Goals**
  - A `SessionProfile` entity in an app-owned registry: `name`, `systemPrompt`, `modelId`, `effort`,
    `permissionMode`, `extraArgs`.
  - `--system-prompt` (**REPLACE** semantics, deliberately) threaded through `turn_args` on **every**
    invocation including `--resume`, exactly as `permission_mode` already is.
  - **Snapshot-at-creation**: a session copies the resolved values into its own record. Editing a
    profile changes the *next* session started from it, never a running or persisted one.
  - Raw `extraArgs` passthrough, with a denylist refused **at save time with a named reason** — never
    a silent drop at spawn.
  - A Profiles modal (sibling to the Projects modal) to create / edit / delete; a profile picker in
    New Session that **pre-fills editable fields**; a project-level default profile *by id*.
  - Profile name surfaced on the session (sidebar card + welcome header).
- **Non-goals**
  - **Mid-session profile switching** — earlier turns ran under a different doctrine, and `--resume`
    would replay that history into a new system prompt, producing an incoherent thread.
  - Importing or parsing existing shell aliases. No alias reader, no migration tool.
  - `--append-system-prompt` mode. v1 replaces, full stop.
  - A profile *path* field (read a file at spawn). The prompt is inline text; the session record
    stays self-contained.
  - Any repo-relative or project-checkout profile source. A project points at an id; it can never
    define a profile.
  - A profile registry / sharing / marketplace.
  - Profiles carrying `cwd`, worktree options, runtime, or account.

**Known, accepted consequence (FR-23).** With the built-in prompt replaced there is no CLAUDE.md
framing and no tool-use doctrine, so the slash-menu, AskUserQuestion cards and permission cards may
degrade — they assume standard behaviour. Accepted deliberately; the replace-mode marker is the
mitigation (the user can always see *why* a session behaves differently).

## 3. User stories / flows

1. **Author a profile.** ⌘K → `Profiles…` (or the Projects-modal sibling entry) → Profiles modal →
   *New profile* → name `agent-architect`, paste the role prompt into the textarea, optionally set
   model / effort / permission mode, optionally paste the alias tail into *Extra args* → Save. A
   denied flag refuses the save inline, naming the flag and the reason; nothing is written.
2. **Start a session from a profile.** New Session → the profile picker → `agent-architect`. The
   dialog's existing model / effort / permission-mode controls **pre-fill** and stay editable. The
   user changes the model, then creates. The session runs with the profile's system prompt and the
   edited model; its card shows the `agent-architect` chip.
3. **Project default.** A project names a profile by id. Opening New Session under that project shows
   the **resolved** profile already selected and its values pre-filled *before* create — never a
   silent application (discovery is not authorization).
4. **Palette path.** ⌘K → `New session with profile…` → pick a profile → the New Session dialog opens
   with that profile selected.
5. **Reopen.** Quit and relaunch: the session resumes over `--resume` and still carries its
   snapshotted system prompt and extra args, plus the profile chip.
6. **Delete a profile.** Sessions created from it keep working and keep showing the snapshotted name.

## 4. Functional requirements

**Registry**

- **FR-1** Profiles persist as a single `profiles.json` in the **app data dir**, alongside
  `projects.json` / `accounts.json`, with the same read-merge-write discipline: Francois is its only
  writer, and a write failure must leave memory and disk agreeing (`INTERNAL`).
- **FR-2** Profiles are **app-scoped — shared across all accounts**. Nothing about a profile is
  per-account.
- **FR-3** `id` is a uuid v4 minted by the core. `name` is trimmed, 1–`MAX_PROFILE_NAME` chars, and
  **not unique** (matching `ProjectMeta.name`).
- **FR-4** `francois:profiles:list` returns every profile ordered by `name`, case-insensitive
  ascending, ties broken by `id` for stability. Present and `ok:true` (empty array) on a first run
  with no `profiles.json` at all.
- **FR-5** `:create` / `:update` / `:remove` each resolve with the new state; `:update` on an unknown
  id and `:remove` on an unknown id both return `PROFILE_NOT_FOUND`. `:update` replaces every
  mutable field it is given and refreshes `updatedAt`.
- **FR-6** Validation runs in the **core**, before anything is written: `name` bounds (FR-3),
  `systemPrompt` ≤ `MAX_SYSTEM_PROMPT`, `extraArgsRaw` ≤ `MAX_EXTRA_ARGS_RAW`. Any breach is
  `INVALID_INPUT` and writes nothing.

**Extra args**

- **FR-7** The editor takes `extraArgsRaw` — **one text field, pasted verbatim**. The core splits it
  at save time using POSIX-ish rules: whitespace separates tokens; single and double quotes group;
  a backslash escapes the next character. An unterminated quote is `INVALID_INPUT`.
- **FR-8** The stored profile carries **both** `extraArgsRaw` (what the user typed, so the editor can
  round-trip it) and `extraArgs` (the resolved tokens). The `:create` / `:update` response carries
  the resolved tokens so the editor can echo exactly what will be spawned.
- **FR-9** A token matching `DENIED_ARG_FLAGS` refuses the save with `PROFILE_ARG_DENIED` and
  `detail: { flag, reason }` — a **named** reason, never a silent drop at spawn. Matching is on the
  flag token and covers the `--flag=value` form and every listed spelling.
- **FR-10** A flag **not** on the denylist saves normally. The Profiles modal renders a non-blocking
  advisory beside any token Francois does not itself model; the advisory never prevents a save.
- **FR-11** `session_create` **re-runs the FR-9 denylist** on the `extraArgs` it receives and returns
  `PROFILE_ARG_DENIED` on a hit. The frontend is not trusted with the parser contract.

**Spawn**

- **FR-12** `turn_args` gains `system_prompt: Option<&str>` and `extra_args: &[String]`. A present
  system prompt appends `--system-prompt <text>`; `extra_args` are appended **last**, after every
  argument Francois builds.
- **FR-13** Both ride **every** invocation, including `--resume` — `--resume` carries neither.
- **FR-14** `turn_args` stays pure and unit-tested: coverage for prompt present/absent, extra args
  present/empty, and the resume path carrying both.

**Session snapshot**

- **FR-15** `SessionCreateInput` gains `systemPrompt?`, `extraArgs?` and `profileId?`. The frontend
  sends the **resolved** values (post-edit) plus the profile id; the core snapshots the profile's
  `name` from the registry itself. A `profileId` that does not resolve is `PROFILE_NOT_FOUND`.
- **FR-16** `SessionMeta.profile` is set **at creation only** — never re-derived, never changed
  afterwards, and never affected by a later edit or deletion of the profile.
- **FR-17** `profile.replacesSystemPrompt` is `true` iff the session was created with a non-empty
  `systemPrompt`. It exists so the UI can pick the replace-mode treatment **without reading the
  prompt text**.
- **FR-18** Selecting a profile and then editing a pre-filled field still snapshots the profile
  identity. There is no "modified" state: the chip records where the session came from, the resolved
  values are the truth.
- **FR-19** The durable-sessions persistence record gains `systemPrompt`, `extraArgs` and the profile
  ref. Absent on load ⇒ a pre-feature session with no profile. A resumed session spawns with its
  persisted values, not with the profile's current ones.

**Project defaults**

- **FR-20** `ProjectDefaults` gains `profileId?`. The contents always resolve from the registry at
  dialog-open time; a project can never define a profile.
- **FR-21** A project default profile is shown **resolved and pre-filled in the New Session dialog
  before create**, exactly like any other default. A `profileId` that no longer resolves is dropped
  silently and the dialog opens with no profile selected.

**Surfacing**

- **FR-22** The profile chip renders `SessionMeta.profile.name` and **never resolves against the
  registry** — a deleted profile's name still shows. The acid accent is used **only** in the focused
  session's welcome header; sidebar and fleet cards use a neutral chip carrying a replace-mode
  marker, so the one-acid-per-view rule holds.
- **FR-23** The Profiles modal states the replace-mode consequence (§2) where the prompt is authored.
- **FR-24** Palette commands: `Profiles…` (open the modal) and `New session with profile…` (pick a
  profile, then open New Session with it selected).

## 5. API contract

`contract/session-profiles.ts`. `ProfileId` and `SessionProfileRef` are added to `contract/common.ts`
(because `SessionMeta` references them) and re-exported here, per the `ProjectId` / `ProjectDefaults`
precedent. **No event channel** — every profile mutation is initiated by this frontend and resolves
with the new state, so a push channel would carry nothing the response does not (the `projects`
§5 preamble reasoning, verbatim).

### 5.1 Added to `contract/common.ts`

```ts
export type ProfileId = string; // uuid v4

/**
 * The profile identity a session snapshots at creation (FR-16). Absent ⇒ no profile.
 * Never re-resolved against the registry: a deleted profile's name still renders (FR-22).
 */
export interface SessionProfileRef {
  id: ProfileId;
  name: string; // snapshotted at creation
  /** true iff the session was created with a non-empty systemPrompt (FR-17). */
  replacesSystemPrompt: boolean;
}
```

`SessionMeta` gains:

```ts
  /** Present ⇔ created from a profile; snapshot-only (FR-16). */
  profile?: SessionProfileRef;
```

`ProjectDefaults` gains:

```ts
  /** A profile that no longer resolves is dropped in the modal (FR-21). */
  profileId?: ProfileId;
```

`ErrorCode` gains:

```ts
  | 'PROFILE_NOT_FOUND'  // session-profiles: a profileId that is not in the registry
  | 'PROFILE_ARG_DENIED' // session-profiles: extraArgs carried a denied flag (detail: { flag, reason })
```

### 5.2 `contract/session-profiles.ts`

```ts
import type { PermissionMode, ProfileId, Result, SessionProfileRef } from './common';

export type { ProfileId, SessionProfileRef };

// ---------- bounds (enforced in the core, FR-6) ----------

export const MAX_PROFILE_NAME = 60;
export const MAX_SYSTEM_PROMPT = 16384; // chars — a generous role doctrine that still leaves the
                                        // Windows 32767-char command line ample headroom (FR-12
                                        // puts the prompt in argv), incl. the WSL nesting case.
export const MAX_EXTRA_ARGS_RAW = 4096;

/**
 * FR-9. Refused at save time with a named reason. The first eight own the stream contract the
 * whole event pipeline parses; --permission-mode / --dangerously-skip-permissions are refused so
 * `permissionMode` stays the single source of truth; --append-system-prompt is a v1 non-goal that
 * would fight replace mode; --permission-prompt-tool owns the stdio control channel.
 */
export const DENIED_ARG_FLAGS: readonly string[] = [
  '--output-format',
  '--input-format',
  '-p',
  '--print',
  '--include-partial-messages',
  '--resume',
  '-c',
  '--continue',
  '--model',
  '--system-prompt',
  '--append-system-prompt',
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--permission-prompt-tool',
];

// ---------- the entity ----------

export interface SessionProfile {
  id: ProfileId;
  name: string; // trimmed, 1–MAX_PROFILE_NAME; NOT unique (FR-3)
  /** Inline text. Present and non-empty ⇒ REPLACE mode: it replaces Claude Code's own prompt. */
  systemPrompt?: string;
  modelId?: string;
  /** low | medium | high | xhigh | max */
  effort?: string;
  permissionMode?: PermissionMode;
  /** Verbatim as typed, for round-tripping the editor (FR-8). */
  extraArgsRaw?: string;
  /** Core-parsed tokens (FR-7); the argv actually appended. */
  extraArgs?: string[];
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

// ---------- francois:profiles:list ----------

// invoke('profiles_list'): Promise<Result<SessionProfile[]>>   // ordered per FR-4; errors: 'INTERNAL'

// ---------- francois:profiles:create ----------

export interface ProfileCreateInput {
  name: string;
  systemPrompt?: string;
  modelId?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  extraArgsRaw?: string;
}
// invoke('profiles_create', req: ProfileCreateInput): Promise<Result<SessionProfile>>
// errors: 'INVALID_INPUT' (bounds, unterminated quote) · 'PROFILE_ARG_DENIED' · 'INTERNAL'

// ---------- francois:profiles:update ----------

export interface ProfileUpdateInput extends ProfileCreateInput {
  id: ProfileId;
}
// invoke('profiles_update', req: ProfileUpdateInput): Promise<Result<SessionProfile>>
// errors: 'PROFILE_NOT_FOUND' · 'INVALID_INPUT' · 'PROFILE_ARG_DENIED' · 'INTERNAL'

// ---------- francois:profiles:remove ----------

export interface ProfileRemoveInput {
  id: ProfileId;
}
// invoke('profiles_remove', req: ProfileRemoveInput): Promise<Result<null>>
// errors: 'PROFILE_NOT_FOUND' · 'INTERNAL'
```

### 5.3 Amended — `contract/session-engine.ts`

`SessionCreateInput` gains:

```ts
  /** Resolved (post-edit) prompt text; present ⇒ --system-prompt on every turn (FR-12/FR-13). */
  systemPrompt?: string;
  /** Resolved argv tokens, appended last. Re-validated against DENIED_ARG_FLAGS (FR-11). */
  extraArgs?: string[];
  /** The profile the values came from; the core snapshots its name itself (FR-15). */
  profileId?: ProfileId;
```

`contract/projects.ts` is **rewritten in place** for the `ProjectDefaults` change (no second file for
the same domain) — though the field itself lands in `common.ts`, where `ProjectDefaults` is defined.

## 6. Data & state

- **Core** — `profiles.json` in the app data dir, mirrored in memory (the `project`/`account`
  registry pattern: a module directory with the model in `mod.rs`, `registry.rs` for persistence).
  Session state gains `system_prompt: Option<String>`, `extra_args: Vec<String>` and the profile ref,
  all persisted with the durable-sessions record and all read back on resume (FR-19).
- **Frontend** — a `profilesStore` (zustand, `src/lib/`) holding the list, loaded on mount and after
  each mutation. New Session holds the selected profile id plus its pre-filled-then-editable field
  values in local dialog state. The chip reads `SessionMeta.profile`; no store lookup (FR-22).
- **Derived** — `replacesSystemPrompt` is computed once at creation, not derived at render time.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| `profiles.json` missing / unreadable / corrupt | `:list` resolves `ok:true` with `[]`; a corrupt file is not overwritten until the next successful mutation |
| Write fails mid-mutation | `INTERNAL`; memory and disk are left agreeing (FR-1) |
| Denied flag on save | `PROFILE_ARG_DENIED`, `detail: { flag, reason }`, rendered inline in the editor; nothing written |
| Unterminated quote in `extraArgsRaw` | `INVALID_INPUT`; the editor points at the field |
| Unmodelled (but allowed) flag | Saves; non-blocking advisory beside the token (FR-10) |
| Denied flag reaches `session_create` | `PROFILE_ARG_DENIED`; no session is created (FR-11) |
| `profileId` in `session_create` does not resolve | `PROFILE_NOT_FOUND`; no session is created |
| Project default `profileId` no longer resolves | Dropped silently; the dialog opens with no profile selected (FR-21) |
| Profile deleted after sessions exist | Sessions keep working and keep the snapshotted chip name (FR-22) |
| Profile edited after sessions exist | Running and persisted sessions are untouched; the next session started from it gets the new values |
| Session persisted before this feature | No `profile`, no `systemPrompt`, no `extraArgs`; resumes exactly as today (FR-19) |
| `systemPrompt` present but whitespace-only | Treated as absent: no `--system-prompt`, `replacesSystemPrompt: false` |
| Extra args make `claude` fail to spawn | The existing `SPAWN_FAILED` path; the session shows `status: 'error'` with the message |

## 8. Design brief

Additions inside existing chrome: a **Profiles modal** built on the Projects-modal pattern
(list + editor: name, prompt textarea, model, effort, permission mode, one *Extra args* text field
with inline denial + advisory), a **profile picker** in New Session whose selection pre-fills the
existing controls, a **profile chip** on the sidebar/fleet card and in the session-welcome header,
and two palette entries. The acid accent appears **only** in the focused session's welcome header;
everywhere else the chip is neutral with a replace-mode marker (FR-22).

Per the 2026-08-13 · design decision, `design_files` stays empty — an addition inside existing modal
chrome does not warrant fresh Claude Design mockups.

> full brief: `specs/design/session-profiles.md`

## 9. Acceptance criteria

- [ ] A profile created in the Profiles modal survives an app restart and lists in `name` order (FR-1, FR-4)
- [x] Saving a profile whose extra args contain `--model` is refused inline, naming the flag and the reason (FR-9)
- [x] Saving a profile whose extra args contain `--add-dir /tmp` succeeds, with an advisory beside the token (FR-10)
- [x] `extraArgsRaw` `--add-dir "/a b" --foo` round-trips into the editor and resolves to 3 tokens (FR-7, FR-8)
- [x] A session created from a replace-mode profile spawns `claude … --system-prompt <text> <extraArgs>`, with the extra args last (FR-12)
- [x] The same holds on a `--resume` turn after a quit and relaunch (FR-13, FR-19)
- [x] `turn_args` unit tests cover prompt present/absent, extra args present/empty, and the resume path (FR-14)
- [ ] Selecting a profile then editing the model creates a session with the edited model AND the profile chip (FR-18)
- [x] `session_create` with a denied flag in `extraArgs` returns `PROFILE_ARG_DENIED` and creates nothing (FR-11)
- [ ] A project default profile is visible and pre-filled in New Session before create (FR-21)
- [ ] Deleting a profile leaves its sessions running and still showing its name (FR-22)
- [ ] The acid chip appears in the focused welcome header only; sidebar cards are neutral (FR-22)
- [ ] Profiles are identical under two different accounts (FR-2)
- [x] A session persisted before this feature resumes unchanged (FR-19)
- [x] `Profiles…` and `New session with profile…` are reachable from ⌘K (FR-24)

> Left open — no pipeline stage runs the app, so these need a manual pass with Francois up:
> FR-1 (survives restart, `name` order), FR-18 (profile + edited model), FR-21 (default visible
> and pre-filled), FR-22 delete-safety, FR-22 acid-chip placement, FR-2 (identical under two
> accounts). Tick them only after exercising each by hand.

## Remediation

### 2026-08-17 — round 1 (REVISE: 1 CRITICAL, 2 MEDIUM, 4 LOW)

- 2026-08-17 — 7 findings, all fixed (core: `resolve_profile_ref` + `check_system_prompt_bound` extracted from `session_create` with command-level tests for `PROFILE_ARG_DENIED`/`PROFILE_NOT_FOUND`; frontend: `projectDefaultProfileResolution` stops a project default from clobbering a pending palette pick, `ProfilesModal` imports `new-session-modal.css` directly, `ProfileChip` uses `RotateCcw` + size-scoped dot token, `INVALID_INPUT` on extra args anchors beside the field)

### 2026-08-17 — round 2 (SHIP: 1 MEDIUM, 3 LOW)

- 2026-08-17 — 1 finding, all fixed (frontend: `Profiles…` button in the PROJECTS modal header — `pj-header-right`/`pj-profiles-link` in `projects.css` — wired to `setProfilesOpen(true)`, giving spec §3 story 1 its second route)

The 3 LOW findings from this report were parked to `specs/refactor-backlog.md` under `deferred:session-profiles` per §3.5 (reviewer-declared, non-blocking) — not tracked here.
