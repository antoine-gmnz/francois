import { describe, expect, it } from 'vitest';
import type { LegacySessionProfile, PiProfileSettings } from '../../../contract/session-profiles';
import { MAX_PI_INSTRUCTION_PATHS, MAX_PI_SKILL_PATHS, MAX_PROFILE_NAME, MAX_SYSTEM_PROMPT } from '../../../contract/session-profiles';
import {
  EMPTY_PI_DRAFT,
  canSavePiDraft,
  invalidPaths,
  isAbsolutePath,
  omittedExtraArgsLine,
  parsePathList,
  piCopyDraftFromLegacy,
  piDraftError,
  piDraftFromSettings,
  piSettingsFromDraft,
  piSystemPromptRequired,
  toggleTool,
  toolsSummary,
} from './pi-profile';

function legacy(overrides: Partial<LegacySessionProfile> = {}): LegacySessionProfile {
  return { id: 'p1', name: 'agent-architect', kind: 'legacy', createdAt: 0, updatedAt: 0, ...overrides };
}

function settings(overrides: Partial<PiProfileSettings> = {}): PiProfileSettings {
  return {
    systemPromptMode: 'default',
    instructionPaths: [],
    skillPaths: [],
    tools: [],
    projectResources: 'ignore',
    ...overrides,
  };
}

describe('piDraftFromSettings / piSettingsFromDraft round-trip', () => {
  it('round-trips a default-mode profile with no paths', () => {
    const s = settings();
    const draft = piDraftFromSettings('role', s);
    expect(draft.name).toBe('role');
    expect(piSettingsFromDraft(draft)).toEqual(s);
  });

  it('round-trips paths through the one-per-line text fields', () => {
    const s = settings({ instructionPaths: ['/a/b.md', '/c/d.md'], skillPaths: ['/e/f.md'] });
    const draft = piDraftFromSettings('role', s);
    expect(draft.instructionPathsText).toBe('/a/b.md\n/c/d.md');
    expect(draft.skillPathsText).toBe('/e/f.md');
    expect(piSettingsFromDraft(draft)).toEqual(s);
  });

  it('drops the prompt when the mode is default', () => {
    const draft = { ...EMPTY_PI_DRAFT, systemPromptMode: 'default' as const, systemPrompt: 'leftover text' };
    expect(piSettingsFromDraft(draft).systemPrompt).toBeUndefined();
  });

  it('keeps the prompt for append/replace', () => {
    const draft = { ...EMPTY_PI_DRAFT, systemPromptMode: 'replace' as const, systemPrompt: 'be terse' };
    expect(piSettingsFromDraft(draft).systemPrompt).toBe('be terse');
  });
});

describe('parsePathList', () => {
  it('splits one path per line, trimming and dropping blanks', () => {
    expect(parsePathList('/a\n  /b  \n\n/c')).toEqual(['/a', '/b', '/c']);
  });

  it('is empty for blank input', () => {
    expect(parsePathList('')).toEqual([]);
    expect(parsePathList('   \n  ')).toEqual([]);
  });
});

describe('isAbsolutePath', () => {
  it('accepts posix absolute paths', () => {
    expect(isAbsolutePath('/home/user/file.md')).toBe(true);
  });

  it('accepts windows drive paths, either separator', () => {
    expect(isAbsolutePath('C:\\Users\\me\\file.md')).toBe(true);
    expect(isAbsolutePath('C:/Users/me/file.md')).toBe(true);
  });

  it('accepts UNC paths', () => {
    expect(isAbsolutePath('\\\\server\\share\\file.md')).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(isAbsolutePath('file.md')).toBe(false);
    expect(isAbsolutePath('./file.md')).toBe(false);
    expect(isAbsolutePath('../file.md')).toBe(false);
  });
});

describe('invalidPaths', () => {
  it('returns only the non-absolute entries', () => {
    expect(invalidPaths(['/a', 'b', 'C:\\c'])).toEqual(['b']);
  });

  it('is empty when every path is absolute', () => {
    expect(invalidPaths(['/a', '/b'])).toEqual([]);
  });
});

describe('piSystemPromptRequired', () => {
  it('is required for append and replace', () => {
    expect(piSystemPromptRequired('append')).toBe(true);
    expect(piSystemPromptRequired('replace')).toBe(true);
  });

  it('is not required for default', () => {
    expect(piSystemPromptRequired('default')).toBe(false);
  });
});

