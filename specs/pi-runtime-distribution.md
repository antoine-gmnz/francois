---
id: pi-runtime-distribution
title: Pi installation and version compatibility
status: shipped
branch: feat/pi-runtime-distribution
created: 2026-09-18
depends_on: [pi-runtime-boundary]
reviewed_base:
reviewed_digest:
design_files: []
---

# Pi installation and version compatibility

## 1. Summary

Detect an external Pi installation, report actionable incompatibility, and certify the
specific release artifacts used by the adapter. Source: [Pi audit](research/pi-integration-audit.md).

## 2. Goals & non-goals

- Goals: reliable GUI/PATH discovery, exact compatibility policy, cross-platform setup,
  and no silent version drift during a session.
- Non-goals: downloading Pi from François, bundling Node, npm postinstall changes,
  automatic Pi updates, or executing project-local launchers.

## 3. User stories / flows

Open Accounts → Pi setup. With no installation, see installation instructions and Retry.
With a supported installation, see version and resolved path. With an unsupported one,
see detected versus certified versions and how to install the certified version.
Keyboard users reach Retry and Copy installation command using Tab/Enter.

## 4. Functional requirements

- FR-1: Use `process_util` login-shell PATH resolution; reject relative/empty PATH entries
  and cwd-local executable discovery. Reuse native/WSL path handling, with explicit distro.
- FR-2: Probe version with a 5-second deadline and 64 KiB output limit. Never run a shell
  interpolation of a user path. Windows npm `.cmd` shims need an argv-safe resolution to
  their Node entrypoint or a tested existing launcher helper; do not concatenate commands.
- FR-3: Choose external Pi for MVP. The install instruction comes from a certified
  manifest package/version, not `latest`. Upstream source currently names
  `@earendil-works/pi-coding-agent`, version 0.85.1, Node >=22.19.0 and MIT.
- FR-4: Compatibility is an explicit allowlist of exact package versions/artifact identities
  plus required RPC operations. No inferred semver-wide support. Source-main audit alone
  cannot add an entry to the allowlist. A same-version locally modified artifact must pass
  the protocol probe; report provenance as unverified rather than certified if identity differs.
- FR-5: Certify `get_state`, `get_available_models`, `get_commands`, `get_entries`,
  `get_session_stats`, `prompt`, `steer`, `follow_up`, `clear_queue`, `abort`, `compact`,
  `set_model`, `get_available_thinking_levels`, and `agent_settled` against a pinned artifact.
  If 0.85.1 lacks an audited main feature, choose a released artifact that contains it and
  record that version; do not silently emulate unsupported semantics.
  **Scope for this feature**: the audit that produced `fixtures/manifest.json` ran no real Pi
  process (`specs/research/pi-integration-audit.md`: "no real Pi runtime … was executed"), so
  there is no captured RPC transcript to probe against yet — `artifactDigest` is `null` and
  `tested` is empty in the checked-in manifest. This feature therefore certifies **version
  string only**: an exact `packageVersion` match reports `state: 'ready'`,
  `provenance: 'unverified'`; there is no code path to `provenance: 'certified'` today, because
  that requires actually running the RPC surface above against a live process and capturing
  its wire behavior. Wiring that live RPC-protocol probe (spawning Pi, driving `get_state`,
  `prompt`, … over its real transport, diffing the response shapes against a captured fixture)
  is follow-up work once a real Pi installation is available to audit against — tracked as
  `deferred:pi-runtime-distribution` in `specs/refactor-backlog.md`, not built in this round.
- FR-6: Version/path are pinned for each child lifetime. Reprobe before a reconnect;
  installation changes do not kill a healthy running child. Incompatible resume leaves
  transcript readable and offers installation repair without opening the Pi session file.
- FR-7: Show installation health independently from authentication and provider reachability.
  A supported binary with no credentials is still an installed, compatible runtime.
- FR-8: Validate Windows/macOS/Linux and native versus WSL separately. An uncertified
  environment is unavailable with an explicit reason; no implicit cross-environment fallback.

## 5. API contract

Author `contract/pi-runtime-distribution.ts`, importing `Result`, `ClaudeRuntime` and
`AppError` from `common.ts`. Exact types:

