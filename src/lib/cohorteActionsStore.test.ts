import { describe, expect, it } from 'vitest';
import { COHORTE_RESULT_CARD_CAP, pushResult, useCohorteActionsStore, type CohorteResultEntry } from './cohorteActionsStore';

function entry(id: string): CohorteResultEntry {
  return { id, verb: 'intake', at: 0, result: { featureId: id, title: id, triage: 'feature', reasons: [], questions: [], command: 'cohorte intake', durationMs: 1 } };
}

describe('pushResult (FR-50)', () => {
  it('appends, newest last', () => {
    const list = pushResult([entry('a')], entry('b'));
    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('caps at 5, dropping the oldest', () => {
    let list: CohorteResultEntry[] = [];
    for (const id of ['1', '2', '3', '4', '5', '6']) list = pushResult(list, entry(id));
    expect(list).toHaveLength(COHORTE_RESULT_CARD_CAP);
    expect(list.map((e) => e.id)).toEqual(['2', '3', '4', '5', '6']);
  });
});

describe('useCohorteActionsStore', () => {
  it('opening a sheet closes the menu', () => {
    const s = useCohorteActionsStore.getState();
    s.openMenu('s1');
    s.openSheet({ action: 'intake', sessionId: 's1' });
    expect(useCohorteActionsStore.getState().menuOpenFor).toBeNull();
    expect(useCohorteActionsStore.getState().sheet).toEqual({ action: 'intake', sessionId: 's1' });
  });

  it('addResult then dismissResult', () => {
    const s = useCohorteActionsStore.getState();
    s.addResult('s1', entry('a'));
    expect(useCohorteActionsStore.getState().results.s1).toHaveLength(1);
    s.dismissResult('s1', 'a');
    expect(useCohorteActionsStore.getState().results.s1).toHaveLength(0);
  });

  it('markNewFeature is idempotent-safe and additive', () => {
    const s = useCohorteActionsStore.getState();
    s.markNewFeature('f1');
    s.markNewFeature('f2');
    expect(useCohorteActionsStore.getState().newFeatureIds.has('f1')).toBe(true);
    expect(useCohorteActionsStore.getState().newFeatureIds.has('f2')).toBe(true);
  });
});
