// scripts/quality/check.mjs — the I/O half of the convention checker.
//
// Walks the tracked source surfaces, hands plain data to conventions.mjs, then
// prints a report and sets the exit code. Zero dependencies, plain ESM, so CI
// can `node` it straight after checkout with no build and no install.
//
//   node scripts/quality/check.mjs                     # human report, exit 1 on errors
//   node scripts/quality/check.mjs --json reports/conventions.json
//   node scripts/quality/check.mjs --sarif reports/conventions.sarif
//   node scripts/quality/check.mjs --update-baseline    # re-record known-oversized files
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allFindings, summarize, importsOf, MAX_FILE_LINES } from './conventions.mjs';
import { buildSarif, serializeSarif } from './sarif.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = join(ROOT, 'scripts', 'quality', 'oversized-baseline.json');

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
      files.push({
        path: rel,
        lines: source.length === 0 ? 0 : source.split('\n').length,
        imports: /\.tsx?$/.test(rel) ? importsOf(source) : [],
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8')).oversized ?? [];
  } catch {
    return [];
  }
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
    const oversized = files.filter((f) => f.lines > MAX_FILE_LINES).map((f) => f.path);
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(
      BASELINE,
      `${JSON.stringify(
        {
          _comment:
            'Files already over the CLAUDE.md 1000-line cap when the quality gate landed. A file here warns; a file NOT here that crosses the cap fails the build. Shrink the list, never grow it.',
          maxFileLines: MAX_FILE_LINES,
          oversized,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`baseline updated: ${oversized.length} oversized file(s)`);
    return 0;
  }

  const findings = allFindings(files, loadBaseline());
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
