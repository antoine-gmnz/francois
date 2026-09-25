import { describe, expect, it } from 'vitest';
import type { CohorteFeatureChoice } from '../../../contract/cohorte-actions';
import type { CohorteRun } from '../../../contract/cohorte-integration';
import { buildSuggestions, COHORTE_MENU_GROUPS, flattenMenu, moveMenuSelection, withCohorteSlashEntry } from './actions-menu';

function feature(over: Partial<CohorteFeatureChoice> & { id: string }): CohorteFeatureChoice {
  return { title: over.id, status: 'draft', kind: 'feature', updatedAt: 0, ...over };
}

function run(over: Partial<CohorteRun> & { runId: string; specId: string }): CohorteRun {
  return {
    projectRoot: '/root',
    title: over.specId,
    profile: 'default' as never,
    state: 'RUNNING' as never,
    view: 'running',
    since: 0,
    startedAt: 0,
    iteration: { fixRounds: 0, maxFixRounds: 0, reviewRounds: 0 },
    host: { alive: true },
    git: { baseBranch: 'main' },
    phases: [],
    worktrees: [],
    gate: null,
    review: null,
    artifacts: [],
    lastSequence: 0,
    tailTruncated: false,
    refreshedAt: 0,
    ...over,
  } as CohorteRun;
}

describe('menu items (frame 35)', () => {
  it('gives every item an icon from the Graphite set and a one-line description', () => {
    const icons = COHORTE_MENU_GROUPS.flatMap((g) => g.items.map((i) => [i.id, i.icon]));
    expect(Object.fromEntries(icons)).toEqual({
      intake: 'doc', brainstorm: 'spark', spec: 'edit', start: 'arrow-right',
      patch: 'flow', fleet: 'layers', audit: 'search', retro: 'refresh',
    });
    for (const g of COHORTE_MENU_GROUPS) for (const i of g.items) expect(i.description.length).toBeGreaterThan(0);
  });
});

describe('buildSuggestions (FR-31)', () => {
  it('suggests approving a pending gate first, attention toned', () => {
    const gatedRun = run({
      runId: 'r1',
      specId: 'auth-retry',
      gate: {
        runId: 'r1',
        request: {} as never,
        requestedAt: 0,
        phaseCount: 1,
        findings: [],
        actions: [{ id: 'approve', stopsRun: false, cli: ['cohorte approve r1 apr_1'] }],
        morePending: 0,
      },
    });
    const suggestions = buildSuggestions({ linkedRun: gatedRun, features: [], runsForRoot: [gatedRun] });
    expect(suggestions[0]).toEqual({
      id: 'suggest-gate',
      label: 'Approve & ship auth-retry',
      description: 'Review gate on r1 · 0 findings',
      icon: 'check',
      commandHint: 'cohorte approve r1 apr_1',
      tone: 'attention',
      action: { kind: 'gate', gateAction: 'approve' },
    });
  });

  it('omits the gate suggestion when the gate has no approve action', () => {
    const gatedRun = run({
      runId: 'r1',
      specId: 'auth-retry',
      gate: { runId: 'r1', request: {} as never, requestedAt: 0, phaseCount: 1, findings: [], actions: [{ id: 'deny', stopsRun: true, cli: [] }], morePending: 0 },
    });
    const suggestions = buildSuggestions({ linkedRun: gatedRun, features: [], runsForRoot: [] });
    expect(suggestions.find((s) => s.id === 'suggest-gate')).toBeUndefined();
  });

  it('suggests the most recently updated frozen feature with no run yet', () => {
    const features = [
      feature({ id: 'old-frozen', status: 'frozen', updatedAt: 100 }),
      feature({ id: 'new-frozen', status: 'ready', updatedAt: 200 }),
      feature({ id: 'has-a-run', status: 'approved', updatedAt: 300 }),
    ];
    const existing = run({ runId: 'r9', specId: 'has-a-run' });
    const suggestions = buildSuggestions({ linkedRun: null, features, runsForRoot: [existing] });
    expect(suggestions[0]).toMatchObject({ id: 'suggest-start', label: 'Start run · new-frozen', icon: 'arrow-right', action: { kind: 'start', featureId: 'new-frozen' } });
    expect(suggestions[0].description).toContain('Spec frozen');
  });

  it('suggests the most recently updated draft feature to brainstorm', () => {
    const features = [feature({ id: 'old-draft', status: 'draft', updatedAt: 10 }), feature({ id: 'new-draft', status: 'draft', updatedAt: 20 })];
    const suggestions = buildSuggestions({ linkedRun: null, features, runsForRoot: [] });
    expect(suggestions[0]).toMatchObject({ id: 'suggest-brainstorm', label: 'Brainstorm · new-draft', action: { kind: 'brainstorm', featureId: 'new-draft' } });
  });

  it('caps at 2, in gate > start > brainstorm order', () => {
    const gatedRun = run({
      runId: 'r1',
      specId: 'gated-one',
      gate: { runId: 'r1', request: {} as never, requestedAt: 0, phaseCount: 1, findings: [], actions: [{ id: 'approve', stopsRun: false, cli: ['cohorte approve r1'] }], morePending: 0 },
    });
    const features = [feature({ id: 'frozen-one', status: 'frozen', updatedAt: 5 }), feature({ id: 'draft-one', status: 'draft', updatedAt: 5 })];
    const suggestions = buildSuggestions({ linkedRun: gatedRun, features, runsForRoot: [] });
    expect(suggestions).toHaveLength(2);
    expect(suggestions.map((s) => s.id)).toEqual(['suggest-gate', 'suggest-start']);
  });

  it('returns [] with nothing to suggest', () => {
    expect(buildSuggestions({ linkedRun: null, features: [], runsForRoot: [] })).toEqual([]);
  });
});

describe('menu groups + navigation', () => {
  it('exposes the four fixed groups (FR-30)', () => {
    expect(COHORTE_MENU_GROUPS.map((g) => g.label)).toEqual(['Capture', 'Spec', 'Run', 'Improve']);
  });

  it('flattens suggestions before group items', () => {
    const model = { suggestions: [{ id: 's1', label: 'S', description: '', icon: 'arrow-right' as const, commandHint: '', tone: 'neutral' as const, action: { kind: 'start' as const, featureId: 'f' } }], groups: COHORTE_MENU_GROUPS };
    const rows = flattenMenu(model);
    expect(rows[0]).toEqual({ kind: 'suggestion', suggestion: model.suggestions[0] });
    expect(rows[1].kind).toBe('item');
  });

  it('moveMenuSelection wraps both directions', () => {
    expect(moveMenuSelection(3, 2, 1)).toBe(0);
    expect(moveMenuSelection(3, 0, -1)).toBe(2);
    expect(moveMenuSelection(0, 0, 1)).toBe(0);
  });
});

describe('withCohorteSlashEntry (FR-33)', () => {
  it('appends the local entry only when a detection exists', () => {
    expect(withCohorteSlashEntry([], false)).toEqual([]);
    expect(withCohorteSlashEntry([], true).map((c) => c.name)).toEqual(['cohorte']);
  });

  it('never duplicates it', () => {
    const withOne = withCohorteSlashEntry([], true);
    expect(withCohorteSlashEntry(withOne, true)).toHaveLength(1);
  });

  it('leaves the original list untouched', () => {
    const original = [{ name: 'clear', description: '', source: 'builtin' as const }];
    const next = withCohorteSlashEntry(original, true);
    expect(original).toHaveLength(1);
    expect(next).toHaveLength(2);
  });
});
