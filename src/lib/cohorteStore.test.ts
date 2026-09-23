import { beforeEach, describe, expect, it } from 'vitest';
import { COHORTE_PREF_DEFAULTS, COHORTE_PREF_KEYS, type CohorteDerivedEvent, type CohorteEventType } from '../../contract/cohorte-integration';
import { COHORTE_WIRE_EVENT_TYPES } from '../../contract/cohorte-events';
import { applyCohorteEvent, initialCohorteData, loadCohortePrefs, mergeFetchedLog, persistCohortePref, pruneRunsTo, useCohorteStore, type CohorteData } from './cohorteStore';
import { detection, gate, run, RUN_ID, wire } from './cohorte.testutil';

const DERIVED: CohorteDerivedEvent[] = [
  { type: 'francois.detection.changed', detection: detection() },
  { type: 'francois.run.updated', run: run() },
  { type: 'francois.run.removed', projectRoot: '/code/orbit', runId: RUN_ID },
  { type: 'francois.gate.opened', projectRoot: '/code/orbit', gate: gate() },
  { type: 'francois.gate.resolved', projectRoot: '/code/orbit', runId: RUN_ID, approvalId: 'apr_1', decision: 'allow-once', actor: 'human:me' },
  { type: 'francois.watch.status', projectRoot: '/code/orbit', healthy: false, error: { code: 'COHORTE_TIMEOUT', message: 'slow' }, nextPollInMs: 6000 },
];

function data(over: Partial<CohorteData> = {}): CohorteData {
  return { ...initialCohorteData(), prefs: { ...COHORTE_PREF_DEFAULTS }, ...over };
}

describe('applyCohorteEvent — every CohorteEvent member (AC-20)', () => {
  it('handles all 68 wire types plus unknown without throwing, and logs each into a loaded log', () => {
    const types: CohorteEventType[] = [...COHORTE_WIRE_EVENT_TYPES, 'unknown'];
    let s = data({ logs: { [RUN_ID]: [] } });
    types.forEach((type, i) => {
      const payload: Record<string, object> = { 'agent.message.completed': { preview: 'p' }, 'agent.message.delta': { delta: 'd' } };
      s = { ...s, ...applyCohorteEvent(s, wire(type, payload[type] ?? {}, { sequence: i + 1 })) };
    });
    expect(s.logs[RUN_ID]).toHaveLength(types.length);
    expect(s.logs[RUN_ID][types.length - 1].type).toBe('foo.bar');
  });

  it('handles all six derived types', () => {
    for (const e of DERIVED) expect(() => applyCohorteEvent(data({ runs: { [RUN_ID]: run() } }), e)).not.toThrow();
  });

  it('a wire event leaves an unloaded log alone', () => {
    expect(applyCohorteEvent(data(), wire('pipeline.started'))).toEqual({});
  });

  it('run.updated replaces the whole run — never merges', () => {
    const before = run({ gate: gate(), lastError: { code: 'x', message: 'y' } });
    const after = run({ view: 'completed', state: 'COMPLETED' });
    const s = applyCohorteEvent(data({ runs: { [RUN_ID]: before } }), { type: 'francois.run.updated', run: after });
    expect(s.runs?.[RUN_ID]).toBe(after);
    expect(s.runs?.[RUN_ID].lastError).toBeUndefined();
  });

  it('run.removed drops the run, its log, busy and outcome', () => {
    const s = applyCohorteEvent(
      data({ runs: { [RUN_ID]: run() }, logs: { [RUN_ID]: [] }, busy: { [RUN_ID]: 'approve' }, lastOutcome: { [RUN_ID]: { runId: RUN_ID, steps: [], run: null } } }),
      DERIVED[2],
    );
    expect(s.runs).toEqual({});
    expect(s.logs).toEqual({});
    expect(s.busy).toEqual({});
    expect(s.lastOutcome).toEqual({});
  });

  it('gate.opened sets the gate on a known run and is a no-op for an unknown one', () => {
    const s = applyCohorteEvent(data({ runs: { [RUN_ID]: run() } }), DERIVED[3]);
    expect(s.runs?.[RUN_ID].gate?.request.approvalId).toBe('apr_1');
    expect(s.runs?.[RUN_ID].view).toBe('gate');
    expect(applyCohorteEvent(data(), DERIVED[3])).toEqual({});
  });

  it('gate.resolved clears the matching gate, the busy flag, and records who answered', () => {
    const s = applyCohorteEvent(data({ runs: { [RUN_ID]: run({ gate: gate(), view: 'gate' }) }, busy: { [RUN_ID]: 'approve' } }), DERIVED[4]);
    expect(s.runs?.[RUN_ID].gate).toBeNull();
    expect(s.busy).toEqual({});
    expect(s.resolutions?.[RUN_ID]).toMatchObject({ approvalId: 'apr_1', decision: 'allow-once', actor: 'human:me' });
  });

  it('gate.resolved for another approval keeps the current gate', () => {
    const e: CohorteDerivedEvent = { ...(DERIVED[4] as Extract<CohorteDerivedEvent, { type: 'francois.gate.resolved' }>), approvalId: 'apr_other' };
    const s = applyCohorteEvent(data({ runs: { [RUN_ID]: run({ gate: gate() }) } }), e);
    expect(s.runs).toBeUndefined();
  });

  it('detection.changed and watch.status update their records', () => {
    expect(applyCohorteEvent(data(), DERIVED[0]).detections?.['/code/orbit'].state).toBe('detected');
    expect(applyCohorteEvent(data(), DERIVED[5]).watchHealth?.['/code/orbit']).toEqual({
      healthy: false,
      error: { code: 'COHORTE_TIMEOUT', message: 'slow' },
      nextPollInMs: 6000,
    });
  });
});

