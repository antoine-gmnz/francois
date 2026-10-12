// code-editor-workspace FR-3/FR-4: Monaco markers → the problems panel's groups and counts.

import { describe, expect, it } from 'vitest';
import { codeLabel, codePathOf, groupProblems, modelUriPath, parseModelUriPath, problemCounts, toProblem, withOrphans, type MarkerLike, type Problem } from './problems';

const marker = (p: Partial<MarkerLike> = {}): MarkerLike => ({
  severity: 8,
  message: 'boom',
  startLineNumber: 3,
  startColumn: 5,
  endLineNumber: 3,
  endColumn: 9,
  ...p,
});

const problem = (path: string, p: Partial<Problem> = {}): Problem => ({ ...toProblem(path, marker()), ...p });

describe('model uri paths', () => {
  it('round-trips a Code-tab path through the model uri path', () => {
    const uriPath = modelUriPath('project:p1', 'src/a.ts');
    expect(uriPath).toBe('/project%3Ap1/src/a.ts');
    expect(codePathOf('project:p1', uriPath)).toBe('src/a.ts');
  });

  it('parses any Code-tab model uri path back into its root key and path (code-editor-lsp)', () => {
    expect(parseModelUriPath(modelUriPath('session:s1', 'src/a b.ts'))).toEqual({ rootKey: 'session:s1', path: 'src/a b.ts' });
    expect(parseModelUriPath('/project%3Ap1/')).toBeNull();
    expect(parseModelUriPath('/lonely')).toBeNull();
    expect(parseModelUriPath('relative/a.ts')).toBeNull();
  });

  it('refuses a model of another root', () => {
    expect(codePathOf('project:p1', modelUriPath('project:p2', 'a.ts'))).toBeNull();
    expect(codePathOf('project:p1', '/elsewhere.ts')).toBeNull();
  });
});

describe('toProblem', () => {
  it('maps Monaco severities and reads string or object codes', () => {
    expect(toProblem('a.ts', marker({ severity: 8, code: '2304' }))).toMatchObject({ severity: 'error', code: '2304', line: 3, column: 5 });
    expect(toProblem('a.ts', marker({ severity: 4, code: { value: '6133', target: {} } })).severity).toBe('warning');
    expect(toProblem('a.ts', marker({ severity: 2 })).severity).toBe('info');
    expect(toProblem('a.ts', marker({ severity: 1 })).code).toBeNull();
  });

  it('labels the code by its source, ts() when there is none (code-editor-lsp FR-12)', () => {
    expect(codeLabel(toProblem('a.ts', marker({ code: '2304' })))).toBe('ts(2304)');
    expect(codeLabel(toProblem('a.rs', marker({ code: 'E0308', source: 'rustc' })))).toBe('rustc(E0308)');
    expect(codeLabel(toProblem('a.rs', marker()))).toBeNull();
    expect(toProblem('a.ts', marker({ severity: 1 })).severity).toBe('hint');
  });
});

describe('problemCounts', () => {
  it('counts errors, warnings, and info+hint', () => {
    const ps = [problem('a', { severity: 'error' }), problem('a', { severity: 'warning' }), problem('b', { severity: 'hint' }), problem('b', { severity: 'info' })];
    expect(problemCounts(ps)).toEqual({ errors: 1, warnings: 1, infos: 2 });
  });
});

describe('groupProblems', () => {
  const ps = [
    problem('src/b.ts', { line: 9, severity: 'warning', message: 'unused x' }),
    problem('src/b.ts', { line: 2, severity: 'warning', message: 'unused y' }),
    problem('src/b.ts', { line: 20, severity: 'error', message: 'missing' }),
    problem('a.ts', { line: 1, message: 'Cannot find name' }),
  ];

  it('one group per file, by path, rows by severity then line', () => {
    const groups = groupProblems(ps, '');
    expect(groups.map((g) => [g.path, g.name, g.dir])).toEqual([
      ['a.ts', 'a.ts', ''],
      ['src/b.ts', 'b.ts', 'src'],
    ]);
    expect(groups[1].problems.map((p) => p.line)).toEqual([20, 2, 9]);
  });

  it('filters by substring over message or path, case-insensitively', () => {
    expect(groupProblems(ps, 'UNUSED').flatMap((g) => g.problems.map((p) => p.message))).toEqual(['unused y', 'unused x']);
    expect(groupProblems(ps, 'a.ts').map((g) => g.path)).toEqual(['a.ts']);
  });
});

describe('withOrphans (code-editor-lsp FR-12)', () => {
  it('adds the diagnostics of files without a model to the markers', () => {
    const markers = [problem('a.ts')];
    expect(withOrphans(markers, undefined)).toBe(markers);
    expect(withOrphans(markers, {}).length).toBe(1);
    const out = withOrphans(markers, { 'b.ts': { problems: [problem('b.ts'), problem('b.ts', { line: 9 })] } });
    expect(out.map((p) => p.path)).toEqual(['a.ts', 'b.ts', 'b.ts']);
  });
});
