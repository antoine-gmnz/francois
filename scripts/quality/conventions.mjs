// scripts/quality/conventions.mjs — the PURE half of the convention checker.
//
// These are the CLAUDE.md §Code layout rules that neither ESLint nor clippy can
// express, because they are about the shape of the repo rather than the shape
// of a statement. Every function here takes plain data and returns findings; the
// filesystem walk, the printing and the exit code live in check.mjs, mirroring
// the version.mjs / bump.mjs split used by scripts/release.
//
// Severity policy (the "ratchet"): a rule with ZERO violations today is an
// `error`, because it can only ever fire on new code. A rule with existing
// violations is a `warn` carrying its count, so it shows up in the report and
// in review without blocking a build on debt nobody is being asked to pay down
// in this PR.

/** CLAUDE.md §Code layout: "no source file over ~1000 lines." */
export const MAX_FILE_LINES = 1000;

/**
 * Files over the cap that already existed when the checker landed. A file in
 * here is a warning; a file NOT in here that crosses the cap is an error, which
 * is what stops the list from growing. Regenerate with:
 *   node scripts/quality/check.mjs --update-baseline
 */
export function oversizedFindings(files, baseline, max = MAX_FILE_LINES) {
  const known = new Set(baseline);
  const out = [];
  for (const { path, lines } of files) {
    if (lines <= max) continue;
    out.push({
      rule: 'file-size',
      severity: known.has(path) ? 'warn' : 'error',
      path,
      message: known.has(path)
        ? `${lines} lines (over the ${max}-line cap; known debt — split by concern when you next touch it)`
        : `${lines} lines exceeds the ${max}-line cap. CLAUDE.md: split by concern rather than growing the file, and move each test with the code it covers.`,
    });
  }
  return out;
}

/**
 * CLAUDE.md §Code layout: "No barrel files anywhere — import the module
 * directly." Zero of these exist today, so any hit is a regression.
 */
export function barrelFindings(paths) {
  return paths
    .filter((p) => /(^|\/)(src\/features\/[^/]+|src\/lib|src\/ui|src\/app)\/index\.tsx?$/.test(p))
    .map((path) => ({
      rule: 'no-barrel',
      severity: 'error',
      path,
      message: 'CLAUDE.md: no barrel files — import the module directly.',
    }));
}

/**
 * Reads `src/features/<a>/…` importing `../<b>/…`. Reported, never fatal: 63 of
 * these exist and many are legitimate composition. The number is the signal —
 * if it climbs, shared code is owed a move to src/ui or src/lib instead.
 */
export function crossFeatureFindings(files) {
  const out = [];
  for (const { path, imports } of files) {
    const from = /^src\/features\/([^/]+)\//.exec(path);
    if (!from) continue;
    for (const spec of imports) {
      const to = /^\.\.\/([a-z0-9-]+)\//.exec(spec);
      if (!to || to[1] === from[1]) continue;
      out.push({
        rule: 'cross-feature-import',
        severity: 'warn',
        path,
        message: `imports from feature '${to[1]}' — if this is shared, CLAUDE.md says move it to src/ui or src/lib rather than importing across feature folders.`,
      });
    }
  }
  return out;
}

/** Every rule, in one pass. `files` is [{ path, lines, imports }]. */
export function allFindings(files, baseline) {
  return [
    ...oversizedFindings(files, baseline),
    ...barrelFindings(files.map((f) => f.path)),
    ...crossFeatureFindings(files),
  ];
}

export function summarize(findings) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warn');
  const byRule = {};
  for (const f of findings) {
    byRule[f.rule] = byRule[f.rule] || { error: 0, warn: 0 };
    byRule[f.rule][f.severity] += 1;
  }
  return { errors: errors.length, warnings: warnings.length, byRule };
}

/** Parse the import specifiers out of a TS/TSX source. Deliberately regex-based:
 *  this file may not depend on a parser (scripts/ has zero dependencies). */
export function importsOf(source) {
  const out = [];
  const re = /(?:^|\n)\s*(?:import|export)[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}
