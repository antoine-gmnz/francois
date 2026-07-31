import { describe, expect, it } from 'vitest';
import { basename, buildEffortOptions, EFFORT_DEFAULT_LABEL, ultracodeField } from './new-session-form';

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

describe('buildEffortOptions', () => {
  it('leads with the omit-the-flag default, labelled with the resolved value', () => {
    expect(buildEffortOptions([])).toEqual([{ value: '', label: EFFORT_DEFAULT_LABEL }]);
  });

  it('keeps the submitted value for the default option empty (flag still omitted)', () => {
    const [defaultOption] = buildEffortOptions(['low', 'high']);
    expect(defaultOption.value).toBe('');
  });

  it('names the resolved default explicitly rather than the bare word "default"', () => {
    expect(EFFORT_DEFAULT_LABEL).toBe('default (xhigh)');
  });

  it('appends each model effort verbatim, in order, after the default', () => {
    expect(buildEffortOptions(['low', 'medium', 'high', 'xhigh', 'max'])).toEqual([
      { value: '', label: EFFORT_DEFAULT_LABEL },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
      { value: 'xhigh', label: 'xhigh' },
      { value: 'max', label: 'max' },
    ]);
  });
});

describe('ultracodeField', () => {
  it('omits the field when ultracode is false', () => {
    expect(ultracodeField(false)).toBeUndefined();
  });

  it('sends true when ultracode is on', () => {
    expect(ultracodeField(true)).toBe(true);
  });
});
