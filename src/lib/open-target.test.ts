import { describe, expect, it } from 'vitest';
import { targetParts, isOpenModifier, codeTarget } from './open-target';

describe('open targets', () => {
  it('finds URLs and file references without swallowing punctuation', () => {
    expect(targetParts('See https://example.com/x, then src/app.ts:12:3.')).toEqual([
      { text: 'See ' }, { text: 'https://example.com/x', target: 'https://example.com/x' },
      { text: ', then ' }, { text: 'src/app.ts:12:3', target: 'src/app.ts:12:3' }, { text: '.' },
    ]);
  });
  it('recognizes Windows and absolute paths', () => {
    expect(targetParts('C:\\repo\\app.ts:4 /tmp/app.ts#L7').filter(p => p.target).map(p => p.target))
      .toEqual(['C:\\repo\\app.ts:4', '/tmp/app.ts#L7']);
  });
  it('leaves ordinary prose and unsafe schemes inert', () => {
    expect(targetParts('hello app.ts javascript:alert(1)')).toEqual([{ text: 'hello app.ts javascript:alert(1)' }]);
  });
  it('requires Ctrl or Cmd with the primary button', () => {
    expect(isOpenModifier({ button: 0, ctrlKey: true, metaKey: false })).toBe(true);
    expect(isOpenModifier({ button: 0, ctrlKey: false, metaKey: true })).toBe(true);
    expect(isOpenModifier({ button: 0, ctrlKey: false, metaKey: false })).toBe(false);
    expect(isOpenModifier({ button: 2, ctrlKey: true, metaKey: false })).toBe(false);
  });
});

it('recognizes file URLs', () => {
  expect(targetParts('file:///tmp/my%20file.ts')[0].target).toBe('file:///tmp/my%20file.ts');
});

it('offers standalone filenames in inline code, keeping code expressions inert', () => {
  expect(codeTarget('AGENTS.md')).toBe('AGENTS.md');
  expect(codeTarget('hello world.ts:3')).toBe('hello world.ts:3');
  expect(codeTarget('console.log(value)')).toBeNull();
});

it('preserves balanced delimiters inside URLs and paths', () => {
  const url = 'https://en.wikipedia.org/wiki/Function_(mathematics)';
  expect(targetParts(`(${url}).`).filter(p => p.target).map(p => p.target)).toEqual([url]);
  expect(targetParts('/tmp/file(1)').filter(p => p.target).map(p => p.target)).toEqual(['/tmp/file(1)']);
});
