---
id: webview-hardening
title: Webview hardening — self-hosted fonts + Content-Security-Policy
status: shipped
branch: feat/webview-hardening
created: 2026-08-04
depends_on: [app-shell, shell-terminal, session-attachments, multi-account]
loop_pass: 0
loop_phase:
reviewed_base: 17087af4d93ce4d836c3b64a90ccff0fd02f77ad
reviewed_digest: 1a2e8a19bea26714
---

# Webview hardening — self-hosted fonts + Content-Security-Policy

## 1. Summary

The Tauri webview holds real authority: one capability grants `core:default`
(`src-tauri/capabilities/default.json`), so any script executing inside it reaches the IPC, and
through the IPC the PTY and every transcript. Today `"csp": null`
(`src-tauri/tauri.conf.json:26`) — nothing constrains that at all. Independently, `index.html:7-10`
loads IBM Plex Sans and JetBrains Mono from Google Fonts, so the app does not render correctly
offline, calls Google on every launch from a developer tool people run on corporate networks, and
shows FOUT on its own chrome.

The two are coupled: the remote fonts are the **only** external content in the entire app. Vendor
them first and the CSP can name no third-party origin at all. This feature is therefore **one
branch, two commits, in that order** — fonts, then policy. Both must land before the `extensions`
feature: a CSP regression surfaces as something visually odd far from its cause, and in the same
batch as new panels it gets diagnosed as a panel bug.

## 2. Goals & non-goals

- **Goals**
  - Render the design system's typography with zero network access, from committed assets.
  - Turn on a strict `csp` + `devCsp` whose load-bearing directive is `script-src 'self'` — no
    `'unsafe-inline'`, no `'unsafe-eval'`.
  - Leave the fonts commit independently revertable: `git revert` of the CSP commit alone must
    leave a working app with local fonts.
  - Bring the 16 off-system `font-weight: 700` declarations back to the design system's ceiling.
- **Non-goals**
  - **Any automated CSP gate** (a test asserting the policy string, a packaged-build smoke check) —
    explicitly declined; see §7. Verification is manual and per-surface, by decision.
  - **The 85 inline `style={{}}` occurrences across 34 files.** Real, and a `PIPELINE.md` §Code
    layout violation, and the reason `style-src` stays permissive — but a 34-file diff that would
    swallow this feature. Logged in `specs/refactor-backlog.md`, not done here.
  - Splitting `style-src` into `style-src-elem` / `style-src-attr` (refuted — see FR-9).
  - Changing `assetProtocol.scope` (stays `[]`; enforcement lives in
    `src-tauri/src/session/attachments/asset_scope.rs`) · any Tauri capability change · CSP report
    collection · subresource integrity · touching the `extensions` feature.
  - A `devCsp`-only dogfooding release. Dev is looser by construction, so a dev-only rollout cannot
    catch a prod-only violation — it buys the appearance of caution while deferring the check that
    matters.

## 3. User stories / flows

No new screens, no new interactions. The observable flows are:

1. **Offline launch.** A developer with networking disabled opens Francois. Chrome renders in IBM
   Plex Sans, code/paths/counts in JetBrains Mono — identical to an online launch. No FOUT.
2. **Corporate network launch.** Nothing leaves the app at startup; no request to
   `fonts.googleapis.com` or `fonts.gstatic.com` appears in the devtools Network panel.
3. **Terminal bold.** A command in the SHELL tab emits ANSI bold (SGR 1). It renders as a real
   JetBrains Mono 700 face rather than a browser-synthesised smear.
4. **Attachment preview.** A user attaches an image in the composer. The preview loads over the
   asset protocol with the CSP active, on macOS/Linux (`asset://localhost`) and on Windows
   (`http://asset.localhost`).
5. **Hostile-script hypothetical.** Injected markup that tries `<script>`, `eval`, an `<iframe>`,
   or a `<base>` rewrite is refused by the policy before it can reach `invoke`.

## 4. Functional requirements

**Commit 1 — fonts** (must be complete, green, and revertable on its own)

