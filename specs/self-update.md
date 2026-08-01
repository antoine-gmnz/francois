---
id: self-update
title: Self-update
status: shipped
created: 2026-07-31
depends_on: [app-shell, command-palette, session-engine]
design_files: [specs/design/self-update.md]
reviewed_base: c5281aa25a80633b8c1ab5d5071054bf8e7e54cb
reviewed_digest: 9b12c29c64089231
---

# Self-update

## 1. Summary

Francois ships a new version on every push to `main`, but a running install has no idea. This
feature lets the app notice a newer release and install it without leaving the window: the core
compares its own version against what the npm registry serves, surfaces the result on the existing
status-bar version readout, and — when the user asks — hands the actual install to
`npm i -g francois@latest` via a detached helper that waits for the app to quit, updates, and
relaunches it. Delegating to npm is deliberate: `packaging/npm/install.js` already downloads the
right portable archive, verifies it against the sha256 baked into `manifest.json`, unpacks it and
re-registers the Start Menu entry / `~/Applications` bundle / `.desktop` file, and CI exercises that
whole path on every publish. Reimplementing it in Rust would duplicate three platforms of
edge cases with none of the coverage.

## 2. Goals & non-goals

- **Goals**
  - Detect that a newer Francois has been published, on launch and on demand.
  - Show what changed before the user commits to anything.
  - Apply the update and relaunch, in one click, for npm-installed copies.
  - Degrade honestly for copies installed any other way (`.msi`/`.dmg`/built from source): report
    the new version and the command, apply nothing.
- **Non-goals**
  - `tauri-plugin-updater` and signed update artifacts. Its Windows path applies updates by running
    the NSIS/MSI installer, which would plant a second copy in Program Files while the Start Menu
    shortcut npm registered still points at the stale `vendor/` binary. It also needs a minisign
    keypair added to `release.yml`. Revisit only if installer-based distribution becomes primary.
  - Downgrades, channel switching, or pinning to a version.
  - Background polling, update toasts, and per-version dismissal state. Launch + manual is the whole
    cadence; the chip is quiet enough not to need dismissing.
  - Any change to `packaging/npm/`. The helper is authored by the core at update time (FR-13) —
    the npm package is not a surface and stays untouched.
  - Updating the `claude` CLI itself. Unrelated lifecycle.

## 3. User stories / flows

**Noticing.** The user launches Francois. A moment later the version readout at the right of the
status bar changes from `0.15.8` to `↑ 0.16.0` in the accent color. Nothing else moves; no dialog
steals focus. If there is no update, or the check fails, the readout stays exactly as it is today.

**Reading and applying.** The user clicks the readout. A modal opens: `0.15.8 → 0.16.0`, the release
notes, `View release ↗`, and `Update and restart`. They click it; the button becomes `Updating…`,
the window closes, a terminal-less helper runs the install, and Francois reopens on 0.16.0.

**Blocked by work in flight.** Two sessions are mid-turn. The modal's button is disabled and reads
`2 sessions running` with a line explaining that the app has to quit to update. The user finishes
or stops the turns, reopens the modal, and the button is live.

**Manual install.** The user installed from the `.dmg`. The modal shows the same versions and notes,
but instead of the button there is a copyable `npm i -g francois@latest` and a line saying this copy
was not installed through npm, so Francois cannot update it in place.

**Checking on demand.** The user hits `⌘K`, types `update`, and runs **Check for updates**. The
check runs and the modal opens with whatever it found — including `You're on the latest version`
or, if the network is down, the failure. (Unlike the launch check, a check the user asked for
always reports back.)

## 4. Functional requirements

- **FR-1** The core reports its own version from `env!("CARGO_PKG_VERSION")` as `current`. This is
  the same value `release.yml`'s `version` job writes into `Cargo.toml`, so it always names the
  build actually running.
- **FR-2** `latest` comes from `GET https://registry.npmjs.org/francois/latest` → `.version`. The
  npm registry — not GitHub — is the source of truth for the version, because it is exactly what
  `npm i -g francois@latest` will install. `release.yml` un-drafts the GitHub release *before* it
  dispatches `npm-publish.yml`, so a GitHub-first check would offer an update npm cannot yet serve.
- **FR-3** `notes` come from `GET https://api.github.com/repos/antoine-gmnz/francois/releases/tags/v<latest>`
  → `.body`, best-effort: a non-200, a timeout, or an unparseable body leaves `notes` absent and
  **must not** fail the check. Unauthenticated (60 req/h), which the launch+manual cadence never
  approaches. `notesUrl` is always populated, whether or not the body was fetched.
