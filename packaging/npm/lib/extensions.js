'use strict';

/**
 * extension-install FR-27..FR-30 — `francois ext install|list|remove` operate
 * DIRECTLY on the filesystem: no socket, no `CliMethod`, works with the app
 * closed. Plain CommonJS with no dependencies, same discipline as the rest of
 * `packaging/npm/` — this can run inside `npm install`/from a bare `node`
 * invocation before anything else is guaranteed to exist.
 *
 * Mirrors (in spirit, not in code) `src-tauri/src/extensions/manifest.rs` and
 * `registry.rs` — the SAME id/size rules (FR-3, FR-5, FR-28, FR-29) plus a
 * scoped FR-9/FR-10 argv0 check (`assertNoForbiddenArgv0`), reimplemented
 * here because this package cannot depend on the Rust core. This is NOT full
 * schema validation: panel/provider/detect *shape* (FR-6, FR-12, FR-21…) is
 * validated only by the app itself at load time, same as before.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** extension-install FR-3 (contract/extensions.ts `EXTENSION_ID_PATTERN`). */
const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** FR-5: mirrors `MANIFEST_MAX_BYTES` in src-tauri/src/extensions/mod.rs — a
 * manifest larger than this is one the app will always refuse to load, so
 * `francois ext install` must refuse it too rather than install it dead. */
const MANIFEST_MAX_BYTES = 256 * 1024;

/** FR-9: bare binary name, off `PATH`. Mirrors `valid_argv0` /
 * `ARGV0_PATTERN` in src-tauri/src/extensions/mod.rs (contract/extensions.ts). */
const ARGV0_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** FR-10: mirrors `SHELL_ARGV0_BLOCKLIST` in src-tauri/src/extensions/mod.rs. */
const SHELL_ARGV0_BLOCKLIST = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'env',
]);

function assertValidArgv0(argv0) {
  if (typeof argv0 !== 'string' || !ARGV0_PATTERN.test(argv0) || SHELL_ARGV0_BLOCKLIST.has(argv0)) {
    throw new Error(`"${sanitizeForDisplay(argv0)}" is not a valid argv0 (must match ARGV0_PATTERN and not be a shell)`);
  }
}

/** Manifests are capped at `MANIFEST_MAX_BYTES`, but a small file can still
 * encode tens of thousands of nesting levels (`[[[[…]]]]`) — a recursive
 * walk over that would blow the call stack before FR-5's size check even
 * matters. This is well beyond any manifest a real plugin would ever need. */
const MAX_MANIFEST_DEPTH = 200;

/** FR-9/FR-10: walk every `argv0` (provider/source) and `commandSucceeds`
 * detect argv the manifest declares, anywhere in its tree, and refuse a
 * manifest the app will silently reject at load time — see the module doc
 * for what this does and does not check. Iterative (explicit stack), so a
 * pathologically deep manifest is refused cleanly instead of overflowing
 * the call stack. */
function assertNoForbiddenArgv0(root) {
  const stack = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (depth > MAX_MANIFEST_DEPTH) {
      throw new Error(`extension.json is nested more than ${MAX_MANIFEST_DEPTH} levels deep`);
    }
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    if (typeof node.argv0 === 'string') assertValidArgv0(node.argv0);
    if (node.kind === 'commandSucceeds' && Array.isArray(node.argv) && typeof node.argv[0] === 'string') {
      assertValidArgv0(node.argv[0]);
    }
    for (const value of Object.values(node)) stack.push({ node: value, depth: depth + 1 });
  }
}

/** Strips C0/C1 controls + bidi-control code points, mirroring
 * `sanitizeForDisplay` in src/features/extensions/extensions.ts — the manifest
 * `label` is untrusted, disk-supplied text and must never carry terminal
 * control sequences to stdout. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_BIDI_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
function sanitizeForDisplay(value) {
  return typeof value === 'string' ? value.replace(CONTROL_OR_BIDI_RE, '') : value;
}

/** `src-tauri/tauri.conf.json`'s `identifier` — used only to locate the app's
 * OWN `app_data_dir()/extensions.json` toggles, so `list` can report the real
 * enabled/disabled state (FR-27) without a running app. If the app's bundle
 * identifier ever changes, this constant must move with it. */
const APP_IDENTIFIER = 'com.francois.desktop';

/** FR-1: `~/.francois/extensions` — the one registry directory. */
function extensionsDir(home = os.homedir()) {
  return path.join(home, '.francois', 'extensions');
}

