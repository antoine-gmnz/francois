---
id: codex-process-adapter
feature_id: codex-process-adapter
title: "09 · Use native Codex App Server for bidirectional sessions"
status: frozen
branch: feat-rollback-pi-changes
created: 2026-09-21
depends_on: [process-session-use-cases, process-child-supervision, process-runtime-events]
design_files: [specs/design/native-process-requests.md]
---

# 09 · Native Codex bidirectional adapter

## 1. Summary

Replace native Codex exec turn execution with Codex-owned App Server stdio behind05/06/07. Preserve existing accounts, catalog, limits, settings and native thread anchors. Native approvals and questions return through the owning adapter; Francois never executes requested tools or substitutes a text prompt for a protocol response.

## 2. Evidence and scope

Installed codex-cli0.155.1 generated schema is in specs/reports/codex-native-schema; protocol analysis in codex-native-protocol-evidence.md; independent real-process evidence in codex-native-live-evidence.md when available. Official reference is https://learn.chatgpt.com/docs/app-server. Schema evidence is not authenticated smoke. The shared ChatGPT link was inaccessible; transport choice follows explicit user/native-process sketch and observed native protocol.

Reuse adapter/codex/{args,wire,translate,models,catalog,usage}, account/codex.rs and existing exec fixtures. Exec behavior remains rollback baseline and migration compatibility evidence; production interactive turns use native App Server, not two competing turn transports. Model/rate-limit probe services can keep existing short-lived App Server use.

## 3. Native transport behavior

- **FR-1** Spawn codex app-server with stdio via06, same selected account CODEX_HOME/runtime/WSL/cwd isolation. Use JSONL native messages, no shell prompt interpolation. Initialize with client identity and only required verified capabilities, then initialized notification. Requests use per-connection ids and match exact JSON string/number identity. No user CODEX_HOME copies or project credentials.
- **FR-2** One owned process per active Francois Codex session; lazy spawn on first turn/resume. thread/start creates new thread; thread/resume receives the saved opaque threadId under the same account home. Never supply history/path to fabricate migration. Persist returned anchor immediately through07. Invalid resume yields existing explicit recoverable error; no silent fresh conversation or automatic uncertain prompt replay.
- **FR-3** turn/start sends text and supported local image inputs under immutable model/effort/sandbox/cwd snapshot. Native reasoning/tools stay in Codex. Normalize thread/turn/item/text/tool/usage/error/terminal notifications through the shared sink. Preserve command/file/MCP/web-search rendering and command-inspect detail where native fields support them; unknown notifications do not become tools.
- **FR-4** Keep native server across successful turn completion and normal turn/interrupt. Stop uses exact threadId+native turnId. On close/connection failure invalidate generation before cancelling requests and process cleanup. Process exits/EOF cannot leave a live pending card or reanimate old output. A subsequent user action may explicitly restart/resume; never replay an uncertain turn automatically.
- **FR-4a** A turn/start response is not native active-turn readiness. If Stop arrives during start, latch that intent and send native interrupt when turn/started establishes the live turn. The installed native process can return -32600 no active turn to interrupt during this gap; keep the intent scoped and wait for started/completed instead of treating that race as successful cancellation or retrying user input. Completion winning the race closes once. Closing the session while startup never settles invokes06 bounded cleanup.
- **FR-5** Preserve existing sandbox selection: default/plan read-only; acceptEdits workspace-write; bypassPermissions danger-full-access. Nonbypass native approval policy is on-request, bypass never. Select user approvals reviewer only when supported by verified schema. Do not silently widen sandbox or impersonate a user approval to avoid an unsupported request.

## 4. Native requests and reply authority

