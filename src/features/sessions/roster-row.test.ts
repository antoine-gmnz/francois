import { describe, expect, it } from 'vitest';
import type { PermissionAsk, RuntimeMetrics, SessionMeta } from '../../../contract/common';
import type { SessionDerived } from '../../../contract/fleet-board';
import { askLine, contextFraction, formatLineCount, paneBadgeLabel, rosterContextReadout, rowTitle, runningContextFigure, workLine } from './roster-row';
import { UNKNOWN_METRIC } from './runtime-metrics';

function derived(over: Partial<SessionDerived> = {}): SessionDerived {
  return { fileCount: null, runningAgentCount: 0, addedLines: null, deletedLines: null, ...over };
}

function ask(over: Partial<PermissionAsk>): PermissionAsk {
  return {
    toolName: 'Bash',
    summary: 'git push --force',
    inputJson: '{}',
    cwd: '/repo',
    pattern: 'Bash(git push:*)',
    patternLabel: 'git push (any arguments)',
    ...over,
  };
}

function session(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    name: 'context count bugfix',
    cwd: '/home/u/project',
    model: { id: 'm', label: 'Sonnet 5' },
    status: 'idle',
    contextUsedTokens: 0,
    contextLimitTokens: 0,
    startedAt: 0,
    lastActivityAt: 0,
    permissionMode: 'default',
    runtime: 'native',
    accountId: 'default',
    agentRuntime: 'claude-code',
    protocol: 'anthropic',
    ...over,
  } as SessionMeta;
}

describe('askLine', () => {
  it('is the mock\'s own line for a Bash ask', () => {
    expect(askLine(ask({}))).toEqual({ lead: 'Wants to run', code: 'git push --force' });
  });

  it('shortens a file ask to the leaf', () => {
    expect(askLine(ask({ toolName: 'Edit', summary: 'src/lib/api.ts' }))).toEqual({
      lead: 'Wants to edit',
      code: 'api.ts',
    });
  });

  it('names an unknown tool rather than inventing a verb for it', () => {
    expect(askLine(ask({ toolName: 'Playwright', summary: 'click #login' }))).toEqual({
      lead: 'Wants to use Playwright',
      code: 'click #login',
    });
  });

  it('degrades to the lead alone when the ask carries no summary', () => {
    expect(askLine(ask({ summary: '' }))).toEqual({ lead: 'Wants to run', code: '' });
    expect(askLine(ask({ toolName: '', summary: '' }))).toEqual({ lead: 'Wants to use a tool', code: '' });
  });

  it('flattens and truncates a long command', () => {
    const { code } = askLine(ask({ summary: `echo\n${'y'.repeat(200)}` }));
    expect(code.length).toBe(48);
    expect(code.endsWith('…')).toBe(true);
  });
});

describe('rowTitle', () => {
  it('carries everything 12b took off the row', () => {
    const title = rowTitle(
      session({
        cwd: '/home/u/project',
        model: { id: 'm', label: 'Sonnet 5' },
        contextUsedTokens: 289_000,
        contextLimitTokens: 1_000_000,
        worktree: {
          branch: 'feat/x',
          baseRef: 'main',
          path: '/wt',
          sourceRepoRoot: '/home/u/project',
          createdBranch: true,
          fetched: false,
        },
      }),
      '/home/u',
    );
    expect(title).toContain('context count bugfix');
    expect(title).toContain('~/project');
    expect(title).toContain('feat/x');
    expect(title).toContain('Sonnet 5');
    expect(title).toContain('/1M');
  });

  it('omits the segments that would say nothing', () => {
    const title = rowTitle(session(), '/home/u');
    expect(title).toBe('context count bugfix · ~/project · Sonnet 5');
  });
});

describe('contextFraction', () => {
  it('is 0 when the window is unknown — not full', () => {
    expect(contextFraction(session({ contextUsedTokens: 12_000, contextLimitTokens: 0 }))).toBe(0);
  });

  it('divides, and clamps an over-full window to 1', () => {
    expect(contextFraction(session({ contextUsedTokens: 200_000, contextLimitTokens: 1_000_000 }))).toBeCloseTo(0.2);
    expect(contextFraction(session({ contextUsedTokens: 2_000_000, contextLimitTokens: 1_000_000 }))).toBe(1);
  });
});

