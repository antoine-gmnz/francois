// contract/wsl-filesystem.ts — wsl-filesystem (specs/wsl-filesystem.md).
// Pure path vocabulary shared by the new-session modal hint, cwd displays, and
// tests. NO IPC channels, NO event members, NO ErrorCodes are defined here —
// the feature changes behavior behind existing channels only (spec §5). The
// Rust core mirrors the two predicates/transforms (is_wsl_unc_path,
// wsl_unc_to_linux); this file is the canonical statement of their semantics.
//
// Recognized forms (FR-1): \\wsl$\<distro>\… and \\wsl.localhost\<distro>\…,
// case-insensitive prefixes, forward or back slashes tolerated on input.
// Everything else — drive letters, plain UNC shares (\\server\share),
// /mnt/… strings — is not a WSL UNC path.

const WSL_PREFIXES = ['\\\\wsl$\\', '\\\\wsl.localhost\\'];

function backslashed(p: string): string {
  return p.replace(/\//g, '\\');
}

/** True for \\wsl$\<distro>\… and \\wsl.localhost\<distro>\… (case-insensitive, FR-1). */
export function isWslUncPath(p: string): boolean {
  const n = backslashed(p).toLowerCase();
  return WSL_PREFIXES.some((pre) => n.startsWith(pre) && n.length > pre.length);
}

/**
 * \\wsl$\Ubuntu\home\u\api → { distro: 'Ubuntu', path: '/home/u/api' } (FR-2).
 * Distro case is preserved; a root-only path maps to '/'; trailing separators
 * are tolerated. Returns null for anything that is not a WSL UNC path.
 */
export function wslUncToLinux(p: string): { distro: string; path: string } | null {
  const n = backslashed(p);
  const lower = n.toLowerCase();
  const pre = WSL_PREFIXES.find((x) => lower.startsWith(x) && n.length > x.length);
  if (!pre) return null;
  const rest = n.slice(pre.length); // '<Distro>' | '<Distro>\home\u\api' (any trailing '\')
  const sep = rest.indexOf('\\');
  const distro = sep === -1 ? rest : rest.slice(0, sep);
  if (!distro) return null;
  const tail = sep === -1 ? '' : rest.slice(sep + 1);
  const segments = tail.split('\\').filter(Boolean);
  return { distro, path: '/' + segments.join('/') };
}

/**
 * Compact display form for WSL cwds (FR-4): 'Ubuntu:/home/u/api'. Returns null
 * for non-WSL paths — the caller falls back to the existing ~-abbreviation.
 */
export function displayWslCwd(p: string): string | null {
  const t = wslUncToLinux(p);
  return t ? `${t.distro}:${t.path}` : null;
}
