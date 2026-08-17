---
id: ext-path-resolution
title: Extension providers resolve binaries via the login-shell PATH
status: shipped
branch: feat/ext-path-resolution
created: 2026-08-17
depends_on: [extensions, extension-install]
loop_pass: 0
loop_phase:
reviewed_base: 4d7cbbc00284e0fc80bca612a97394aa700dd64d
reviewed_digest: 485d1288f66950cd
---

# Extension providers resolve binaries via the login-shell PATH

## 1. Summary

Extension provider children are spawned with `env_clear()` and a scrubbed copy of the **app
process's own** environment (`extensions/provider.rs:224-227`, `extensions/stream.rs:418-421`). A
GUI app launched from the Dock/Finder inherits launchd's minimal `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`), so an extension whose `argv0` is a bare name — the intended
convention per `extensions` FR-9 — fails to resolve for anyone whose binary lives in nvm, Homebrew
(either prefix), pnpm, cargo, or `~/.local/bin`. The only symptom is
`Need <x> N+ — <x> not found in PATH`, which reads as "you didn't install it". The fix is to reuse
the helper that already solves this for the eight `claude` spawn sites
(`session::spawn::claude_path_env`, over `$SHELL -ilc`, memoized in a `OnceLock`), at **both**
extension spawn sites, filtering the relative and empty `PATH` entries that a repo-controlled `cwd`
would otherwise make exploitable.

## 2. Goals & non-goals

**Goals**

- A bare-name `argv0` resolves for provider panels, `commandSucceeds` detection predicates, and
  `log-tail` `process` sources, wherever the user's login shell can resolve it.
- One shared env helper, so the two spawn sites cannot drift apart again.
- The login shell's `PATH` cannot make a bare `argv0` resolve **inside the open repo**.
- The helper's name and home stop being `claude`-specific.

**Non-goals**

- **No new message for the `None` case.** `login_shell_path()` is `#[cfg(windows)] → None` by
  design (a Windows GUI app already inherits the full user PATH), so `None` is the *nominal*
  Windows value, not a failure — a "could not read your PATH" wording would be wrong for the
  majority of the `None`s it would reach. On unix, post-fix, `None` needs a broken `$SHELL` (the
  helper defaults to `/bin/zsh`). Current copy stands. A diagnostics line is also ruled out:
  `diagnostics::append_log` needs an `AppHandle` that `run_capped` does not have.
- **No generalization of the relative-entry filter to the eight `claude` spawns.** The exposure is
  arguably the same, but it would change eight working call sites inside a patch. It goes to
  `specs/refactor-backlog.md` under `deferred:ext-path-resolution` and to `specs/_decisions.md`, and
  must **not** be done quietly inside this feature.
- No change to any `~/.francois/extensions/*/extension.json`; a bare-name `argv0` stays the
  convention (`extensions` FR-9).
- No `launchctl config user path`, no shim in `/usr/local/bin` — that fixes one machine, not the
  product.
- No re-implementation of PATH resolution on the extensions side, and no widening of
  `ENV_ALLOWLIST`.
- No error-message rewording: the copy is accurate once resolution works.

## 3. User stories / flows

1. A user installs `cohorte` via nvm and enables the `cohorte` extension. **Before:** all three
   panels show `Need cohorte 2.5+ — cohorte not found in PATH`, though `cohorte 2.6.0` runs fine in
   a terminal. **After:** the panels render their rows, and the extension is detected for the
   project.
2. A user configures a `log-tail` panel whose `process` source is a Homebrew-installed binary.
   **Before:** the stream fails at spawn with a raw `io::Error`. **After:** it streams.
3. A user opens a project with several extensions enabled. Detection fans out; the first provider
   call pays the one-time `$SHELL -ilc` cost (1–3s with a heavy `.zshrc`) **without** holding one of
   the four concurrency slots, and every later call reads the memoized value.
4. A user clones a hostile repo containing `./cohorte` or `node_modules/.bin/cohorte`, and their
   login shell's `PATH` carries `.` or a relative entry. **After:** the relative entry is dropped
   from the override, so the bare `argv0` never resolves against the repo.

## 4. Functional requirements

- **FR-1** — `process_util` exposes `login_shell_path_env() -> Option<String>`, moved verbatim from
  `session::spawn::claude_path_env` (together with its private `login_shell_path()` and the
  `SHELL_PATH: OnceLock`). Semantics are unchanged: the login shell's `PATH` prefixed onto the
  process's own, memoized at most once per app run, `None` when unresolvable.
- **FR-2** — `session` re-exports it as `claude_path_env` so the eight existing `claude` spawn call
  sites (`session/turn.rs`, `session/usage.rs`, `account/login.rs`, `session/remote/start.rs`,
  `session/cloud/adopt.rs`, `session/commands/lifecycle.rs`, `session/usage_probe.rs`,
  `session/spawn.rs`) compile and behave **identically**, byte for byte, with no filtering applied
  to their PATH.
- **FR-3** — `extensions::provider` exposes `apply_ext_env(cmd: &mut Command, path_override:
  Option<&str>)`, which performs the `env_clear()` + `scrub_env(std::env::vars())` block and then,
  when `path_override` is `Some`, sets `PATH` to the **filtered** override.
- **FR-4** — Both extension spawn sites call `apply_ext_env` and contain no `env_clear()`/`scrub_env`
  block of their own: `provider::run_capped` and `stream::spawn_process_stream`. `stream.rs` already
  imports `scrub_env` from `provider`, so this adds no new module dependency.
