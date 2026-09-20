---
id: pi-migration-rollout
title: Pi profiles, migration and release acceptance
status: frozen
branch: feat/pi-migration-rollout
created: 2026-09-18
depends_on: [pi-session-durability, pi-provider-auth, pi-models-metrics, pi-turn-controls, pi-skills-capabilities]
reviewed_base:
reviewed_digest:
design_files: []
---

# Pi profiles, migration and release acceptance

## 1. Summary

Add a runtime-specific Pi profile schema and enable the complete Pi mission-control loop
only after migration/recovery/platform checks pass. The user validated additive first-release
migration on 2026-09-18: preserve existing runtimes and sessions. Pi-only replacement is
outside this release. See [programme](_roadmap-pi-integration.md).

## 2. Goals & non-goals

- Goals: preserve user data, prevent Claude argv leakage, define default precedence,
  validate the whole product loop, and publish accurate setup/feature limitations.
- Non-goals: converting old conversations into Pi context, moving account secrets,
  deleting old adapters/accounts, rebuilding deferred runtime features, or shipping a
  partial Pi option as generally ready before dependencies pass.

## 3. User stories / flows

After upgrade, existing fleet/history/accounts/projects/profiles remain usable. Add a Pi
account and select it explicitly in a project/New Session. Create a Pi profile with a
prompt/tool/skill configuration; use it without carrying Claude command-line flags.
Run → inspect transcript/diff → use shell → steer/follow up → stop → restart → resume.

## 4. Functional requirements

- FR-1: Preserve existing runtime identities, account pins, native thread references,
  project/worktree ownership, display transcripts, UI layout and preferences. No old
  session becomes Pi because a project default changes. No lossless history import claim.
- FR-2: Introduce a profile discriminator. Existing profiles with absent discriminator
  load as `legacy` and retain their existing fields/behaviour. Pi profiles contain no
  raw argv, plaintext environment secrets, account, model, effort or permission mode.
- FR-3: Retain single ownership: project defaults own account/model/effort/response mode;
  explicit New Session overrides win; profile owns prompt/tool/skill/resource configuration.
  The fully resolved creation snapshot is stored on the session. Editing defaults or
  profiles never retroactively changes a session's immutable configuration.
- FR-4: Offer explicit “Create Pi copy” of a legacy profile. Copy name and user-authored
  system prompt only; show omitted Claude extraArgs; require reviewing typed Pi settings.
  Keep original profile. Do not translate flags such as --mcp-config or --allowedTools.
- FR-5: Pi profile system prompt mode is default/append/replace. Files/instructions/skills
  are explicit absolute paths resolved by core; Pi owns AGENTS.md/SYSTEM.md loading.
  Implement append/replace using documented Pi launch arguments through safe argv/file
  handling, never embed prompts into shell text. Tool list is an allowlist of certified
  built-ins; it restricts available tools, not filesystem/network rights.
- FR-6: Registry format migration is versioned, idempotent, atomic and backed up before
  the first write. Failed migration leaves the original readable and Pi creation disabled.
  A future unknown schema is not rewritten with dropped fields. This is JSON, not a DB migration.
- FR-7: Removing a Pi account/profile updates project defaults explicitly and reports
  affected sessions. Missing Pi accounts block resume rather than credential fallback.
  Original credentials stay in their original tooling; no automatic auth migration.
- FR-8: Production availability requires all ten task acceptance checks and supported
  OS/environment certification. The capability table cannot advertise unimplemented functions.
- FR-9: Update README/PROJECT setup and feature wording: model-agnostic mission control
  with Pi support; external certified Pi install and its Node requirement; explicit legacy
  continuity, lack of native Pi approval enforcement and deferred capability list.
- FR-10: Rollback is read-only access plus validated recovery from backups, not automatic
  downgrade of native Pi files. Existing legacy application data remains independently usable.

## 5. API contract

Amend `contract/session-profiles.ts` in place; shared `ProfileId`/refs remain in common.ts.
Convert existing `SessionProfile` into the discriminated union below without duplicating
the existing registry API. Legacy fields and validation bounds remain unchanged.

```ts
interface PiProfileSettings {
  systemPromptMode: 'default' | 'append' | 'replace';
  systemPrompt?: string; // <= existing MAX_SYSTEM_PROMPT; required for append/replace
  instructionPaths: string[]; // max 20 existing absolute text file paths
  skillPaths: string[]; // max 50 absolute paths; validate before spawn
  tools: ('read' | 'write' | 'edit' | 'bash' | 'grep' | 'find' | 'ls')[];
  projectResources: 'ignore' | 'allow';
}
interface PiSessionProfile {
  id: ProfileId;
  name: string;
  kind: 'pi';
  settings: PiProfileSettings;
  createdAt: number;
  updatedAt: number;
}
// LegacySessionProfile is the existing SessionProfile plus kind:'legacy'.
type SessionProfile = LegacySessionProfile | PiSessionProfile;
type ProfileCreateInput =
  | { kind?: 'legacy'; name: string; systemPrompt?: string; extraArgsRaw?: string }
  | { kind: 'pi'; name: string; settings: PiProfileSettings };
type ProfileUpdateInput = ProfileCreateInput & { id: ProfileId };
interface ProfileCopyToPiInput { id: ProfileId; name: string; settings: PiProfileSettings }
```

