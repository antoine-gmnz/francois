// pi-migration-rollout §5/§8 — the Pi profile editor's pure logic. Kept apart
// from profiles.ts (which keeps owning the LEGACY profile's pure logic,
// unchanged): a Pi profile is an entirely new, typed surface — no raw argv,
// no free-text extra args — so its draft shape, validation and "Create Pi
// copy" review draft earn their own module rather than growing profiles.ts's
// legacy-shaped functions extra branches.
//
// A profile's `kind` cannot change after creation (FR-2) — this module never
// mutates a `kind`, only ever produces a NEW draft for a new/copied entry.

import type { LegacySessionProfile, PiBuiltinTool, PiProfileSettings } from '../../../contract/session-profiles';
import { MAX_PI_INSTRUCTION_PATHS, MAX_PI_SKILL_PATHS, MAX_PROFILE_NAME, MAX_SYSTEM_PROMPT } from '../../../contract/session-profiles';

// ---------- the editor's working draft ----------

/**
 * The editor's own state: paths are edited as one-per-line text (so a
 * half-typed path never has to round-trip through an array on every
 * keystroke), everything else maps straight onto `PiProfileSettings`.
 */
export interface PiDraft {
  name: string;
  systemPromptMode: PiProfileSettings['systemPromptMode'];
  systemPrompt: string;
  instructionPathsText: string;
  skillPathsText: string;
  tools: PiBuiltinTool[];
  projectResources: PiProfileSettings['projectResources'];
}

/** A brand-new Pi profile starts with NO tools — an explicit, cautious empty
 * allowlist (§7: empty means "no built-in tools", not "the defaults"), never
 * a track it accidentally inherits. */
export const EMPTY_PI_DRAFT: PiDraft = {
  name: '',
  systemPromptMode: 'default',
  systemPrompt: '',
  instructionPathsText: '',
  skillPathsText: '',
  tools: [],
  projectResources: 'ignore',
};

export function piDraftFromSettings(name: string, settings: PiProfileSettings): PiDraft {
  return {
    name,
    systemPromptMode: settings.systemPromptMode,
    systemPrompt: settings.systemPrompt ?? '',
    instructionPathsText: settings.instructionPaths.join('\n'),
    skillPathsText: settings.skillPaths.join('\n'),
    tools: settings.tools,
    projectResources: settings.projectResources,
  };
}

// ---------- path lists ----------

/** One path per line; blank lines and surrounding whitespace are dropped. */
export function parsePathList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Cross-platform absolute check: POSIX `/…`, a Windows drive (`C:\…` / `C:/…`), or a UNC `\\server\share`. */
export function isAbsolutePath(path: string): boolean {
  return /^\//.test(path) || /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

export function invalidPaths(paths: string[]): string[] {
  return paths.filter((p) => !isAbsolutePath(p));
}

// ---------- assembling + validating the settings the core will see ----------

export function piSystemPromptRequired(mode: PiProfileSettings['systemPromptMode']): boolean {
  return mode === 'append' || mode === 'replace';
}

/** §5: absent for 'default' — a stale prompt left over from a previous mode is dropped, never sent. */
export function piSettingsFromDraft(draft: PiDraft): PiProfileSettings {
  return {
    systemPromptMode: draft.systemPromptMode,
    systemPrompt: draft.systemPromptMode === 'default' ? undefined : draft.systemPrompt,
    instructionPaths: parsePathList(draft.instructionPathsText),
    skillPaths: parsePathList(draft.skillPathsText),
    tools: draft.tools,
    projectResources: draft.projectResources,
  };
}

/** null ⇔ the draft may be saved; otherwise the one reason shown inline (§7). */
export function piDraftError(draft: PiDraft): string | null {
  const trimmedName = draft.name.trim();
  if (trimmedName.length === 0) return 'name is required';
  // §5: "same bounds as the legacy profile" — PiSessionProfile.name.
  if (trimmedName.length > MAX_PROFILE_NAME) return `name is over ${MAX_PROFILE_NAME} characters`;
  const prompt = draft.systemPrompt.trim();
  if (piSystemPromptRequired(draft.systemPromptMode) && prompt.length === 0) {
    return 'a system prompt is required for append/replace mode';
  }
  if (prompt.length > MAX_SYSTEM_PROMPT) return `system prompt is over ${MAX_SYSTEM_PROMPT} characters`;
  const instructionPaths = parsePathList(draft.instructionPathsText);
  if (instructionPaths.length > MAX_PI_INSTRUCTION_PATHS) return `at most ${MAX_PI_INSTRUCTION_PATHS} instruction paths`;
  if (invalidPaths(instructionPaths).length > 0) return 'instruction paths must be absolute';
  const skillPaths = parsePathList(draft.skillPathsText);
  if (skillPaths.length > MAX_PI_SKILL_PATHS) return `at most ${MAX_PI_SKILL_PATHS} skill paths`;
  if (invalidPaths(skillPaths).length > 0) return 'skill paths must be absolute';
  return null;
}

export function canSavePiDraft(draft: PiDraft): boolean {
  return piDraftError(draft) === null;
}

// ---------- tool allowlist (§5/§7) ----------

export function toggleTool(tools: PiBuiltinTool[], tool: PiBuiltinTool): PiBuiltinTool[] {
  return tools.includes(tool) ? tools.filter((t) => t !== tool) : [...tools, tool];
}

/** §7: an empty list means NO built-in tools — never "the defaults" — said explicitly. */
export function toolsSummary(tools: PiBuiltinTool[]): string {
  return tools.length === 0 ? 'no built-in tools' : tools.join(', ');
}

export const TOOL_LIST_NOTE = 'restricts which built-in tools this profile may use — not filesystem or network rights.';
export const EMPTY_TOOLS_NOTE = 'no tools selected: the agent has NO built-in tools here, not the defaults.';
export const PROJECT_RESOURCES_NOTE =
  '"allow" lets Pi read this project\u2019s own resource files (e.g. AGENTS.md/SYSTEM.md); "ignore" starts from a blank slate.';

// ---------- "Create Pi copy" of a legacy profile (FR-4) ----------

/**
 * FR-4: only the name and the user-authored system prompt carry over. No flag
 * translation — `--mcp-config`/`--allowedTools`/etc. are never turned into Pi
 * settings, so every other field starts at the same empty draft a brand-new
 * Pi profile would.
 */
export function piCopyDraftFromLegacy(source: LegacySessionProfile): PiDraft {
  const prompt = source.systemPrompt?.trim() ?? '';
  return {
    ...EMPTY_PI_DRAFT,
    name: source.name,
    systemPromptMode: prompt.length > 0 ? 'replace' : 'default',
    systemPrompt: prompt,
  };
}

/** FR-4: the omitted Claude extraArgs, shown verbatim so the user sees what was dropped. Null when there were none. */
export function omittedExtraArgsLine(source: LegacySessionProfile): string | null {
  const raw = source.extraArgsRaw?.trim();
  return raw && raw.length > 0 ? raw : null;
}
