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

// ---------------------------------------------------------------------------
// core-architecture-wave3 FR-8 / FR-10 — the two Rust-shape ratchets.
//
// Both exist for the same reason the file-size ratchet does: the rule they
// enforce is a repo-shape rule that neither clippy nor rustc can express.
// Rust does not reject an intra-crate module cycle, and it has no opinion at
// all about which of two ways to start a child process you used.
// ---------------------------------------------------------------------------

/** The one file allowed to construct a `std::process::Command` — the FR-7 facade. */
export const SPAWN_FACADE = 'src-tauri/src/process_util.rs';

const RUST_SRC = /^src-tauri\/src\/.+\.rs$/;

/**
 * FR-8: every child process goes through `process_util::spawn`, which applies
 * the four spawn concerns (login-shell PATH, window suppression, environment,
 * stdio) by construction. A bare `Command::new` applies whichever of them its
 * author remembered — which is exactly how ext-path-resolution's bug reached a
 * user: the sites that forgot the login-shell PATH were invisible.
 *
 * `baseline` is `{ "<path>": <allowed count> }`. A file over its allowance
 * errors; a file at or under a non-zero allowance warns, so the debt is visible
 * in the report without blocking a build on it. Regenerate with:
 *   node scripts/quality/check.mjs --update-baseline bare-spawn
 */
export function bareSpawnFindings(files, baseline = {}) {
  const out = [];
  for (const { path, spawnSites } of files) {
    if (!RUST_SRC.test(path) || path === SPAWN_FACADE) continue;
    const count = (spawnSites ?? []).length;
    if (count === 0) continue;
    const allowed = baseline[path] ?? 0;
    const lines = (spawnSites ?? []).join(', ');
    out.push({
      rule: 'bare-spawn',
      severity: count > allowed ? 'error' : 'warn',
      path,
      message:
        count > allowed
          ? `${count} bare Command::new site(s) (line ${lines}), ${allowed} allowed. core-architecture-wave3 FR-7: start children with process_util::spawn, which applies PATH resolution, window suppression, the environment policy and stdio discipline by construction.`
          : `${count} bare Command::new site(s) (line ${lines}) — known debt; migrate to process_util::spawn when you next touch this file.`,
    });
  }
  return out;
}

/**
 * The `crate::<domain>` references a Rust source makes. `crate::{a::X, b::Y}`
 * counts as both. Deliberately regex-based, like `importsOf`: scripts/ has zero
 * dependencies, so there is no parser to reach for.
 *
 * Comments are stripped first, and that is load-bearing rather than tidy: this
 * codebase's doc comments explain WHY a dependency was removed, naming the
 * domain they no longer depend on. Counting those made `ids` and `ipc` — two
 * leaf modules that exist precisely to have no dependencies — read as cyclic.
 */
export function crateRefsOf(source) {
  const out = new Set();
  const code = stripRustComments(source);
  const grouped = /crate::\{([^}]*)\}/g;
  let m;
  while ((m = grouped.exec(code)) !== null) {
    for (const part of m[1].split(',')) {
      const name = /^\s*([a-z_][a-z0-9_]*)/.exec(part);
      if (name) out.add(name[1]);
    }
  }
  const plain = /crate::([a-z_][a-z0-9_]*)/g;
  while ((m = plain.exec(code)) !== null) out.add(m[1]);
  return [...out].sort();
}

/** The domain a core source belongs to: the first segment under `src-tauri/src/`. */
export function domainOf(path) {
  const m = /^src-tauri\/src\/([^/]+?)(?:\.rs)?(?:\/|$)/.exec(path);
  return m ? m[1] : null;
}

/** Every domain the core actually has, as named by the files on disk. */
export function domainsOf(files) {
  const out = new Set();
  for (const { path } of files) {
    if (!RUST_SRC.test(path)) continue;
    const d = domainOf(path);
    if (d) out.add(d);
  }
  return out;
}

/** `a` and `b` as one order-independent key, so `a<->b` and `b<->a` are one pair. */
function pairKey(a, b) {
  return a < b ? `${a}<->${b}` : `${b}<->${a}`;
}

