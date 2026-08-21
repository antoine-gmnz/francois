// scripts/quality/report.mjs — run every quality tool, write machine-readable
// reports plus one markdown summary.
//
//   node scripts/quality/report.mjs            # everything it can run here
//   node scripts/quality/report.mjs --no-rust  # skip clippy (no toolchain)
//
// Outputs, all under reports/ (gitignored):
//   eslint.{json,sarif}  conventions.{json,sarif}  clippy.{json,sarif}
//   summary.md           ← the CI job summary, and a readable local digest
//
// This NEVER fails on findings — it is a reporter. The gates are `npm run
// quality` locally and the individual CI steps; conflating "tell me" with
// "block me" is what makes people stop reading reports. Exit is non-zero only
// if a tool could not be run at all.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSarif, serializeSarif, normalizeUri } from './sarif.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'reports');

// Run eslint's entry script under THIS node rather than shelling out to `npx`.
// Since Node 18.20.2 / 20.12.2 (CVE-2024-27980) spawnSync refuses a Windows
// `.cmd` without `shell: true`, and turning the shell on to run a linter means
// quoting every path it is given. Resolving the bin removes both problems.
const ESLINT_BIN = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');

const rel = (p) => relative(ROOT, p).split(sep).join('/');

function write(name, contents) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), contents);
  return rel(join(OUT, name));
}