- **FR-5** — The filter drops, from the override string, every `':'`-separated entry that is empty
  or not absolute (`Path::new(s).is_absolute()`). The remaining entries keep their original order,
  re-joined with `':'`. If filtering leaves nothing, the override is not applied and the spawn keeps
  the scrubbed process `PATH`.
- **FR-6** — When `login_shell_path_env()` returns `None`, `PATH` keeps the value `scrub_env`
  produced. No message, no diagnostics, no UI difference (see §2 non-goals).
- **FR-7** — `run_capped` resolves the override **before** `acquire_slot(concurrency)`, so the
  first-call `$SHELL -ilc` cost never holds one of `EXT_CONCURRENCY = 4` slots.
- **FR-8** — `spawn_process_stream` has no slot to acquire and needs nothing beyond calling
  `apply_ext_env`; its failure surface (`std::io::Error`) is unchanged.
- **FR-9** — `extensions` FR-20 holds unchanged: the child's environment stays `env_clear()`ed and
  limited to `ENV_ALLOWLIST`. `PATH` is already an allowlist member — this is a value override, not
  a widening.

## 5. API contract

**No contract change.** This feature touches no IPC channel, no event, and no payload type. No
`contract/ext-path-resolution.ts` is authored, and no existing contract file is edited — a build
that produces one has misread this spec.

The interface is Rust-internal:

```rust
// src-tauri/src/process_util.rs
pub(crate) fn login_shell_path_env() -> Option<String>;

// src-tauri/src/session/mod.rs (or spawn.rs) — compatibility re-export, FR-2
pub(crate) use crate::process_util::login_shell_path_env as claude_path_env;

// src-tauri/src/extensions/provider.rs
pub(crate) fn apply_ext_env(cmd: &mut Command, path_override: Option<&str>);
```

## 6. Data & state

No persisted state, no frontend state, no store. The only state is the pre-existing
`SHELL_PATH: OnceLock<Option<String>>`, which moves module along with the helper and keeps its
"resolve at most once per app run" semantics.

## 7. Edge cases & errors

| Case | Behaviour |
|---|---|
| Windows | `login_shell_path()` is `None` by `#[cfg]`; the override is skipped, `PATH` untouched. Nothing platform-specific to add. |
| `$SHELL` unset | Helper defaults to `/bin/zsh`, as today. |
| `$SHELL` broken / shell exits non-zero / prints no markers | `None` → FR-6 path, current `EXT_PROVIDER_MISSING` copy. |
| Login shell PATH contains `.`, `node_modules/.bin`, or an empty field (`PATH=$PATH:`) | Entry dropped (FR-5). No legitimate loss: a relative entry was resolving inside the open repo, never where the user thought. |
| Every entry filtered out | Override not applied; scrubbed process `PATH` stands (FR-5). |
| `argv0` still unresolvable after the override | Unchanged: `ProviderError::Missing` → `EXT_PROVIDER_MISSING` in panels and a false `commandSucceeds` in `detect.rs:178`. |
| First provider call after app start | Pays the one-time shell spawn outside the slot (FR-7); all later calls read the `OnceLock`. |

## 8. Design brief

None — no UI. The change is invisible except that panels which previously showed
`Need <x> N+ — <x> not found in PATH` now render their rows. No `specs/design/` brief is authored
and `design_files` is omitted from the front-matter.

## 9. Acceptance criteria

- [x] FR-1/FR-2 — `login_shell_path_env` lives in `process_util`; `cargo check` is clean and the
      eight `claude` call sites are unchanged apart from the import path.
- [x] FR-3/FR-4 — `apply_ext_env` exists and is the **only** place in `src-tauri/src/extensions/`
      that calls `env_clear()`; a test (or a grep-shaped assertion) pins that both spawn sites go
      through it, so `stream.rs` cannot silently drift back.
- [x] FR-3/FR-5 — the child actually receives the login shell's `PATH`: a marker script echoing its
      received `$PATH` asserts the resolved prefix is present. The battery around `run_capped`
      (`provider.rs` ~437-602) and `detect.rs`'s cross-platform `marker_script_argv` are the model.
      **The test must tolerate `None`** (no usable `$SHELL` on the machine) rather than be flaky.
- [x] FR-5 — a unit test on the filter: `":/abs:.:node_modules/.bin:/other"` → `"/abs:/other"`; an
      all-relative input yields no override.
- [x] FR-9 — non-regression: the child's environment stays limited to `ENV_ALLOWLIST`, overridden
      `PATH` included; no extra variable leaks through this path.
- [x] FR-7 — the resolution call precedes `acquire_slot` in `run_capped` (readable in the diff).
- [ ] Manual: with the `cohorte` extension enabled and `cohorte` installed under nvm, all three
      panels render rows instead of `Need cohorte 2.5+ — cohorte not found in PATH`.
- [x] `specs/refactor-backlog.md` carries the `deferred:ext-path-resolution` item for generalizing
      the filter to the `claude` spawns.

## Remediation

### 2026-08-17 — CI failure on PR #82 (windows-latest)

- 2026-08-17 — 2 findings, all fixed. The FR-5 filter's unit tests asserted POSIX absolute paths, but
  `Path::is_absolute()` on Windows requires a drive or UNC prefix, so `/abs` / `/usr/bin` filtered out
  and 2/1023 `cargo test` cases failed on `windows-latest` (ubuntu green). Test fixtures only —
  production behaviour was never affected, since `login_shell_path()` is `#[cfg(windows)] → None` per
  §2 non-goals. Fixed by `#[cfg(unix)]`-gating the POSIX fixtures and adding `#[cfg(windows)]`
  counterparts using **UNC** paths (`\\server\share`) rather than drive letters, whose own `:` would
  collide with the function's `':'` splitter. `filter_absolute_path_entries` itself unchanged.