describe('workLine', () => {
  it("is the design's own line for a dirty tree", () => {
    expect(workLine(derived({ fileCount: 6, addedLines: 184, deletedLines: 52 }))).toEqual({
      added: 184,
      deleted: 52,
      note: '6 files, uncommitted',
    });
  });

  it('says "file" for one', () => {
    expect(workLine(derived({ fileCount: 1, addedLines: 3, deletedLines: 0 }))?.note).toBe('1 file, uncommitted');
  });

  it('is absent for a clean tree — a row that says "0 files" every time is the repetition 12b removes', () => {
    expect(workLine(derived({ fileCount: 0, addedLines: 0, deletedLines: 0 }))).toBeNull();
  });

  it('is absent while the counts are still unknown', () => {
    expect(workLine(undefined)).toBeNull();
    expect(workLine(derived({ fileCount: null }))).toBeNull();
    // A file count without totals (diff.changed landed, the summary has not).
    expect(workLine(derived({ fileCount: 4 }))).toBeNull();
  });
});

describe('formatLineCount', () => {
  it('prints small counts verbatim', () => {
    expect(formatLineCount(0)).toBe('0');
    expect(formatLineCount(184)).toBe('184');
    expect(formatLineCount(999)).toBe('999');
  });

  it("switches to K at four figures, the design's own +1.2K", () => {
    expect(formatLineCount(1200)).toBe('1.2K');
    expect(formatLineCount(1000)).toBe('1.0K');
  });

  it('drops the decimal past ten thousand', () => {
    expect(formatLineCount(12_400)).toBe('12K');
  });
});

function metrics(over: Partial<RuntimeMetrics> = {}): RuntimeMetrics {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    contextTokens: null,
    contextWindow: null,
    contextBasis: 'unknown',
    costUsd: null,
    costBasis: 'unknown',
    measuredAt: 0,
    stale: false,
    ...over,
  };
}

describe('rosterContextReadout (pi-models-metrics §6: no Claude context fallback for Pi)', () => {
  it('reads the legacy fields for a non-Pi session, unchanged', () => {
    const s = session({ contextUsedTokens: 200_000, contextLimitTokens: 1_000_000 });
    expect(rosterContextReadout(s)).toEqual({ fraction: 0.2, usedLabel: '200K', windowLabel: '1M' });
  });

  it('is null for a non-Pi session with no window — never a bar at zero', () => {
    expect(rosterContextReadout(session({ contextLimitTokens: 0 }))).toBeNull();
  });

  it('reads session.metrics for a Pi session — NEVER contextUsedTokens/contextLimitTokens', () => {
    const s = session({
      agentRuntime: 'pi',
      contextUsedTokens: 999_999, // a legacy value that must be ignored outright
      contextLimitTokens: 999_999,
      metrics: metrics({ contextTokens: 84_000, contextWindow: 200_000, contextBasis: 'reported' }),
    });
    expect(rosterContextReadout(s)).toEqual({ fraction: 0.42, usedLabel: '84K', windowLabel: '200K' });
  });

  it('is null for a Pi session before metrics arrive, or with an unknown value', () => {
    expect(rosterContextReadout(session({ agentRuntime: 'pi' }))).toBeNull();
    expect(rosterContextReadout(session({ agentRuntime: 'pi', metrics: metrics({ contextTokens: 1_000, contextWindow: null }) }))).toBeNull();
  });
});

describe('runningContextFigure', () => {
  it('matches the legacy format for a non-Pi session', () => {
    expect(runningContextFigure(session({ contextUsedTokens: 200_000, contextLimitTokens: 1_000_000 }))).toBe('200K/1M');
    expect(runningContextFigure(session({ contextUsedTokens: 200_000, contextLimitTokens: 0 }))).toBe('200K');
  });

  it('is an em dash for a Pi session with nothing reported yet — never a fabricated 0', () => {
    expect(runningContextFigure(session({ agentRuntime: 'pi' }))).toBe(UNKNOWN_METRIC);
  });

  it('formats a Pi session with a known window, and falls back to the bare count without one', () => {
    const withWindow = session({ agentRuntime: 'pi', metrics: metrics({ contextTokens: 84_000, contextWindow: 200_000 }) });
    expect(runningContextFigure(withWindow)).toBe('84K/200K');
    const withoutWindow = session({ agentRuntime: 'pi', metrics: metrics({ contextTokens: 84_000, contextWindow: null }) });
    expect(runningContextFigure(withoutWindow)).toBe('84K');
  });
});

describe('paneBadgeLabel', () => {
  it('names the two-pane positions, and numbers the rest', () => {
    expect(paneBadgeLabel(0, 2)).toBe('left');
    expect(paneBadgeLabel(1, 2)).toBe('right');
    expect(paneBadgeLabel(2, 4)).toBe('3');
  });
});
