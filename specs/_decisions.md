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
- 2026-08-12 · naming · A session's provider names the RUNNER (`claude-code` | `openai-compatible`), never the vendor — because an Anthropic-API-through-our-own-loop path would make a vendor name a lie the day it lands · multi-provider-seam
- 2026-08-12 · data · A session's provider is DERIVED from its account's kind at creation and never chosen or re-derived — because two sources of truth for which wire a session speaks is how a session ends up pointed at a key it does not have · multi-provider-seam
- 2026-08-12 · auth · Non-OAuth provider keys live in a 0600/ACL-restricted file in the account config dir, never the OS keychain, and never enter session state, the transcript or diagnostics — because one code path on three platforms beats a keychain that is absent on headless Linux · multi-provider-seam
- 2026-08-12 · ui · Parity with Claude Code's tuned harness is not a goal for Francois-loop sessions; their first turn states so once, in-transcript — because otherwise every tool-loop quality gap gets filed as a Francois bug · multi-provider-seam

## Superseded

<!-- moved here when a line above supersedes them; never deleted -->
