---
id: extension-install
title: Extension install — plugins loaded from disk
status: shipped
branch: feat/extensions
created: 2026-08-13
depends_on: [extensions, cli-companion, app-shell, projects]
loop_pass: 0
loop_phase:
reviewed_base: 9d471154a835f85ac1987132268dbe9b779da95e
reviewed_digest: 56b36ccd1fd34e69
design_files: []
---

# Extension install — plugins loaded from disk

> **Amends `specs/extensions.md`.** Everything frozen there — the four primitives, the provider caps
> (FR-19..FR-25), refresh & pagination, the streaming lifecycle, rendering hygiene and the error
> states — **holds unchanged**. This spec replaces only where the definitions come from, how
> detection is expressed, and what authorizes a definition to run. Every FR below that supersedes one
> there names it.

## 1. Summary

`extensions` ships a registry compiled into the Francois binary: three entries (`cohorte`, `git`,
`docker`) that no user can add to. This feature **deletes that array** and makes the registry a
directory: `~/.francois/extensions/<id>/extension.json`. A plugin is a manifest — an id, a detection
predicate, and a list of panels declaring provider argv — referencing binaries the user already has
on `PATH`. Francois reads manifests, it never ships them.

Because a manifest is argv that Francois executes unattended and unsandboxed, **discovery is not
authorization**: an extension found on disk arrives disabled and stays inert until the user consents
to its declared commands, shown verbatim. The consent is bound to the manifest's content hash, so a
plugin that changes after being trusted must be trusted again.

The repo ships one worked example (`examples/extensions/plugin-example/`) that is both the authoring reference
and the e2e fixture.

## 2. Goals & non-goals

**Goals**

- One registry source: `~/.francois/extensions/*/extension.json`. The compiled array is gone.
- A manifest schema covering everything the three built-ins expressed, so nothing regresses in
  expressive power: declarative detection predicates and a declarative output adapter.
- A consent model where installing and authorizing are two separate acts.
- `francois ext install|list|remove` — filesystem verbs in the npm launcher, off the socket.
- A worked example plugin, versioned in the repo, that a user copies to start.

**Non-goals**

- **A plugin registry, versioning, or dependency resolution.** `install` takes a name, a local path
  or a git URL and copies/clones. There is **no index to search**, no semver, no update command, and
  no list anyone curates. FR-28a's bare-name form is a **URL shorthand** — a naming convention
  resolved by string substitution, fetching nothing to decide where to look — which is why it does
  not reopen this. What stays refused is the index and everything downstream of it: search,
  moderation, and a trust relationship with whoever is listed.
- **Signing or provenance.** Consent is the whole trust story: the user reads the argv and decides.
  A signature would only move the question to who holds the key.
- **Bundled executables.** A manifest references an `argv0` resolved on `PATH` and nothing else. A
  plugin may not ship a binary and may not name an absolute path — see FR-9.
- **Repo-scoped manifests.** Never, at any scope. `<root>/.francois/`, a `package.json` key, a Claude
  Code plugin — none of these are read. This is the one half of `extensions` FR-1 that survives
  intact, and it is the half that carried the threat.
- **Contributed JS or CSS**, a published/stable schema, or a compatibility promise across Francois
  versions. `manifest: 1` is a refusal marker, not a contract.
- **The `cohorte-dashboard` launch action.** It leaves with cohorte (FR-24). Whether a manifest may
  declare a mutating action is its own decision, taken when cohorte returns as a plugin.
- **Re-authoring cohorte / git / docker as plugins.** Out of scope beyond the git example; they are
  the user's to write against this schema.
- **A filesystem watcher.** `extensions` FR-4 refused one for the detection cache; the same reasoning
  holds for the manifest directory (FR-13).

## 3. User stories / flows

1. **Installing.** I run `francois ext install ~/src/francois-k8s`. The directory is copied to
   `~/.francois/extensions/k8s/`. The CLI prints the id, the path, and `disabled — enable it in
   Extensions (⌘K)`. Nothing runs.
2. **Consenting.** I open Extensions. `k8s` sits under `Installed` with a `Review & enable` control
   rather than a toggle. Clicking it shows every distinct command the manifest declares, one per
   line, monospace. I confirm; the toggle flips on and the tab is offered where it detects.
3. **A plugin changes under me.** I `git pull` in the plugin's directory and its argv now include a
   flag I never saw. On the next launch Francois finds a manifest whose hash differs from the one I
   consented to. The extension reverts to disabled and shows `changed since you enabled it — review
   again`, listing the new commands.
4. **A broken manifest.** I hand-edit and typo a primitive name. Extensions lists `k8s` under
   `Installed` with `invalid manifest · unknown primitive "tabel" at panels[1].primitive` and the
   file path. No tab is offered; nothing spawns. Fixing the file and hitting `Re-detect` clears it.
5. **Seeing what I installed.** `francois ext list` prints id, label, path, and enabled/disabled —
   read straight off the directory, so it works with the app closed.
6. **Removing.** `francois ext remove k8s` prints the directory it is about to delete and asks for
   confirmation. Its toggle and consent record are dropped with it.