describe('prefs (FR-53, AC-24)', () => {
  const mem = (entries: Record<string, string>) => ({ getItem: (k: string) => entries[k] ?? null });

  it('loads the defaults from empty storage', () => {
    expect(loadCohortePrefs(mem({}))).toEqual(COHORTE_PREF_DEFAULTS);
  });
  it('loads the defaults when storage is unavailable or throws', () => {
    expect(loadCohortePrefs(null)).toEqual(COHORTE_PREF_DEFAULTS);
    expect(loadCohortePrefs({ getItem: () => { throw new Error('denied'); } })).toEqual(COHORTE_PREF_DEFAULTS);
  });
  it('ignores malformed values', () => {
    expect(loadCohortePrefs(mem({ [COHORTE_PREF_KEYS.showPanelTab]: 'yes', [COHORTE_PREF_KEYS.notifyOnGate]: '{' }))).toEqual(COHORTE_PREF_DEFAULTS);
  });
  it('round-trips through storage', () => {
    const backing: Record<string, string> = {};
    const store = { getItem: (k: string) => backing[k] ?? null, setItem: (k: string, v: string) => void (backing[k] = v) };
    persistCohortePref('showPanelTab', false, store);
    persistCohortePref('notifyOnGate', true, store);
    expect(loadCohortePrefs(store)).toEqual({ ...COHORTE_PREF_DEFAULTS, showPanelTab: false, notifyOnGate: true });
  });
  it('a throwing setItem is swallowed', () => {
    expect(() => persistCohortePref('showPanelTab', true, { setItem: () => { throw new Error('quota'); } })).not.toThrow();
  });
});

describe('useCohorteStore actions', () => {
  beforeEach(() => useCohorteStore.setState(initialCohorteData()));

  it('records a launched link once per ref', () => {
    const st = useCohorteStore.getState();
    st.recordLaunch('s1', 'run_7fa3c1');
    st.recordLaunch('s1', 'run_7fa3c1');
    expect(useCohorteStore.getState().explicitLinks).toEqual({ s1: ['run_7fa3c1'] });
  });

  it('stores a detection under the asked key and its own start dir', () => {
    useCohorteStore.getState().setDetection('~/code/orbit', detection({ startDir: '/code/orbit' }));
    const d = useCohorteStore.getState().detections;
    expect(Object.keys(d).sort()).toEqual(['/code/orbit', '~/code/orbit']);
  });

  it('hydrates, sets busy and clears it', () => {
    const st = useCohorteStore.getState();
    st.hydrateRuns([run()]);
    st.setBusy(RUN_ID, 'fix');
    expect(useCohorteStore.getState().busy[RUN_ID]).toBe('fix');
    st.setBusy(RUN_ID, null);
    expect(useCohorteStore.getState().busy).toEqual({});
    expect(useCohorteStore.getState().runs[RUN_ID]).toBeDefined();
  });

  it('apply routes through the reducer', () => {
    useCohorteStore.getState().apply({ type: 'francois.run.updated', run: run({ title: 'x' }) });
    expect(useCohorteStore.getState().runs[RUN_ID].title).toBe('x');
  });
});

