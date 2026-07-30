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
