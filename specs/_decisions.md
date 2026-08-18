# Decisions

> The project's **transverse decision journal** — the non-obvious rules a stateless agent would
> otherwise re-discover or contradict, one feature at a time. `PIPELINE.md` says *how this repo is
> built* (surfaces, commands, conventions); this file says *what was decided and why*.
>
> **Append-only. One line per decision. No prose blocks, no code.** The bound is the point: this file
> is read by `/cohorte-spec`, `/cohorte-brainstorm` and `/cohorte-audit` — the deciding stages — and by **nothing else**.
> Implementers and reviewers never read it: they work from the frozen contract, which already tells
> them what to do; handing them the rationale too would cost `surfaces × dispatches` tokens per
> feature for a fact they cannot act on.
>
> Line shape (≤ ~160 chars, `·`-separated, no wrapping):
>
> ```
> - <YYYY-MM-DD> · <area> · <the decision, imperative> — because <the reason> · <feature_id>
> ```
>
> `<area>` is a short tag, not a path: `auth`, `data`, `api`, `ui`, `deploy`, `naming`, `surfaces`…
>
> **Reversing a decision** never edits or deletes a line — append a superseding one and move the old
> one to `## Superseded`:
>
> ```
> - <YYYY-MM-DD> · <area> · <the new decision> — because <reason> · supersedes <YYYY-MM-DD> <area> · <feature_id>
> ```
>
> **Keep it bounded:** when `## Live` passes ~100 lines, move every superseded line into
> `## Superseded` (the audit trail survives; the section the deciding stages actually read stays
> short). Never summarize or merge live lines — a decision either holds or has been superseded.
>
> **What does NOT belong here:** anything the code, the tests, `PIPELINE.md` §Conventions or a spec
> already states; a feature-local choice (that lives in its spec); a task, a TODO or a finding (those
> are `## Remediation` and `specs/refactor-backlog.md`).

## Live

<!-- newest last -->