/** Run a command, tolerating a non-zero exit (a linter with findings exits 1). */
function run(cmd, args, opts = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(cmd, args, {
        cwd: opts.cwd ?? ROOT,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (e) {
    // A spawn failure (ENOENT, and on Windows a shell-less npx) yields no
    // stdout; a linter that merely found something exits non-zero WITH stdout.
    const stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString?.() ?? '');
    if (!stdout) return { ok: false, error: e.message, stdout: '' };
    return { ok: true, stdout };
  }
}

// ── eslint ───────────────────────────────────────────────────────────────────
function eslintReport() {
  if (!existsSync(ESLINT_BIN)) return { name: 'eslint', unavailable: 'not installed (npm ci)' };
  const { ok, stdout, error } = run(process.execPath, [ESLINT_BIN, '.', '--format', 'json']);
  if (!ok || !stdout.trim()) return { name: 'eslint', unavailable: error ?? 'no output' };

  let results;
  try {
    results = JSON.parse(stdout);
  } catch {
    return { name: 'eslint', unavailable: 'unparseable output' };
  }

  const findings = [];
  for (const file of results) {
    for (const m of file.messages) {
      findings.push({
        rule: m.ruleId ?? 'eslint',
        severity: m.severity === 2 ? 'error' : 'warn',
        path: normalizeUri(rel(file.filePath)),
        line: m.line,
        message: m.message,
      });
    }
  }
  write('eslint.json', `${JSON.stringify(results, null, 2)}\n`);
  write(
    'eslint.sarif',
    serializeSarif(
      buildSarif({ toolName: 'eslint', informationUri: 'https://eslint.org', findings }),
    ),
  );
  return { name: 'eslint', findings };
}

// ── conventions (CLAUDE.md §Code layout) ─────────────────────────────────────
function conventionsReport() {
  const { ok, error } = run(process.execPath, [
    join(ROOT, 'scripts', 'quality', 'check.mjs'),
    '--json',
    'reports/conventions.json',
    '--sarif',
    'reports/conventions.sarif',
  ]);
  if (!ok) return { name: 'conventions', unavailable: error };
  const p = join(OUT, 'conventions.json');
  if (!existsSync(p)) return { name: 'conventions', unavailable: 'no report written' };
  return { name: 'conventions', findings: JSON.parse(readFileSync(p, 'utf8')).findings };
}

// ── clippy ───────────────────────────────────────────────────────────────────
// `cargo clippy --message-format json` emits one JSON object per line; the ones
// we want are `{reason: "compiler-message"}` whose span points into src-tauri.
function clippyReport() {
  const { ok, stdout, error } = run(
    'cargo',
    ['clippy', '--all-targets', '--message-format', 'json'],
    { cwd: join(ROOT, 'src-tauri') },
  );
  if (!ok) return { name: 'clippy', unavailable: error };

  const findings = [];
  const seen = new Set();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.reason !== 'compiler-message') continue;
    const m = msg.message;
    if (!m?.code || (m.level !== 'warning' && m.level !== 'error')) continue;
    const span = m.spans?.find((s) => s.is_primary) ?? m.spans?.[0];
    if (!span) continue;
    // --all-targets compiles the bin and its test target, so the same finding
    // is reported twice; dedupe on rule+file+line.
    const key = `${m.code.code}|${span.file_name}|${span.line_start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      rule: m.code.code,
      severity: m.level === 'error' ? 'error' : 'warn',
      path: normalizeUri(`src-tauri/${span.file_name}`),
      line: span.line_start,
      message: m.message,
    });
  }
  write('clippy.json', `${JSON.stringify(findings, null, 2)}\n`);
  write(
    'clippy.sarif',
    serializeSarif(
      buildSarif({
        toolName: 'clippy',
        informationUri: 'https://rust-lang.github.io/rust-clippy/',
        findings,
      }),
    ),
  );
  return { name: 'clippy', findings };
}

// ── summary ──────────────────────────────────────────────────────────────────
function countsOf(findings) {
  const errors = findings.filter((f) => f.severity === 'error').length;
  return { errors, warnings: findings.length - errors };
}

function topRules(findings, n = 5) {
  const by = {};
  for (const f of findings) by[f.rule] = (by[f.rule] ?? 0) + 1;
  return Object.entries(by)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function summaryMarkdown(reports) {
  const lines = ['# Code quality report', ''];

  lines.push('| tool | errors | warnings |', '| --- | ---: | ---: |');
  for (const r of reports) {
    if (r.unavailable) {
      lines.push(`| ${r.name} | — | _not run: ${r.unavailable}_ |`);
      continue;
    }
    const { errors, warnings } = countsOf(r.findings);
    lines.push(`| ${r.name} | ${errors} | ${warnings} |`);
  }
  lines.push('');

  for (const r of reports) {
    if (r.unavailable || r.findings.length === 0) continue;
    lines.push(`## ${r.name}`, '');
    const errs = r.findings.filter((f) => f.severity === 'error');
    if (errs.length) {
      lines.push('**Errors** (these fail the build):', '');
      for (const f of errs.slice(0, 25)) {
        lines.push(`- \`${f.path}:${f.line ?? 1}\` — ${f.message} _(${f.rule})_`);
      }
      if (errs.length > 25) lines.push(`- …and ${errs.length - 25} more`);
      lines.push('');
    }
    const top = topRules(r.findings.filter((f) => f.severity === 'warn'));
    if (top.length) {
      lines.push('Most frequent warnings:', '');
      for (const [rule, n] of top) lines.push(`- \`${rule}\` × ${n}`);
      lines.push('');
    }
  }

  lines.push(
    '---',
    '',
    'Warnings are tracked debt, not build failures — see `eslint.config.js`,',
    '`src-tauri/Cargo.toml` `[lints]` and `scripts/quality/conventions.mjs` for why each',
    'rule sits at the level it does. Run `npm run quality` to reproduce the gates locally.',
    '',
  );
  return lines.join('\n');
}

function main() {
  const skipRust = process.argv.includes('--no-rust');
  const reports = [eslintReport(), conventionsReport()];
  if (!skipRust) reports.push(clippyReport());

  const paths = ['eslint.json', 'eslint.sarif', 'conventions.json', 'conventions.sarif'];
  if (!skipRust) paths.push('clippy.json', 'clippy.sarif');

  const md = summaryMarkdown(reports);
  write('summary.md', md);

  console.log(md);
  for (const p of paths) if (existsSync(join(OUT, p))) console.log(`  reports/${p}`);

  // Only a tool that could not run at all is a failure here.
  return reports.some((r) => r.unavailable && r.name !== 'clippy') ? 1 : 0;
}

process.exit(main());