- **FR-6** Handle item/commandExecution/requestApproval and item/fileChange/requestApproval. Keep native envelope request id (string or number), approval/item/thread/turn identifiers and generation in adapter-private state. Produce a unique application block id and PermissionAsk. Narrow choices against availableDecisions: native accept -> allowOnce, native decline -> denyOnce, native cancel -> cancel. Native cancel interrupts the turn; label it Cancel turn and resolve cancelled, never disguise it as Deny once. If absent, use only version-verified default choices. Live0.155.1 command requests offered accept, policy amendment and cancel without decline; omit unavailable Deny once and do not offer policy amendments. Do not surface acceptForSession or amendment choices as Claude Always. Unsupported choices fail before any write.
- **FR-7** Handle item/tool/requestUserInput questions with exact opaque id, header/question/options/isOther/isSecret and request isBlocking. Normalize multiSelect:false; native schema does not establish multi-select. Preserve null/empty options as a freeform question. When nonempty options and isOther:false, do not add an invented Other answer. Response is native {answers:{[questionId]:{answers:[string]}}}; adapter maps from current request, validates ids and permitted choices, and preserves two equal question texts with different ids.
- **FR-6a** File approval has a distinct native schema: FileChangeRequestApprovalParams carries threadId, turnId, itemId, startedAtMs, optional reason/grantRoot, and no availableDecisions or command/diff payload. Installed0.155.1 FileChangeApprovalDecision is accept | acceptForSession | decline | cancel. Offer the verified supported subset allowOnce/denyOnce/cancel, returning exactly accept/decline/cancel; omit session grants. Correlate file details only with the current connection generation and matching thread/turn/item id from ThreadItem.fileChange.changes (path, kind, diff). Missing item detail remains an honest generic file approval with native reason/root where available; never borrow another item's command, path or diff. grantRoot remains native-owned metadata, not a Francois permission rule or local root grant.
- **FR-8** UI sends existing sessionId+blockId command, question answers keyed by question.id if present else legacy question text. Core resolves current scope and validates request, not transcript state. Duplicate clicks cause at most one stdin write. Native response writes return AwaitingConfirmation; serverRequest/resolved closes the pending card, using our submitted decision where known and cancellation if native request was removed without a confirmed submitted reply. Removal is not tool success; tool result remains separately driven by item completion.
- **FR-9** Cancellation/turn completion drains native pending requests once. Unknown/stale request ids or old connection generations cannot send. Unsupported server requests receive a protocol error using their exact envelope id when supported, fail clearly otherwise; never run dynamic tools or external auth callbacks inside Francois merely to satisfy a request. Malformed/oversized frames follow06 transport errors.
- **FR-10** Codex allowAlways/denyAlways returns RUNTIME_UNSUPPORTED before PermissionRulePort or Claude settings access. Per-request available choices are validated in backend as well as UI. Enable permissions capability only for live negotiated native transport; no baseline Codex exec capability is invented. Publish existing SessionMeta.runtimeGeneration (opaque string) and negotiated effectiveCapabilities before any live request event; invalidate on replacement/loss. Internal numeric generation may be formatted to this existing field. Historical/unconnected cards remain inert until a native live request exists.
- **FR-11** isSecret answers exist only in transient form state/IPC/native response. Use masked freeform input. Before any resolved event, transcript block/file, diagnostics/error/log or captured protocol trace, replace secret answers with the fixed marker [redacted]; clear transient input after submit/unmount. Preserve answered state and nonsecret answers. Do not serialize raw response envelopes as diagnostics.
- **FR-11a** isSecret changes answer confidentiality, not native choice validation. If options are nonempty and isOther=false, accept only offered option labels, including for secret questions. Freeform is masked when native options/Other permit it; secret option answers are also redacted in stored resolution. Invalid-answer errors never echo submitted values.
- **FR-12** Frontend maintains only a transient projection of live request authority: register session+current generation+block from live permission.asked/question.asked dispatch before subscribers render; remove on resolution, terminal transition, session removal/reset or generation replacement. History hydration grants no reply authority, including during a resumed live session. Cards and roster recheck at invocation and synchronously claim across panes during IPC; core pending map remains final authority. No additional wire/native-id field is introduced.

## 5. Additive shared contract

Lead owns these optional deltas; old consumers remain valid:

- common.ts PermissionDecision = allowOnce | denyOnce | allowAlways | denyAlways | cancel; permission-guardrails.ts re-exports this alias from common rather than defining it twice.
- PermissionAsk.allowedDecisions?: PermissionDecision[]. Absent preserves legacy four-choice behavior (cancel hidden); present is an authoritative offered subset. Empty means no reply choice is actionable.
- SessionQuestion.id?: string; isOther?: boolean; isSecret?: boolean. id absent preserves question-text key. isOther absent preserves existing Claude freeform/Other semantics. isSecret absent means false.
- question.asked SessionEvent and QuestionConversationBlock gain blocking?: boolean. Absent is legacy blocking=true. Nonblocking questions remain visible but do not force awaiting_question status or prevent unrelated native progress.
- AnswerQuestionRequest stays Record<string,string>; resolved answers for secret ids use [redacted]. No new native ids in command shapes, event bus, runtime enum or provider SDK dependency.

Rust serde/persistence readers mirror optional fields with backward-compatible defaults and omission rules. Frontend stores/projection preserve those fields through live and reload paths. No native request data enables Pi.

## 6. Ownership and design

Core: codex native client/adapter/normalization, generation/request maps, settings/capability enforcement, redaction before persistence and fake protocol tests. Frontend: PermissionCard offered choices, QuestionCard opaque answer keys/Other/masked input, nonblocking behavior, store/history projection and tests. Lead: common and feature contracts. Reuse existing cards/labels/buttons; local design brief specs/design/native-process-requests.md. No new panel or arbitrary visual redesign.

## 7. Acceptance

- [ ] Fake native process exercises initialize/start/resume/turn/text/tool/finish/error/interrupt and process cleanup with exact framing, id types and no AppHandle/Engine adapter coupling.
- [ ] Command+file approval native request -> shared card -> command -> exact response -> server removal works; no tool success inferred from removal.
- [ ] Separate file-approval fixtures omit availableDecisions, verify accept/decline/cancel defaults and exact response shape, correlate matching file changes and reject cross-item/turn/generation detail reuse. Command offered-choice evidence does not count as a live file-approval smoke.
- [ ] Native questions with duplicate displayed text/distinct ids, no options, Other=false, secret=true and nonblocking state roundtrip correctly.
- [ ] Cross-session/cross-generation/duplicate/stale answers write nothing additional; unsupported native choices/Always never access Claude rules.
- [ ] Sentinel secret occurs in expected native stdin only; absent from emitted/persisted/transcript/error/diagnostic captures. Legacy Claude nonsecret behavior unchanged.
- [ ] Existing exec-created thread resumes in native App Server under same account; missing/invalid anchor never starts a replacement silently.
- [ ] Existing Codex models/effort, interactive commands, quota/usage and response-mode tests remain green; frontend capabilities use live evidence.
- [ ] Record installed-version real process protocol evidence and authenticated two-turn/interrupt/resume/approval/question smoke separately. Exact unavailable external prerequisites leave corresponding live acceptance unchecked; they do not justify replacing required implementation with permanently unavailable controls.
- [ ] Product integration exercises the actual Francois adapter entry, normalized sink and reply commands; the direct native CLI protocol probe alone does not satisfy this check.

## 8. Readiness

READY to implement after05/06/07 production seam gates and lead's optional contract publication. Core/frontend may work in parallel against frozen optional shapes. Live protocol probe may refine a documented native field mapping from evidence before dispatch; it cannot silently expand the UI/agent scope.

## Remediation