/** Where Tauri's `app_data_dir()` resolves for this app, per OS — the SAME
 * directory `extensions.json` (the toggles) is persisted to. */
function appDataDir({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_IDENTIFIER);
  }
  if (platform === 'win32') {
    const base = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(base, APP_IDENTIFIER);
  }
  const base = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, APP_IDENTIFIER);
}

/** Best-effort: a missing/unreadable/unparseable file reads as "nothing
 * enabled" — the same default the core itself falls back to (FR-15). */
function readToggles(opts = {}) {
  const file = path.join(appDataDir(opts), 'extensions.json');
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (doc && typeof doc.toggles === 'object' && doc.toggles) || {};
  } catch {
    return {};
  }
}

function isValidExtensionId(id) {
  return typeof id === 'string' && EXTENSION_ID_PATTERN.test(id);
}

/** A local path vs. a git remote — an scp-like `user@host:path`, a URL with a
 * scheme, or anything ending `.git`. */
function isGitUrl(source) {
  return /^[\w.-]+@[\w.-]+:/.test(source) || /^[a-z][a-z0-9+.-]*:\/\//i.test(source) || source.endsWith('.git');
}

/** FR-28a: the bare-name convention. `cohorte` → the repository
 * `francois-plugin-cohorte`. This is a URL SHORTHAND, not the plugin registry
 * §2 refuses: there is no index to fetch, nothing to search, no version to
 * resolve, and no list anyone curates. A name that does not follow the
 * convention is still installable — by its full URL, exactly as before. */
const PLUGIN_REPO_PREFIX = 'francois-plugin-';
/** The owner a bare `<name>` (no `<owner>/`) is looked up under. */
const DEFAULT_PLUGIN_OWNER = 'antoine-gmnz';
/** GitHub's own owner rule: alphanumerics and single hyphens, not at the ends. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** `francois-plugin-cohorte` → `cohorte`. Applied to every source kind, so an
 * extension's id never depends on how it was fetched. */
function stripRepoPrefix(name) {
  return name.startsWith(PLUGIN_REPO_PREFIX) ? name.slice(PLUGIN_REPO_PREFIX.length) : name;
}

function conventionUrl(owner, name) {
  return `https://github.com/${owner}/${PLUGIN_REPO_PREFIX}${name}.git`;
}

/**
 * FR-28a — decide what `install <source>` actually means, and what id it lands
 * under. Precedence, most explicit first:
 *
 *   1. an explicit git URL        ⇒ cloned as given
 *   2. an EXISTING local directory ⇒ copied (so `install ./cohorte` and
 *      `install cohorte` next to a real directory keep working — a bare name
 *      never silently reaches the network when a local answer exists)
 *   3. `<name>` or `<owner>/<name>` ⇒ the convention above
 *
 * The id comes from the NAME the user typed, never from the repository's
 * basename — otherwise `francois-plugin-cohorte` would install under the id
 * `francois-plugin-cohorte` and FR-3 would mint every panel as
 * `francois-plugin-cohorte:health`.
 */
function resolveInstallSource(source, { cwd = process.cwd() } = {}) {
  if (!source) throw new Error('a source path or git URL is required');
  // A leading `-` would be read as a flag by `git clone` (or by `ssh`/`git`
  // fetching a scp-like remote) once this string reaches spawnSync — the
  // CVE-2017-1000117 argv-injection class. Refuse it before anything below
  // gets a chance to treat it as a URL, a path, or a bare name.
  if (source.startsWith('-')) {
    throw new Error(`"${sanitizeForDisplay(source)}" is not a valid extension source (must not start with "-")`);
  }

  if (isGitUrl(source)) {
    const id = stripRepoPrefix(idFromSource(source));
    if (!isValidExtensionId(id)) {
      throw new Error(`"${sanitizeForDisplay(id)}" is not a valid extension id (must match ${EXTENSION_ID_PATTERN})`);
    }
    return { kind: 'git', location: source, id };
  }

  // A path the user actually has wins over anything remote.
  const local = path.resolve(cwd, source);
  if (fs.existsSync(local) && fs.statSync(local).isDirectory()) {
    // The prefix is stripped here too, so cloning `francois-plugin-cohorte`
    // by hand and installing the PATH lands on the same id as installing the
    // NAME. Anything else would make the id depend on how you fetched it.
    return { kind: 'dir', location: local, id: stripRepoPrefix(idFromSource(local)) };
  }

  // Neither a URL nor a directory ⇒ the convention. A source that LOOKS like a
  // path is refused as a bad id rather than being reinterpreted as a repo name:
  // `../evil` is a typo'd or hostile path, and "no such directory" is the honest
  // answer to it — not "cloning github.com/../francois-plugin-evil".
  const parts = source.split('/');
  if (source.includes('\\') || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`"${sanitizeForDisplay(source)}" is not a valid extension id (must match ${EXTENSION_ID_PATTERN})`);
  }
  if (parts.length > 2) {
    throw new Error(`"${sanitizeForDisplay(source)}" is not a valid extension id (must match ${EXTENSION_ID_PATTERN})`);
  }
  const [owner, name] = parts.length === 2 ? parts : [DEFAULT_PLUGIN_OWNER, parts[0]];
  if (!isValidExtensionId(name)) {
    throw new Error(`"${sanitizeForDisplay(name)}" is not a valid extension id (must match ${EXTENSION_ID_PATTERN})`);
  }
  if (!OWNER_PATTERN.test(owner)) {
    throw new Error(`"${sanitizeForDisplay(owner)}" is not a valid GitHub owner`);
  }
  return { kind: 'git', location: conventionUrl(owner, name), id: name };
}

