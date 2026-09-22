import { describe, expect, it } from 'vitest';
import { diffStat, FILE_STATUS } from './file-status';

describe('FILE_STATUS', () => {
  it('gives each git status its letter and its design tone', () => {
    expect(FILE_STATUS.modified).toEqual({ ch: 'M', tone: 'info' });
    expect(FILE_STATUS.added).toEqual({ ch: 'A', tone: 'success' });
    expect(FILE_STATUS.untracked).toEqual({ ch: 'U', tone: 'success' });
    expect(FILE_STATUS.deleted).toEqual({ ch: 'D', tone: 'danger' });
    expect(FILE_STATUS.renamed).toEqual({ ch: 'R', tone: 'info' });
  });
});

describe('diffStat', () => {
  it('reads "+a −d", dropping a zero side', () => {
    expect(diffStat(34, 19)).toBe('+34 −19');
    expect(diffStat(48, 0)).toBe('+48');
    expect(diffStat(0, 6)).toBe('−6');
  });

  it('is empty when nothing changed line-wise (a binary or a pure rename)', () => {
    expect(diffStat(0, 0)).toBe('');
  });
});
