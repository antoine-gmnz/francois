// Unit tests for the PURE half of the convention checker, mirroring how
// scripts/release/version.test.mjs covers version.mjs. The I/O half (check.mjs)
// is proven by `npm run lint:conventions` in CI and by the pre-push hook.
import { describe, it, expect } from 'vitest';
import {
  MAX_FILE_LINES,
  oversizedFindings,
  barrelFindings,
  crossFeatureFindings,
  summarize,
  importsOf,
  allFindings,
} from './conventions.mjs';

const big = MAX_FILE_LINES + 1;

describe('oversizedFindings', () => {
  it('ignores files at or under the cap', () => {
    const files = [
      { path: 'src/a.ts', lines: MAX_FILE_LINES },
      { path: 'src/b.ts', lines: 1 },
    ];
    expect(oversizedFindings(files, [])).toEqual([]);
  });

  it('errors on a NEW file over the cap', () => {
    const found = oversizedFindings([{ path: 'src/new.ts', lines: big }], []);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].rule).toBe('file-size');
  });

  it('only warns for a file already in the baseline', () => {
    const found = oversizedFindings([{ path: 'src/old.ts', lines: big }], ['src/old.ts']);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warn');
  });

  // The ratchet's whole point: known debt never fails the build, but the list
  // it is on cannot grow without someone deciding to grow it.
  it('still errors on a new file even when others are baselined', () => {
    const found = oversizedFindings(
      [
        { path: 'src/old.ts', lines: big },
        { path: 'src/new.ts', lines: big },
      ],
      ['src/old.ts'],
    );
    expect(found.filter((f) => f.severity === 'error').map((f) => f.path)).toEqual(['src/new.ts']);
  });
});

describe('barrelFindings', () => {
  it('flags a feature barrel', () => {
    const found = barrelFindings(['src/features/diff/index.ts']);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
  });

  it('flags barrels in lib, ui and app too', () => {
    const found = barrelFindings(['src/lib/index.ts', 'src/ui/index.tsx', 'src/app/index.ts']);
    expect(found).toHaveLength(3);
  });

  it('does not flag a normal module that merely ends in index', () => {
    expect(barrelFindings(['src/features/diff/reindex.ts', 'src/lib/indexer.ts'])).toEqual([]);
  });

  it('does not flag the repo-root index.html sibling', () => {
    expect(barrelFindings(['src/main.tsx', 'contract/common.ts'])).toEqual([]);
  });
});

describe('crossFeatureFindings', () => {
  it('flags an import that reaches into another feature', () => {
    const found = crossFeatureFindings([
      { path: 'src/features/sessions/Sidebar.tsx', imports: ['../palette/palette'] },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('warn');
    expect(found[0].message).toContain('palette');
  });

  it('allows a feature importing its own siblings', () => {
    const found = crossFeatureFindings([
      { path: 'src/features/sessions/Sidebar.tsx', imports: ['./sessions', '../sessions/helper'] },
    ]);
    expect(found).toEqual([]);
  });

  it('allows reaching into lib, ui and contract', () => {
    const found = crossFeatureFindings([
      {
        path: 'src/features/sessions/Sidebar.tsx',
        imports: ['../../lib/store', '../../ui/Button', '../../../contract/common'],
      },
    ]);
    expect(found).toEqual([]);
  });

  it('ignores files outside src/features', () => {
    const found = crossFeatureFindings([{ path: 'src/app/App.tsx', imports: ['../features/x/y'] }]);
    expect(found).toEqual([]);
  });
});

describe('importsOf', () => {
  it('reads static, type-only and re-export specifiers', () => {
    const src = [
      "import { a } from './a';",
      "import type { B } from '../b/types';",
      "export { c } from './c';",
      "import Default from '../../lib/d';",
    ].join('\n');
    expect(importsOf(src)).toEqual(['./a', '../b/types', './c', '../../lib/d']);
  });

  // Regression: the first version of this regex used [^'\"\n]*? and so could
  // not cross a newline, silently missing every multi-line import — which is
  // most of the long ones in src/features. Caught by Codacy on the PR that
  // introduced it.
  it('reads a multi-line import statement', () => {
    const src = `import {
  a,
  b,
} from '../other/thing';`;
    expect(importsOf(src)).toEqual(['../other/thing']);
  });

  // The negated class still excludes quotes, so a side-effect import cannot
  // swallow the statement after it and report the wrong specifier.
  it('does not run a no-from import into the next statement', () => {
    const src = `import './side-effect.css';
import { a } from '../other/thing';`;
    expect(importsOf(src)).toEqual(['../other/thing']);
  });

  it('does not treat a quoted path inside a string as an import', () => {
    expect(importsOf('const s = "import x from \'./nope\'";')).toEqual([]);
  });
});

describe('summarize', () => {
  it('counts by severity and by rule', () => {
    const s = summarize([
      { rule: 'file-size', severity: 'error' },
      { rule: 'file-size', severity: 'warn' },
      { rule: 'no-barrel', severity: 'error' },
    ]);
    expect(s).toEqual({
      errors: 2,
      warnings: 1,
      byRule: { 'file-size': { error: 1, warn: 1 }, 'no-barrel': { error: 1, warn: 0 } },
    });
  });
});

describe('allFindings', () => {
  it('runs every rule in one pass', () => {
    const found = allFindings(
      [
        { path: 'src/features/a/index.ts', lines: 10, imports: ['../b/thing'] },
        { path: 'src/big.ts', lines: big, imports: [] },
      ],
      [],
    );
    expect(new Set(found.map((f) => f.rule))).toEqual(
      new Set(['no-barrel', 'cross-feature-import', 'file-size']),
    );
  });
});