- 2026-08-04 · api · Re-keying an existing IPC domain rewrites that domain's contract file in place; never a second file for the same domain — because two files defining the same payload types is how a contract silently forks · multiple-shells
- 2026-08-04 · ui · Bare letters stay GLOBAL shortcuts; a context-local action takes a modified key (⌘X / Ctrl+Shift+X) and must be a documented PTY carve-out — because the shell forwards every unmodified key verbatim · multiple-shells
- 2026-08-04 · security · No third-party origin in the webview — vendor every asset; the CSP names only 'self', ipc: and asset: — because script there reaches the IPC, the PTY and every transcript · webview-hardening
- 2026-08-04 · security · Never tighten style-src nor loosen img-src/font-src — 'unsafe-inline' is forced by xterm's runtime <style> AND the inline style attrs, and img/font-src are what close CSS exfiltration · webview-hardening
- 2026-08-04 · ui · Cap feature CSS at font-weight 600, the design mirror's ceiling — because 700 is off-system and renders faux-bold; only xterm's fontWeightBold may use 700 · webview-hardening
- 2026-08-05 · ui · `activeSessionId` means the LEFT/only main pane; anything meaning "the session the user is looking at" reads the derived `focusedSessionId` selector — because storing focus in `activeSessionId` would remount the transcript on every focus change · split-session
- 2026-08-11 · api · `remote-control` "Francois cannot be a client" is scoped to Remote Control sessions only; cloud sessions have documented CLI verbs and ARE reachable — because collapsing the two objects kills a feasible feature · cloud-sessions
- 2026-08-11 · auth · Francois READS Anthropic credentials (`<configDir>/.credentials.json` → `claudeAiOauth`) but never mints, refreshes or writes them — because two writers on one token file is how a login silently breaks · cloud-sessions
- 2026-08-11 · api · A hidden CLI surface (`.hideHelp()` flag, undocumented endpoint) may only power a degrade-to-empty convenience path, never the authoritative one, and needs a canary test — because it can move without deprecation · cloud-sessions
- 2026-08-13 · ui · Block only irreversible choices; risky-but-recoverable ones are annotated, not blocked — because a blocked legitimate case has no escape hatch · attach-to-worktree
- 2026-08-13 · scope · Worktree UI stays inside New Session, scoped to the probed repo — no cross-project inventory/manager — because git already owns that state · attach-to-worktree
- 2026-08-13 · design · `design_files: []` stays empty; §8 brief + `specs/design/attach-to-worktree.md` is the design source — because a two-chip/picker addition inside existing modal chrome doesn't warrant fresh Claude Design mockups, matching collapse-right-column/multiple-shells/workflow-details · attach-to-worktree
- 2026-08-04 · security · Sanitize subprocess output in the core before it crosses IPC, never at display time — because the webview holds IPC authority and a display-time strip is one forgotten renderer from an XSS · extensions
- 2026-08-04 · ui · A main-pane tab family about the SESSION closes on session change; one about the PROJECT re-scopes and stays — because agent:/workflow: set the closing precedent and ext: would silently inherit the wrong one · extensions
- 2026-08-13 · surfaces · Extension manifests are read from `~/.francois/extensions/` ONLY, never from a repo or any project-relative path — because the impersonation threat was always repo-scoped, and a user directory a clone cannot write to does not carry it · supersedes 2026-08-04 surfaces · extension-install
- 2026-08-13 · surfaces · A disk-loaded artifact's id is its DIRECTORY NAME, never a field it declares — because a name it cannot forge makes impersonation and id collision structurally impossible instead of validated against · extension-install
- 2026-08-13 · security · Discovery is not authorization: anything loaded from disk arrives disabled and executes nothing — not even its own detection probe — until the user consents to its declared argv, and the consent is bound to the artifact's content hash — because otherwise the mechanism that precedes the gate walks around it, and trusted-then-mutated is free · extension-install
- 2026-08-17 · surfaces · UI-authored registries persist as one JSON in the APP DATA DIR (projects/accounts/profiles); `~/.francois/` is for artifacts read FROM disk only — because a hand-editable file the app trusts re-opens the impersonation surface the extension-install consent gate was written to close · session-profiles
- 2026-08-17 · ui · Acid marks the ONE focused/singular surface; the same state on a repeatable surface (list row, fleet card) renders neutral + a marker — because one-acid-per-view and "always show why this differs" only reconcile by splitting the treatment by surface cardinality · session-profiles
- 2026-08-17 · security · A validation the core owns is re-run at every entry point that accepts the same value from the frontend, never trusted once — because the frontend is not the authority on the core's own parser/stream contract · session-profiles
- 2026-08-17 · ui · When two registries can set the same value, exactly one owns it — a profile carries no model/effort/permission mode because the project it is paired with already does — because two owners for one value make precedence invisible at the point of use · session-profiles
- 2026-08-17 · data · Deleting a row sweeps every cross-registry reference to it (project defaults naming a profile/account), best-effort AFTER the delete commits — because a resolve-time fallback hides dangling refs but lets them accumulate, and failing the delete to protect a harmless stale id refuses what the user asked for · session-profiles
- 2026-08-17 · security · Drop empty and non-absolute entries from any PATH override on a child spawned in a repo-controlled cwd — because a bare argv0 would otherwise resolve inside a hostile clone · ext-path-resolution
- 2026-08-18 · deps · No third-party grammar/parser engine may run over repo or transcript content in the webview, and no dependency added for a display nicety — because the npm-first install sells on bundle size and the engine parses untrusted input inside the IPC-authoritative webview · diff-navigator
- 2026-08-18 · ui · In a navigator whose rows are not all selectable, the keyboard CURSOR is separate state from the SELECTION and the detail pane never blanks on a non-selectable row — because collapsing them makes traversal destroy what the user was reading · diff-navigator
- 2026-08-18 · ui · A filter is a view, never a mutation: it changes visibility only, and any action whose scope exceeds what is visible must state the hidden count rather than be blocked or silently narrowed — because a filter that edits selection loses hand-built state on every keystroke · diff-navigator

## Superseded

<!-- moved here when a line above supersedes them; never deleted -->
- 2026-08-04 · surfaces · Extension definitions are a compiled-in array — never a manifest read from disk at any scope — because an id allowlist stops unknown extensions but never a repo impersonating a known one · extensions · superseded 2026-08-13 by extension-install
- 2026-08-13 · api · `ext install <name>` resolves a bare name by the `francois-plugin-<name>` naming convention, never through an index — because the refused non-goal was the registry (search, curation, a trust relationship with whoever is listed), and a string substitution that fetches nothing to decide where to look carries none of that · extension-install