- **FR-1** Vendor **12 `woff2` files** to `src/assets/fonts/`, referenced by relative `url()` from
  `src/styles.css` so Vite hashes and emits them. No new npm dependency; the files are committed.
  - IBM Plex Sans **400, 500, 600** × { `latin`, `latin-ext` }
  - JetBrains Mono **400, 500, 700** × { `latin`, `latin-ext` }
  - `700` is vendored for **JetBrains Mono only**, because both xterm instances request
    `fontWeightBold: '700'` (`src/features/shell/ShellTerminal.tsx:41`,
    `src/features/accounts/AccountLoginTerminal.tsx:45`) and xterm sets its font directly rather
    than through the tokens — so the mirror's 600 ceiling (FR-4) does not govern it.
  - Copy each `unicode-range` value **verbatim** from that family's Google Fonts / fontsource CSS.
    Do not hand-author ranges.
- **FR-2** Declare all 12 faces with `@font-face` in `src/styles.css`, above the `:root` token
  block, each with `font-display: block` and the matching `unicode-range`.
- **FR-3** Delete the three `<link>` tags from `index.html:7-10` (both `preconnect`s and the
  stylesheet). `index.html` must then contain **no external reference of any kind**.
- **FR-4** Rewrite the **16** `font-weight: 700` declarations to `600`. The design mirrors
  (`Francois Design System v2.dc.html`, `Francois Redesign.dc.html`) contain zero `font-weight:700`
  — 600 is the system's heaviest weight, and these sites read as bold today only because the
  browser synthesises faux-bold from the 600 face. Exact sites:
  `projects.css:43,122` · `diff.css:100` ·
  `accounts.css:46,62,122,165,223,301,384,400` · `overview.css:33,81` ·
  `conversation.css:544,569,623` (all under `src/features/<feature>/`).
- **FR-5** Replace the two hardcoded `font-family: 'JetBrains Mono', monospace` declarations
  (`src/features/mcp/mcp.css:247`, `:360`) with `var(--font-mono)` so they inherit the fallback
  chain.
- **FR-6** **Keep** the `system-ui` / `ui-monospace` fallback chain (`src/styles.css:28-29`,
  `--font-ui` / `--font-mono`). With local fonts it is not dead code — it is the path for a
  corrupted or missing asset in a packaged build. Do not simplify it away.
- **FR-7** Ship both OFL-1.1 licence texts (`src/assets/fonts/IBM-Plex-Sans-OFL.txt`,
  `src/assets/fonts/JetBrains-Mono-OFL.txt`). Both families are OFL-1.1, so redistribution inside
  the app is permitted, and an AGPL app that vendors OFL fonts must carry them.

**Commit 2 — CSP**

- **FR-8** Set `app.security.csp` **and** `app.security.devCsp` in `src-tauri/tauri.conf.json`, in
  one commit, to the exact strings in §5.
- **FR-9** `style-src` carries `'unsafe-inline'`. **Both** halves of the reason must be recorded in
  the code review / spec, because a reader who knows only the first will attempt the split, find it
  works in dev, and break the app:
  1. `@xterm/xterm` creates `<style>` elements at runtime (two `createElement("style")` sites in
     `lib/xterm.js`, `StyleElement` identifiers — theme + dimensions). Runtime-created `<style>`
     nodes are governed by `style-src`, so `style-src 'self'` breaks the SHELL tab and the accounts
     login terminal **in production**, not just in dev. A sweep of all eight runtime deps found
     xterm is the **only** one doing this — React, react-dom, zustand, lucide-react,
     `@tauri-apps/api`, the notification plugin and `@xterm/addon-fit` are clean.
  2. 85 inline `style={{}}` occurrences across 34 files, so `style-src-attr 'none'` is impossible
     and the elem/attr split buys nothing but two more directives to get wrong per platform.
- **FR-10** `img-src` must carry **both** asset-protocol spellings — `asset:` and
  `http://asset.localhost` — because they differ per platform (`asset://localhost` on macOS/Linux,
  `http://asset.localhost` on Windows). Listing one breaks attachment previews on the other.
- **FR-11** `devCsp` differs from `csp` in **exactly one** directive: `connect-src` additionally
  allows `http://localhost:1420 ws://localhost:1420` (Vite, `strictPort: true`, plus its HMR
  WebSocket). `style-src 'unsafe-inline'` is needed in prod too (FR-9), so it is **not** a
  dev-only divergence.
