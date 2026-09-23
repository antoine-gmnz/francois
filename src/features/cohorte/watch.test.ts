import { describe, expect, it } from 'vitest';
import { detection } from '../../lib/cohorte.testutil';
import { cohorteRunIdFromTab, cohorteTabId } from './tab';
import { rootIsWatched, watchedRoots, watchedRunList } from './watch';

describe('watchedRoots (FR-52)', () => {
  const dets = {
    '/code/orbit': detection(),
    '/code/orbit/api': detection({ startDir: '/code/orbit/api' }),
    '/code/ledger': detection({ startDir: '/code/ledger', state: 'not-initialised', root: undefined }),
    '/code/infra': detection({ startDir: '/code/infra', state: 'cli-missing', root: '/code/infra' }),
  };
  it('keeps only detected roots, deduplicated and sorted', () => {
    expect(watchedRoots(dets, ['/code/orbit/api', '/code/ledger', '/code/orbit', '/code/infra', '/unknown'], false)).toEqual(['/code/orbit']);
  });
  it('is empty with nothing detected', () => {
    expect(watchedRoots({}, ['/code/orbit'], false)).toEqual([]);
  });
});

describe('cohorte tab ids (FR-70)', () => {
  it('round-trips', () => {
    expect(cohorteTabId('run_x')).toBe('cohorte:run_x');
    expect(cohorteRunIdFromTab('cohorte:run_x')).toBe('run_x');
    expect(cohorteRunIdFromTab('ext:run_x')).toBeNull();
  });
});

describe('watched-root filters (R-13)', () => {
  it('keeps only runs under a watched root, tolerant of path spelling', () => {
    const runs = { a: { projectRoot: 'C:\\Code\\Orbit' }, b: { projectRoot: '/code/other' } };
    expect(watchedRunList(runs, ['c:/code/orbit/'], true)).toEqual([runs.a]);
    expect(watchedRunList(runs, [], true)).toEqual([]);
    expect(rootIsWatched(['/code/other'], false)('/code/other')).toBe(true);
  });
});
