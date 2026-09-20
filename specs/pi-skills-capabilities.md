---
id: pi-skills-capabilities
title: Pi skills, capability-driven UI and extension policy
status: frozen
branch: feat/pi-skills-capabilities
created: 2026-09-18
depends_on: [pi-provider-auth, pi-models-metrics, pi-turn-controls]
reviewed_base:
reviewed_digest:
design_files: []
---

# Pi skills, capability-driven UI and extension policy

## 1. Summary

Expose Pi-loaded skills/templates through François's current views and make unsupported
actions visibly unavailable. Establish the first release's executable extension and
project-resource policy. Sources: [skills/extensions/project-trust audit](research/pi-integration-audit.md).

## 2. Goals & non-goals

- Goals: real loaded skill discovery/invocation, scope labels, capability-driven actions,
  accurate execution warning, and consistent keyboard/palette behaviour.
- Non-goals: MCP/subagent/workflow reimplementation, arbitrary Pi extensions/packages,
  official François Pi extension, extension marketplace, Claude Remote Control parity,
  native approval interception, or automatic skill installation.

## 3. User stories / flows

Open Skills on a Pi session and see its loaded skills/templates. Filter, select, and Run
using Enter or the mouse; invocation fills/submits the documented Pi command through
normal message admission. Open Agents/MCP/Flows via tabs or shortcuts and see why they
are unavailable. New Session states that Pi tools run with the user's permissions and
offers an explicit project-resource choice before first execution.

## 4. Functional requirements

- FR-1: Pi `get_commands` is authoritative for loaded skills/templates. Keep command
  source and scope; do not scan `.claude/` or count uninstalled marketplace entries.
  Preserve exact `/skill:name` spelling. Built-in TUI commands are absent from this list.
- FR-2: Reuse current skills view and slash menu with provider-neutral descriptors.
  Run routes through task 08 admission with an explicit delivery mode; it is not a raw
  `bash` call or an opaque arbitrary RPC invocation. Commands disappearing on reconnect
  return RUNTIME_UNSUPPORTED and refresh the listing.
- FR-3: Baseline Pi capabilities: skills true when discovery is available; skillsInstall,
  mcp, subagents, workflows, permissions, remoteControl and usageBar false. Steering,
  followUps, compaction, resumableSessions and modelSwitching follow certified adapter
  support; images follows current model input; metrics follow observed support/data.
- FR-4: Frontend gates through `sessionCapability` and core validates the same effective
  capability. Tabs, shortcuts, palette, toolbars and context menus agree. Disabled actions
  give a reason; a hidden button alone is not enforcement.
- FR-5: Baseline Pi has no François-enforced tool approvals, filesystem sandbox, project
  confinement or network restriction. Hide misleading plan/accept-edits/bypass controls;
  show “Pi tools run with your user permissions; François does not approve each tool call.”
  Record user acknowledgment per session before first send; never reuse Claude permission rules.
- FR-6: Disable arbitrary extension loading with --no-extensions and no explicit -e,
  raw argv or config path override. No package install/update from François. An installed
  extension/package never elevates capabilities by name or manifest claim. If a baseline
  child emits extension UI requests, cancel known blocking requests, surface policy failure,
  and stop it; never automatically confirm a request as an approval bridge.
- FR-7: Project resources default to ignored using --no-approve even if Pi's global trust
  is permissive. User may explicitly allow the selected project resources for that session;
  describe that instructions/skills/settings may affect behaviour. This does not grant
  permission to load executable extensions. If project package/configuration can execute
  installation helpers despite flags, fail preflight and explain the unsupported configuration.
- FR-8: Show the actual loaded list after policy application; distinguish “no skills”
  from “project resources are disabled.” Pi owns AGENTS.md/SYSTEM.md/context precedence.
  François does not duplicate-load instructions or pretend these text files enforce a sandbox.
- FR-9: Refresh/reload of resource configuration happens on an idle reconnect, not by
  mutating the active run. Directory/file change cannot silently enable new executable code.
- FR-10: Existing François declarative extension tabs remain separate from Pi executable
  extensions. Their enabled state is not an authorization for Pi to run extension code.

## 5. API contract

Amend shared SkillInfo / SkillScope / SlashCommandInfo in `common.ts`; requests remain
in `contract/skills-panel.ts` and `contract/slash-menu.ts` (no duplicate registry).