- **FR-12** Verify at first launch that Tauri injects nonces/hashes for its own initialisation
  scripts, so `script-src 'self'` suffices. Do not assume — if it does not, this is where the
  feature grows, and the finding must be written into the spec before working around it.
- **FR-13** Confirm-only, change nothing: `app.security.assetProtocol.scope` stays `[]` with
  enforcement in `asset_scope.rs` (403 out of scope). Note in the PR that this was confirmed
  deliberate.

## 5. API contract

**This feature adds nothing to the contract.** No `contract/webview-hardening.ts`, no
`francois:<domain>:<verb>` channel, no event, no Tauri command, no serde struct. It changes
configuration and static assets only.

The interface it *does* pin down is the policy text. These strings are the spec:

**`app.security.csp` (production)**

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' asset: http://asset.localhost; connect-src 'self' ipc: http://ipc.localhost; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

**`app.security.devCsp`** — identical, with `connect-src` extended:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' asset: http://asset.localhost; connect-src 'self' ipc: http://ipc.localhost http://localhost:1420 ws://localhost:1420; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

Directive rationale — the part a future reader needs before editing:

- **`script-src 'self'` is the load-bearing directive.** Script execution is what reaches the IPC,
  and through it the PTY and every transcript. It carries no `'unsafe-inline'` and no
  `'unsafe-eval'`; the audit found no `eval`, `new Function` or `innerHTML` anywhere in `src/`, and
  no inline `<script>` in `index.html`.
- **`connect-src` can be fully locked** because the webview issues no `fetch`/XHR/WebSocket of its
  own — every call goes through `invoke` → Rust.
- **`style-src 'unsafe-inline'` is the one concession**, forced by FR-9's two causes. It cannot be
  nonced: the `<style>` nodes are created by library code at runtime. What makes it acceptable is
  that the classic CSS-injection exfiltration channel (attribute selectors driving
  `background-image: url(https://…)`) is closed by the **neighbouring** directives, not by
  `style-src`: `img-src` is `'self'` plus the asset protocol, `font-src` is `'self'`, `connect-src`
  is local. **Loosening `img-src` or `font-src` silently reopens that channel.**
- **`frame-src 'none'` is not decoration.** It is what makes "no third-party HTML in this webview"
  enforced rather than merely intended, and it is the directive `extensions` would have to change
  if it ever grew an embedded-webview escape hatch. Changing it should require a deliberate edit.

`tauri.conf.json` is strict JSON and cannot carry a comment, so this rationale lives here plus one
line in `specs/_decisions.md`.

## 6. Data & state

No entities, no persistence, no store slice, no derived state. Files touched:

| File | Change |
| --- | --- |
| `index.html` | three `<link>` tags removed (FR-3) |
| `src/styles.css` | 12 `@font-face` blocks added; `--font-ui` / `--font-mono` untouched (FR-2, FR-6) |
| `src/assets/fonts/` | **new** — 12 `woff2` + 2 OFL-1.1 licence texts (FR-1, FR-7) |
| `src/features/{projects,diff,accounts,overview,conversation}/*.css` | 16 × `700` → `600` (FR-4) |
| `src/features/mcp/mcp.css` | `:247`, `:360` → `var(--font-mono)` (FR-5) |
| `src-tauri/tauri.conf.json` | `app.security.csp` + `devCsp` (FR-8) |
| `specs/refactor-backlog.md` | log the 85 inline-`style` violation as a follow-up |

## 7. Edge cases & errors

- **Verification is manual-only, by decision.** Nothing in `npm test` or `cargo test` reads
  `tauri.conf.json`, so nothing re-checks the policy after merge. The concrete failure mode:
  someone later adds an iframe-based preview, `frame-src 'none'` refuses it, and they "fix" it by
  editing the config — exactly the deliberate edit §5 says should be hard, with nothing making it
  hard. **Accepted risk, not an oversight.** Mitigated only by §5's rationale and the
  `specs/_decisions.md` line.
- **`img-src` is platform-divergent and manual-only.** A Mac-only review passes and Windows fails,
  and CI cannot click through the composer either. §9 therefore names the platform each row was
  checked on; an unchecked platform is an unmet criterion, not an assumed pass.
