import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// What `npm publish` would actually put in the tarball, asked of npm itself
// rather than reimplemented from the `files` globs — the point of this file is
// to catch a mismatch between what npm packs and what the CLI needs, so
// deriving one from the other would be circular.
// On Windows npm is a `npm.cmd` shim: a bare `npm` resolves to no executable
// (ENOENT), and since Node's CVE-2024-27980 fix a `.cmd` cannot be spawned
// without a shell either (EINVAL). Every argument here is a literal, so the
// shell has nothing to interpolate.
const WIN = process.platform === 'win32';

function packedFiles() {
  const out = execFileSync(WIN ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: WIN,
  });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

// Regression (v0.19.0): `files` listed lib/ entries ONE BY ONE, so the
// lib/extensions.js added with the extensions CLI was never published. The
// require sits at the top of bin/francois.js, so EVERY command of the
// installed package threw MODULE_NOT_FOUND — `francois --version` included.
// A directory entry plus a test-file exclusion is what makes this structural;
// this test is what keeps it that way.
describe('packaging/npm publishable contents', () => {
  const packed = packedFiles();

  it('ships every lib/ module the CLI requires at load time', () => {
    const src = fs.readFileSync(path.join(__dirname, 'bin', 'francois.js'), 'utf8');
    const required = [...src.matchAll(/require\('\.\.\/(lib\/[\w.-]+)'\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    for (const rel of required) expect(packed).toContain(rel);
  });

  it('ships the entry point the bin field names', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    for (const target of Object.values(pkg.bin)) expect(packed).toContain(target);
    for (const script of ['install.js', 'uninstall.js']) expect(packed).toContain(script);
  });

  it('ships no test files', () => {
    expect(packed.filter((f) => f.endsWith('.test.mjs'))).toEqual([]);
  });
});