```ts
interface RuntimeInstallProbeInput {
  runtime: ClaudeRuntime;
  distro?: string; // required iff WSL; reject off Windows
  refresh?: boolean; // default false
}
interface RuntimeInstallStatus {
  state: 'missing' | 'incompatible' | 'ready' | 'probe-failed';
  executablePath?: string;
  detectedVersion?: string;
  nodeVersion?: string;
  supportedVersions: string[];
  provenance: 'certified' | 'unverified' | 'unknown';
  checkedAt: number;
  installCommand: string; // display/copy only
  error?: AppError;
}
```

`francois:runtime:installation` → `runtime_installation(req)` frontend → core,
`Result<RuntimeInstallStatus>`. Missing/incompatible/probe failure are successful health
responses with `error` describing the problem. Invalid runtime/distro uses `INVALID_INPUT`;
registry/I/O failure uses `INTERNAL`. No new event. Cache keyed by environment and resolved
binary metadata for 60 seconds; refresh bypasses it. Probe occurs only after the user opens
setup or explicitly selects a Pi account; no startup execution of arbitrary discovered code.

Internal `PiCompatibilityManifest`: schemaVersion=1, packageName, packageVersion,
artifactDigest, sourceRevision, nodeRange, tested OS/environment tuples, requiredCommands,
requiredEvents, fixtureRevision. Store with the adapter's versioned fixtures.

## 6. Data & state

Health/cache is transient. Checked-in certification manifest and sanitized fixtures belong
under `src-tauri/src/session/adapter/pi/fixtures/`. No machine paths in committed manifests.
Expected files: `process_util.rs`, `account/cli_tools.rs`, new `session/adapter/pi/discovery.rs`,
`src/features/accounts/CliToolCard.tsx`, new typed API wrapper, README at final rollout.
`packaging/npm/` remains a zero-dependency package and is not a new surface.

Distribution comparison: external Pi adds no François package bytes and lets users own
updates; managed Pi adds installer/recovery/version ownership; bundled Pi adds platform
artifacts, Node/runtime distribution and license notices. Exact managed/bundled sizes are
unmeasured and are not a requirement for the selected external strategy.

## 7. Edge cases & errors

Missing binary → `RUNTIME_UNAVAILABLE`; wrong version → `RUNTIME_INCOMPATIBLE`;
timeout → `RUNTIME_TIMEOUT`; malformed version / wrong executable → `RUNTIME_PROTOCOL_ERROR`.
Show these in setup, never as a provider login error. Installation failure leaves old
sessions and the currently running application usable. Do not auto-downgrade Pi files.

## 8. Design brief

Extend the existing CLI tool card in Accounts with version/path/health and Retry/Copy.
> full brief: specs/design/pi-runtime-distribution.md

## 9. Acceptance criteria

- [ ] Path fixtures cover spaces, Unicode, npm shims, missing Node, nvm changes, WSL paths (FR-1–3).
- [ ] Only allowlisted versions/environments pass the gate as `unverified`; unknown versions stay
      `incompatible` (FR-4–5). Real RPC-protocol certification (`provenance: 'certified'`) is
      out of scope for this feature per FR-5's scope note — tracked as
      `deferred:pi-runtime-distribution`.
- [ ] ~~Real-process certification records exact package/digest and sanitized captures (FR-5).~~
      Deferred: no audited real Pi process exists yet to capture against (FR-5 scope note);
      tracked as `deferred:pi-runtime-distribution` in `specs/refactor-backlog.md`.
- [ ] Upgrading the executable does not mutate a live connection; reconnect reprobes (FR-6).
- [ ] Missing credentials do not change installation health to missing (FR-7).
- [ ] Core unit tests and setup state/typed-wrapper vitest pass; three-platform smoke results recorded.

## Remediation

- 2026-09-18 — 5 findings, all fixed (FR-5 amended to version-string certification; RPC probe deferred to `deferred:pi-runtime-distribution` in refactor-backlog)

- 2026-09-18 (round 2) — 3 findings, all fixed (PiSetupCard surfaces IPC probe failure via `piSetupErrorText`/`Headline`/`Note`; app.css restored from main; `nodeRange` floor gates `ready` → `incompatible`)

- 2026-09-18 (round 3) — 5 findings, all fixed (bounded spawn moved to `process_util::CommandBuilder::run_bounded`, also fixing `cli_tools::probe_version` pipe deadlock; duplicate `has_detail` removed; poison-tolerant probe cache; `checkedAt` rendered in PiSetupCard; env picker logged as `deferred:pi-runtime-distribution`)