- **Missing / corrupted font asset in a packaged build.** The `system-ui` / `ui-monospace` fallback
  (FR-6) takes over. `font-display: block` means the text is briefly invisible rather than
  swapping — with local files the block period is effectively zero, but on a corrupted asset the
  fallback still resolves.
- **Non-latin text in a transcript.** Cyrillic, Greek and Vietnamese fall back to `system-ui`,
  where today's Google URL serves those ranges. **Deliberate regression** in exchange for a 12-file
  asset set instead of ~30. (IBM Plex Sans has no CJK, so CJK already falls back today — unchanged.)
  If a user reports it, the fix is additive: drop in the extra subset files and their
  `unicode-range` blocks.
- **A `Refused to …` line in the devtools console is a failure**, on any surface in §9 — there is
  no report collector, so the console is the only signal.

## 8. Design brief

**No new design work, and no `specs/design/webview-hardening.md`** — this feature adds no screen,
component, state or interaction. The design mirrors act only as the **arbiter for FR-4**: their
type-role section (`Francois Design System v2.dc.html`, "Type roles") defines IBM Plex Sans for
interface and JetBrains Mono for facts, and neither mirror uses a weight above **600**. FR-4 brings
the code back to that ceiling; FR-1's JetBrains Mono 700 is outside the token system (xterm-only)
and does not contradict it.

The visible delta after FR-4 is that 16 sites become slightly lighter than today's synthesised
faux-bold. That is the intended direction: toward the system.

## 9. Acceptance criteria

**Commit 1 — fonts**

- [x] `git grep -c 'https://fonts' index.html` returns 0; `index.html` has no external reference (FR-3)
- [ ] Launch with networking disabled: chrome renders in IBM Plex Sans, code/paths/counts in
      JetBrains Mono, identical to an online launch (FR-1, FR-2)
- [ ] Devtools Network panel at startup shows no request to any non-local origin (FR-3)
- [x] `git grep -c 'font-weight: 700' src/` returns 0 (FR-4)
- [x] `git grep -c "'JetBrains Mono', monospace" src/features/mcp/mcp.css` returns 0 (FR-5)
- [x] Both OFL-1.1 licence texts are committed under `src/assets/fonts/` (FR-7)
- [x] `npx tsc --noEmit` and `npm test` green; `npm run build` emits the 12 hashed `woff2` into `dist/`
- [ ] **Revertability (FR, hard gate):** with commit 2 applied, `git revert` of commit 2 alone
      leaves an app that builds and launches with local fonts

**Commit 2 — CSP.** Open the webview devtools on each surface and treat any `Refused to …` as a
failure. **Record the platform each row was checked on** (macOS / Windows / Linux); an unchecked
platform is not a pass.

- [ ] SHELL tab renders and accepts input — xterm's runtime `<style>` (FR-9) · platform: ______
- [ ] Accounts login terminal renders — same mechanism, second instance · platform: ______
- [ ] ANSI-bold output in SHELL renders as a real 700 face (FR-1) · platform: ______
- [ ] **An image attachment preview in the composer loads — asset protocol → `img-src` (FR-10).
      Checked on macOS/Linux *and* on Windows**, because the two spellings differ · platforms: ______
- [ ] A transcript with markdown, an agent tab and a workflow tab render normally · platform: ______
- [ ] DIFF on a large diff renders (windowed rendering) · platform: ______
- [ ] Update modal, a desktop notification, and a file dialog work — Tauri plugin surfaces · platform: ______
- [ ] **App launches clean under `tauri dev` *and* from a packaged build** (FR-11) — the dev policy
      is looser, so a dev-only pass proves nothing. This is the row most likely to be skipped and
      the one most likely to bite · platforms: ______
- [ ] Tauri's own init scripts run under `script-src 'self'` with no console refusal (FR-12)
- [ ] `assetProtocol.scope` is still `[]` and the PR notes it was confirmed deliberate (FR-13)
- [x] `devCsp` differs from `csp` in `connect-src` only — diff the two strings (FR-11)

## Remediation

(Empty until a review returns findings.)
