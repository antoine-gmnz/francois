// code-editor-lsp FR-14/FR-15/FR-16: what the status pill reads, and what showing a file
// under a root asks of its language server. Pure.

import type { LspLanguage, LspServerStatus } from '../../../contract/code-editor-lsp';
import { languageFor } from './language';
import { lspLanguageOf } from './lsp-convert';

export interface LspProgress {
  title: string | null;
  message: string | null;
  percentage: number | null;
}

export type PillTone = 'ready' | 'busy' | 'idle' | 'missing' | 'crashed';

export interface PillView {
  text: string;
  tone: PillTone;
  title: string;
  /** A click: `install` copies the hint (and re-probes), `restart` retries a crashed server. */
  action: 'install' | 'restart' | null;
}

export const lspLanguageForPath = (path: string): LspLanguage | null => lspLanguageOf(languageFor(path).id);

/** `TypeScript 5.6` for TS (the project's own TypeScript), else `<server> <version>`. */
export function serverLabel(s: LspServerStatus): string {
  if (s.language === 'typescript' && s.version) {
    const ts = /TypeScript [\d.]+/.exec(s.version);
    if (ts) return ts[0];
  }
  return s.version ? `${s.server} ${s.version}` : s.server;
}

function progressText(list: readonly LspProgress[]): string | null {
  const p = list[list.length - 1];
  if (!p) return null;
  const what = p.title ?? p.message ?? 'Indexing';
  return p.percentage === null ? what : `${what} ${Math.round(p.percentage)}%`;
}

/** FR-14 — null when no server applies (unknown, untrusted): the v1 Monaco pill stays. */
export function pillView(s: LspServerStatus | undefined, progress: readonly LspProgress[]): PillView | null {
  if (!s || s.state === 'untrusted') return null;
  const name = serverLabel(s);
  const lines = [s.program ?? s.server, s.state === 'missing' && s.installHint ? `Install: ${s.installHint}` : null, s.error].filter(Boolean);
  const title = lines.join('\n');
  const busy = progressText(progress);
  switch (s.state) {
    case 'ready':
      return busy ? { text: `${name} · ${busy}`, tone: 'busy', title, action: null } : { text: `${name} · ready`, tone: 'ready', title, action: null };
    case 'starting':
      return { text: `${name} · ${busy ?? 'starting'}`, tone: 'busy', title, action: null };
    case 'stopped':
      // A failed spawn leaves `stopped` + `error`: never auto-retried (FR-16), so the click retries.
      return s.error
        ? { text: `${name} · stopped`, tone: 'idle', title: `${title}\nClick to retry`, action: 'restart' }
        : { text: `${name} · stopped`, tone: 'idle', title, action: null };
    case 'missing':
      return { text: `${name} · not installed`, tone: 'missing', title, action: 'install' };
    case 'crashed':
      return { text: `${name} · crashed`, tone: 'crashed', title: `${title}\nClick to restart`, action: 'restart' };
  }
}

/** FR-15/FR-16: what showing a file asks — start a stopped server, prompt an untrusted root, or nothing. */
export function showAction(s: LspServerStatus | undefined, ctx: { dismissed: boolean; pending: boolean }): 'start' | 'prompt' | 'none' {
  if (!s) return 'none';
  // `stopped` with an error is a failed spawn — restarting it on every render would loop.
  if (s.state === 'stopped') return ctx.pending || s.error ? 'none' : 'start';
  if (s.state === 'untrusted') return ctx.dismissed ? 'none' : 'prompt';
  return 'none';
}
