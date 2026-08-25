// session-settings-sheet — pure-logic tests (§6: dirtyKeys and the timing
// sentence are derived, pure, unit-tested here), plus the store flag and
// palette entry that reach the sheet's edit mode (FR-19).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

// A file-wide default so a test that never sets its own resolution (or a
// describe block that runs after one that did) still gets a Promise back —
// registerBuiltinCommands() eagerly calls session_models() at import time.
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'not mocked' } });
});
import type { Account } from '../../../contract/multi-account';
import type { ProjectMeta } from '../../../contract/projects';
import type { SessionMeta } from '../../../contract/common';
import {
  SET_PROJECT_DEFAULT_COPY,
  SET_PROJECT_DEFAULT_TITLE,
  buildPatch,
  canSetProjectDefault,
  carryOverToCreate,
  changeCountLabel,
  dirtyKeys,
  draftFromSession,
  effortSupportedByModel,
  fixedAtSpawnLines,
  nextProjectDefaults,
  rebaseDraft,
  timingLine,
  type SettingsDraft,
} from './session-settings';

function session(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    name: 'context count bugfix',
    cwd: '/repo',
    model: { id: 'claude-opus-5', label: 'Opus 5', efforts: ['medium', 'high', 'xhigh'] },
    status: 'running',
    contextUsedTokens: 0,
    contextLimitTokens: 1_000_000,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    permissionModeSince: 0,
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    responseMode: 'default',
    allowGit: false,
    ...over,
  } as SessionMeta;
}

describe('draftFromSession / dirtyKeys', () => {
  it('starts with no dirty keys', () => {
    const s = session();
    const draft = draftFromSession(s);
    expect(dirtyKeys(draft, draft)).toEqual([]);
  });

  it('flags exactly the fields that differ, in field order', () => {
    const baseline = draftFromSession(session());
    const draft: SettingsDraft = { ...baseline, permissionMode: 'acceptEdits', responseMode: 'concise' };
    expect(dirtyKeys(draft, baseline)).toEqual(['permissionMode', 'responseMode']);
  });

  it('compares name trimmed — trailing whitespace alone is not a change', () => {
    const baseline = draftFromSession(session({ name: 'api refactor' }));
    expect(dirtyKeys({ ...baseline, name: 'api refactor  ' }, baseline)).toEqual([]);
    expect(dirtyKeys({ ...baseline, name: 'api refactor v2' }, baseline)).toEqual(['name']);
  });

  it('reverting to the original value clears the dirty flag (FR-14)', () => {
    const baseline = draftFromSession(session());
    const changed: SettingsDraft = { ...baseline, allowGit: true };
    expect(dirtyKeys(changed, baseline)).toEqual(['allowGit']);
    const reverted: SettingsDraft = { ...changed, allowGit: baseline.allowGit };
    expect(dirtyKeys(reverted, baseline)).toEqual([]);
  });
});

describe('buildPatch', () => {
  it('sends only the changed keys, name trimmed', () => {
    const baseline = draftFromSession(session({ name: 'old' }));
    const draft: SettingsDraft = { ...baseline, name: '  new name  ', allowGit: true };
    expect(buildPatch(draft, baseline)).toEqual({ name: 'new name', allowGit: true });
  });

  it('is empty for an unchanged draft', () => {
    const baseline = draftFromSession(session());
    expect(buildPatch(baseline, baseline)).toEqual({});
  });

  it("sends '' for effort cleared back to the model default", () => {
    const baseline = draftFromSession(session({ effort: 'high' }));
    const draft: SettingsDraft = { ...baseline, effort: '' };
    expect(buildPatch(draft, baseline)).toEqual({ effort: '' });
  });
});

describe('rebaseDraft (FR-18)', () => {
  const baseline = draftFromSession(session({ permissionMode: 'default', responseMode: 'default' }));

  it('an untouched field follows a live session.meta', () => {
    const draft = { ...baseline };
    const nextBaseline: SettingsDraft = { ...baseline, permissionMode: 'plan' };
    expect(rebaseDraft(draft, nextBaseline, new Set())).toEqual(nextBaseline);
  });

  it('a touched field holds the user pending value', () => {
    const draft: SettingsDraft = { ...baseline, responseMode: 'concise' };
    const nextBaseline: SettingsDraft = { ...baseline, permissionMode: 'plan' };
    const rebased = rebaseDraft(draft, nextBaseline, new Set(['responseMode']));
    expect(rebased.permissionMode).toBe('plan'); // untouched — followed
    expect(rebased.responseMode).toBe('concise'); // touched — held
  });
});