- **FR-4** `updateAvailable` is true iff `latest` is strictly greater than `current`, compared as a
  numeric `major.minor.patch` triple. A version carrying a pre-release suffix sorts below the same
  triple without one. An unparseable `latest` is a check failure (FR-6), never `false`.
- **FR-5** `method` is `'npm'` iff all three hold, else `'manual'`:
  1. `npm root -g` exits 0 and names an existing directory;
  2. `<root>/francois/vendor/install.json` exists and parses;
  3. its `executable`, canonicalized, is the running `std::env::current_exe()` — or, on macOS, the
     `.app` bundle containing it.
  Deriving the package root from the executable path does not work on macOS, where the postinstall
  moves the bundle out to `~/Applications`; `npm root -g` is the only anchor that holds on all three
  platforms.
- **FR-6** Both HTTP calls use a 10 s timeout. A failure to reach or parse the npm registry resolves
  `UPDATE_CHECK_FAILED` with the reason in `message`.
- **FR-7** The frontend calls `checkUpdate` exactly once when the app shell mounts. A failure there
  is **silent** — no chip, no toast, no error surface. A launch-time network blip must not shout.
- **FR-8** While the last check reports `updateAvailable`, the status-bar version readout
  (`StatusBar.tsx:66`) renders `↑ <latest>` in the accent color and becomes a button that opens the
  update modal. Otherwise it renders exactly as today: dim, plain, `current` (or `dev`).
- **FR-9** The command palette registers **Check for updates**, always available. It runs a fresh
  check and opens the modal with the outcome — up-to-date and failed checks included.
- **FR-10** The modal shows `current → latest`, the notes (preformatted, scroll-capped, never
  rendered as HTML), a `View release ↗` link to `notesUrl`, and the primary action.
- **FR-11** For `method: 'manual'` the modal shows the copyable `command` and a one-line explanation
  in place of the update button. The button is never rendered for a manual install.
- **FR-12** The update is refused while any session's status is `running`. The frontend disables the
  button and names the count; the core independently re-checks and resolves `UPDATE_BLOCKED` with
  `detail: { running: number }`. Both sides enforce it — the core check is what actually holds,
  since the count can change between render and click.
- **FR-13** `applyUpdate` writes a self-contained relauncher into a **fresh temp directory outside
  the npm package** (`.cmd` on Windows, `.sh` elsewhere, mode 0o755). Outside is load-bearing: npm
  replaces `node_modules/francois/` wholesale during the install, and a helper executing from inside
  that directory can be deleted under itself, or fail outright on Windows where the file is locked.
- **FR-14** The helper, in order: polls until the app's PID is gone (giving up after 120 s); runs
  `npm i -g francois@latest`, **retrying up to 3 times, 5 s apart** (an `EBUSY` on npm's rename of
  the package directory is often a race the next attempt wins); on exit 0 re-reads
  `<npm root -g>/francois/vendor/install.json` for the new `executable`; launches it; removes its own
  temp directory. When npm fails all 3 times it leaves the log in place and **relaunches the version
  that is still installed** — a failed install changes nothing on disk, and quitting to update
  without ever coming back is the worst outcome available.
- **FR-15** The helper is spawned **detached** — `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` on
  Windows, `setsid` elsewhere — so it outlives the app. Its stdout and stderr go to `update.log` in
  the temp directory, whose path is returned in the ack so a failed update can be diagnosed. Its
  **working directory is the system temp dir**, never inherited: a cwd is an open handle, the app is
  launched from its shortcut with a cwd of `<npm root>/francois/vendor`, and a helper inheriting that
  pins the very directory npm has to rename (see §7).
- **FR-16** `applyUpdate` resolves its ack **before** the core begins shutdown, then exits after a
  short grace period so the ack reaches the webview. Ordering matters: an app that quits first
  leaves the frontend with a pending promise and no way to report failure.
- **FR-17** If the post-install `install.json` is missing or unreadable, the helper relaunches the
  executable path recorded **before** the update. That path is stable across updates on Windows and
  Linux (the vendor directory does not move) and on macOS (the bundle returns to `~/Applications`).
- **FR-18** If `npm` cannot be resolved, the temp directory cannot be written, or the helper cannot
  be spawned, `applyUpdate` resolves `UPDATE_APPLY_FAILED` with the reason and the core does **not**
  quit. Calling `applyUpdate` with `method: 'manual'` resolves the same code.
- **FR-19** The last `UpdateCheck` is held in memory by the core and returned to the frontend on
  each call. A new check replaces it wholesale. Nothing about update state is persisted to disk.

## 5. API contract

`contract/self-update.ts`. Adds three members to `ErrorCode` in `contract/common.ts`:
`'UPDATE_CHECK_FAILED'`, `'UPDATE_APPLY_FAILED'`, `'UPDATE_BLOCKED'`.

