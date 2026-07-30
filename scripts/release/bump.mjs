#!/usr/bin/env node
// Decide the next version from the commits since the last release tag, then write
// it into every manifest that carries one. Called by .github/workflows/release.yml
// on every push to main; the decision logic itself lives in ./version.mjs.
//
//   node scripts/release/bump.mjs            # rewrite the manifests
//   node scripts/release/bump.mjs --dry-run  # print the plan, touch nothing
//
// Emits `version=` / `tag=` / `bump=` / `current=` to $GITHUB_OUTPUT when set.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planRelease } from './version.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dryRun = process.argv.includes('--dry-run');

const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const read = (relative) => readFileSync(join(repo, relative), 'utf8');

/**
 * Replace the first `"version": "..."` / `version = "..."` in a manifest.
 * Targeted on purpose: reserialising tauri.conf.json or Cargo.toml would churn
 * formatting and comments the humans own.
 */
function setVersion(relative, pattern, version) {
  const before = read(relative);
  const after = before.replace(pattern, `$1${version}`);
  if (after === before) throw new Error(`${relative}: no version line matched ${pattern}`);
  if (!dryRun) writeFileSync(join(repo, relative), after);
  return relative;
}

// ── where we stand ──────────────────────────────────────────────────────────
// `--match v[0-9]*` deliberately skips any non-version tag. Requires a full
// history in CI (actions/checkout with fetch-depth: 0), or the range is wrong.
let lastTag = '';
try {
  lastTag = git('describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0').trim();
} catch {
  console.warn('no v* tag found — treating this as the first release');
}

const manifestVersion = JSON.parse(read('src-tauri/tauri.conf.json')).version;

// %B is the full message; NUL-delimited so multi-line bodies survive the split.
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const messages = git('log', '--format=%B%x00', range).split('\0');

const plan = planRelease({ baselines: [lastTag, manifestVersion], messages });

// ── write it everywhere ─────────────────────────────────────────────────────
const touched = [
  // `npm version` is the only thing that reliably keeps package-lock.json in step.
  ...(() => {
    if (!dryRun) {
      execFileSync(
        'npm',
        ['version', plan.version, '--no-git-tag-version', '--allow-same-version'],
        { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' },
      );
    }
    return ['package.json', 'package-lock.json'];
  })(),
  // `\r?\n` throughout: a Windows checkout of this repo has CRLF line endings.
  setVersion('src-tauri/tauri.conf.json', /("version":\s*")[^"]+"/, `${plan.version}"`),
  setVersion(
    'src-tauri/Cargo.toml',
    /(\[package\][\s\S]*?\r?\nversion = ")[^"]+"/,
    `${plan.version}"`,
  ),
  // The lockfile records the crate's own version too; a stale entry leaves the
  // tree dirty after the first cargo invocation of the build.
  setVersion(
    'src-tauri/Cargo.lock',
    /(name = "francois"\r?\nversion = ")[^"]+"/,
    `${plan.version}"`,
  ),
];

const summary = `${plan.current} → ${plan.version} (${plan.bump}) from ${
  lastTag || 'the beginning'
}, ${messages.filter((m) => m.trim()).length} commit(s)`;
console.log(`${dryRun ? '[dry-run] ' : ''}${summary}`);
for (const file of touched) console.log(`  ${dryRun ? 'would write' : 'wrote'} ${file}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${plan.version}\ntag=${plan.tag}\nbump=${plan.bump}\ncurrent=${plan.current}\n`,
  );
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Release \`${plan.tag}\`\n\n${summary}\n`);
}
