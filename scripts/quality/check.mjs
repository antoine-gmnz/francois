// scripts/quality/check.mjs — the I/O half of the convention checker.
//
// Walks the tracked source surfaces, hands plain data to conventions.mjs, then
// prints a report and sets the exit code. Zero dependencies, plain ESM, so CI
// can `node` it straight after checkout with no build and no install.
//
//   node scripts/quality/check.mjs                     # human report, exit 1 on errors
//   node scripts/quality/check.mjs --json reports/conventions.json
//   node scripts/quality/check.mjs --sarif reports/conventions.sarif
//   node scripts/quality/check.mjs --update-baseline               # re-record ALL three
//   node scripts/quality/check.mjs --update-baseline bare-spawn    # …or just one rule
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allFindings,
  summarize,
  importsOf,
  spawnSitesOf,
  crateRefsOf,
  domainOf,
  domainsOf,
  MAX_FILE_LINES,
  SPAWN_FACADE,
} from './conventions.mjs';
import { buildSarif, serializeSarif } from './sarif.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const QUALITY = join(ROOT, 'scripts', 'quality');
const BASELINE = join(QUALITY, 'oversized-baseline.json');
// core-architecture-wave3 FR-8/FR-10. One file per ratchet, not one shared one:
// each is regenerated at the end of its own chain (spec §7.6), and a shared file
// would make regenerating one of them silently re-record the other two.
const SPAWN_BASELINE = join(QUALITY, 'spawn-baseline.json');
const CYCLE_BASELINE = join(QUALITY, 'cycle-baseline.json');

const SOURCE_DIRS = ['src', 'contract', 'src-tauri/src', 'scripts', 'packaging/npm'];
const SOURCE_EXT = /\.(ts|tsx|rs|mjs|js)$/;
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'vendor', 'coverage', 'reports', '.git']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a surface that does not exist in this checkout is not an error
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(e.name)) out.push(full);
  }
  return out;
}

function collect() {
  const files = [];
  for (const d of SOURCE_DIRS) {
    for (const full of walk(join(ROOT, d))) {
      const rel = relative(ROOT, full).split(sep).join('/');
      const source = readFileSync(full, 'utf8');
      const rust = /\.rs$/.test(rel);
      files.push({
        path: rel,
        lines: source.length === 0 ? 0 : source.split('\n').length,
        imports: /\.tsx?$/.test(rel) ? importsOf(source) : [],
        spawnSites: rust ? spawnSitesOf(source) : [],
        crateRefs: rust ? crateRefsOf(source) : [],
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback; // a baseline that does not exist yet records nothing
  }
}

function loadBaselines() {
  return {
    oversized: readJson(BASELINE, {}).oversized ?? [],
    bareSpawn: readJson(SPAWN_BASELINE, {}).allowed ?? {},
    domainCycle: readJson(CYCLE_BASELINE, {}).cycles ?? [],
  };
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`  wrote ${relative(ROOT, file).split(sep).join('/')}`);
}

function writeOut(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`  wrote ${relative(ROOT, file).split(sep).join('/')}`);
}

function toSarif(findings) {
  return serializeSarif(
    buildSarif({
      toolName: 'francois-conventions',
      informationUri: 'https://github.com/antoine-gmnz/francois/blob/main/CLAUDE.md',
      findings,
    }),
  );
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : (argv[i + 1] ?? true);
  };

  const files = collect();

  if (argv.includes('--update-baseline')) {
    const only = flag('--update-baseline');
    const wants = (rule) => only === true || only === rule;
    mkdirSync(QUALITY, { recursive: true });

    if (wants('file-size')) {
      const oversized = files.filter((f) => f.lines > MAX_FILE_LINES).map((f) => f.path);
      writeJson(BASELINE, {
        _comment:
          'Files already over the CLAUDE.md 1000-line cap when the quality gate landed. A file here warns; a file NOT here that crosses the cap fails the build. Shrink the list, never grow it.',
        maxFileLines: MAX_FILE_LINES,
        oversized,
      });
      console.log(`file-size baseline: ${oversized.length} oversized file(s)`);
    }

    if (wants('bare-spawn')) {
      const allowed = {};
      for (const f of files) {
        if (!/^src-tauri\/src\/.+\.rs$/.test(f.path) || f.path === SPAWN_FACADE) continue;
        if (f.spawnSites.length > 0) allowed[f.path] = f.spawnSites.length;
      }
      writeJson(SPAWN_BASELINE, {
        _comment:
          'core-architecture-wave3 FR-8. Files still constructing std::process::Command directly instead of going through process_util::spawn, with the number of sites each is allowed. A file over its count fails the build; a file at or under it warns. Shrink these, never grow them.',
        facade: SPAWN_FACADE,
        allowed,
      });
      console.log(`bare-spawn baseline: ${Object.keys(allowed).length} file(s)`);
    }

    if (wants('domain-cycle')) {
      const domains = domainsOf(files);
      const edges = new Set();
      for (const f of files) {
        if (!/^src-tauri\/src\/.+\.rs$/.test(f.path)) continue;
        const from = domainOf(f.path);
        if (!from) continue;
        for (const to of f.crateRefs) {
          if (to !== from && domains.has(to)) edges.add(`${from}->${to}`);
        }
      }
      const cycles = [
        ...new Set(
          [...edges]
            .map((e) => e.split('->'))
            .filter(([from, to]) => edges.has(`${to}->${from}`))
            .map(([from, to]) => (from < to ? `${from}<->${to}` : `${to}<->${from}`)),
        ),
      ].sort();
      writeJson(CYCLE_BASELINE, {
        _comment:
          'core-architecture-wave3 FR-10. Module cycles between core domains that already exist: `a<->b` means a/ references crate::b AND b/ references crate::a. A pair here warns; a NEW pair fails the build. Rust does not reject intra-crate cycles and clippy has no lint for them, so this list is the only thing stopping the graph getting worse. Shrink it, never grow it.',
        cycles,
      });
      console.log(`domain-cycle baseline: ${cycles.length} cycle(s)`);
    }
    return 0;
  }

  const findings = allFindings(files, loadBaselines());
  const { errors, warnings, byRule } = summarize(findings);

  const jsonOut = flag('--json');
  if (typeof jsonOut === 'string') {
    writeOut(join(ROOT, jsonOut), `${JSON.stringify({ summary: { errors, warnings, byRule }, findings }, null, 2)}\n`);
  }
  const sarifOut = flag('--sarif');
  if (typeof sarifOut === 'string') writeOut(join(ROOT, sarifOut), toSarif(findings));

  console.log(`\nconventions — ${files.length} files scanned\n`);
  for (const [rule, counts] of Object.entries(byRule).sort()) {
    console.log(`  ${rule.padEnd(22)} ${String(counts.error).padStart(3)} error  ${String(counts.warn).padStart(3)} warn`);
  }
  if (errors > 0) {
    console.log('\nerrors:');
    for (const f of findings.filter((x) => x.severity === 'error')) {
      console.log(`  ${f.path}\n      ${f.message}`);
    }
  }
  console.log(`\n${errors} error(s), ${warnings} warning(s)\n`);
  return errors > 0 ? 1 : 0;
}

process.exit(main());
