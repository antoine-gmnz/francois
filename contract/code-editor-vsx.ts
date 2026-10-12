// contract/code-editor-vsx.ts — code-editor-vsx feature contract (specs/code-editor-vsx.md §5).
// Binding per PIPELINE.md: francois:vsx:<verb> -> invoke('vsx_<verb>') -> Promise<Result<T>>.
// No event stream: every verb is request/response; the frontend reloads contributions after
// install / uninstall / enable.
// Added ErrorCode members (VSX_UNREACHABLE, VSX_NOT_FOUND, VSX_INVALID_PACKAGE, VSX_UNSUPPORTED)
// live in contract/error-code.ts.
//
// Scope (FR-3): only the DECLARATIVE half of a VS Code extension is ever used — languages,
// TextMate grammars, snippets, language configuration. No extension JavaScript is downloaded
// into the webview, evaluated, or run anywhere.

import type { Result } from './common';

/** The only registry in v1 (FR-1). Microsoft's Marketplace terms forbid non-Visual-Studio clients. */
export const VSX_REGISTRY = 'https://open-vsx.org';

/** FR-4 limits — shared so the core and the frontend cannot drift. */
export const VSX_MAX_PACKAGE_BYTES = 60 * 1024 * 1024; // the .vsix download
export const VSX_MAX_EXTRACT_BYTES = 25 * 1024 * 1024; // the declarative files kept on disk
export const VSX_MAX_FILE_BYTES = 8 * 1024 * 1024; // any single kept file
export const VSX_SEARCH_PAGE = 30;

/** `<namespace>.<name>`, lower-cased — the registry's own identity. */
export type VsxId = string;

/** FR-3: what Francois can take from the extension. */
export type VsxSupport =
  | 'full' // declarative contributions only — everything it offers works here
  | 'partial' // declarative contributions AND code (`main`/`browser`) — only the declarative half works
  | 'unsupported'; // code only, nothing declarative — never installable

/** The declarative contribution kinds Francois loads (FR-6..FR-9). */
export interface VsxContributionCounts {
  languages: number;
  grammars: number;
  snippets: number;
  /** language-configuration files referenced by `contributes.languages[].configuration`. */
  languageConfigurations: number;
}

export interface VsxSummary {
  id: VsxId;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  publisher: string; // namespace display name when the registry provides one, else namespace
  downloadCount: number;
  averageRating: number | null;
  /** `data:image/png;base64,…` (or svg) fetched by the core — the webview CSP has no https img-src.
   *  null when the extension has no icon or it could not be fetched. */
  icon: string | null;
  /** Unknown (null) in search results until details are fetched — the registry search API does not
   *  carry `contributes`. */
  support: VsxSupport | null;
  verified: boolean; // registry's namespace verification
}

export interface VsxDetails extends VsxSummary {
  support: VsxSupport;
  contributions: VsxContributionCounts;
  /** Language ids the extension contributes or targets, e.g. ['toml'] — shown as chips. */
  languageIds: string[];
  license: string | null;
  repository: string | null;
  /** The registry page, for "View on Open VSX" (opened in the system browser). */
  pageUrl: string;
  /** Plain-text README excerpt (first ~2 KB, markdown stripped of images/HTML). */
  readme: string | null;
}

export interface VsxInstalled {
  id: VsxId;
  displayName: string;
  publisher: string;
  description: string;
  version: string;
  icon: string | null;
  support: Exclude<VsxSupport, 'unsupported'>;
  contributions: VsxContributionCounts;
  languageIds: string[];
  enabled: boolean;
  installedAt: number; // epoch ms
}

// ---------- francois:vsx:search ----------
export interface VsxSearchRequest {
  /** Empty = the registry's most-downloaded list. */
  query: string;
  offset: number;
}
export interface VsxSearchData {
  results: VsxSummary[];
  total: number;
}
// invoke('vsx_search', req): Promise<Result<VsxSearchData>>  — GET /api/-/search?query&size=VSX_SEARCH_PAGE&offset
// errors: 'VSX_UNREACHABLE' | 'INTERNAL'
export type VsxSearchResponse = Result<VsxSearchData>;

