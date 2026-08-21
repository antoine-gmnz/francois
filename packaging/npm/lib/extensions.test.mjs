/* eslint-disable no-control-regex --
 * These tests assert that control and bidi code points are STRIPPED from
 * untrusted text, so the control characters in the patterns below are the
 * subject under test, not a typo. */
import { describe, expect, it, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const {
  EXTENSION_ID_PATTERN,
  MANIFEST_MAX_BYTES,
  ARGV0_PATTERN,
  assertNoForbiddenArgv0,
  sanitizeForDisplay,
  extensionsDir,
  appDataDir,
  readToggles,
  isValidExtensionId,
  isGitUrl,
  idFromSource,
  readManifest,
  listExtensions,
  installExtension,
  removeExtension,
  resolveExtensionDir,
  resolveInstallSource,
} = require('./extensions.js');

/** Windows rejects C0 controls in a filename, so a few hostile-name fixtures
 *  below are unrepresentable there and use their bidi-only variant. */
const WINDOWS = process.platform === 'win32';

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'francois-ext-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function writePlugin(dir, manifest = { manifest: 1, label: 'K8s' }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest));
  return dir;
}

const GIT_AUTHOR = ['-c', 'user.email=t@t.test', '-c', 'user.name=t'];

/** A real, local git repo to clone from — offline (no network, filesystem-only
 * remote), but exercising the actual `git clone` path rather than a fake. */
function initGitRepo(dir, manifest) {
  writePlugin(dir, manifest);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', [...GIT_AUTHOR, 'add', '-A'], { cwd: dir });
  spawnSync('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function commitManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify(manifest));
  spawnSync('git', [...GIT_AUTHOR, 'add', '-A'], { cwd: dir });
  spawnSync('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'update'], { cwd: dir });
}

describe('extensionsDir', () => {
  it('is ~/.francois/extensions under the given home', () => {
    expect(extensionsDir('/home/u')).toBe(path.join('/home/u', '.francois', 'extensions'));
  });
});

describe('isValidExtensionId', () => {
  it('matches the contract EXTENSION_ID_PATTERN', () => {
    expect(EXTENSION_ID_PATTERN.test('git')).toBe(true);
    expect(isValidExtensionId('k8s-tools')).toBe(true);
    expect(isValidExtensionId('Git')).toBe(false);
    expect(isValidExtensionId('1git')).toBe(false);
    expect(isValidExtensionId('../etc')).toBe(false);
    expect(isValidExtensionId('a/b')).toBe(false);
  });
});

describe('isGitUrl / idFromSource', () => {
  it('recognizes git remotes and derives the target id from the source name', () => {
    expect(isGitUrl('git@github.com:acme/francois-k8s.git')).toBe(true);
    expect(isGitUrl('https://github.com/acme/francois-k8s.git')).toBe(true);
    expect(isGitUrl('/home/u/src/francois-k8s')).toBe(false);
    expect(isGitUrl('./local/path')).toBe(false);

    expect(idFromSource('git@github.com:acme/K8s.git')).toBe('k8s');
    expect(idFromSource('https://github.com/acme/francois-k8s.git')).toBe('francois-k8s');
    expect(idFromSource('/home/u/src/k8s/')).toBe('k8s');
  });
});

describe('appDataDir / readToggles', () => {
  it('resolves per OS and reads the app-owned enabled/consent record', () => {
    // Each expectation is in the separator flavour of the platform being
    // resolved FOR — `path.join` here would be the HOST's flavour, which made
    // these three pass on POSIX and fail on Windows for no reason the code
    // under test is responsible for.
    expect(appDataDir({ platform: 'darwin', home: '/Users/u' })).toContain('Library/Application Support');
    expect(appDataDir({ platform: 'win32', home: 'C:\\Users\\u', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } })).toBe(
      path.win32.join('C:\\Users\\u\\AppData\\Roaming', 'com.francois.desktop'),
    );
    expect(appDataDir({ platform: 'linux', home: '/home/u', env: {} })).toBe(
      path.posix.join('/home/u', '.local', 'share', 'com.francois.desktop'),
    );

    // The round trip runs on the NATIVE platform — what it proves (readToggles
    // finds what the app wrote) is platform-independent, and simulating another
    // OS against a real temp directory only mixes separators.
    const home = tempDir();
    const dataDir = appDataDir({ home, env: {} });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'extensions.json'),
      JSON.stringify({ toggles: { git: { enabled: true, consentSha256: 'abc' } } }),
    );
    expect(readToggles({ home, env: {} })).toEqual({
      git: { enabled: true, consentSha256: 'abc' },
    });
  });

  it('reads as no overrides when the file is missing or unparseable', () => {
    const home = tempDir();
    expect(readToggles({ home, env: {} })).toEqual({});
  });
});