No new events: the frontend drives both calls (FR-7, FR-9), so the existing
`francois://app/*` event surface is untouched.

| channel | command | payload | resolves |
|---|---|---|---|
| `francois:app:checkUpdate` | `app_check_update` | — | `Result<UpdateCheck>` |
| `francois:app:applyUpdate` | `app_apply_update` | — | `Result<UpdateApplyAck>` |

`app_check_update` errors: `UPDATE_CHECK_FAILED` (FR-6), `INTERNAL`.
`app_apply_update` errors: `UPDATE_BLOCKED` (FR-12), `UPDATE_APPLY_FAILED` (FR-18), `INTERNAL`.

```ts
// contract/self-update.ts
import type { Result } from './common';

/**
 * How this copy of Francois can be updated.
 * 'npm'    — installed by `npm i -g francois`; the core can update in place (FR-5).
 * 'manual' — installed from a .msi/.dmg/.AppImage or built from source; report only.
 */
export type UpdateMethod = 'npm' | 'manual';

export interface UpdateCheck {
  /** The running build, from CARGO_PKG_VERSION (FR-1). */
  current: string;
  /** Newest version on the npm registry — what `@latest` resolves to (FR-2). */
  latest: string;
  /** latest > current as a numeric triple (FR-4). */
  updateAvailable: boolean;
  method: UpdateMethod;
  /** GitHub release body for v<latest>; absent when that fetch failed (FR-3). */
  notes?: string;
  /** Release page for v<latest>. Always present, even when `notes` is not. */
  notesUrl: string;
  /** Verbatim command a manual install should run: 'npm i -g francois@latest'. */
  command: string;
  /** epoch ms this check completed. */
  checkedAt: number;
}

export interface UpdateApplyAck {
  /** The detached relauncher (FR-15). */
  helperPid: number;
  /** The version being installed — echoed so the UI can name it after the check is gone. */
  latest: string;
  /** Absolute path to the helper's update.log (FR-15). */
  logPath: string;
}

// francois:app:applyUpdate errors: 'UPDATE_BLOCKED' (FR-12, detail: UpdateBlockedDetail),
//                                  'UPDATE_APPLY_FAILED' (FR-18), 'INTERNAL'
export type CheckUpdateResult = Result<UpdateCheck>;
export type ApplyUpdateResult = Result<UpdateApplyAck>;

/** Shape of `AppError.detail` when the code is 'UPDATE_BLOCKED' (FR-12). */
export interface UpdateBlockedDetail {
  running: number;
}
```

## 6. Data & state

**Core** — `Mutex<Option<UpdateCheck>>` in the app state, replaced wholesale on each check (FR-19).
The pre-update `executable` path is read at apply time and baked into the helper script (FR-17); the
core keeps no other update state, and nothing touches disk.

**Frontend** — a slice on the existing store: `update: UpdateCheck | null`,
`updateModalOpen: boolean`, `updateBusy: boolean` (true from the click until the window goes). The
chip derives entirely from `update` (FR-8); the running-session count derives from the existing
`sessions` slice, not from anything new.

## 7. Edge cases & errors

| case | behavior |
|---|---|
| Launch check fails (offline, DNS, registry 5xx) | Silent. No chip, nothing logged to the UI (FR-7). |
| Manual check fails | Modal opens showing the `UPDATE_CHECK_FAILED` message and a retry. |
| GitHub notes fetch fails but npm succeeded | Update offered normally; modal shows `Release notes unavailable` plus the `View release ↗` link (FR-3). |
| `latest` equals `current` | `updateAvailable: false`. No chip; a manual check says `You're on the latest version`. |
| `latest` is older than `current` (local dev build ahead of the registry) | `updateAvailable: false`. Never offers a downgrade (FR-4). |
| Not an npm install | `method: 'manual'` — a normal, non-error outcome. Modal shows the command (FR-11). |
| Sessions running at click time | `UPDATE_BLOCKED`; modal re-renders with the disabled button and the count (FR-12). |
| `npm` missing from PATH | `UPDATE_APPLY_FAILED`; the app stays open (FR-18). |
| npm exits non-zero (EACCES on a system-owned prefix, registry down mid-install) | Retried 3 times, 5 s apart. If it still fails the helper leaves `update.log` **and relaunches the installed version**, which still works — the install is atomic from the app's point of view because npm either replaced `vendor/` or did not (FR-14). |
| npm fails `EBUSY: rename '<npm root>\francois\vendor'` | Was **every** update on Windows. The Start Menu shortcut set the app's working directory to `…/francois/vendor`; a cwd is an open handle and is inherited by children, so the helper pinned the directory npm renames. Fixed on both ends: the helper runs in the system temp dir (FR-15), and the shortcut now starts the app in the user's home (`packaging/npm/lib/desktop.js`). |
| A bare `npm` in the Windows helper | `npm` on Windows is `npm.cmd`, a batch file: invoked from a batch file **without `call`** it never returns — cmd hands over the script context, so the helper ended the moment npm did. `npm root -g` was bare, which silently killed every otherwise-successful update just before the relaunch. Every npm invocation is `call`ed, and a test asserts it. |
| App does not exit within 120 s | The helper gives up without running npm and removes itself. The install is never attempted against a locked binary (FR-14). |
| Two `applyUpdate` calls in a row | The second resolves `UPDATE_APPLY_FAILED`; the frontend's `updateBusy` prevents it reaching the core in the first place. |
| Update lands while the modal is open | Irrelevant — the window is closing. No reconciliation needed. |