7. **Starting from the example.** I copy `examples/extensions/plugin-example/` into `~/.francois/extensions/`,
   consent, and get a working git panel — then edit its manifest to learn the schema.

## 4. Functional requirements

### The manifest directory

- **FR-1** *(supersedes `extensions` FR-1)* The registry is every immediate subdirectory of
  `~/.francois/extensions/` containing a readable `extension.json`. **No manifest is read from any
  other location** — not a repo, not `~/.claude`, not a Claude Code plugin, not an env-var override.
  The path is fixed: `$HOME/.francois/extensions/` on all three platforms (`%USERPROFILE%` on
  Windows), reusing the `~/.francois` directory `cli-companion` FR-1 already creates at mode `0700`.
- **FR-2** *(supersedes `extensions` FR-2)* The registry has no fixed membership and no reserved ids.
  Order is lexicographic by id, which is what the tab strip renders (`extensions` FR-10).
- **FR-3** An extension's **id is its directory name**, not a manifest field — so a directory can
  never claim an id it does not occupy, and two extensions cannot collide. It must match
  `^[a-z][a-z0-9-]{0,31}$`. A directory failing this is skipped with `EXT_MANIFEST_INVALID`, listed
  in the modal, and never loaded. A `"id"` key in the manifest that disagrees with the directory is
  the same refusal, not a rename.
- **FR-4** A subdirectory with no `extension.json`, or an unreadable one, is **ignored silently** —
  it is how a plugin repo's `.git/` and any support files coexist with the manifest.

### The manifest

- **FR-5** `extension.json` is UTF-8 JSON, **≤ 256 KiB**, and carries `"manifest": 1`. Any other
  value resolves `EXT_MANIFEST_UNSUPPORTED` and names the version it found. Its full shape is §5.
- **FR-6** Validation is **whole-manifest and all-or-nothing**: a manifest with one bad panel loads
  no panels. The error names the **JSON pointer** of the first failure (`/panels/1/primitive`) and
  what was expected. A partially-valid manifest is never partially registered — the same rule
  `extensions` FR-25 applies to provider payloads.