describe('Remediation round 1 — store', () => {
  const resolved = DERIVED[4];

  it('R-15: a resolution records whether this window issued the answer', () => {
    const mine = applyCohorteEvent(data({ runs: { [RUN_ID]: run({ gate: gate() }) }, busy: { [RUN_ID]: 'approve' } }), resolved, 42);
    expect(mine.resolutions?.[RUN_ID]).toMatchObject({ at: 42, byThisWindow: true });
    const theirs = applyCohorteEvent(data({ runs: { [RUN_ID]: run({ gate: gate() }) } }), resolved, 42);
    expect(theirs.resolutions?.[RUN_ID].byThisWindow).toBe(false);
  });

  it('R-16: a resolved gate clears the last outcome', () => {
    const s = applyCohorteEvent(data({ lastOutcome: { [RUN_ID]: { runId: RUN_ID, steps: [], run: null } } }), resolved);
    expect(s.lastOutcome).toEqual({});
    expect(s.resolutions?.[RUN_ID].byThisWindow).toBe(true);
  });

  it("R-16: auth.required keeps the event's own cli hint, log loaded or not", () => {
    const s = applyCohorteEvent(data(), wire('auth.required', { provider: 'pi', cause: 'expired', cli: 'cohorte auth login pi' }));
    expect(s.authCli?.[RUN_ID]).toBe('cohorte auth login pi');
  });

  it('R-16: rows arriving during a log fetch are buffered, then merged after the fetched ring', () => {
    let s = data({ logBuffers: { [RUN_ID]: [] } });
    s = { ...s, ...applyCohorteEvent(s, wire('pipeline.started', {}, { sequence: 7 })) };
    s = { ...s, ...applyCohorteEvent(s, wire('pipeline.started', {}, { sequence: 3 })) };
    expect(s.logs[RUN_ID]).toBeUndefined();
    const fetched = [1, 2, 3].map((n) => ({ runId: RUN_ID, sequence: n, sub: 0, at: n, type: 'x', severity: 'info', summary: '' }));
    const merged = mergeFetchedLog(s, RUN_ID, fetched);
    expect(merged.logs?.[RUN_ID].map((r) => r.sequence)).toEqual([1, 2, 3, 7]);
    expect(merged.logBuffers).toEqual({});
  });

  it('R-13: pruning drops runs (and their state) whose root left the watch set', () => {
    const other = run({ runId: 'run_bbbbbbbbbbbb', projectRoot: '/code/other' });
    const s = data({
      runs: { [RUN_ID]: run(), [other.runId]: other },
      logs: { [other.runId]: [] },
      busy: { [other.runId]: 'pause' },
      lastOutcome: { [other.runId]: { runId: other.runId, steps: [], run: null } },
    });
    const p = pruneRunsTo(s, (root) => root === '/code/orbit');
    expect(Object.keys(p.runs ?? {})).toEqual([RUN_ID]);
    expect(p.logs).toEqual({});
    expect(p.busy).toEqual({});
    expect(p.lastOutcome).toEqual({});
    expect(pruneRunsTo(s, () => true)).toEqual({});
  });

  it('R-16: the panel log is keyed by session', () => {
    useCohorteStore.setState(initialCohorteData());
    useCohorteStore.getState().setPanelLog('s1', RUN_ID);
    expect(useCohorteStore.getState().panelLog).toEqual({ s1: RUN_ID });
    useCohorteStore.getState().setPanelLog('s1', null);
    expect(useCohorteStore.getState().panelLog).toEqual({});
  });
});
