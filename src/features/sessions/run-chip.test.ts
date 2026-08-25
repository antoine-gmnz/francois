// design 11c — "the run chip's menu". The pure half: what the chip says, which
// effort levels a model row offers, and the second line `bypass` earns.

import { describe, expect, it } from 'vitest';
import type { ModelInfo, ResponseMode, SessionMeta } from '../../../contract/common';
import { RESPONSE_MODE_OPTIONS } from '../../../contract/response-mode';
import { bypassNote, effortHint, effortLevels, formatClock, responseModeOption, runChipParts } from './run-chip';

const OPUS: ModelInfo = { id: 'claude-opus-5', label: 'Opus 5', efforts: ['medium', 'high', 'xhigh'] };
const SONNET: ModelInfo = { id: 'claude-sonnet-5', label: 'Sonnet 5', efforts: ['low', 'medium', 'high'] };
const HAIKU: ModelInfo = { id: 'claude-haiku-4-5', label: 'Haiku 4.5' };

function session(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    name: 'context count bugfix',
    cwd: '/repo',
    model: OPUS,
    status: 'running',
    contextUsedTokens: 180_000,
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
    ...over,
  } as SessionMeta;
}

describe('runChipParts', () => {
  it('reads model then permission mode, in the chip’s own order', () => {
    const parts = runChipParts(session({ permissionMode: 'bypassPermissions' }));
    expect(parts.model).toBe('Opus 5');
    expect(parts.mode).toBe('bypass');
    expect(parts.danger).toBe(true);
  });

  it('is not dangerous in any mode but bypass', () => {
    expect(runChipParts(session({ permissionMode: 'plan' })).danger).toBe(false);
    expect(runChipParts(session()).mode).toBe('default');
    expect(runChipParts(session()).danger).toBe(false);
  });

  // response-mode FR-15: the face carries the mode's `short` ONLY when it is not
  // 'default' — the same rule the model chip already applies, so the common case
  // never widens the row.
  it('carries the response mode short only when it is not default', () => {
    expect(runChipParts(session()).response).toBe(null);
    expect(runChipParts(session({ responseMode: 'concise' })).response).toBe('concise');
    expect(runChipParts(session({ responseMode: 'explanatory' })).response).toBe('explain');
    expect(runChipParts(session({ responseMode: 'learning' })).response).toBe('learn');
  });

  it('appends the effort only when the session has one', () => {
    expect(runChipParts(session()).effort).toBe(null);
    expect(runChipParts(session({ effort: 'high' })).effort).toBe('high');
  });
});

describe('effortLevels / effortHint', () => {
  it('offers exactly what the model advertises', () => {
    expect(effortLevels(OPUS)).toEqual(['medium', 'high', 'xhigh']);
    expect(effortLevels(SONNET)).toEqual(['low', 'medium', 'high']);
  });

  it('offers nothing for a model that advertises no effort', () => {
    expect(effortLevels(HAIKU)).toEqual([]);
    expect(effortLevels({ id: 'x', label: 'X', efforts: [] })).toEqual([]);
  });

  it('summarises an unselected model row as a range, or as `no effort`', () => {
    expect(effortHint(SONNET)).toBe('low → high');
    expect(effortHint(HAIKU)).toBe('no effort');
    expect(effortHint({ id: 'x', label: 'X', efforts: ['high'] })).toBe('high');
  });
});

// response-mode FR-13: RESPONSE_MODE_OPTIONS (contract) is the single source for
// every presentation of a mode; nothing maps a mode to a string on its own.
describe('responseModeOption', () => {
  it('resolves every member of the union to its own row', () => {
    expect(responseModeOption('default').label).toBe('default');
    expect(responseModeOption('concise').short).toBe('concise');
    expect(responseModeOption('explanatory').short).toBe('explain');
    expect(responseModeOption('learning').short).toBe('learn');
  });

  it('carries a hint for every mode, so no panel row is ever blank', () => {
    for (const opt of RESPONSE_MODE_OPTIONS) expect(opt.hint.length).toBeGreaterThan(0);
  });

  it('falls back to the first row for a value the union does not carry', () => {
    expect(responseModeOption('shouty' as ResponseMode).mode).toBe('default');
  });
});

describe('formatClock', () => {
  it('is a 24h local wall clock, zero-padded', () => {
    expect(formatClock(new Date(2026, 7, 19, 18, 41).getTime())).toBe('18:41');
    expect(formatClock(new Date(2026, 7, 19, 6, 5).getTime())).toBe('06:05');
  });
});

describe('bypassNote', () => {
  const since = new Date(2026, 7, 19, 18, 41).getTime();

  it('says how long bypass has been on, and where', () => {
    expect(
      bypassNote(
        session({
          permissionMode: 'bypassPermissions',
          permissionModeSince: since,
          worktree: { path: '/wt', branch: 'feat-context-count', detached: false } as SessionMeta['worktree'],
        }),
      ),
    ).toBe('on since 18:41 · worktree feat-context-count');
  });

  it('drops the worktree clause when the session runs in the checkout itself', () => {
    expect(bypassNote(session({ permissionMode: 'bypassPermissions', permissionModeSince: since }))).toBe(
      'on since 18:41',
    );
  });

  it('is null for every other mode — only bypass earns a second line', () => {
    expect(bypassNote(session({ permissionMode: 'plan', permissionModeSince: since }))).toBe(null);
    expect(bypassNote(session({ permissionMode: 'acceptEdits', permissionModeSince: since }))).toBe(null);
  });

  it('is null when the stamp is missing, rather than claiming 1970', () => {
    expect(bypassNote(session({ permissionMode: 'bypassPermissions', permissionModeSince: 0 }))).toBe(null);
  });
});

// session-settings-sheet FR-17/FR-20: the footer's "Set as project default" and
// its nextProjectDefaults/canSetProjectDefault helpers moved to
// session-settings.ts/.test.ts with the run chip's popover — see there.
