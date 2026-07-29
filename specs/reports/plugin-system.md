# REVIEW REPORT — `plugin-system` · ROUND 2

- **Date**: 2026-07-29 · branch `feat/plugin-web-tabs` · base `main`
- **Spec**: `specs/plugin-system.md` (`status: frozen`, `amended: 2026-07-29`)
- **Round 1**: BLOCK — 12 CRITICAL · 7 HIGH · 13 MEDIUM · 12 LOW
- **Surfaces**: `core` (`src-tauri/` + `plugins/cohorte-dashboard/`) · `frontend` (`src/` + `contract/` + root config)

## Verdict: **SHIP**

| severity | round 1 | round 2 |
|---|---|---|
| CRITICAL | 12 | **0** |
| HIGH | 7 | **1** (spec text — fixed by the lead, see below) |
| MEDIUM | 13 | 8 |
| LOW | 12 | 20 |

**Gates — run by the lead** (both reviewers are read-only by construction; the `review` agent type has no Bash, so this falls to the lead every round):

| gate | result |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npm test` | **596 passed**, 0 failed (24 files) |
| `npm run build` | **clean** |
| `cd src-tauri && cargo test` | **506 passed**, 0 failed, 1 ignored |
| `cargo check --all-targets` | **zero warnings** |
| `cargo fmt --check` | **clean** |

**All 44 round-1 findings are verified closed**, each checked at the call site rather than by presence. The two reviewers independently confirmed the web-tab surface holds against FR-81..FR-86 and FR-82a, including that the byte-for-byte URL pin is a raw `&str` comparison with no `Url::parse` between the two strings that could canonicalize case, a default port, or a trailing slash.

### Already resolved by the lead after the reviews returned

**HIGH 1 · `contract/plugin-system.ts:353-365` · spec-violation** — `francois:plugins:status` was a fourteenth channel the spec never declared, while FR-26 still said "a thirteenth command … the original §5.4 declared twelve", tripping §9's "exactly the channels of §5" criterion. The channel is demanded by §7 #40 and §7 #42, so the fix was the amendment, not a code removal. **Fixed**: §5.4 now carries a `francois:plugins:status` stanza with `PluginStatusOutput` and the cleared-by-the-read semantics; FR-26 cross-references it. No code change.

---

## MEDIUM

### 1 · `PluginDetail` has no `key`, so an armed uninstall confirmation survives a selection change
**quality (FR-74)** — `src/features/plugins/PluginsModal.tsx:407`
Arm the uninstall confirmation for plugin A, click plugin B in the left list: the armed confirmation is still on screen, now naming B. `UninstallControl`'s `confirming` state (`PluginDetail.tsx:576`) is never reset. FR-74 makes the action irreversible — tree, settings, storage, and log ring all deleted. `SettingsForm` guards the analogous leak with an effect (`:409-412`); `UninstallControl` has no equivalent. **This is the only round-2 finding that can destroy user data.**
**Fix:** `<PluginDetail key={selected.manifest.id} plugin={selected} … />`. That also removes the one-frame stale-draft paint in `SettingsForm` and lets its reset effect go.

### 2 · A registry-write failure after a successful update swap leaves the pin describing code that is not running
**correctness (FR-3/FR-4 pin, FR-79, §7 #38)** — `src-tauri/src/plugin/commands/lifecycle.rs:513-538`
`swap_install` succeeds and deletes the `.previous` backup (`unpack.rs:302`); if `persist_or_rollback` then fails at `:536`, the entry rolls back to the **old** manifest and `resolvedRef` while the **new** tree is live on disk. §7 #38 covers the swap failing and FR-79 covers the write failing — this is the seam between them. On next load `hydrate` catches a capability or tab change, but a same-capability update just runs new code under the old pin, and §10 states the pin's whole value is that it records *what* ran.
**Fix:** keep the `.previous` directory until the registry write returns `Ok` — thread a restore handle out of `swap_install` (or inline the two renames in `plugins_update`) and roll the tree back beside `*entries = snapshot`.

### 3 · FR-84's second half — "the app still boots and renders with it" — is asserted by nothing
**quality (§9 acceptance)** — `src-tauri/tauri.conf.json:26` · `src-tauri/src/plugin/webtab.rs:180-213`
The CSP is checked as a *string* in `cargo test`. It is **not** exercised by `npm run dev:app` — with `build.devUrl` set, Tauri applies the policy only to `tauri://localhost` assets — and no CI job launches a production-config build (`release-main.yml` builds installers and stops). Both failure modes are silent: a wrong `connect-src` kills every `invoke()` with no error surface; a wrong `style-src` renders the whole UI unstyled. The rolling `dev` pre-release *is* a production-mode webview carrying this CSP, so it is the cheapest real check.
**Fix:** before merge, launch one `npm run build:app:dev` artifact and confirm the session list populates (proves IPC) and JetBrains Mono renders (proves fonts); record it on the §9 line. Longer term a `tauri-driver` smoke test is the only way this stops being manual.