/** FR-28: the target id is resolved from the SOURCE's own name — never read
 * from the manifest. */
function idFromSource(source) {
  const stripped = source.replace(/[/\\]+$/, '').replace(/\.git$/, '');
  const last = stripped.split(/[/\\]/).pop() || '';
  return last.toLowerCase();
}

/**
 * The full read: distinguishes "too large" (`tooLarge: true`, `manifest:
 * null`) from "missing or unparseable" (`tooLarge: false`, `manifest: null`)
 * so a caller building an error message can name the actual cause instead of
 * collapsing both into the same "missing or is not valid JSON" text.
 */
function statManifest(dir) {
  const manifestPath = path.join(dir, 'extension.json');
  let stat;
  try {
    stat = fs.statSync(manifestPath);
  } catch {
    return { manifest: null, tooLarge: false };
  }
  if (stat.size > MANIFEST_MAX_BYTES) return { manifest: null, tooLarge: true };
  try {
    return { manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')), tooLarge: false };
  } catch {
    return { manifest: null, tooLarge: false };
  }
}

function readManifest(dir) {
  return statManifest(dir).manifest;
}

/** The size-specific vs. generic message a caller reports for a manifest that
 * failed to load — shared by `assertValidManifestOrCleanup` and the local-copy
 * install path so both name the same cause the same way. */
function manifestLoadErrorMessage(dir, status) {
  const manifestPath = path.join(dir, 'extension.json');
  return status.tooLarge
    ? `${manifestPath} exceeds the ${MANIFEST_MAX_BYTES} byte limit`
    : `${manifestPath} is missing or is not valid JSON`;
}

/** FR-27: id, label, path, enabled/disabled — read straight off the
 * directory, so this works with the app closed. */
function listExtensions(opts = {}) {
  const dir = extensionsDir(opts.home);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const toggles = readToggles(opts);
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'extension.json')))
    .map((e) => e.name)
    .sort()
    .map((id) => {
      const manifest = readManifest(path.join(dir, id));
      const entry = toggles[id];
      const enabled = Boolean(entry && entry.enabled === true);
      // The manifest is untrusted, disk-supplied text — and so is `id`
      // itself, a directory name that need not have gone through
      // `francois ext install`'s EXTENSION_ID_PATTERN check (a hand-copied
      // directory reaches here too). Sanitize both before they ever reach
      // stdout (`francois ext list`) or any other consumer.
      const dirPath = path.join(dir, id);
      return {
        id: sanitizeForDisplay(id),
        label: sanitizeForDisplay((manifest && typeof manifest.label === 'string' && manifest.label) || id),
        path: sanitizeForDisplay(dirPath),
        enabled,
        valid: Boolean(manifest),
      };
    });
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // A cloned/copied plugin's own VCS history is not part of the plugin.
    if (entry.name === '.git') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    // A symlink in the source tree must never be dereferenced: copying its
    // TARGET's content would silently snapshot an arbitrary file the user
    // can read into the extensions registry. Recreate the link itself.
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else if (entry.isDirectory()) {
      copyDirSync(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function assertValidManifestOrCleanup(dir) {
  const status = statManifest(dir);
  if (!status.manifest) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(manifestLoadErrorMessage(dir, status));
  }
  const manifest = status.manifest;
  try {
    assertNoForbiddenArgv0(manifest);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return manifest;
}

/** FR-28/FR-31: copy a local directory, or clone a git URL, into
 * `~/.francois/extensions/<id>/`. Refuses to overwrite an existing directory
 * unless `force`; validates the manifest before returning; never enables
 * anything (FR-30 — consent is the app's, and only the app's). */
function installExtension(source, { home = os.homedir(), force = false, cwd = process.cwd() } = {}) {
  const resolved = resolveInstallSource(source, { cwd });
  const dir = extensionsDir(home);
  fs.mkdirSync(dir, { recursive: true });

  if (resolved.kind === 'git') {
    const { id, location } = resolved;
    const target = path.join(dir, id);
    const targetExists = fs.existsSync(target);
    if (targetExists && !force) throw new Error(`${target} already exists — pass --force to overwrite.`);

    // FR-28: an overwrite must validate the NEW clone before the OLD install is
    // touched — clone into a scratch dir under the registry root, validate
    // there, and only then remove `target` and swap the scratch dir into place.
    // Without this, an invalid update would destroy a working install.
    const scratch = targetExists ? fs.mkdtempSync(path.join(dir, `.${id}-install-`)) : null;
    const cloneTarget = scratch ?? target;
    const result = spawnSync('git', ['clone', '--depth', '1', '--', location, cloneTarget], {
      stdio: 'inherit',
    });
    if (result.error || result.status !== 0) {
      fs.rmSync(cloneTarget, { recursive: true, force: true });
      throw new Error(`git clone failed${result.status != null ? ` (exit ${result.status})` : ''}`);
    }
    // `assertValidManifestOrCleanup` removes `cloneTarget` itself on failure —
    // `target` (the pre-existing install) is never touched until this returns.
    const manifest = assertValidManifestOrCleanup(cloneTarget);
    if (scratch) {
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(scratch, target);
    }
    return { id, path: target, manifest, source: location };
  }

  const { id, location } = resolved;
  if (!isValidExtensionId(id)) {
    throw new Error(`"${sanitizeForDisplay(id)}" is not a valid extension id (must match ${EXTENSION_ID_PATTERN})`);
  }
  // FR-28: validated BEFORE anything is written.
  const sourceStatus = statManifest(location);
  if (!sourceStatus.manifest) {
    throw new Error(manifestLoadErrorMessage(location, sourceStatus));
  }
  const sourceManifest = sourceStatus.manifest;
  assertNoForbiddenArgv0(sourceManifest);
  const target = path.join(dir, id);
  if (fs.existsSync(target)) {
    if (!force) throw new Error(`${target} already exists — pass --force to overwrite.`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  copyDirSync(location, target);
  return { id, path: target, manifest: sourceManifest, source: location };
}

/** FR-29: refuses any path that does not resolve under
 * `~/.francois/extensions/` — defense in depth alongside `EXTENSION_ID_PATTERN`
 * already ruling out `/` and `..` in `id`. */
function resolveExtensionDir(id, home = os.homedir()) {
  if (!isValidExtensionId(id)) {
    throw new Error(`"${sanitizeForDisplay(id)}" is not a valid extension id`);
  }
  const dir = path.resolve(extensionsDir(home));
  const target = path.resolve(dir, id);
  if (target !== dir && !target.startsWith(dir + path.sep)) {
    throw new Error(`refusing to remove a path outside ${dir}`);
  }
  return target;
}

/** FR-29: its toggle/consent record is dropped with it — nothing else needs
 * to act, since a missing directory is what the core's own FR-19 reconciles
 * on next load. */
function removeExtension(id, { home = os.homedir() } = {}) {
  const target = resolveExtensionDir(id, home);
  if (!fs.existsSync(target)) {
    throw new Error(`${target} does not exist`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  return target;
}

module.exports = {
  EXTENSION_ID_PATTERN,
  MANIFEST_MAX_BYTES,
  ARGV0_PATTERN,
  SHELL_ARGV0_BLOCKLIST,
  assertNoForbiddenArgv0,
  sanitizeForDisplay,
  APP_IDENTIFIER,
  extensionsDir,
  appDataDir,
  readToggles,
  isValidExtensionId,
  isGitUrl,
  idFromSource,
  readManifest,
  listExtensions,
  installExtension,
  resolveInstallSource,
  removeExtension,
  resolveExtensionDir,
};
