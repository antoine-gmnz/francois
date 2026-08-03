// Guard: the demo backend (src/demo/) must never reach a shipped bundle.
//
// It exists only to capture the README screenshot and GIF — a whole invented
// fleet of sessions, transcripts and accounts. Nothing routes to it unless
// VITE_FRANCOIS_DEMO=1, so a leak is dead weight rather than a bug, but it is
// dead weight that has come back twice: Rollup keeps any top-level expression it
// cannot prove pure (a helper call, a property read), and keeping ONE anchors
// the module and everything it references. This asserts the outcome rather than
// the technique, so any future regression shows up here whatever caused it.
//
// CI runs `npm run build` before `npm test` (.github/workflows/ci.yml), so dist/
// is present there. Locally it may not be — the test says so instead of passing
// silently on nothing.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST = join(process.cwd(), 'dist', 'assets');

/** Strings that appear ONLY in src/demo/fixtures.ts. */
const DEMO_MARKERS = [
  'sess-orbit-api',
  'proj-orbit',
  'acct-work',
  'agent-test-writer',
  'review-auth-surface',
  'orbitlabs',
  'Capture the exchange params',
  '~/code/orbit',
];

function bundles() {
  if (!existsSync(DIST)) return null;
  return readdirSync(DIST)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ name: f, code: readFileSync(join(DIST, f), 'utf8') }));
}

describe('production bundle', () => {
  const built = bundles();

  it.skipIf(built === null)('carries no trace of the demo fixtures', () => {
    expect(built.length).toBeGreaterThan(0);
    const found = [];
    for (const { name, code } of built) {
      for (const marker of DEMO_MARKERS) {
        if (code.includes(marker)) found.push(`${name}: ${marker}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('has a dist/ to check (run `npm run build` first)', () => {
    // Deliberately NOT skipped: this is the signal that the check above ran.
    // It fails locally only when nothing has been built yet.
    expect(built, 'dist/assets is missing — run `npm run build`').not.toBeNull();
  });
});
