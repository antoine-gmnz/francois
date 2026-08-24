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
- 2026-08-12 · data · A session's provider is DERIVED from its account's kind at creation and never chosen or re-derived — because two sources of truth for which wire a session speaks is how a session ends up pointed at a key it does not have · multi-provider-seam
- 2026-08-12 · auth · Non-OAuth provider keys live in a 0600/ACL-restricted file in the account config dir, never the OS keychain, and never enter session state, the transcript or diagnostics — because one code path on three platforms beats a keychain that is absent on headless Linux · multi-provider-seam
- 2026-08-12 · ui · Parity with Claude Code's tuned harness is not a goal for Francois-loop sessions; their first turn states so once, in-transcript — because otherwise every tool-loop quality gap gets filed as a Francois bug · multi-provider-seam
- 2026-08-12 · auth · Secret material is WRITE-ONLY across the IPC boundary — a payload carries `hasKey`, never the value, and no verb reads a secret back — because a secret that can be read back is one debug log or one screenshot from disclosure · multi-provider-endpoint
- 2026-08-12 · ui · A new credential kind ships listable-but-NOT-selectable until its runner exists, with a stated reason — because an account that mints a session which dies on an unavailable adapter is worse than one that says "not yet" · multi-provider-endpoint
- 2026-08-12 · security · Permission rules never cross credentials: a new account kind starts with an empty global tier and every tool asks — because a rule granted to one vendor's model is not consent for another's · multi-provider-openai
- 2026-08-12 · naming · Tools Francois executes itself take Claude Code's tool NAMES verbatim (Read/Write/Edit/Grep/Glob/Bash) — because permission rules are one vocabulary, and a second dialect would re-ask the user for what they already allowed · multi-provider-openai
- 2026-08-12 · data · Wire-format conversation state lives in an adapter-owned thread file, never merged into the durable-sessions transcript — because the transcript is a render model and collapsing the two makes every future adapter's wire format the UI's problem · multi-provider-openai
- 2026-08-14 · naming · A session carries TWO axes — `agentRuntime` (who owns the loop) and `protocol` (the wire dialect); the vendor is named by the account, by neither axis — because Claude Code honours ANTHROPIC_BASE_URL, so runtime×dialect is a real matrix one enum cannot name · supersedes 2026-08-12 naming · multi-provider-seam
- 2026-08-14 · ui · A capability that is merely not built yet says "yet"; only a genuine vendor service states what it is — because "X is a Claude Code feature" writes a v1 gap into the architecture and the next agent reads it as settled · multi-provider-seam
- 2026-08-14 · api · Skills port across runtimes (name+description injected into the system prompt); MCP, subagents and workflows do not until they have a client/dispatcher — because a skill's whole mechanism is instructions, and the discovery already exists · multi-provider-openai
- 2026-08-16 · stack · The Francois loop streams SSE over the crate's existing blocking `ureq` on a spawned thread — no `tokio`, no `reqwest`, no async runtime — because the core has zero async today and `begin_turn` already hands work to a reader thread, so an async runtime would be a larger change than the feature it serves · multi-provider-openai
- 2026-08-17 · ui · When two registries can set the same value, exactly one owns it — a profile carries no model/effort/permission mode because the project it is paired with already does — because two owners for one value make precedence invisible at the point of use · session-profiles
- 2026-08-17 · data · Deleting a row sweeps every cross-registry reference to it (project defaults naming a profile/account), best-effort AFTER the delete commits — because a resolve-time fallback hides dangling refs but lets them accumulate, and failing the delete to protect a harmless stale id refuses what the user asked for · session-profiles
- 2026-08-17 · security · Drop empty and non-absolute entries from any PATH override on a child spawned in a repo-controlled cwd — because a bare argv0 would otherwise resolve inside a hostile clone · ext-path-resolution
- 2026-08-17 · api · An undocumented OS-state probe degrades to the PERMISSIVE answer (act as if the restriction is absent), never the restrictive one — because a moved OS surface must lose a convenience, never silently disable a feature · audio-cues
- 2026-08-17 · surfaces · Session-event derivation lives in ONE trigger source that fans out to registered sinks; a new consumer registers a sink and never opens its own onSessionEvent — because a second copy of lastStatus/seenAsks drifts and double-fires · audio-cues
- 2026-08-18 · deps · No third-party grammar/parser engine may run over repo or transcript content in the webview, and no dependency added for a display nicety — because the npm-first install sells on bundle size and the engine parses untrusted input inside the IPC-authoritative webview · diff-navigator
- 2026-08-18 · ui · In a navigator whose rows are not all selectable, the keyboard CURSOR is separate state from the SELECTION and the detail pane never blanks on a non-selectable row — because collapsing them makes traversal destroy what the user was reading · diff-navigator
- 2026-08-18 · ui · A filter is a view, never a mutation: it changes visibility only, and any action whose scope exceeds what is visible must state the hidden count rather than be blocked or silently narrowed — because a filter that edits selection loses hand-built state on every keystroke · diff-navigator
- 2026-08-19 · ui · A regime or viewport may CONSTRAIN a user-set value at render time without owning it — stored = intent, rendered = intent ∩ fit, and the constraint never writes back — because otherwise every fit rule reads as a second owner and the one-owner rule blocks legitimate clamping · resizable-sidebar
- 2026-08-19 · ui · Visibility and size are separate state: a gesture that hides a surface never writes its size, so reopening restores the user's value and not the default — because collapsing is what makes a resize gesture destructive · resizable-sidebar
- 2026-08-19 · design · Once a dimension becomes user-settable the design mirror owns its DEFAULT and no longer its runtime value; review and align-ds must not read that divergence as drift — because the mock stays the source of truth for everything it still governs · resizable-sidebar
- 2026-08-20 · ui · A pane [1] grouping tier nests INSIDE a state band, never above it — because state-first order is what keeps a blocked session off row four · roster-group-tier
- 2026-08-20 · ui · A derived grouping heading is suppressed when the band resolves to ONE group — because a heading that partitions nothing costs a row and teaches nothing · roster-group-tier
- 2026-08-20 · data · Group membership is hand-assigned only, never inferred from a name or path prefix — because a prefix misses members and silently reclassifies on rename · roster-group-tier
- 2026-08-23 · api · A change-only injection channel must emit an explicit REVERT instruction when returning to the neutral value, never fall silent — because the previous instruction survives in the thread's own history · response-mode
- 2026-08-23 · api · Instruction/prompt text the core injects never crosses the IPC boundary; the frontend gets the enum plus a label/hint table only — because text the webview can read is text it will be asked to edit, and that is a registry feature, not a setting · response-mode