/**
 * FR-10: a MUTUAL pair of domains — `a` reaching into `b` while `b` reaches back
 * into `a` — is a module cycle. Rust compiles those happily and clippy has no
 * lint for them, so without this check the graph only ever gets worse; the two
 * that already exist took a dedicated feature to unpick.
 *
 * Only mutual pairs are reported, not every new edge: a one-directional
 * `crate::` reference is ordinary layering, and failing the build on those would
 * make the rule something people route around.
 *
 * `baseline` is the list of pair keys (`"a<->b"`) that already exist. A pair not
 * on it errors, on the first file that closes it. Regenerate with:
 *   node scripts/quality/check.mjs --update-baseline domain-cycle
 */
export function domainCycleFindings(files, baseline = []) {
  const known = new Set(baseline);
  const edges = new Map(); // "from->to" -> first path that makes it
  // A `crate::` reference only names a domain when a domain by that name
  // exists: `crate::dispose_session_shells` is a crate-root re-export, not an
  // edge into a module, and counting it would put a phantom node in the graph.
  const domains = domainsOf(files);
  for (const { path, crateRefs } of files) {
    if (!RUST_SRC.test(path)) continue;
    const from = domainOf(path);
    if (!from) continue;
    for (const to of crateRefs ?? []) {
      if (to === from || !domains.has(to)) continue;
      const key = `${from}->${to}`;
      if (!edges.has(key)) edges.set(key, path);
    }
  }

  const out = [];
  const seen = new Set();
  for (const key of [...edges.keys()].sort()) {
    const [from, to] = key.split('->');
    if (!edges.has(`${to}->${from}`)) continue; // one-directional: ordinary layering
    const pair = pairKey(from, to);
    if (seen.has(pair)) continue;
    seen.add(pair);
    out.push({
      rule: 'domain-cycle',
      severity: known.has(pair) ? 'warn' : 'error',
      path: edges.get(key),
      message: known.has(pair)
        ? `${pair} is a known module cycle — do not deepen it; invert the dependency (a shared value type, or a trait the other side implements) when you next touch either.`
        : `${pair} is a NEW module cycle: ${from}/ references crate::${to} and ${to}/ references crate::${from}. Rust does not reject this and clippy has no lint for it. Invert one direction — a value type both depend on, or a trait the callee implements — rather than baselining it.`,
    });
  }
  return out;
}

/**
 * Every rule, in one pass. `files` is
 * `[{ path, lines, imports, spawnSites, crateRefs }]`, and `baselines` is
 * `{ oversized, bareSpawn, domainCycle }`. An array is accepted for
 * `baselines` as the pre-FR-8 shape (the oversized list alone).
 */
export function allFindings(files, baselines = {}) {
  const b = Array.isArray(baselines) ? { oversized: baselines } : baselines;
  return [
    ...oversizedFindings(files, b.oversized ?? []),
    ...barrelFindings(files.map((f) => f.path)),
    ...crossFeatureFindings(files),
    ...bareSpawnFindings(files, b.bareSpawn ?? {}),
    ...domainCycleFindings(files, b.domainCycle ?? []),
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

/** Parse the bare `std::process::Command` construction sites out of a Rust
 *  source, as 1-based line numbers. Aliased imports count: a site that writes
 *  `use std::process::Command as Cmd;` and then `Cmd::new(...)` is the same
 *  bypass, and was in fact how three of them hid from the first FR-7 sweep.
 *  Comment lines are skipped — `Command::new("codex")` appears in several doc
 *  comments explaining why the facade exists. */
export function spawnSitesOf(source) {
  const aliases = new Set(['Command']);
  const aliasRe = /use\s+std::process::Command\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  let m;
  while ((m = aliasRe.exec(source)) !== null) aliases.add(m[1]);

  const out = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('//')) continue;
    for (const alias of aliases) {
      if (lines[i].includes(`${alias}::new(`)) {
        out.push(i + 1);
        break;
      }
    }
  }
  return out;
}

/** Line and block comments out of a Rust source, replaced by nothing. String
 *  literals are not tracked: a `crate::` inside one is vanishingly rare here and
 *  over-reporting one is a conversation, not a hole. */
export function stripRustComments(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = withoutBlocks.split('\n').map((line) => {
    if (line.trimStart().startsWith('//')) return '';
    return line.replace(/\s\/\/.*$/, '');
  });
  return lines.join('\n');
}
