// contract/pi-skills-capabilities.ts — canonical imports for Pi skills, capability-driven
// UI and the extension policy. Authored from specs/pi-skills-capabilities.md §5.
//
// The spec amends EXISTING contracts in place ("no duplicate registry"), so this file
// defines no duplicate shapes:
//   - common.ts: SkillInfo gains the RuntimeSkillFields (invocation · source · sourcePath ·
//     loaded · unavailableReason), SkillScope gains 'path', SlashCommandInfo gains
//     `invocation` and the widened scope, RuntimeResourcePolicy, SessionMeta.resourcePolicy,
//     and the RUNTIME_POLICY_REQUIRED error code.
//   - session-engine.ts: SessionCreateInput.resourcePolicy.
//   - skills-panel.ts: SkillsRunRequest.clientMessageId / .delivery and the Pi routing of
//     skills_list · skills_run · skills_install.
//   - slash-menu.ts: unchanged request shape; a Pi session's list is the runtime's own
//     commands plus François-owned implemented actions only.
//
// Effective RuntimeCapabilities and the `capabilities` envelope stay owned by
// pi-runtime-boundary. Every unavailable CapabilityState carries a plain-English `reason`.

export type {
  CapabilityState,
  RuntimeCapabilities,
  RuntimeCapability,
  RuntimeResourcePolicy,
  SkillInfo,
  SkillScope,
  SlashCommandInfo,
} from './common';
export type { SkillsListRequest, SkillsRunRequest, SkillsInstallRequest, SkillsEvent } from './skills-panel';

/** FR-5: the one sentence every Pi surface uses — New Session, run chip, first send. */
export const PI_UNRESTRICTED_TOOLS_NOTICE =
  'Pi tools run with your user permissions; François does not approve each tool call.';

/**
 * FR-3: the baseline a Pi session can never exceed by name or manifest claim. The core's
 * capability table is the authority; this list exists so the frontend's tests can assert
 * that no UI surface treats one of these as reachable for a Pi session.
 */
export const PI_BASELINE_UNAVAILABLE = [
  'skillsInstall',
  'mcp',
  'subagents',
  'workflows',
  'permissions',
  'remoteControl',
  'usageBar',
] as const;