describe('listExtensions', () => {
  it('reads id, label, path and enabled/disabled straight off the directory', () => {
    const home = tempDir();
    writePlugin(path.join(extensionsDir(home), 'git'), { manifest: 1, label: 'git' });
    writePlugin(path.join(extensionsDir(home), 'zeta'), { manifest: 1, label: 'Zeta' });
    // A directory with no extension.json is invisible, same as the core's FR-4.
    fs.mkdirSync(path.join(extensionsDir(home), 'not-a-plugin'), { recursive: true });

    const dataDir = appDataDir({ home, env: {} });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'extensions.json'),
      JSON.stringify({ toggles: { git: { enabled: true, consentSha256: 'x' } } }),
    );

    const found = listExtensions({ home, env: {} });
    expect(found.map((e) => e.id)).toEqual(['git', 'zeta']);
    expect(found[0]).toMatchObject({ id: 'git', label: 'git', enabled: true, valid: true });
    expect(found[1]).toMatchObject({ id: 'zeta', label: 'Zeta', enabled: false, valid: true });
  });

  it('is an empty list when the registry directory does not exist', () => {
    const home = tempDir();
    expect(listExtensions({ home })).toEqual([]);
  });

  it('sanitizes a manifest label before it ever reaches a caller (terminal injection)', () => {
    const home = tempDir();
    // \x1b (ESC, ANSI) and \u202e (RLO, bidi) are exactly the classes
    // `francois ext list` must never write to stdout unfiltered.
    writePlugin(path.join(extensionsDir(home), 'evil'), {
      manifest: 1,
      label: '\x1b[31mFAKE ERROR\x1b[0m\u202ereversed',
    });
    const found = listExtensions({ home });
    expect(found[0].label).toBe('[31mFAKE ERROR[0mreversed');
  });

  it('sanitizes a hostile directory name in id and path (not just label)', () => {
    // Nothing enforces EXTENSION_ID_PATTERN on directories that were never
    // installed via `francois ext install` — a hand-copied directory can
    // carry any name, including these control/bidi sequences.
    const home = tempDir();
    // Windows forbids C0 controls (chars 0-31) in a filename outright, so the
    // ANSI-escape half of this name cannot exist on that OS — there is no
    // directory to defend against. The bidi override IS representable there,
    // and it is the half that fools the eye in any UI rather than only in a
    // terminal, so Windows still exercises the real case.
    const hostileName = WINDOWS ? 'FAKE‮reversed' : '\x1b[31mFAKE\x1b[0m‮reversed';
    const expectedId = WINDOWS ? 'FAKEreversed' : '[31mFAKE[0mreversed';
    writePlugin(path.join(extensionsDir(home), hostileName), { manifest: 1, label: 'fine' });

    const found = listExtensions({ home });
    expect(found[0].id).toBe(expectedId);
    expect(found[0].path).not.toMatch(/[\x1b‮]/);
  });
});

describe('sanitizeForDisplay', () => {
  it('strips C0/C1 controls and bidi-control code points, leaving plain text untouched', () => {
    expect(sanitizeForDisplay('plain label')).toBe('plain label');
    expect(sanitizeForDisplay('abc')).toBe('abc');
    expect(sanitizeForDisplay('a\u202eb\u2066c\u2069d')).toBe('abcd');
  });
});

