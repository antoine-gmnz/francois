// Shared home-directory abbreviation (REFACTOR.md audit: byte-for-byte
// duplicated at App.tsx and OverviewView.tsx, plus a near-copy in
// Sidebar.tsx that dropped the `!cwd` guard — for an empty `cwd` AND an empty
// `home` that copy would compare `'' === ''` and return `'~'` instead of `''`;
// this shared version keeps the guard, matching App.tsx/OverviewView.tsx's
// behaviour and the only behaviour that has ever mattered in practice, since
// `home` is always populated from `homeDir()` before any of these render).

/**
 * Last segment of a path in EITHER dialect (the core hands the frontend host
 * paths — `C:\…` on Windows, `/…` elsewhere), with a trailing separator ignored.
 * Used by session-attachments to name a refused file in the composer banner.
 */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
}

/**
 * Renders `cwd` as `~/…` when it is `home` or lives under it (checking both
 * `/` and `\` separators), otherwise returns `cwd` unchanged. Returns `''` for
 * an empty `cwd`.
 */
export function abbreviate(cwd: string, home: string): string {
  if (!cwd) return '';
  if (home && (cwd === home || cwd.startsWith(home + '/') || cwd.startsWith(home + '\\'))) {
    return '~' + cwd.slice(home.length);
  }
  return cwd;
}

// ---------- code-editor-agents FR-2: normalised absolute paths ----------

const DRIVE = /^[A-Za-z]:/;

/**
 * The normalised form the core emits for `editor_files.rootDir` and
 * `file.touched.path`: `\` → `/`, no trailing `/`, drive letter upper-cased.
 * Mirrors the core's `fs_util::norm_path`: a bare `/` stays `/` (stripping it would
 * name nothing), and `C:\` becomes `C:`.
 */
export function normPath(path: string): string {
  let p = path.replace(/\\/g, '/');
  if (DRIVE.test(p)) p = p[0].toUpperCase() + p.slice(1);
  const trimmed = p.replace(/\/+$/, '');
  return trimmed === '' && p !== '' ? '/' : trimmed;
}

/** A map/compare key for a path: normalised, and case-folded when it is a drive path. */
export function pathKey(path: string): string {
  const p = normPath(path);
  return DRIVE.test(p) ? p.toLowerCase() : p;
}

/** FR-2: `path` lies under `rootDir` (strictly — the root itself is not "in" it). */
export function inRoot(path: string, rootDir: string): boolean {
  return relativeTo(path, rootDir) !== null;
}

/** `path` relative to `rootDir`, or null when it lies outside it. */
export function relativeTo(path: string, rootDir: string): string | null {
  const p = normPath(path);
  const root = normPath(rootDir);
  if (root === '') return null;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const head = p.slice(0, prefix.length);
  const same = DRIVE.test(root) ? head.toLowerCase() === prefix.toLowerCase() : head === prefix;
  return same && p.length > prefix.length ? p.slice(prefix.length) : null;
}

/** A root-relative path made absolute under a normalised `rootDir` (FR-2 form). */
export function joinRoot(rootDir: string, rel: string): string {
  return rootDir.endsWith('/') ? `${rootDir}${rel}` : `${rootDir}/${rel}`;
}
