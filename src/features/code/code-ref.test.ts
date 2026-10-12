// code-editor-agents FR-14 — an inline-code span that names a file in the session root.

import { describe, expect, it } from 'vitest';
import { parseCodeRef } from './code-ref';

describe('parseCodeRef (FR-14)', () => {
  it.each([
    ['src/auth.ts', { path: 'src/auth.ts' }],
    ['src/auth.ts:42', { path: 'src/auth.ts', line: 42 }],
    ['./src/auth.ts:7', { path: 'src/auth.ts', line: 7 }],
    ['README.md', { path: 'README.md' }],
  ])('%s', (text, ref) => {
    expect(parseCodeRef(text)).toEqual(ref);
  });

  it.each(['', 'npm run build', 'foo()', 'src/auth.ts:0', 'a:b', '/abs/path.ts', 'src\\auth.ts', 'src/'])('rejects %j', (text) => {
    expect(parseCodeRef(text)).toBeNull();
  });
});
