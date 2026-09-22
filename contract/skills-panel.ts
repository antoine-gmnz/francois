// contract/skills-panel.ts — skills-panel (pane [5]).
// Authored from specs/skills-panel.md §5. Imports shared vocabulary from
// common.ts; never redefines it.
//
// Physical Tauri binding: `francois:skills:<verb>` → command `skills_<verb>`;
// the event `francois:skills:event` → Tauri event `francois://skills/event`.

import type { DeliveryMode, Result, SessionId, SkillInfo } from './common';
// Pi retirement overrides the historical Pi descriptions below: all Pi-targeted
// skill execution/install/listing returns RUNTIME_UNSUPPORTED without native I/O.

// ---------- francois:skills:list ----------
export interface SkillsListRequest {
  sessionId: SessionId;
}
export type SkillsListResult = Result<SkillInfo[]>;

// ---------- francois:skills:install ----------
// "Install" enables the plugin that owns an available (non-enabled) plugin skill,
// by setting its entry in ~/.claude/settings.json `enabledPlugins` (global, applies
// on the next turn). Not a per-project copy. Errors: SESSION_NOT_FOUND, SKILL_ERROR.
export interface SkillsInstallRequest {
  sessionId: SessionId;
  name: string; // an available skill's name (its owning plugin is what gets enabled)
}
export type SkillsInstallResult = Result<void>;

// ---------- francois:skills:run ----------
export interface SkillsRunRequest {
  sessionId: SessionId;
  name: string; // an installed skill or slash-command name (invoked as /<name>)
  /** pi-skills-capabilities: REQUIRED for a Pi session — the LISTED entry's exact
   *  `SkillInfo.invocation`, which is what the core matches on. `name` is derived from it
   *  and is not an identity there: '/skill:deploy' and '/deploy' both list as 'deploy', so
   *  a run keyed on `name` lets a repo's skill shadow the user's command. Ignored by every
   *  other runtime. */
  invocation?: string;
  args?: string; // optional free-text arguments, appended after the slash command
  /** pi-skills-capabilities: REQUIRED for a Pi session (uuid v4), validated exactly as
   *  RuntimeMessageInput.clientMessageId. Ignored by every other runtime. */
  clientMessageId?: string;
  /** pi-skills-capabilities: REQUIRED for a Pi session; same state rules as session_submit. */
  delivery?: DeliveryMode;
}
export type SkillsRunResult = Result<void>;
// pi-skills-capabilities, for a Pi session:
//   skills_list returns the commands the runtime ACTUALLY loaded (its `get_commands`)
//     after the session's resource policy was applied — no `.claude/` scan, no
//     marketplace entries. Every entry carries the RuntimeSkillFields on SkillInfo.
//   skills_run matches the request's `invocation` against the LISTED entries (exact
//     string, never the derived `name`) and admits it through the same internal
//     admissions function as session_submit. A Pi request with no `invocation` is
//     INVALID_INPUT. It resolves after ADMISSION (Result<void>); the receipt arrives on
//     `queue.changed`. The frontend never also calls session_submit for the same run. An
//     invocation that is no longer listed (it vanished on reconnect) is
//     RUNTIME_UNSUPPORTED and the core emits `skills.changed` so the listing refreshes.
//   skills_install is RUNTIME_UNSUPPORTED and touches no Claude settings file.
//   errors: SESSION_NOT_FOUND · RUNTIME_UNSUPPORTED · RUNTIME_EXITED · RUNTIME_TIMEOUT ·
//     RUNTIME_PROTOCOL_ERROR · RUNTIME_POLICY_REQUIRED · ACCOUNT_CONFIG_UNTRUSTED ·
//     ACCOUNT_CONFIG_CHANGED · INVALID_INPUT · QUEUE_FULL · SESSION_BUSY · INTERNAL

// ---------- francois:skills:event (core → frontend) ----------
export type SkillsEvent = { type: 'skills.changed'; sessionId: SessionId };