```ts
// Add optional fields to SkillInfo; required on Pi entries:
interface RuntimeSkillFields {
  invocation: string; // e.g. '/skill:review' or '/summarize'
  source: 'skill' | 'prompt';
  sourcePath?: string;
  loaded: boolean;
  unavailableReason?: string;
}
// Widen existing SkillScope with 'path'; legacy members remain.
interface RuntimeResourcePolicy {
  projectResources: 'ignore' | 'allow';
  extensions: 'disabled';
  acknowledgedUnrestrictedTools: boolean;
}
```

Add optional `resourcePolicy: RuntimeResourcePolicy` to SessionCreateInput and SessionMeta
(required for Pi). Core rejects false acknowledgment on first submit with
RUNTIME_POLICY_REQUIRED; account consent and session tool acknowledgment are distinct.
Profile task 10 can provide an initial projectResources choice but not fabricate the acknowledgment.

Existing `francois:skills:list` / `skills_list` → `Result<SkillInfo[]>` routes to loaded Pi
commands for Pi sessions. Keep existing list request shape; sessionId identifies the runtime.
Extend existing SkillsRunRequest with optional `clientMessageId:string` and
`delivery:DeliveryMode`; both are required for Pi, validated as in task 08. `skills_run`
keeps Result<void>, resolves after admission, and the receipt arrives in queue.changed.
The core resolves the listed skill's exact invocation and submits through the same internal
admissions function as session_submit; the frontend never sends both commands for one run.
SkillsEvent `skills.changed` continues to invalidate the listing after reconnect.
No `skills_install` call may touch Claude settings for a Pi session; return RUNTIME_UNSUPPORTED.
Slash menu augments the Pi list only with François-owned implemented actions (model,
compact, clear-queue); never advertise a TUI-only `/login` as an RPC command.

Effective RuntimeCapabilities and `capabilities` envelope are owned by task 01. Every
unavailable state includes a plain-English reason. Known optional provider features remain
unavailable until verified; no runtime-name checks outside dispatch/default capability tables.
Errors: SESSION_NOT_FOUND, RUNTIME_UNSUPPORTED, RUNTIME_EXITED, RUNTIME_TIMEOUT,
RUNTIME_PROTOCOL_ERROR, RUNTIME_POLICY_REQUIRED, ACCOUNT_CONFIG_UNTRUSTED,
ACCOUNT_CONFIG_CHANGED, INVALID_INPUT, INTERNAL.

## 6. Data & state

Resource policy is snapshotted/persisted with session; acknowledgment never converts into
an allow/deny tool rule. The list is connection-scoped and invalidated on reconnect.
Capabilities are observed state, not user-editable flags. No extension installer state.

Expected files: `session/{skills,slash,interactive}.rs`, `adapter/pi/{resources,process}.rs`,
`src/lib/runtimeCapability.ts`, `src/features/{skills,agents,mcp,workflows,permissions}/`,
New Session/run chip/palette action guards, `src/ui/CapabilityNotice.tsx`.

## 7. Edge cases & errors

Skill name collision: preserve Pi's resolved command identity/order; no second filename
scanner introduces alternatives. Unsupported extension request: cancel/stop with policy
error; do not park a fake permission card. User edits trust settings mid-run: effective
policy stays pinned until reconnect, which revalidates it. Unknown commands fail explicitly.

## 8. Design brief

Use existing Skills and CapabilityNotice components, with accurate source and policy copy.
> full brief: specs/design/pi-skills-capabilities.md

## 9. Acceptance criteria

- [ ] Global/project/path skills and templates reflect actual Pi-loaded commands (FR-1/8).
- [ ] Invocation includes `/skill:` where required and uses normal admission (FR-2).
- [ ] Tabs, shortcuts, palette and core reject unavailable capabilities consistently (FR-3–4).
- [ ] No Pi permission setting claims an enforcement mechanism the adapter lacks (FR-5).
- [ ] Sentinel extensions/packages cannot execute under the certified launch policy (FR-6–7).
- [ ] Existing declarative François extension tabs do not enable Pi code (FR-10).
- [ ] Core capability/discovery/security tests and frontend skill/action state tests pass.

## Remediation

(Empty.)