- **FR-7** Every field `extensions` clamps, it still clamps here: `refreshMs` to the 2 000 ms floor
  (FR-28), `paginated` to `table` only, `tokenSource` to `log-tail` only and to a sibling panel in
  the same manifest, one `token` slot maximum in the whole manifest. A manifest violating a clamp
  that is **structural** (a `token` in a `table`'s argv, a `tokenSource` naming a non-sibling) is
  rejected by FR-6; a numeric one (`refreshMs: 100`) is silently corrected, as before.
- **FR-8** A panel's `id` is minted as `<dir-name>:<slug>`, never read from the manifest — so
  `PanelId` stays unforgeable and `extensions`' panel addressing is unchanged.

### Provider argv

- **FR-9** `argv[0]` must be a **bare binary name** matching `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$` —
  no `/`, no `\`, no `.`, no absolute path. It is resolved on `PATH` at spawn time. A manifest may
  therefore not point at a binary it ships, nor at one outside `PATH`. This is what keeps the
  execution surface identical to `extensions` FR-27 (Francois already spawns `git` and `claude`).
- **FR-10** `argv[0]` may not be a shell (`sh`, `bash`, `zsh`, `fish`, `cmd`, `powershell`, `pwsh`,
  `env`) — the compiled registry had a test asserting this and it becomes a load-time refusal.
  Everything in `extensions` FR-19 still holds: argv arrays, never a string, never `sh -c`.
- **FR-11** Every provider cap in `extensions` FR-20..FR-24 applies unchanged — scrubbed env, cwd
  confinement, closed stdin, 10 s timeout, 4 MiB output cap, concurrency 4.

### Detection

- **FR-12** *(supersedes `extensions` FR-3)* A manifest declares its predicate. Exactly three kinds
  exist, and the set is closed:
  | kind | shape | evaluates |
  | --- | --- | --- |
  | `pathExists` | `{ path }` — relative to the root | the path exists (file or dir) |
  | `pathJsonEquals` | `{ path, pointer, equals }` | the file parses as JSON and the RFC-6901 pointer resolves to `equals` |
  | `commandSucceeds` | `{ argv }` | the process exits 0 within the FR-11 caps |
  `path` is resolved under the root and must stay there after symlink resolution, the rule
  `extensions` FR-39 already applies to log-tail files. `pathExists` and `pathJsonEquals` execute
  nothing; `commandSucceeds` is a spawn and is gated by FR-17.
- **FR-13** Detection results cache per normalized root exactly as `extensions` FR-4, and the
  **manifest directory is re-scanned on app launch and on `extensions_detect` only** — the same two
  triggers, no watcher, no TTL. A plugin installed while the app runs appears on `Re-detect`.
- **FR-14** A manifest that loads but whose predicate does not hold renders the modal's existing
  `unavailable here` row (`extensions` FR-56) with the predicate's own description as the reason —
  e.g. `.git not found in acme-api`.

### Consent — installing is not authorizing

- **FR-15** *(supersedes `extensions` FR-6)* A newly discovered extension is **disabled**. There is
  no default-on: a key never written reads as **`false`**, inverting the built-in registry's rule,
  because a compiled definition was authorized by being merged and a manifest is authorized by
  nobody until the user says so.
- **FR-16** Enabling requires a **consent step**, not a toggle flip: a Francois-owned confirmation
  (the `extensions` FR-48 idiom — `src/ui/Modal`, the `RemoveAccountConfirm` register) listing
  **every distinct argv the manifest declares**, deduplicated, one per line, monospace, including
  the `commandSucceeds` predicate's. The user confirms or cancels; cancelling leaves it disabled.
- **FR-17** **Nothing from an unconsented extension executes** — not a panel, not a stream, and not
  a `commandSucceeds` predicate. Such an extension shows `not evaluated — enable to detect` rather
  than a detection state. `pathExists` / `pathJsonEquals` predicates are inert and *may* be
  evaluated pre-consent, so a plugin can be shown as relevant before it is trusted.
- **FR-18** Consent records the **sha256 of the manifest bytes** alongside the toggle. On every load
  a mismatch **reverts the extension to disabled**, kills anything it owns per `extensions` FR-8,
  and shows `changed since you enabled it — review again`. Re-consent shows the new argv.
- **FR-19** Toggles and consent records persist together in `app_data_dir()`, where `extensions`
  FR-6 already writes. An entry whose directory has disappeared is dropped on load, so removing a
  plugin cannot leave a consent record that a same-named directory would inherit.
- **FR-20** Disabling behaves exactly as `extensions` FR-7/FR-8 — no tab, no spawn, streams killed
  in the same turn — and **keeps** the consent record, so re-enabling does not re-prompt.

### Output adaptation

- **FR-21** *(generalizes `extensions` FR-54)* A panel declares how its provider's stdout becomes a
  payload:
  | kind | behaviour |
  | --- | --- |
  | `json` | stdout is parsed and validated against the primitive's payload schema (`extensions` FR-25, unchanged) |
  | `lines` | `{ separator, fields, idField? }` — each non-empty line is split on `separator` into `fields`, producing one `TableRow` whose `cells` are keyed by field name |
- **FR-22** `lines` is **`table`-only**. `key-value`, `stat-row` and `log-tail` require `json` (a
  `log-tail` process source streams raw lines and declares no adapter at all). A manifest pairing
  `lines` with another primitive is rejected by FR-6.
- **FR-23** Under `lines`: `idField` names the field used as the row `id`, defaulting to the first;
  a line with fewer fields than declared fills the rest empty; a line with more puts the remainder
  in the last field (so a commit subject may contain the separator); `tone` is `neutral` unless a
  field named `tone` carries a valid `StatusTone`. Sanitisation and the 512-char truncation
  (`extensions` FR-51) apply after splitting.

### What leaves

- **FR-24** `PanelAction`, `extensions_probe`, `extensions_launch`, `ProbeResult`, `LaunchRequest`,
  `EXT_DASHBOARD_URL`, `EXT_PORT_OCCUPIED`, `EXT_LAUNCH_FAILED` and `DashboardAction.tsx` are
  **deleted**. `extensions` FR-46..FR-48 are void. No panel mutates anything, with no exception.
- **FR-25** `src-tauri/src/extensions/registry.rs`'s compiled array and `detect.rs`'s three
  hard-coded predicates are deleted. `registry.rs` becomes the loader; `detect.rs` becomes the
  predicate evaluator. Everything else in `src-tauri/src/extensions/` stays.
- **FR-26** With an empty directory the Extensions modal renders an empty state naming the path and
  pointing at the example, and **no `ext:` tab exists**. This is the out-of-the-box state and must
  read as "nothing installed yet", never as an error.

### The CLI verbs

- **FR-27** `francois ext install <path|git-url>`, `francois ext list`, `francois ext remove <id>`
  live in `packaging/npm/bin/francois.js` and operate **directly on the filesystem**. They do not
  connect to the socket, carry no `CliMethod`, and work with the app closed — so `cli-companion`'s
  read-only protocol (its FR-9..FR-13) is untouched.
- **FR-28** `install` resolves the target id from the source's own name, refuses to
  overwrite an existing directory unless `--force`, validates the manifest before writing anything,
  and always prints both the **resolved source** and that the extension arrived **disabled**. A git
  URL is cloned with the `git` on `PATH`; there is no download, no archive, no checksum.
- **FR-28a** `install <name>` resolves a **bare name** by convention to the repository
  `github.com/<owner>/francois-plugin-<name>`, with `<owner>` defaulting to `antoine-gmnz` and
  `<owner>/<name>` naming another. Resolution order is most-explicit-first: an explicit **git URL**
  is cloned as given; an **existing local directory** of that name is copied — so a bare name never
  reaches the network when a local answer exists; only then does the convention apply. The
  `francois-plugin-` prefix is **stripped to form the id** for every source kind, so installing the
  path of a hand-cloned `francois-plugin-cohorte` and installing the name `cohorte` land on the same
  id — an extension's id never depends on how it was fetched. A source shaped like a path (`..`,
  `.`, a backslash, an empty segment) is refused as an invalid id rather than reinterpreted as a
  repository name. There is no index, no lookup and no network call in the resolution itself.
- **FR-29** `remove` prints the absolute directory it will delete and requires confirmation
  (`--yes` to skip). It refuses any path that does not resolve under `~/.francois/extensions/`.
- **FR-30** The verbs never enable anything. Consent is the app's, and only the app's.

### The example plugin

- **FR-31** `examples/extensions/plugin-example/extension.json` is a working git-driven plugin with two panels —
  `Branches` (table, `lines`, `pathExists` predicate) and `Log` (table, `lines`, `paginated`) —
  chosen because they exercise the predicate language, the `lines` adapter and pagination in one
  file. `examples/extensions/plugin-example/README.md` explains the schema field by field and how to install.
- **FR-32** That same manifest is the **core's load-and-validate test fixture**, so the example
  cannot silently rot: a schema change that breaks it fails `cargo test`.

## 5. API contract

`contract/extensions.ts` is **rewritten in place** — the `extensions` domain keeps one contract file
(`_decisions.md`, 2026-08-04 · api). No `contract/extension-install.ts` is created.

**Unchanged**: `PanelScope`, `PrimitiveKind`, `StatusTone`, `ColumnKind`, `ColumnDef`, `PanelInfo`
(minus `action`), `KeyValueRow`, `TableRow`, `StatTile`, `PanelData`, `ExtensionEvent`, `TOKEN_PATTERN`,
and every `EXT_*` cap constant.

**Removed**: `PanelAction`, `ProbeResult`, `LaunchRequest`, `ProbeResponse`, `LaunchResponse`,
`EXT_DASHBOARD_URL`, and `PanelInfo.action`.

**Changed / added**:

```ts
/** FR-3: minted from the directory name, never from the manifest. */
export type ExtensionId = string;
export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** FR-9: a bare binary name resolved on PATH — no separator, no absolute path. */
export const ARGV0_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export const MANIFEST_VERSION = 1;
export const MANIFEST_MAX_BYTES = 256 * 1024;

/** FR-12 — the closed predicate set, as the frontend sees it (for the reason copy). */
export type DetectPredicate =
  | { kind: 'pathExists'; path: string }
  | { kind: 'pathJsonEquals'; path: string; pointer: string; equals: string }
  | { kind: 'commandSucceeds'; argv: string[] };

/** FR-15..FR-18 — the three states a disk extension can be in. */
export type ConsentState =
  | { state: 'granted' }
  | { state: 'never' }
  /** FR-18: consented, then the manifest bytes changed. */
  | { state: 'stale' };

export interface ExtensionSource {
  /** Absolute directory under ~/.francois/extensions. */
  dir: string;
  /** FR-18: sha256 of the manifest bytes as loaded. The consent dialog echoes it
   *  back in `ConsentRequest`, so a manifest edited mid-dialog resolves
   *  EXT_CONSENT_STALE instead of being consented to by accident. Empty string
   *  when the manifest could not be read (`manifestError` non-null). */
  manifestSha256: string;
  /** FR-16/FR-18: every distinct argv the manifest declares, deduplicated, in
   *  declaration order — panels first, then the predicate's. What the consent
   *  dialog renders verbatim. */
  declaredCommands: string[][];
}

export interface ExtensionInfo {
  id: ExtensionId;
  label: string;
  /** FR-15: a key never written reads as FALSE. */
  enabled: boolean;
  consent: ConsentState;
  detected: boolean;
  /** FR-14/FR-17: `null` when detected; `not evaluated — enable to detect`
   *  whenever consent is not `granted` and the predicate is `commandSucceeds`. */
  undetectedReason: string | null;
  minVersionLabel: string | null;
  source: ExtensionSource;
  predicate: DetectPredicate;
  /** FR-6: empty when `manifestError` is non-null — never partially loaded. */
  panels: PanelInfo[];
  /** FR-5/FR-6: the load failure, with its JSON pointer in `detail`. */
  manifestError: AppError | null;
}

/** FR-16 — the only way `enabled` becomes true for a `never`/`stale` extension. */
export interface ConsentRequest {
  extensionId: ExtensionId;
  /** The sha256 the dialog showed, so a manifest edited mid-dialog cannot be
   *  consented to by accident (FR-18). Mismatch ⇒ EXT_CONSENT_STALE. */
  manifestSha256: string;
  root: string | null;
}
```

**Commands** — `extensions_list`, `extensions_set_enabled`, `extensions_detect`, `extensions_panel`,
`extensions_open_stream`, `extensions_close_stream` keep their names, payloads and `Result` shapes.
`extensions_detect` additionally **re-scans the manifest directory** (FR-13). One new command:

| logical channel | tauri command | payload → data |
| --- | --- | --- |
| `francois:extensions:consent` | `extensions_consent` | `ConsentRequest` → `Result<ExtensionInfo[]>` |

`extensions_set_enabled` resolves `EXT_NOT_CONSENTED` when asked to enable an extension whose consent
is not `granted` — the frontend must route through `extensions_consent`.

**Error codes** — added to `ErrorCode` in `contract/common.ts`:

```ts
| 'EXT_MANIFEST_INVALID'      // FR-6: schema failure; detail: { pointer, expected, manifestPath }
| 'EXT_MANIFEST_UNSUPPORTED'  // FR-5: unknown `manifest` version; detail: { found, supported }
| 'EXT_NOT_CONSENTED'         // FR-17: enable/spawn refused before consent
| 'EXT_CONSENT_STALE'         // FR-18: the manifest changed under the dialog
```

Removed: `EXT_PORT_OCCUPIED`, `EXT_LAUNCH_FAILED`.

## 6. Data & state

- **Core** — the loaded registry (`Vec<LoadedExtension>`, rebuilt on launch and on
  `extensions_detect`), each carrying its manifest sha256, its parsed definition or its load error,
  and its source dir. The detection cache stays keyed by normalized root (`extensions` FR-4).
- **Persisted** (`app_data_dir()`, beside the existing toggles): `{ [id]: { enabled, consentSha256 } }`.
  Entries whose directory is gone are dropped on load (FR-19).
- **Frontend** — `extensionsStore` gains `consent` per entry and a pending-consent dialog id. The
  per-panel cursor and stream state are unchanged.

## 7. Edge cases & errors

| Case | Behaviour |
| --- | --- |
| `~/.francois/extensions/` missing | Created at mode `0700` on first load; empty state (FR-26) |
| Directory name fails FR-3 | Listed with `EXT_MANIFEST_INVALID`, never loaded |
| Subdirectory with no `extension.json` | Ignored silently (FR-4) |
| Manifest > 256 KiB / not UTF-8 / not JSON | `EXT_MANIFEST_INVALID` naming the file |
| `"manifest": 2` | `EXT_MANIFEST_UNSUPPORTED`, `detail: { found: 2, supported: 1 }` |
| One bad panel | Whole manifest refused; pointer names it (FR-6) |
| `argv[0]` is `/usr/bin/git` or `bash` | `EXT_MANIFEST_INVALID` (FR-9/FR-10) |
| Two `token` slots | `EXT_MANIFEST_INVALID` (FR-7) |
| `tokenSource` naming a panel in another manifest | `EXT_MANIFEST_INVALID` (FR-7) |
| Enable without consent | `EXT_NOT_CONSENTED`; nothing spawns |
| Manifest edited while the consent dialog is open | `EXT_CONSENT_STALE`; the dialog reloads |
| Manifest edited after consent | Reverts to disabled, `stale` (FR-18) |
| Plugin directory deleted while enabled | Tab closes, streams killed, record dropped (FR-19) |
| `lines` row with fewer/more fields | Fills empty / remainder into the last field (FR-23) |
| `install` onto an existing id | Refused unless `--force` (FR-28) |
| `remove` given a path outside the dir | Refused (FR-29) |

Everything in `extensions` §7 that concerns provider execution, streaming and rendering still applies.

## 8. Design brief

> full brief: `specs/design/extension-install.md`

The Extensions modal gains an `Installed` section: one row per manifest directory carrying the id,
the label, the source path (monospace, truncated left), and either a toggle (consent `granted`) or a
`Review & enable` control (`never` / `stale`). Load failures render in the row itself, in the
`extensions` FR-49 error register — cause, then the manifest path in monospace. The consent dialog is
a `src/ui/Modal` in the `RemoveAccountConfirm` register whose body is the declared commands, one per
line, monospace, unwrapped and horizontally scrollable. The empty state names
`~/.francois/extensions/` and points at the example. No new tokens; no acid accent — nothing here is
the live thing.

## 9. Acceptance criteria

- [ ] With an empty `~/.francois/extensions/`, the app shows no `ext:` tab and the modal's empty
      state names the path (FR-26).
- [ ] Copying `examples/extensions/plugin-example/` in and hitting `Re-detect` lists it as `Installed`,
      disabled, undetected-or-not per the root (FR-13, FR-31).
- [ ] Enabling it shows both `git` commands verbatim before anything runs; cancelling leaves it
      disabled and spawns nothing (FR-16, FR-17).
- [ ] After consent, the `ext:plugin-example` tab renders Branches and pages through Log (FR-21, FR-23).
- [ ] Editing the manifest reverts it to disabled with `changed since you enabled it` (FR-18).
- [ ] A manifest with `argv0: "bash"`, an absolute `argv0`, or two `token` slots is refused with a
      pointer naming the field, and no panel of it loads (FR-6, FR-9, FR-10).
- [ ] A `commandSucceeds` predicate does not execute before consent (FR-17) — asserted by a test
      that would observe the spawn.
- [ ] `francois ext install`/`list`/`remove` work with the app closed; `install` prints `disabled`;
      `remove` refuses a path outside the directory (FR-27..FR-30).
- [ ] `francois ext install cohorte` resolves to `francois-plugin-cohorte` under the default owner
      and installs under the id `cohorte`; an existing `./cohorte` directory wins over it; and
      installing a hand-cloned `francois-plugin-cohorte` path yields the same id (FR-28a).
- [ ] No manifest is read from a repo, `~/.claude`, or an env-var path (FR-1) — asserted by a test.
- [x] `grep -r cohorte-dashboard src src-tauri contract` returns nothing (FR-24).
- [x] `cargo test` loads and validates `examples/extensions/plugin-example/extension.json` (FR-32).

## Remediation

### 2026-08-14 review round 15 (BLOCK — 1 CRITICAL, 1 LOW; 1 MEDIUM resolved as diff-base artifact)
- [x] CRITICAL · `packaging/npm/lib/extensions.js:187` · security · `resolveInstallSource`'s
  leading-`-` refusal interpolated the raw `source` unsanitized, unlike every sibling throw site in
  the function — fixed: wrapped in `sanitizeForDisplay(source)`, plus a regression test in
  `packaging/npm/lib/extensions.test.mjs` asserting the leading-dash error path strips ANSI and bidi
  bytes.
- [x] LOW · `src-tauri/src/extensions/detect.rs:1123` (`sanitize_reason_field`) · security · only
  stripped ANSI/control sequences, not Unicode bidi-control/zero-width code points, unlike
  `manifest::sanitize_argv_element` — fixed: extracted `strip_bidi_and_zero_width` +
  `sanitize_field_strict` into `schema.rs`, `sanitize_argv_element` now composes the shared helper,
  `sanitize_reason_field` calls `sanitize_field_strict`, plus a bidi/zero-width regression test in
  `detect.rs`.
- MEDIUM · `src-tauri/Cargo.toml:3`, `Cargo.lock:9`, `tauri.conf.json:3` — no action: verified as a
  stale-diff-base artifact (branch is 4 commits behind `main`), not a defect. Rebase onto `main`
  before `/cohorte-ship`.
- 2026-08-14 — core 973 cargo tests (3 pre-existing ignored, 1 new), frontend/packaging 1830 vitest
  tests green (2 new), `tsc --noEmit` clean, `cargo check` clean.

### 2026-08-13 review round 1 (BLOCK — 1 CRITICAL, 3 MEDIUM, 1 LOW)
- 2026-08-13 — 5 findings (1 CRITICAL path-containment escape in `detect.rs`, 3 MEDIUM, 1 LOW), all fixed; core + frontend suites green.

### 2026-08-13 review round 2 (BLOCK — 1 CRITICAL, 1 MEDIUM, 3 LOW)
- 2026-08-13 — 5 findings (1 CRITICAL git-URL argv injection in `packaging/npm/lib/extensions.js`,
  1 MEDIUM missing FR-1 env-override test in `fs_util.rs`, 3 LOW), all fixed; core (964) + frontend/
  packaging (1794) suites green, `tsc --noEmit` clean.

### 2026-08-13 review round 3 (BLOCK — 1 CRITICAL, 1 MEDIUM)
- 2026-08-13 — 2 findings (1 CRITICAL unsanitized bidi/control characters in manifest-declared argv
  crossing IPC, 1 MEDIUM missing `formatArgv` hygiene test), all fixed — core:
  `sanitize_argv_element` in `manifest.rs` strips C0/C1 + ANSI + bidi-control + zero-width from every
  `declared_commands()` argv element; frontend: `sanitizeForDisplay` in `extensions.ts` applied to
  `formatArgv` (each token then wrapped in `U+2066…U+2069` isolates), `truncatePathLeft`,
  `manifestErrorCause`/`manifestErrorPath`, and `source.dir` in `ConsentDialog.tsx`. Core 965 cargo
  tests, frontend 1798 vitest tests green; `tsc --noEmit` clean.

### 2026-08-13 review round 4 (BLOCK — 1 CRITICAL, 2 LOW)
- 2026-08-13 — 3 findings (1 CRITICAL require-time `SyntaxError` from unescaped nested backticks in
  `EXT_USAGE`, `packaging/npm/bin/francois.js`, which broke every `francois` CLI invocation; 2 LOW),
  all fixed — frontend: backticks escaped plus a new `packaging/npm/bin/francois.test.mjs` smoke test
  that parses the entrypoint and execs `--help` / `ext --help`, closing the TDD gap that let a syntax
  error in `bin/` ship invisibly; core: `extensions_consent` now refuses with `INVALID_INPUT` when
  `manifest_error.is_some()` (pre-flight extracted into `check_consentable`, refusal precedes the sha
  comparison), and `a_disabled_extension_never_runs_its_exec_predicate` now spawns a real marker script
  and asserts the sentinel file is absent when disabled (with an enabled control). Core 966 cargo tests
  (3 pre-existing ignored), frontend/packaging 1801 vitest tests green; `tsc --noEmit` clean.

### 2026-08-13 review round 5 (BLOCK — 1 HIGH, 2 MEDIUM)
- 2026-08-13 — 3 findings (1 HIGH unsanitized `ext.label` terminal injection in `francois ext list`,
  2 MEDIUM spec-violations — misplaced example README, missing FR-9/FR-10 argv0 check), all fixed —
  `packaging/npm/lib/extensions.js`: added `sanitizeForDisplay` (mirrors `extensions.ts`, applied in
  `listExtensions`) and `assertNoForbiddenArgv0` (walks the manifest tree for `argv0`/`commandSucceeds`
  argv against `ARGV0_PATTERN` + the shell blocklist, wired into both the git-clone and local-dir
  `installExtension` paths before anything is written; module doc corrected to describe the narrower,
  accurate scope); moved `examples/extensions/README.md` → `examples/extensions/plugin-example/README.md`
  (and its one stray doc-comment reference in `src-tauri/src/extensions/provider.rs`). Frontend/packaging
  1810 vitest tests green (9 new), core 966 cargo tests green, `tsc --noEmit` clean.

### 2026-08-14 review round 6 (BLOCK — 6 CRITICAL, 1 HIGH)
- 2026-08-14 — 8 findings (6 CRITICAL + 1 HIGH unsanitized manifest-declared `label`/`undetectedReason`/
  `minVersionLabel` strings rendered raw across the extensions UI, closing the sanitization-boundary gap
  round 3 left open), all fixed — `sanitizeForDisplay` applied at `ExtensionsModal.tsx` (`e.label`,
  `e.undetectedReason`), `ExtensionView.tsx` (`info.label`), `PanelSection.tsx`/`LogTailSection.tsx`
  (`panel.label`), `ExtTable.tsx` (`c.label`, text + `title`), `extensions.ts`'s `errorHeadline`
  (`minVersionLabel`, covering both `ExtSectionError` call sites), and `SessionRow.tsx`'s pre-existing
  sidebar chip (`e.label`, text + `title`). Frontend 1811 vitest tests green (1 new), `tsc --noEmit` clean.

### 2026-08-14 review round 7 (REVISE — 1 CRITICAL, 1 MEDIUM)
- 2026-08-14 — 2 findings (1 CRITICAL unsanitized `panel.emptyCopy` sibling field, 1 MEDIUM inconsistent
  `source.dir` hygiene in a tooltip `title`), all fixed; frontend 1814 vitest tests green (1 new suite),
  `tsc --noEmit` clean.

### 2026-08-14 review round 8 (REVISE — 1 CRITICAL)
- 2026-08-14 — 1 finding (1 CRITICAL unsanitized `AppError.message` rendered raw in
  `ConsentDialog.tsx`, the last sanitization-boundary gap on the consent surface), fixed —
  `error.message` now wrapped in `sanitizeForDisplay`, matching the `source.dir` line above it.
  Frontend 1814 vitest tests green, `tsc --noEmit` clean.

### 2026-08-14 review round 9 (BLOCK — 1 HIGH, 1 MEDIUM, 2 LOW)
- 2026-08-14 — 4 findings (1 HIGH unsanitized `argv0` in `assertValidArgv0`'s thrown message reaching
  stderr via `bin/francois.js`'s `die()`, 1 MEDIUM case/`.exe`-variant bypass of
  `SHELL_ARGV0_BLOCKLIST`, 2 LOW), all fixed — packaging: `sanitizeForDisplay(argv0)` in
  `assertValidArgv0`, and `copyDirSync` now recreates symlinks (`fs.symlinkSync`) instead of
  dereferencing them into the registry; frontend: `sanitizeForDisplay(error.message)` on the
  `ExtensionsModal` error banner; core: `normalize_argv0_for_blocklist` (lowercase + strip trailing
  `.exe`) applied at both blocklist call sites in `manifest.rs` (`require_argv0` and
  `parse_predicate`'s `commandSucceeds` arm), with `bash.exe`/`SH`/`CMD.EXE`/`PowerShell.exe`
  regression cases. Core 967 cargo tests (3 pre-existing ignored), frontend/packaging 1817 vitest
  tests green, `tsc --noEmit` clean.

### 2026-08-14 review round 10 (BLOCK — 1 HIGH, 2 LOW)
- 2026-08-14 — 3 findings (1 HIGH unsanitized `id`/`source`/`name`/`owner` interpolated into thrown
  messages that `bin/francois.js`'s `die()` writes verbatim to stderr, 2 LOW), all fixed — packaging:
  `sanitizeForDisplay(...)` applied at all 7 throw sites in `resolveInstallSource`/`resolveExtensionDir`
  (matching `assertValidArgv0`'s round-9 pattern), and `assertNoForbiddenArgv0` rewritten as an
  iterative explicit-stack walk with a 200-level `MAX_MANIFEST_DEPTH` cap so a deeply nested manifest
  is refused cleanly instead of overflowing the call stack; core: `refresh_ms` parsing in
  `manifest.rs` now falls back to `as_i64()`/`as_f64()` and maps a negative reading to `0`, which
  `to_info()`'s existing `clamp_refresh_ms` raises to `EXT_REFRESH_FLOOR_MS` — so a negative
  `refreshMs` is clamped per FR-7 instead of being dropped as absent. Core 968 cargo tests (3
  pre-existing ignored), frontend/packaging 1820 vitest tests green, `tsc --noEmit` clean.

### 2026-08-14 review round 11 (REVISE — 2 MEDIUM)
- 2026-08-14 — 2 findings, both fixed — `causeText`'s manifest-invalid/unsupported branches now
  delegate to `manifestErrorCause` (removing the duplicated unsanitized interpolation) instead of
  re-wrapping separately; `installExtension`'s git-clone `--force` path now clones into a scratch dir,
  validates the manifest there, and only then swaps it in for `target` — an invalid clone no longer
  destroys a working install. Frontend/packaging 1823 vitest tests green (2 new), `tsc --noEmit` clean.

### 2026-08-14 review round 12 (BLOCK — 1 CRITICAL, 1 HIGH, 1 MEDIUM, 1 LOW)
- 2026-08-14 — 4 findings, all fixed — the last two uncovered fields of the recurring
  sanitization-boundary class (the *identifiers*, not the labels) plus two core hygiene items.
  frontend: `sanitizeForDisplay(e.id)` in `ExtensionsModal.tsx` (the raw, disk-supplied directory
  name shown for FR-3's invalid-id row), with a source-text regression guard in `extensions.test.ts`;
  packaging: `listExtensions` now returns `sanitizeForDisplay`d `id` and `path` alongside the
  round-5 `label`, so `francois ext list` cannot print a hand-copied hostile directory name to
  stdout, plus a "hostile directory name" test; core: `detect.rs`'s `evaluate` sanitizes
  `path`/`pointer`/`equals` through a new `sanitize_reason_field` (wrapping `schema::sanitize_field`)
  before composing `Detection::no(...)`, so `undetected_reason` never crosses IPC carrying raw
  manifest text, and `manifest.rs`'s `parse_columns` refuses a `weight` that does not fit `u32`
  (`invalid(.../weight, "a u32")`) instead of truncating it. Core 971 cargo tests (3 pre-existing
  ignored), frontend/packaging 1825 vitest tests green (4 new), `tsc --noEmit` clean.

### 2026-08-14 review round 13 (BLOCK — 1 CRITICAL, 1 MEDIUM, 2 LOW)
- 2026-08-14 — 4 findings, all fixed — the recurring sanitization-boundary class closed on the
  provider *error* path (round 12 closed the identifiers; this closes the argv). frontend:
  `errorCommand`'s two return branches in `extensions.ts` now wrap `detail.command`/`detail.argv0` in
  `sanitizeForDisplay`, with a bidi regression test mirroring the `causeText`/`errorHeadline` tests;
  `ExtensionView`'s `disable()` no longer swallows a rejected promise or `{ ok: false }` — a
  `disableError` state (with a `useMounted` guard, matching `ExtensionsModal`'s `apply` pattern)
  renders the sanitized message in a new `.ext-view__error` line; packaging: a new
  `statManifest`/`manifestLoadErrorMessage` pair distinguishes "manifest exceeds the 256KiB cap" from
  "missing or not valid JSON" at both call sites (`assertValidManifestOrCleanup` and
  `installExtension`'s local-copy branch), leaving `readManifest`'s null-for-both contract intact for
  `listExtensions`. core: `manifest::sanitize_argv_element` made `pub(crate)` and applied in
  `provider_error`/`spawn_error`, so `detail.command`/`detail.argv0` (and the human-readable message)
  are sanitized in the core payload itself on every `EXT_PROVIDER_MISSING`/`EXT_PROVIDER_TIMEOUT`/
  `EXT_PROVIDER_EXIT`/`EXT_OUTPUT_CAPPED` error, plus a comment on `extensions_panel`'s `_limit`
  noting FR-31's fixed page size. Core 972 cargo tests (3 pre-existing ignored), frontend/packaging
  1828 vitest tests green, `tsc --noEmit` clean.

### 2026-08-14 review round 14 (BLOCK — 1 HIGH, 3 LOW)
- 2026-08-14 — 4 findings, all resolved — the sanitization-boundary class closed on the last
  uncovered CLI path (rounds 5/9/10/12 closed `list`, the thrown-message sites, and the identifiers;
  this closes `install`'s success stdout). packaging: `bin/francois.js`'s `ext install` success path
  now wraps `result.id`/`result.source`/`result.path` in `extensions.sanitizeForDisplay(...)` before
  writing to stdout, matching `listExtensions`' existing sanitization, plus a
  `bin/francois.test.mjs` regression case that installs a fixture whose resolved source path carries
  an ANSI escape and RTL-override/PDF bidi controls in an ancestor directory name and asserts both
  `result`-derived stdout lines are free of C0/C1 and bidi-control code points (verified red→green).
  frontend: `ExtensionView`'s `disable()` gained a `disableBusy` in-flight guard (early-return on
  re-entry, cleared in both branches, mirroring `ExtensionsModal.apply`), with the control reflecting
  it via `tabIndex={-1}`/`aria-disabled`/`.ext-view__disable--busy` (dimmed, `pointer-events: none`).
  The detected-row copy divergence was resolved as **no change**: the design brief's `available here`
  is illustrative of the row layout, while the functional spec mandates exact wording only for the
  negative/undetected case (`unavailable here`) — the shipped `detected` / `detected in <project>`
  copy stands. No `src-tauri` change was needed. Frontend/packaging 1829 vitest tests green (1 new),
  `tsc --noEmit` clean.