Existing profiles_list/create/update/remove commands keep their result semantics with
the union. New `francois:profiles:copyToPi` → `profiles_copy_to_pi(req)` →
`Result<PiSessionProfile>`. Errors PROFILE_NOT_FOUND, INVALID_INPUT, PROFILE_ARG_DENIED,
PROFILE_RUNTIME_MISMATCH, INTERNAL. No events, matching current registry conventions.

Amend SessionCreateInput with optional `piProfile: PiProfileSettings`; require matched Pi
account/profile kind, reject legacy extraArgs for Pi and Pi settings for other runtimes.
Core resolves/validates actual profile ID and stores its own name/settings snapshot, never
trusting the caller's claim about the saved profile. Explicit edited settings are permitted
as creation overrides after the same validation. SessionProfileRef keeps ID/name identity.

Instruction paths are read once into the core-owned launch prompt snapshot; tool names
are validated against the certified Pi builtin set. Missing/unsupported tool rejects rather
than broadening to defaults. Secret-bearing environment configuration is excluded; Pi
account tooling owns it. Runtime-specific options beyond these fields are intentionally absent.

## 6. Data & state

Keep `profiles.json`, `projects.json`, `accounts.json`, `sessions.json` under app_data.
Profile registry gains a format version and per-entry kind. Preserve existing atomic write
helpers and typed session snapshots. Before modifying a registry, create a versioned backup
once; record completion only after all necessary per-file migrations validate. Resume an
interrupted migration idempotently; never discard an original because another file succeeded.

Expected files: `profiles/{mod,registry,parse,commands}.rs`, `project/`, `account/registry.rs`,
`session/persistence.rs`, profile and session forms/stores, capability readiness configuration,
README/PROJECT, platform certification fixtures and integration-test harness.

## 7. Edge cases & errors

Unknown profile discriminator: preserve/read-only, no reinterpretation. Legacy profile
selected with Pi: PROFILE_RUNTIME_MISMATCH plus Create Pi copy action. Missing file path
at submit: INVALID_INPUT, retain editor contents. Backup/disk failure: no partial destructive
rewrite. Tool list empty explicitly means no built-in tools, not default tools.

## 8. Design brief

Profile editor gets a runtime-kind choice and typed Pi settings. Existing sessions retain
their labels and controls; Pi limitations are stated at setup and the relevant action.
> full brief: specs/design/pi-migration-rollout.md

## 9. Acceptance criteria

- [ ] Old pre-runtime and current multi-runtime records migrate without changed identities.
- [ ] Re-running migration is a no-op; failure injection between every file write is recoverable.
- [ ] Legacy profile copy preserves original, drops/reports argv, validates Pi settings.
- [ ] Project→New Session precedence has one resolved value per field; snapshots survive edits.
- [ ] Core unit tests cover event mapping, capabilities, model descriptors, errors and migration.
- [ ] Protocol fixtures cover text/tools/failure/cancel/steering/compaction/model change,
  malformed/unknown events, crash, and partial UTF-8; each carries artifact provenance.
- [ ] Fake-process integration verifies create/send/stream/tool/resume/cancel/model/shutdown/crash.
- [ ] Real certified Pi smoke covers two cloud providers with opt-in test credentials and
  one configured local model, plus Windows/macOS/Linux and WSL only if advertised.
- [ ] Frontend tests cover transcript reducers, capabilities, picker/auth/error/unknown metrics,
  disabled legacy-only actions, pending queues and migration states; manual keyboard review passes.
- [ ] End-to-end loop includes git diff/worktree and independent shell before and after crash.
- [ ] No provider secret fixture appears in logs/IPC/registry data; no unapproved extension runs.
- [ ] `npm test`, `npx tsc --noEmit`, `npm run build`, cargo test and normal quality gates pass.
- [ ] Documentation matches certified versions, supported environments and actual enforcement.

## Remediation

### 2026-09-20 — round 1 (PR #142 review, §6)

- 7 findings (1 MEDIUM / 6 LOW), all fixed: a skill run matches the listed entry's exact `invocation`
  (contract `SkillsRunRequest.invocation`), never the derived name; preserved registry entries count as
  known ids; a relative skill path is refused at spawn; built-ins beat a runtime command of the same name;
  the `profiles<->project` cycle is inverted through `ProfileRemovalObserver`.
- **FR-6/FR-10 read-only, as implemented.** On `FutureSchema`/`Failed` the registry is READABLE and every
  mutating command is refused (`INTERNAL`); nothing on disk is rewritten; Pi creation stays disabled through
  readiness. Consequence, accepted: a legacy (Claude) session can be created from a profile in a
  future-schema file — read-only access, writes nothing.
- **Profile delete fails closed.** `sessions_referencing` is a typed read; an unreadable or reshaped
  `sessions.json` refuses the delete. Accepted cost: one malformed session record blocks every profile
  delete until the file is fixed. Residual: a rename of the record's outer `profile` KEY would still read as
  "no profile" — close it with a reader injected from `session` if that key ever moves.
