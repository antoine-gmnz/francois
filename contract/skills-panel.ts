// contract/skills-panel.ts — skills-panel (pane [5]).
// Authored from specs/skills-panel.md §5. Imports shared vocabulary from
// common.ts; never redefines it.
//
// Physical Tauri binding: `francois:skills:<verb>` → command `skills_<verb>`;
// the event `francois:skills:event` → Tauri event `francois://skills/event`.

import type { Result, SessionId, SkillInfo } from './common';

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
  args?: string; // optional free-text arguments, appended after the slash command
}
export type SkillsRunResult = Result<void>;

// ---------- francois:skills:event (core → frontend) ----------
export type SkillsEvent = { type: 'skills.changed'; sessionId: SessionId };