## 8. Design brief

Two touch points, both in existing chrome. **Status bar**: the version readout at the far right of
`app-status-bar` (`StatusBar.tsx:66`, currently `<span className="app-key">`) gains an
update state — `↑ 0.16.0`, accent-colored, clickable — and is otherwise unchanged. It sits to the
right of the theme toggle and `AccountChip`, which establishes the pattern this follows: a
status-bar chip that opens a modal. **Update modal**: reuses `src/ui/Modal.tsx`, narrow, with the
version transition as its headline, a scroll-capped monospace notes block, `View release ↗`, and one
primary action that is either `Update and restart`, a disabled `N sessions running`, or a copyable
command for a manual install.

> full brief: `specs/design/self-update.md`

## 9. Acceptance criteria

- [ ] Launching a build older than the published version shows `↑ <latest>` in the status bar within
      a few seconds; launching the newest build shows the plain version readout. (FR-1, FR-2, FR-4, FR-8)
- [ ] Launching with the network unplugged shows the plain version readout and no error anywhere. (FR-6, FR-7)
- [ ] Clicking the chip opens the modal with `current → latest` and the release body for that tag. (FR-3, FR-10)
- [ ] With the GitHub API blocked but the registry reachable, the modal still offers the update and
      shows `Release notes unavailable`. (FR-3)
- [ ] `⌘K → Check for updates` opens the modal on an up-to-date install and on a failed check. (FR-9)
- [ ] On an npm install, `Update and restart` closes the app, and it reopens on the new version with
      its Start Menu / Launchpad / `.desktop` entry still working. (FR-13, FR-14, FR-15, FR-17)
- [ ] The helper's temp directory is outside `node_modules/francois/`, and is gone after a successful
      update. (FR-13, FR-14)
- [ ] On a `.dmg`/`.msi` install, the modal shows the copyable command and no update button. (FR-5, FR-11)
- [ ] With a session mid-turn, the button is disabled and names the count; invoking `app_apply_update`
      directly resolves `UPDATE_BLOCKED` with `detail.running`. (FR-12)
- [ ] With `npm` removed from PATH, `Update and restart` reports the failure and the app stays open. (FR-18)
- [x] `cargo test` covers: the version triple comparison including pre-release and
      downgrade cases, `UpdateCheck`/`UpdateApplyAck` serde round-trips against the contract shapes,
      provenance detection against a fake `npm root -g` + `install.json` fixture, and the generated
      helper script's text for both platforms. (FR-4, FR-5, FR-14)
- [x] `npm test` covers: the chip's rendered state from an `UpdateCheck`, the running-session guard's
      disabled/enabled decision, and the `invoke` wrappers' `Result` handling for all three error codes.

## Remediation

### 2026-07-31 — round 1 (`/review` self-update)

- 2026-07-31 — 6 findings (3 MEDIUM, 3 LOW incl. 1 security), all fixed.
  - core: `app_apply_update` in-flight `AtomicBool` guard (`UpdateState::begin_apply`/`end_apply`,
    overlapping calls resolve `UPDATE_APPLY_FAILED`); `remove_dir_all` cleanup on every
    `tmp_root`/`npm_tree` fixture; `fresh_helper_dir` sets `0o700` on unix; `fetch_latest_version`
    phrases `ureq::Error::Status` separately from `Transport`. 4 new tests, 589 pass.
  - frontend: `actionRef` also attached to the `failed`-state `Retry` button so the mount effect
    focuses the primary control for every `view.kind`. 1109 tests pass, `tsc` clean.
  - spec: §5's contract block now carries the named `UpdateBlockedDetail` interface (doc-only sync
    with the already-correct `contract/self-update.ts`).