describe('effortSupportedByModel (EditSheet model-swap effort reset)', () => {
  it('the model default ("") is always supported', () => {
    expect(effortSupportedByModel('', [])).toBe(true);
    expect(effortSupportedByModel('', ['medium', 'high'])).toBe(true);
  });

  it('is true when the level is in the model efforts list', () => {
    expect(effortSupportedByModel('high', ['medium', 'high', 'xhigh'])).toBe(true);
  });

  it('is false when the newly picked model drops the level', () => {
    expect(effortSupportedByModel('xhigh', ['medium', 'high'])).toBe(false);
    expect(effortSupportedByModel('high', [])).toBe(false);
  });
});

describe('changeCountLabel', () => {
  it('pluralises correctly', () => {
    expect(changeCountLabel(0)).toBe('0 changes');
    expect(changeCountLabel(1)).toBe('1 change');
    expect(changeCountLabel(2)).toBe('2 changes');
  });
});

describe('timingLine (FR-15)', () => {
  it('is absent when every change is immediate', () => {
    expect(timingLine(['name', 'allowGit'])).toBeNull();
  });

  it('names the one next-turn field, singular verb', () => {
    expect(timingLine(['allowGit', 'responseMode'])).toBe('response applies from the next turn');
  });

  it('names two next-turn fields, plural verb, in contract order', () => {
    expect(timingLine(['responseMode', 'permissionMode'])).toBe('permissions and response apply from the next turn');
  });

  it('names three+ with an oxford-comma-free list', () => {
    expect(timingLine(['modelId', 'permissionMode', 'responseMode'])).toBe(
      'model, permissions and response apply from the next turn',
    );
  });
});

describe('fixedAtSpawnLines (FR-12)', () => {
  const projects: ProjectMeta[] = [{ id: 'p1', name: 'francois', root: '/repo' } as ProjectMeta];
  const accounts: Account[] = [{ id: 'default', label: 'Default', isDefault: true } as Account];

  it('renders path and runtime even when nothing else applies', () => {
    const lines = fixedAtSpawnLines(session(), [], []);
    expect(lines.map((l) => l.label)).toEqual(['path', 'runtime']);
    expect(lines.find((l) => l.label === 'runtime')?.value).toBe('native');
  });

  it('omits, never blanks, an absent line', () => {
    const lines = fixedAtSpawnLines(session({ projectId: undefined, worktree: undefined }), projects, accounts);
    expect(lines.some((l) => l.label === 'project')).toBe(false);
    expect(lines.some((l) => l.label === 'worktree')).toBe(false);
  });

  it('includes project, worktree, account and profile when present', () => {
    const s = session({
      projectId: 'p1',
      worktree: { branch: 'feat/x', baseRef: 'main', path: '/wt', sourceRepoRoot: '/repo', createdBranch: true, fetched: true },
      profile: { id: 'pr1', name: 'reviewer', replacesSystemPrompt: false },
    });
    const lines = fixedAtSpawnLines(s, projects, accounts);
    expect(lines.map((l) => l.label)).toEqual(['project', 'worktree', 'path', 'runtime', 'account', 'profile']);
    expect(lines.find((l) => l.label === 'worktree')?.value).toBe('feat/x · from main');
    expect(lines.find((l) => l.label === 'profile')?.value).toBe('reviewer');
  });

  it('marks a detached worktree instead of naming a base ref', () => {
    const s = session({
      worktree: { branch: 'a1b2c3d', baseRef: 'main', path: '/wt', sourceRepoRoot: '/repo', createdBranch: false, fetched: false, detached: true },
    });
    expect(fixedAtSpawnLines(s, [], []).find((l) => l.label === 'worktree')?.value).toBe('a1b2c3d (detached)');
  });
});

describe('carryOverToCreate (FR-13 / §7 case 12)', () => {
  const projects: ProjectMeta[] = [{ id: 'p1', name: 'francois', root: '/repo' } as ProjectMeta];

  it('carries the ten values when the project still resolves', () => {
    const s = session({ projectId: 'p1', effort: 'high', accountId: 'acct-2', allowGit: true });
    const seed = carryOverToCreate(s, projects);
    expect(seed).toEqual({
      projectId: 'p1',
      cwd: undefined,
      name: 'context count bugfix',
      modelId: 'claude-opus-5',
      effort: 'high',
      accountId: 'acct-2',
      profileId: '',
      runtime: 'native',
      permissionMode: 'default',
      responseMode: 'default',
      allowGit: true,
    });
  });

  it('falls back to the session cwd when the project no longer resolves', () => {
    const s = session({ projectId: 'gone' });
    const seed = carryOverToCreate(s, projects);
    expect(seed.projectId).toBeUndefined();
    expect(seed.cwd).toBe('/repo');
  });
});

