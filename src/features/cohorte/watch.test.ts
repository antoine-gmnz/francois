import { describe, expect, it } from 'vitest';
import { detection } from '../../lib/cohorte.testutil';
import { cohorteRunIdFromTab, cohorteTabId } from './tab';
import { watchedRoots } from './watch';

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