### 4 · FR-86's ACL assertion checks one of the two places a `remote` grant can live
**security (defense in depth)** — `src-tauri/src/plugin/webtab.rs:236-251`
`no_capability_grants_a_remote_origin` walks `src-tauri/capabilities/*.json`. Tauri v2 also accepts capabilities declared **inline at `app.security.capabilities` in `tauri.conf.json`**, and `AppHandle::add_capability` can add one at runtime. Both are absent today (verified), so the guarantee holds — but this test *is* the whole of FR-86's evidence.
**Fix:** in the same test, assert `config()["app"]["security"].get("capabilities").is_none()`; if inline capabilities are ever wanted, recurse for a `remote` key instead.

### 5–8 · Four dead exports — round 1's dominant defect recurring at small scale
**quality** — the reviewer re-derived the "tested but never called" check from scratch. Down from ~a dozen (which meant the feature shipped nothing) to four thin duplicates of logic that *is* wired. None is a false green, but each re-opens a second answer to a question that should have one.
- `plugins.ts:627-644` `settingsFormValues` / `PluginSettingsForm` — `PluginDetail.tsx:436-443` re-derives the identical value inline as `shown`.
- `plugins.ts:651-653` `secretDisplay` — `PluginDetail.tsx:439-442` inlines `secretSet ? SECRET_SENTINEL : ''`.
- `plugins.ts:323-325` `pluginTabs` — `App.tsx:117-124` uses `resolvedPluginTabs` and derives ids itself. This one contradicts `resolvedPluginTabs`' own doc-comment, which says a second "does this plugin have a tab?" answer must not exist.
- `pluginsStore.ts:232-234` `selectionFor` — `PluginPane.tsx:447` inlines `clampSelection(...)`.
**Fix:** for each, either wire it at the existing call site or delete it with its test. Prefer deletion where the inline form is clearer.

---

## LOW

**Core**
1. `webtab.rs:198-212` — the CSP assertions are substring matches on an unparsed policy; a reordered `script-src 'unsafe-inline' 'self'` satisfies every one of them. Split on `;` into a directive→sources map and assert per directive.
2. `webtab.rs:204-206` — the recorded justification for `style-src 'unsafe-inline'` credits only xterm.js's runtime `<style>` elements. The load-bearing half is that the entire UI uses React inline `style={{…}}` props, which are style *attributes* (`style-src-attr` falls back to `style-src`). As written, someone dropping xterm.js would read this as permission to tighten the directive and blank the app.
3. `tauri.conf.json:26` — `img-src … blob:` is unused (no `createObjectURL`, no `Worker`, no remote images). Drop `blob:`, keep `data:` for Vite-inlined assets.
4. `isolate/limits.rs:32` — `READ_STATE_MAX_CALLS = 32` is a sixth core-enforced limit appearing in no contract and no FR, and it reports as `too many host calls` — the same message as the 8-call I/O budget — so a plugin author cannot tell which budget they blew. Export it beside `ISOLATE_MAX_IO_CALLS` with its own message, or record it under FR-20.
5. `commands/lifecycle.rs:539` — the dropped-tick cache is not cleared on update, so a tick dropped right after an update answers with the pre-update spec. Self-correcting, but the reasoning that clears it at uninstall applies identically.
6. `registry/mod.rs:133-155` vs `registry/settings.rs:43-114` — the settings form's *descriptors* come from the on-disk manifest (deliberate, FR-16) while its *values* resolve from the consented one. A disk manifest adding a `configuration[]` key without touching capabilities is not `consentPending`, so the modal renders a field that `plugins_set_settings` then rejects as `unknown setting`. Apply the treatment the tab already gets, or resolve the form from `entry.manifest` too.
7. `registry/mod.rs:135-137` — a plugin whose install directory is missing still contributes its tab (`disk_manifest: None` falls back to `entry.manifest`). Nothing unsafe is framed (the URL is the consented one), but §7 #39 calls such an entry inert. A tab needs no code, so surviving is defensible — decide and record which it is.
8. `isolate/prelude.rs:141-145,180,318,337` · `commands/render.rs:366-378` — three "argued with the compiler rather than answered it" spots: an unused `sync` kept alive by `void sync;`, a `plugin_id` parameter discarded with `let _`, and an `unreadable` binding acted on inside the lock then discarded.
9. `contract/plugin-system.ts:748` — `allow-popups-to-escape-sandbox` without `allow-popups` is inert today; its only future effect is that adding `allow-popups` would make popups open **unsandboxed**. Matches FR-83 verbatim so it is not a violation — worth one sentence in the comment at the point someone would be tempted.

