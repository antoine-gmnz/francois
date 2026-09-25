// cohorte-actions FR-3/FR-4 — the display string for an intake request: what
// the sheet's Command block shows AND, byte-for-byte, what the core spawns
// (minus `--data-dir`/`--json`, which never reach the display). Kept in sync
// with the Rust builder (src-tauri/src/cohorte/actions_cli.rs) by the same
// unit tests, per FR-4's "if it does, the TS function carries the same unit
// tests as the Rust one".

import type { CohorteIntakeRequest } from '../../../contract/cohorte-actions';
import { COHORTE_ACTION_LIMITS } from '../../../contract/cohorte-actions';

/** Double-quote an arg holding whitespace or a quote; inside the quotes,
 * escape backslashes first so an escaped quote can't read as a closing one.
 * Mirrors actions_cli.rs `quote`. */
function quoteArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : arg;
}

/** FR-3: `--text` values longer than 60 chars render as `<text, N lines>`. */
function displayTextValue(text: string): string {
  if (text.length <= COHORTE_ACTION_LIMITS.textDisplayMax) return text;
  const lines = text.split('\n').length;
  return `<text, ${lines} lines>`;
}

/** FR-3 — `cohorte intake <source flag> <value> --title <title>`. */
export function cohorteIntakeDisplay(req: CohorteIntakeRequest): string {
  const args: string[] = ['intake'];
  if (req.source.kind === 'text') args.push('--text', displayTextValue(req.source.text));
  else if (req.source.kind === 'file') args.push('--file', req.source.path);
  else args.push('--url', req.source.url);
  args.push('--title', req.title);
  return ['cohorte', ...args.map(quoteArg)].join(' ');
}

/** FR-42: `cohorte brainstorm --feature-id <id>` or `cohorte brainstorm` (new idea). */
export function cohorteBrainstormDisplay(featureId: string | null): string {
  return featureId ? `cohorte brainstorm --feature-id ${featureId}` : 'cohorte brainstorm';
}

/** FR-42: `cohorte spec <id>` — positional, unlike brainstorm's flag. */
export function cohorteSpecDisplay(featureId: string): string {
  return `cohorte spec ${featureId}`;
}

/** Flow 4 — display only; the actual call is `cohorte_v3_start` (FR-25), never a spawn. */
export function cohorteStartDisplay(featureId: string): string {
  return `cohorte start ${featureId}`;
}

/** FR-21 — `cohorte <verb> ` with the trailing space Francois types but never sends. */
export function cohortePlumbingLine(verb: 'patch' | 'fleet' | 'audit' | 'retro'): string {
  return `cohorte ${verb} `;
}

/**
 * Frame 36's Command block: a display string broken before each `--flag`, with
 * a shell continuation, so a long intake reads one argument per line. Never
 * breaks inside a double-quoted value (a title may itself contain ` --`).
 */
export function cohorteCommandLines(display: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < display.length; i += 1) {
    const ch = display[i];
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === ' ' && display.startsWith('--', i + 1)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part, i) => `${i === 0 ? '' : '    '}${part}${i < parts.length - 1 ? ' \\' : ''}`);
}