## Superseded

- 2026-08-12 · naming · A session's provider names the RUNNER (`claude-code` | `openai-compatible`), never the vendor — because an Anthropic-API-through-our-own-loop path would make a vendor name a lie the day it lands · multi-provider-seam

<!-- moved here when a line above supersedes them; never deleted -->
- 2026-08-04 · surfaces · Extension definitions are a compiled-in array — never a manifest read from disk at any scope — because an id allowlist stops unknown extensions but never a repo impersonating a known one · extensions · superseded 2026-08-13 by extension-install
- 2026-08-13 · api · `ext install <name>` resolves a bare name by the `francois-plugin-<name>` naming convention, never through an index — because the refused non-goal was the registry (search, curation, a trust relationship with whoever is listed), and a string substitution that fetches nothing to decide where to look carries none of that · extension-install
- 2026-08-17 · api · One registry, one list call — widen the existing list response rather than add a companion list command for a sibling collection — because two round-trips give the frontend two moments where the halves of one registry disagree · project-groups
- 2026-08-17 · ui · A roster tier is an organising parent, never a SCOPE — the title-bar switcher stays `all | project` — because `activeProjectId` is one id threaded through the board filter, the OVERVIEW auto-switch and the row cursor, so widening it doubles any tier feature · project-groups
- 2026-08-18 · ui · `activeProjectId` filters the ROSTER and OVERVIEW only — it never gates the main pane's contents, count or layout — because a scope that also gates panes collapses the fleet view at the exact moment the fleet story pays off · unbound-panes
- 2026-08-18 · api · When a core-owned resource can belong to two kinds of parent, its owner is a discriminated union on the entity and every event — never an optional id per parent kind — because two optionals encode one required fact and make the invalid states (both, neither) representable · unbound-panes
- 2026-08-18 · data · Persist the INTENT that produces a runtime handle (a shell rooted at project X), never the handle — because a PID/ShellId that outlives its process rehydrates as a dangling reference the UI must special-case forever · unbound-panes
- 2026-08-18 · ui · An APP-scoped view (OVERVIEW) takes the main view over full-width and leaves the pane layout waiting underneath — never unsplits to render itself — because destroying panes to show a view makes the layout unrecoverable, and a view that is auto-selected on a scope change would destroy them on every change · unbound-panes
- 2026-08-17 · surfaces · An OpenAI-compatible vendor API earns no adapter; only its CLI earns a runtime — because endpoint accounts already drive the API · multi-provider-grok
- 2026-08-17 · api · A doc-derived wire format is marked PROVISIONAL and needs a live capture before the parser — because undocumented details are where it bites · multi-provider-grok
- 2026-08-17 · security · An OS guarantee absent on a platform degrades to one in-transcript notice, never a blocked session — because a blocked platform has no escape hatch · multi-provider-grok
- 2026-08-19 · api · A mutable session setting changes at TURN granularity — the verb writes the session, and every runtime picks it up from its next `TurnContext` snapshot; no verb reaches into a running turn — because "next turn" is the only semantic true on all four runtimes, and one runtime re-reading the session mid-turn would silently give it a different rule · session-permission-mode
- 2026-08-19 · ui · The presentation table for a contract enum (label/hint/tone) lives in that feature's contract file the moment a SECOND surface renders it, never imported from the component that needed it first — because a component-local table is how two surfaces end up wording the same choice differently · session-permission-mode
- 2026-08-19 · design · `design_files: []` stays empty; §8 brief + `specs/design/session-permission-mode.md` is the design source — because a badge-to-popover addition inside existing session-row chrome doesn't warrant fresh Claude Design mockups, matching attach-to-worktree/collapse-right-column/multiple-shells/self-update · session-permission-mode
- 2026-08-20 · ui · A prompt the core accepted but has not started is NOT a transcript block — pending intent renders beside the composer and enters the transcript only on the core's echo — because the transcript records what ran, and predicting placement the core owns is what makes live and persisted order diverge · transcript-perf
- 2026-08-20 · ui · Stream-rate events (deltas, PTY data, agent steps, log tails) accumulate in a ref and flush on a frame boundary; never one state dispatch per event — because a per-event dispatch makes render cost scale with token rate × transcript length, and any non-stream event must flush the buffer first to keep order · transcript-perf
- 2026-08-20 · data · A bounded in-memory buffer evicts from the head but never past the oldest UNSETTLED entry — because an entry evicted then upserted by a later event re-appends at the tail and silently reorders what the user reads · transcript-scale
- 2026-08-20 · data · Page an append-with-upsert log over the FOLDED sequence, never raw line offsets, re-folding per request — because a line index is not a block index, and a parse cache re-grows the memory the cap was added to remove · transcript-scale
- 2026-08-20 · surfaces · Exactly ONE Tauri session listener exists in the webview; every consumer subscribes through the session-keyed router and none calls onSessionEvent directly — because per-consumer JS filtering makes event cost scale with panes × fleet · extends 2026-08-17 surfaces · transcript-scale
