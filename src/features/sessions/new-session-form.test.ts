import { describe, expect, it } from 'vitest';
import { basename } from './new-session-form';

describe('basename', () => {
  it('returns the last segment of a posix path', () => {
    expect(basename('/home/user/my-project')).toBe('my-project');
  });

  it('returns the last segment of a windows path', () => {
    expect(basename('C:\\Users\\me\\my-project')).toBe('my-project');
  });

  it('handles a mix of separators', () => {
    expect(basename('C:\\Users\\me/my-project')).toBe('my-project');
  });

  it('ignores a trailing separator', () => {
    expect(basename('/home/user/my-project/')).toBe('my-project');
  });

  it('falls back to the input when there are no segments', () => {
    expect(basename('')).toBe('');
    expect(basename('/')).toBe('/');
  });

  it('returns a bare name unchanged', () => {
    expect(basename('my-project')).toBe('my-project');
  });
});