describe('piDraftError / canSavePiDraft', () => {
  it('requires a name', () => {
    const draft = { ...EMPTY_PI_DRAFT, name: '' };
    expect(piDraftError(draft)).toBe('name is required');
    expect(canSavePiDraft(draft)).toBe(false);
  });

  it('requires a prompt for append/replace', () => {
    const draft = { ...EMPTY_PI_DRAFT, name: 'x', systemPromptMode: 'replace' as const, systemPrompt: '' };
    expect(piDraftError(draft)).toBe('a system prompt is required for append/replace mode');
  });

  it('accepts default mode with no prompt', () => {
    const draft = { ...EMPTY_PI_DRAFT, name: 'x' };
    expect(piDraftError(draft)).toBeNull();
    expect(canSavePiDraft(draft)).toBe(true);
  });

  it('rejects a name over MAX_PROFILE_NAME, same bound as the legacy profile', () => {
    const draft = { ...EMPTY_PI_DRAFT, name: 'a'.repeat(MAX_PROFILE_NAME + 1) };
    expect(piDraftError(draft)).toBe(`name is over ${MAX_PROFILE_NAME} characters`);
  });

  it('accepts a name exactly at MAX_PROFILE_NAME', () => {
    const draft = { ...EMPTY_PI_DRAFT, name: 'a'.repeat(MAX_PROFILE_NAME) };
    expect(piDraftError(draft)).toBeNull();
  });

  it('rejects a prompt over MAX_SYSTEM_PROMPT', () => {
    const draft = { ...EMPTY_PI_DRAFT, name: 'x', systemPromptMode: 'append' as const, systemPrompt: 'a'.repeat(MAX_SYSTEM_PROMPT + 1) };
    expect(piDraftError(draft)).toContain('over');
  });

  it('rejects more than MAX_PI_INSTRUCTION_PATHS instruction paths', () => {
    const text = Array.from({ length: MAX_PI_INSTRUCTION_PATHS + 1 }, (_, i) => `/p${i}`).join('\n');
    const draft = { ...EMPTY_PI_DRAFT, name: 'x', instructionPathsText: text };
    expect(piDraftError(draft)).toBe(`at most ${MAX_PI_INSTRUCTION_PATHS} instruction paths`);
  });

  it('accepts exactly MAX_PI_INSTRUCTION_PATHS instruction paths', () => {
    const text = Array.from({ length: MAX_PI_INSTRUCTION_PATHS }, (_, i) => `/p${i}`).join('\n');
    const draft = { ...EMPTY_PI_DRAFT, name: 'x', instructionPathsText: text };
    expect(piDraftError(draft)).toBeNull();
  });

  it('rejects a non-absolute instruction path', () => {
    const draft = { ...EMPTY_PI_DRAFT, name: 'x', instructionPathsText: 'relative/path.md' };
    expect(piDraftError(draft)).toBe('instruction paths must be absolute');
  });

  it('rejects more than MAX_PI_SKILL_PATHS skill paths', () => {
    const text = Array.from({ length: MAX_PI_SKILL_PATHS + 1 }, (_, i) => `/s${i}`).join('\n');
    const draft = { ...EMPTY_PI_DRAFT, name: 'x', skillPathsText: text };
    expect(piDraftError(draft)).toBe(`at most ${MAX_PI_SKILL_PATHS} skill paths`);
  });

  it('rejects a non-absolute skill path', () => {
    const draft = { ...EMPTY_PI_DRAFT, name: 'x', skillPathsText: 'relative/skill.md' };
    expect(piDraftError(draft)).toBe('skill paths must be absolute');
  });
});

describe('toggleTool', () => {
  it('adds an absent tool', () => {
    expect(toggleTool([], 'read')).toEqual(['read']);
  });

  it('removes a present tool', () => {
    expect(toggleTool(['read', 'write'], 'read')).toEqual(['write']);
  });
});

describe('toolsSummary (§7 empty ≠ defaults)', () => {
  it('names an empty allowlist explicitly, never as defaults', () => {
    expect(toolsSummary([])).toBe('no built-in tools');
  });

  it('joins the selected tools', () => {
    expect(toolsSummary(['read', 'grep'])).toBe('read, grep');
  });
});

describe('piCopyDraftFromLegacy (FR-4)', () => {
  it('carries the name and prompt, in replace mode, when the source has a prompt', () => {
    const draft = piCopyDraftFromLegacy(legacy({ name: 'reviewer', systemPrompt: 'be terse' }));
    expect(draft.name).toBe('reviewer');
    expect(draft.systemPromptMode).toBe('replace');
    expect(draft.systemPrompt).toBe('be terse');
  });

  it('falls back to default mode with an empty prompt when the source has none', () => {
    const draft = piCopyDraftFromLegacy(legacy({ name: 'reviewer', systemPrompt: undefined }));
    expect(draft.systemPromptMode).toBe('default');
    expect(draft.systemPrompt).toBe('');
  });

  it('never carries over paths/tools/resources — every copy starts blank', () => {
    const draft = piCopyDraftFromLegacy(legacy({ name: 'reviewer', systemPrompt: 'x' }));
    expect(draft.instructionPathsText).toBe('');
    expect(draft.skillPathsText).toBe('');
    expect(draft.tools).toEqual([]);
    expect(draft.projectResources).toBe('ignore');
  });
});

describe('omittedExtraArgsLine (FR-4)', () => {
  it('shows the raw extra args verbatim', () => {
    expect(omittedExtraArgsLine(legacy({ extraArgsRaw: '--add-dir /tmp' }))).toBe('--add-dir /tmp');
  });

  it('is null when there were none, or whitespace-only', () => {
    expect(omittedExtraArgsLine(legacy())).toBeNull();
    expect(omittedExtraArgsLine(legacy({ extraArgsRaw: '   ' }))).toBeNull();
  });
});