**Frontend**
10. `PluginTab.tsx:154-173` — `AttributionStrip`'s copy timer has no unmount cleanup; switching tabs within `TAB_COPIED_MS` fires `setCopied` on an unmounted tree.
11. `PluginTab.tsx:60,115-118` — the iframe `key` is `tab.pluginId` while `loaded` is component state, so an update repointing the tab swaps `src` with `loaded` still `true` and §8·H34's `loading <host>…` never reappears. Key on `tab.url`, or reset on `[tab.url]`.
12. `PluginPane.tsx:72,271` — `⟨invalid node⟩` hardcoded twice while `PANEL_INVALID_NODE` is exported and asserted in tests. Same shape as round-1 finding 28.
13. `PluginDetail.tsx:445` — `key={d.key}` over a plugin-controlled string; uniqueness is a *core* invariant and a duplicate silently drops the second field. The host chips two lines down already use `${i}:${h}`.
14. `PluginPane.tsx:304,397` — `declared` is a fresh `Set` every render and sits in the keydown effect's deps, so the `window` listener is torn down and re-added on every render of a focused pane. `useMemo` on `[plugin.manifest]`.
15. `PluginDetail.tsx:459-471` — the `select` control renders a `—` option whose `''` value `settingPatch` rejects, so a `select` setting is unclearable and the failure reads as a validation error rather than "you can't unset this".
16. `pluginPalette.ts:39-45` — `glyph`/`name`/`hint` are captured at registration and refreshed only when the *id set* changes, so an update renaming a command (same id, new title) leaves the stale row in ⌘K.
17. `src/lib/api.ts:206` — `pluginsGetSettings` has no caller (`PluginDetail` reads `plugin.settings` off the snapshot). Defensible as a contract-mandated wrapper; worth stating.
18. `plugins.ts` is **998 lines** — one under the ~1000 ceiling. Pre-emptively split the tab/§8·H block (`:268-449`) into `pluginTabs.ts` beside its existing test.
19. `package.json:14-15` — round-1 finding 32 still open: `scripts/dev-clean.mjs` exists but `scripts/` is untracked, so a fresh checkout still breaks `npm run dev:app`.
20. Two test gaps, both structural rather than oversights: nothing covers `PluginStatusItems`' loader (the exact wiring round-1 finding 7 was about — PIPELINE §Testing wires no DOM component framework, so the cheapest close is extracting the render-and-store step into a plain function and testing it like `invokePluginCommand`), and nothing asserts that an invalid-URL tab still yields a `resolvedPluginTabs` entry so §8·H35 is reachable.

---

## Known structural limit (worth recording once, not re-raising each round)

Everything needing an `AppHandle` is unreachable from `cargo test`: `plugins_update`'s `PLUGIN_CONSENT_REQUIRED` gate (`lifecycle.rs:483-491`), the staging-identity check (`:493-506`), `plugins_check_update` mutating nothing (`:404-434`), and the render → validate → `record_failure`/`record_success` path (`render.rs:113-148`). The crate has no `lib.rs` and does not enable tauri's `test` feature. The fix pass did the right thing by extracting `check_runnable`, `take_staging`, `last_render`/`remember_render` and `take_status` as pure functions; what remains is glue.

Also not verifiable from a review: the CSP at runtime (MEDIUM 3) and §10's `rquickjs`/`chacha20poly1305` 3-OS matrix.

---

## What is solid (do not disturb)

**Core** — `webtab.rs` is the right size and shape for the rule it carries: one function, three refusals, each with its reasoning attached, borrowing `net::host_allowed` rather than growing a second host matcher. Its FR-84/FR-86 tests are labelled *configuration assertions* with an explicit note that a webview's runtime behaviour cannot be observed from `cargo test` — nothing pretends to have loaded a page. `strip_untrusted_tab` checks the disk tab against the **granted** capabilities rather than the disk manifest's own, closing the "the same edit widened the capabilities" hole, and drops only the tab. `injection.rs`'s pure `decide()` makes "expiry beats the decision" provable at the boundary. `Guard::charge_call` tripping before it returns `Err` — with a test that deliberately swallows the refusal and returns a good spec — is the correct shape for "a budget breach is not catchable". The four splits are clean: no logic went missing, nothing was widened to `pub` beyond Tauri command signatures and serde wire types, and each child kept its tests.

**Frontend** — `PluginTab.tsx` is the strongest new file: the sandbox comes from the contract constant rather than a literal, the refusal path returns *before* any iframe exists, the offending URL is a text child, and the attribution strip shows the **parsed** host rather than the plugin's copy. `resolvedPluginTabs` collapses the gate and the resolution into one decision with `break`-after-`push` ordering, so a dropped tab consumes no slot. `consentPendingReason` discriminates on the capability delta and its test asserts the *negative* — that `lastError`'s wording and `surface` do **not** distinguish the two states — which is the assertion that actually protects it. `pluginInvoke.ts` is one funnel with `busy` in a `finally`, making the FR-50 disabled state trustworthy everywhere at once. `consented: true` appears exactly once in `src/`, inside `PluginConsentCard.onConfirm`.

**Test quality** — `pluginWiring.test.ts` is the right kind of test for round 1's defect: it exercises *call sites*, not helpers. `pluginTabs.test.ts` covers every FR-85 rejection class, wildcard host matching, the sandbox token set by token-equality rather than substring, and FR-82a's two distinct drop states.
