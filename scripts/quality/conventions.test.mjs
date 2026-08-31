// Unit tests for the PURE half of the convention checker, mirroring how
// scripts/release/version.test.mjs covers version.mjs. The I/O half (check.mjs)
// is proven by `npm run lint:conventions` in CI and by the pre-push hook.
import { describe, it, expect } from 'vitest';
import {
  MAX_FILE_LINES,
  SPAWN_FACADE,
  oversizedFindings,
  barrelFindings,
  crossFeatureFindings,
  bareSpawnFindings,
  domainCycleFindings,
  domainOf,
  crateRefsOf,
  spawnSitesOf,
  stripRustComments,
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

// ---------------------------------------------------------------------------
// core-architecture-wave3 FR-8 / FR-10
// ---------------------------------------------------------------------------

const rs = (path, over) => ({ path, lines: 10, imports: [], spawnSites: [], crateRefs: [], ...over });

describe('spawnSitesOf', () => {
  it('finds a bare Command::new and reports its 1-based line', () => {
    expect(spawnSitesOf('fn a() {\n    let c = Command::new("git");\n}')).toEqual([2]);
  });

  it('finds an ALIASED construction — the bypass that hid from the first sweep', () => {
    const src = 'use std::process::Command as Cmd;\nlet c = Cmd::new("git");';
    expect(spawnSitesOf(src)).toEqual([2]);
  });

  it('ignores a comment: the facade\'s own docs explain why Command::new is wrong', () => {
    expect(spawnSitesOf('// `Command::new("codex")` fails on Windows.\n')).toEqual([]);
    expect(spawnSitesOf('    /// so Command::new(x) is not how a spawn finds it\n')).toEqual([]);
  });

  it('counts a site once even when several aliases are in scope', () => {
    const src = 'use std::process::Command as Cmd;\nlet c = Command::new("git");';
    expect(spawnSitesOf(src)).toEqual([2]);
  });
});

describe('bareSpawnFindings', () => {
  it('errors on a Rust source that constructs a Command with no allowance', () => {
    const found = bareSpawnFindings([rs('src-tauri/src/diff/git.rs', { spawnSites: [14] })], {});
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].rule).toBe('bare-spawn');
    expect(found[0].message).toMatch(/process_util::spawn/);
  });

  it('only warns while a file is within its baselined allowance', () => {
    const files = [rs('src-tauri/src/a/b.rs', { spawnSites: [1, 2] })];
    expect(bareSpawnFindings(files, { 'src-tauri/src/a/b.rs': 2 })[0].severity).toBe('warn');
  });

  // The ratchet: baselined debt is a ceiling, not a licence.
  it('errors again as soon as a baselined file gains one more site', () => {
    const files = [rs('src-tauri/src/a/b.rs', { spawnSites: [1, 2, 3] })];
    expect(bareSpawnFindings(files, { 'src-tauri/src/a/b.rs': 2 })[0].severity).toBe('error');
  });

  it('exempts the facade itself — it is the one place a Command is constructed', () => {
    expect(bareSpawnFindings([rs(SPAWN_FACADE, { spawnSites: [1, 2, 3] })], {})).toEqual([]);
  });

  it('says nothing about the frontend', () => {
    expect(bareSpawnFindings([{ path: 'src/lib/api.ts', spawnSites: [3] }], {})).toEqual([]);
  });
});

describe('domainOf', () => {
  it('reads the first segment under src-tauri/src', () => {
    expect(domainOf('src-tauri/src/session/adapter/codex/runner.rs')).toBe('session');
    expect(domainOf('src-tauri/src/usage.rs')).toBe('usage');
    expect(domainOf('src/lib/api.ts')).toBeNull();
  });
});

describe('stripRustComments', () => {
  it('drops a whole-line comment and a trailing one, keeping the code', () => {
    expect(stripRustComments('// crate::session\nlet a = 1; // crate::diff\n')).toBe('\nlet a = 1;\n');
  });

  it('drops a block comment', () => {
    expect(stripRustComments('a /* crate::session */ b')).toBe('a  b');
  });
});

describe('crateRefsOf', () => {
  it('reads plain and braced crate:: references', () => {
    expect(crateRefsOf('use crate::account::AccountKind;')).toEqual(['account']);
    expect(crateRefsOf('use crate::{account::A, session::B};')).toEqual(['account', 'session']);
  });

  it('reports each domain once', () => {
    expect(crateRefsOf('crate::session::a; crate::session::b;')).toEqual(['session']);
  });

  // The bug this caught for real: `ids.rs` and `ipc/model.rs` exist precisely to
  // depend on nothing, and their doc comments say so by NAMING the domain they
  // no longer depend on. Counting those made both read as cyclic with `session`.
  it('ignores a domain named only in a comment', () => {
    expect(crateRefsOf('//! moved out of crate::session\npub fn now_ms() {}')).toEqual([]);
    expect(crateRefsOf('/// see crate::session::models\nlet a = 1;')).toEqual([]);
  });
});

describe('domainCycleFindings', () => {
  const mutual = [
    rs('src-tauri/src/account/mod.rs', { crateRefs: ['session'] }),
    rs('src-tauri/src/session/mod.rs', { crateRefs: ['account'] }),
  ];

  it('errors on a NEW mutual pair', () => {
    const found = domainCycleFindings(mutual, []);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toMatch(/NEW module cycle/);
  });

  it('reports the pair once, not once per direction', () => {
    expect(domainCycleFindings(mutual, [])).toHaveLength(1);
  });

  it('only warns for a cycle that is already on the baseline', () => {
    expect(domainCycleFindings(mutual, ['account<->session'])[0].severity).toBe('warn');
  });

  // The rule that keeps it usable: ordinary layering is not a finding, so
  // nobody has a reason to route around it.
  it('says nothing about a one-directional reference', () => {
    const layered = [
      rs('src-tauri/src/session/mod.rs', { crateRefs: ['account'] }),
      rs('src-tauri/src/account/mod.rs', { crateRefs: [] }),
    ];
    expect(domainCycleFindings(layered, [])).toEqual([]);
  });

  // `crate::dispose_session_shells` is a crate-root re-export, not a module.
  it('ignores a crate:: reference that names no domain', () => {
    const files = [
      rs('src-tauri/src/session/mod.rs', { crateRefs: ['dispose_session_shells'] }),
      rs('src-tauri/src/shell/mod.rs', { crateRefs: ['session'] }),
    ];
    expect(domainCycleFindings(files, [])).toEqual([]);
  });
});

describe('allFindings', () => {
  it('runs every rule in one pass', () => {
    const found = allFindings(
      [
        { path: 'src/features/a/index.ts', lines: 10, imports: ['../b/thing'] },
        { path: 'src/big.ts', lines: big, imports: [] },
        rs('src-tauri/src/a/one.rs', { spawnSites: [4], crateRefs: ['b'] }),
        rs('src-tauri/src/b/two.rs', { crateRefs: ['a'] }),
      ],
      {},
    );
    expect(new Set(found.map((f) => f.rule))).toEqual(
      new Set(['no-barrel', 'cross-feature-import', 'file-size', 'bare-spawn', 'domain-cycle']),
    );
  });

  // The pre-FR-8 call shape — a bare oversized list — still means what it did.
  it('accepts a plain array as the oversized baseline', () => {
    const files = [{ path: 'src/old.ts', lines: big, imports: [] }];
    expect(allFindings(files, ['src/old.ts'])[0].severity).toBe('warn');
  });
});