describe('moved from run-chip.ts (FR-17/FR-20)', () => {
  const s = session({ projectId: 'p1', permissionMode: 'plan', effort: 'high' });
  const draft = draftFromSession(s);

  it('names every setting the action writes, git included', () => {
    expect(SET_PROJECT_DEFAULT_COPY).toBe('Set as project default');
    expect(SET_PROJECT_DEFAULT_TITLE).toContain('response mode');
    expect(SET_PROJECT_DEFAULT_TITLE).toContain('git');
  });

  it('offers the project default only for a session that has a project', () => {
    expect(canSetProjectDefault(session())).toBe(false);
    expect(canSetProjectDefault(s)).toBe(true);
  });

  it('writes the sheet CURRENT draft, unapplied edits included', () => {
    const editedDraft: SettingsDraft = { ...draft, responseMode: 'concise', allowGit: true };
    expect(nextProjectDefaults({ runtime: 'wsl' }, editedDraft)).toEqual({
      runtime: 'wsl',
      modelId: 'claude-opus-5',
      effort: 'high',
      permissionMode: 'plan',
      responseMode: 'concise',
      allowGit: true,
    });
  });

  it('clears the effort default when the draft has none, rather than leaving a stale one', () => {
    const noEffort: SettingsDraft = { ...draft, effort: '' };
    expect(nextProjectDefaults({ effort: 'xhigh' }, noEffort)).toEqual({
      modelId: 'claude-opus-5',
      permissionMode: 'plan',
      responseMode: 'default',
      allowGit: false,
    });
  });
});

describe('sessionUpdateSettings wrapper (§5)', () => {
  it('invokes session_update_settings with { sessionId, patch } and resolves the Result', async () => {
    const { sessionUpdateSettings } = await import('../../lib/api');
    const meta = session();
    invokeMock.mockResolvedValue({ ok: true, data: meta });
    await expect(sessionUpdateSettings({ sessionId: 's1', patch: { allowGit: true } })).resolves.toEqual({
      ok: true,
      data: meta,
    });
    expect(invokeMock).toHaveBeenCalledWith('session_update_settings', { sessionId: 's1', patch: { allowGit: true } });
  });

  it('surfaces an ok:false rather than rejecting', async () => {
    const { sessionUpdateSettings } = await import('../../lib/api');
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'SESSION_NOT_RUNNING', message: 'session is not running' } });
    const res = await sessionUpdateSettings({ sessionId: 's1', patch: { modelId: 'claude-opus-5' } });
    expect(res.ok).toBe(false);
  });
});

describe('sessionSettingsId store flag (FR-19)', () => {
  it('defaults to null and holds the session whose settings are open', async () => {
    const { useStore } = await import('../../lib/store');
    expect(useStore.getState().sessionSettingsId).toBeNull();
    useStore.getState().setSessionSettingsId('s1');
    expect(useStore.getState().sessionSettingsId).toBe('s1');
    useStore.getState().setSessionSettingsId(null);
    expect(useStore.getState().sessionSettingsId).toBeNull();
  });
});

describe("'session-settings' palette command (FR-19)", () => {
  async function freshCommands() {
    vi.resetModules();
    const storeMod = await import('../../lib/store');
    const paletteMod = await import('../palette/palette');
    const commandsMod = await import('../palette/paletteCommands');
    commandsMod.registerBuiltinCommands();
    const cmd = paletteMod.paletteCommands().find((c) => c.id === 'session-settings');
    if (!cmd) throw new Error("command 'session-settings' not registered");
    return { useStore: storeMod.useStore, cmd };
  }

  it('is registered with its spec name', async () => {
    const { cmd } = await freshCommands();
    expect(cmd.name).toBe('Session settings…');
  });

  it('is disabled (⇒ hidden) with no active session', async () => {
    const { cmd } = await freshCommands();
    expect(cmd.enabled?.({ activeSessionId: null, runningAgentCount: 0 })).toBe(false);
    expect(cmd.enabled?.({ activeSessionId: 's1', runningAgentCount: 0 })).toBe(true);
  });

  it('opens the sheet for the active session and returns void (no SecondaryStep)', async () => {
    const { useStore: store, cmd } = await freshCommands();
    const step = cmd.run({ activeSessionId: 's1', runningAgentCount: 0 });
    expect(step).toBeUndefined();
    expect(store.getState().sessionSettingsId).toBe('s1');
  });
});