describe('assertNoForbiddenArgv0', () => {
  it('accepts a manifest with no argv0 anywhere', () => {
    expect(() => assertNoForbiddenArgv0({ manifest: 1, label: 'x' })).not.toThrow();
  });

  it('matches the contract ARGV0_PATTERN', () => {
    expect(ARGV0_PATTERN.test('git')).toBe(true);
    expect(ARGV0_PATTERN.test('/usr/bin/git')).toBe(false);
  });

  it('refuses an absolute-path provider argv0 — FR-9', () => {
    const manifest = {
      manifest: 1,
      panels: [{ id: 'p', provider: { argv0: '/usr/bin/git', args: [] } }],
    };
    expect(() => assertNoForbiddenArgv0(manifest)).toThrow(/not a valid argv0/);
  });

  it('refuses a shell provider argv0 — FR-10', () => {
    const manifest = {
      manifest: 1,
      panels: [{ id: 'p', provider: { argv0: 'bash', args: [] } }],
    };
    expect(() => assertNoForbiddenArgv0(manifest)).toThrow(/not a valid argv0/);
  });

  it('refuses a forbidden argv0 nested in a log-tail source', () => {
    const manifest = {
      manifest: 1,
      panels: [{ id: 'p', source: { kind: 'process', argv0: 'powershell', args: [] } }],
    };
    expect(() => assertNoForbiddenArgv0(manifest)).toThrow(/not a valid argv0/);
  });

  it('refuses a forbidden argv0 in a commandSucceeds detect predicate', () => {
    const manifest = { manifest: 1, detect: { kind: 'commandSucceeds', argv: ['sh', '-c', 'true'] } };
    expect(() => assertNoForbiddenArgv0(manifest)).toThrow(/not a valid argv0/);
  });

  it('sanitizes an invalid argv0 before it ever reaches the thrown message (terminal injection)', () => {
    // \x1b (ESC, ANSI) and ‮ (RLO, bidi) must never reach a caller that
    // writes error.message straight to the terminal (bin/francois.js `die`).
    const manifest = {
      manifest: 1,
      panels: [{ id: 'p', provider: { argv0: '\x1b[31mFAKE ERROR\x1b[0m‮reversed', args: [] } }],
    };
    let caught = null;
    try {
      assertNoForbiddenArgv0(manifest);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(caught.message).not.toMatch(/[‮]/);
    expect(caught.message).toContain('[31mFAKE ERROR[0mreversed');
  });
});

describe('assertNoForbiddenArgv0 — depth guard', () => {
  it('refuses a pathologically deep manifest instead of overflowing the call stack', () => {
    let node = { argv0: 'git' };
    for (let i = 0; i < 100000; i += 1) node = { nested: node };
    expect(() => assertNoForbiddenArgv0(node)).toThrow(/nested more than \d+ levels deep/);
  });
});

describe('installExtension', () => {
  it('copies a local directory and always reports disabled — FR-28', () => {
    const home = tempDir();
    const source = writePlugin(path.join(tempDir(), 'francois-k8s'), { manifest: 1, label: 'K8s' });
    const { id, path: installed } = installExtension(source, { home });
    expect(id).toBe('francois-k8s');
    expect(fs.existsSync(path.join(installed, 'extension.json'))).toBe(true);
    // Nothing runs, nothing is enabled — that is the app's job (FR-30).
    expect(readToggles({ home, env: {} })).toEqual({});
  });

  it('refuses to overwrite an existing directory unless --force', () => {
    const home = tempDir();
    const source = writePlugin(path.join(tempDir(), 'k8s'));
    installExtension(source, { home });
    expect(() => installExtension(source, { home })).toThrow(/already exists/);
    fs.writeFileSync(path.join(source, 'extension.json'), JSON.stringify({ manifest: 1, label: 'K8s v2' }));
    const { path: installed } = installExtension(source, { home, force: true });
    expect(JSON.parse(fs.readFileSync(path.join(installed, 'extension.json'), 'utf8')).label).toBe('K8s v2');
  });

  it.skipIf(process.platform === 'win32')(
    'never removes the existing install until the new git-clone --force manifest validates — FR-28',
    () => {
      const home = tempDir();
      const sourceRepo = path.join(tempDir(), 'k8s.git');
      initGitRepo(sourceRepo, { manifest: 1, label: 'K8s v1' });

      const { path: installed } = installExtension(sourceRepo, { home });
      expect(fs.readFileSync(path.join(installed, 'extension.json'), 'utf8')).toContain('K8s v1');

      // The upstream repo's next commit ships a manifest this app refuses.
      commitManifest(sourceRepo, {
        manifest: 1,
        label: 'K8s v2 - broken',
        panels: [{ id: 'p', provider: { argv0: 'bash', args: [] } }],
      });

      expect(() => installExtension(sourceRepo, { home, force: true })).toThrow(/not a valid argv0/);

      // The old, working install must survive an invalid --force update — no
      // scratch/temp directories left behind under the registry either.
      expect(fs.existsSync(installed)).toBe(true);
      expect(fs.readFileSync(path.join(installed, 'extension.json'), 'utf8')).toContain('K8s v1');
      expect(fs.readdirSync(extensionsDir(home))).toEqual(['k8s']);
    },
  );

  it('refuses a source with no readable extension.json before writing anything', () => {
    const home = tempDir();
    const source = tempDir();
    fs.mkdirSync(path.join(source, 'bare'));
    expect(() => installExtension(path.join(source, 'bare'), { home })).toThrow(/extension\.json/);
    expect(fs.existsSync(extensionsDir(home))).toBe(true);
    expect(fs.readdirSync(extensionsDir(home))).toEqual([]);
  });

  it('refuses a source name that is not a valid extension id', () => {
    const home = tempDir();
    const source = writePlugin(path.join(tempDir(), 'Not_Valid'));
    expect(() => installExtension(source, { home })).toThrow(/not a valid extension id/);
  });

  it.skipIf(process.platform === 'win32')(
    'invokes `git clone` with a `--` separator before the positional args — argv-injection guard',
    () => {
      // A fake `git` on PATH that records its argv and exits non-zero, so this
      // stays offline: only the SHAPE of the spawnSync call is under test.
      const binDir = tempDir();
      const argvFile = path.join(tempDir(), 'argv.txt');
      fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nexit 1\n`);
      fs.chmodSync(path.join(binDir, 'git'), 0o755);
      const home = tempDir();
      const restore = process.env.PATH;
      process.env.PATH = `${binDir}:${process.env.PATH}`;
      try {
        expect(() => installExtension('git@github.com:acme/francois-plugin-k8s.git', { home })).toThrow();
      } finally {
        process.env.PATH = restore;
      }
      const argv = fs.readFileSync(argvFile, 'utf8').trim().split('\n');
      expect(argv.slice(0, 3)).toEqual(['clone', '--depth', '1']);
      expect(argv).toContain('--');
      expect(argv.indexOf('--')).toBeLessThan(argv.indexOf('git@github.com:acme/francois-plugin-k8s.git'));
    },
  );

  it('refuses a manifest declaring a shell or absolute argv0, before writing anything — FR-9/FR-10', () => {
    const home = tempDir();
    const source = writePlugin(path.join(tempDir(), 'shelled'), {
      manifest: 1,
      label: 'x',
      panels: [{ id: 'p', provider: { argv0: 'bash', args: [] } }],
    });
    expect(() => installExtension(source, { home })).toThrow(/not a valid argv0/);
    expect(fs.readdirSync(extensionsDir(home))).toEqual([]);
  });

  it('refuses a manifest larger than MANIFEST_MAX_BYTES — FR-5, with a size-specific message', () => {
    const home = tempDir();
    const source = path.join(tempDir(), 'huge');
    fs.mkdirSync(source, { recursive: true });
    const huge = JSON.stringify({ manifest: 1, label: 'x'.repeat(MANIFEST_MAX_BYTES) });
    fs.writeFileSync(path.join(source, 'extension.json'), huge);
    // Regression guard: an oversized manifest must not be misdiagnosed as
    // "missing or is not valid JSON" — it is neither.
    expect(() => installExtension(source, { home })).toThrow(/exceeds the .* byte limit/);
    expect(fs.readdirSync(extensionsDir(home))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'recreates a symlink in the source tree instead of dereferencing its target — never snapshot arbitrary file content',
    () => {
      const home = tempDir();
      const sourceParent = tempDir();
      const source = writePlugin(path.join(sourceParent, 'francois-linked'));
      // A file OUTSIDE the plugin source tree that the plugin has no business
      // reading into the registry.
      const secret = path.join(sourceParent, 'secret.txt');
      fs.writeFileSync(secret, 'super-secret-content');
      fs.symlinkSync(secret, path.join(source, 'link-to-secret'));

      const { path: installed } = installExtension(source, { home });
      const copied = path.join(installed, 'link-to-secret');
      expect(fs.lstatSync(copied).isSymbolicLink()).toBe(true);
      // The link itself was recreated, not the file it points at — no
      // silent snapshot of `secret`'s content under the registry.
      expect(fs.readlinkSync(copied)).toBe(secret);
    },
  );
});

describe('resolveExtensionDir / removeExtension', () => {
  it('resolves under the registry directory for a valid id', () => {
    const home = tempDir();
    expect(resolveExtensionDir('git', home)).toBe(path.resolve(extensionsDir(home), 'git'));
  });

  it('refuses a path-traversal id outright', () => {
    expect(() => resolveExtensionDir('../../etc', '/home/u')).toThrow();
    expect(() => resolveExtensionDir('a/b', '/home/u')).toThrow();
  });

  it('sanitizes a rejected id before it ever reaches the thrown message (terminal injection)', () => {
    let caught = null;
    try {
      resolveExtensionDir('\x1b[31mFAKE\x1b[0m‮vil', '/home/u');
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(caught.message).not.toMatch(/‮/);
    expect(caught.message).not.toMatch(/\x1b/);
  });

  it('removes the directory and refuses a target that does not exist', () => {
    const home = tempDir();
    writePlugin(path.join(extensionsDir(home), 'git'));
    const removed = removeExtension('git', { home });
    expect(fs.existsSync(removed)).toBe(false);
    expect(() => removeExtension('git', { home })).toThrow(/does not exist/);
  });
});

describe('readManifest', () => {
  it('reads null for a missing or unparseable manifest', () => {
    const dir = tempDir();
    expect(readManifest(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'extension.json'), 'not json');
    expect(readManifest(dir)).toBeNull();
  });

  it('also reads null for a manifest over the size cap — same as missing/unparseable', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({ manifest: 1, label: 'x'.repeat(MANIFEST_MAX_BYTES) }));
    expect(readManifest(dir)).toBeNull();
  });
});

// extension-install FR-28a — a BARE NAME resolves to the `francois-plugin-<name>`
// convention, so `francois ext install cohorte` needs no index and no URL.
describe('resolveInstallSource', () => {
  it('leaves an explicit git URL alone, and takes its id from the convention name', () => {
    const r = resolveInstallSource('git@github.com:acme/francois-plugin-k8s.git', { cwd: tempDir() });
    expect(r.kind).toBe('git');
    expect(r.location).toBe('git@github.com:acme/francois-plugin-k8s.git');
    expect(r.id).toBe('k8s');
  });

  it('an existing local directory WINS over the convention, so nothing silently hits the network', () => {
    const cwd = tempDir();
    writePlugin(path.join(cwd, 'cohorte'));
    const r = resolveInstallSource('cohorte', { cwd });
    expect(r.kind).toBe('dir');
    expect(r.location).toBe(path.join(cwd, 'cohorte'));
    expect(r.id).toBe('cohorte');
  });

  it('a bare name with no local directory resolves to the default org convention', () => {
    const r = resolveInstallSource('cohorte', { cwd: tempDir() });
    expect(r.kind).toBe('git');
    expect(r.location).toBe('https://github.com/antoine-gmnz/francois-plugin-cohorte.git');
    expect(r.id).toBe('cohorte');
  });

  it('accepts `org/name` so a third party needs no central index', () => {
    const r = resolveInstallSource('acme/k8s', { cwd: tempDir() });
    expect(r.kind).toBe('git');
    expect(r.location).toBe('https://github.com/acme/francois-plugin-k8s.git');
    expect(r.id).toBe('k8s');
  });

  it('the id comes from the NAME, never from the repo name — that is the whole point', () => {
    // The repo is `francois-plugin-cohorte`; the extension id must be `cohorte`,
    // because FR-3 mints the id from the directory and we control that directory.
    expect(resolveInstallSource('cohorte', { cwd: tempDir() }).id).toBe('cohorte');
  });

  it('refuses a name that could never be a valid extension id (FR-3)', () => {
    expect(() => resolveInstallSource('Cohorte', { cwd: tempDir() })).toThrow(/not a valid extension id/);
    expect(() => resolveInstallSource('../evil', { cwd: tempDir() })).toThrow(/not a valid extension id/);
    expect(() => resolveInstallSource('a/b/c', { cwd: tempDir() })).toThrow(/not a valid extension id/);
  });

  it('sanitizes the rejected source/id before it ever reaches the thrown message (terminal injection)', () => {
    // \x1b (ESC, ANSI) and the bidi RLO control must never reach a caller
    // that writes error.message straight to the terminal (bin/francois.js
    // `die`) — the same class round 9 fixed for argv0, applied here to the
    // id/source/owner rejection paths in resolveInstallSource.
    const evil = 'a/\x1b[31mFAKE\x1b[0m‮vil/c';
    let caught = null;
    try {
      resolveInstallSource(evil, { cwd: tempDir() });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(caught.message).not.toMatch(/‮/);
    expect(caught.message).not.toMatch(/\x1b/);
  });

  it('refuses a source starting with "-" before it is ever treated as a git URL — argv-injection guard', () => {
    // A leading `-` would be read as a flag once this string reaches
    // `spawnSync('git', ['clone', ..., location, target])` — the
    // CVE-2017-1000117 class (e.g. `-uACMD.git`, `-oProxyCommand=...`).
    expect(() => resolveInstallSource('-uACMD.git', { cwd: tempDir() })).toThrow(/not a valid extension source/);
    expect(() => resolveInstallSource('-oProxyCommand=x@host:y', { cwd: tempDir() })).toThrow(
      /not a valid extension source/,
    );
  });

  it('sanitizes a hostile leading-dash source before it reaches the thrown message (terminal injection)', () => {
    // The leading-`-` refusal above is the one throw site in this function
    // that used to interpolate the raw `source` — round 15 closed it to
    // match every sibling throw site (id/name/owner) already wrapped in
    // sanitizeForDisplay.
    const evil = '-\x1b[31mFAKE\x1b[0m‮vil';
    let caught = null;
    try {
      resolveInstallSource(evil, { cwd: tempDir() });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    expect(caught.message).toMatch(/not a valid extension source/);
    expect(caught.message).not.toMatch(/‮/);
    expect(caught.message).not.toMatch(/\x1b/);
  });

  it('refuses an org that is not a plausible GitHub owner', () => {
    expect(() => resolveInstallSource('bad org/k8s', { cwd: tempDir() })).toThrow(/owner/);
  });
});

describe('the francois-plugin- prefix is stripped whatever the source kind', () => {
  it('a hand-cloned local directory lands on the same id as the bare name', () => {
    const cwd = tempDir();
    writePlugin(path.join(cwd, 'francois-plugin-cohorte'));
    // Installing the PATH and installing the NAME must agree, or the id would
    // depend on how the user happened to fetch the plugin.
    expect(resolveInstallSource('francois-plugin-cohorte', { cwd }).id).toBe('cohorte');
    expect(resolveInstallSource('cohorte', { cwd }).id).toBe('cohorte');
  });
});