// ---------- francois:vsx:details ----------
export interface VsxDetailsRequest {
  id: VsxId;
}
// invoke('vsx_details', req): Promise<Result<VsxDetails>> — GET /api/<ns>/<name> + its package.json (files.manifest)
// errors: 'VSX_UNREACHABLE' | 'VSX_NOT_FOUND' | 'INTERNAL'
export type VsxDetailsResponse = Result<VsxDetails>;

// ---------- francois:vsx:install ----------
export interface VsxInstallRequest {
  id: VsxId;
  /** Omitted = latest. */
  version?: string;
}
// invoke('vsx_install', req): Promise<Result<VsxInstalled>>
// Download (files.download) → verify sha256 (files.sha256) → extract ONLY package.json and the files
// its declarative contributions reference (+ the icon) into ~/.francois/vsx/<id>-<version>/ → record
// in ~/.francois/vsx/installed.json (atomic). Installing another version replaces the old one.
// Installed enabled.
// errors: 'VSX_UNREACHABLE' | 'VSX_NOT_FOUND' | 'VSX_INVALID_PACKAGE' (detail: { reason }) | 'VSX_UNSUPPORTED' | 'INTERNAL'
export type VsxInstallResponse = Result<VsxInstalled>;

// ---------- francois:vsx:uninstall ----------
export interface VsxUninstallRequest {
  id: VsxId;
}
// invoke('vsx_uninstall', req): Promise<Result<null>> — removes the directory and the record. errors: 'VSX_NOT_FOUND' | 'INTERNAL'
export type VsxUninstallResponse = Result<null>;

// ---------- francois:vsx:setEnabled ----------
export interface VsxSetEnabledRequest {
  id: VsxId;
  enabled: boolean;
}
// invoke('vsx_set_enabled', req): Promise<Result<VsxInstalled>> — errors: 'VSX_NOT_FOUND' | 'INTERNAL'
export type VsxSetEnabledResponse = Result<VsxInstalled>;

// ---------- francois:vsx:list ----------
// invoke('vsx_list'): Promise<Result<VsxInstalled[]>> — installed extensions, display-name order. Never hits the network.
export type VsxListResponse = Result<VsxInstalled[]>;

// ---------- francois:vsx:contributions ----------
/** Everything the editor loads, from ENABLED installed extensions only. File contents are inlined
 *  (they were already size-capped at install), so the webview never reads the filesystem. */
export interface VsxLanguage {
  extensionId: VsxId;
  id: string; // Monaco/VS Code language id
  aliases: string[];
  extensions: string[]; // with the leading dot, e.g. ".toml"
  filenames: string[];
  filenamePatterns: string[];
  firstLine: string | null;
  /** The language-configuration file's raw text (JSON with comments), null when none. */
  configuration: string | null;
}

export interface VsxGrammar {
  extensionId: VsxId;
  /** The language this grammar tokenizes; absent for injection-only grammars. */
  language: string | null;
  scopeName: string;
  /** `.tmLanguage.json` text, or `.tmLanguage`/`.plist` XML text — `format` says which. */
  content: string;
  format: 'json' | 'plist';
  embeddedLanguages: Record<string, string>;
  tokenTypes: Record<string, string>;
  injectTo: string[];
}

export interface VsxSnippetFile {
  extensionId: VsxId;
  language: string;
  /** The snippets JSON text (JSON with comments). */
  content: string;
}

export interface VsxContributions {
  languages: VsxLanguage[];
  grammars: VsxGrammar[];
  snippets: VsxSnippetFile[];
}
// invoke('vsx_contributions'): Promise<Result<VsxContributions>> — never hits the network. errors: 'INTERNAL'
export type VsxContributionsResponse = Result<VsxContributions>;
