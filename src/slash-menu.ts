// slash-menu — pure popup logic (FR-5..FR-10), extracted from ConversationView
// and SlashMenu.tsx so the trigger predicate, filtering, selection rules,
// completion text and the dismissal state machine are unit-testable without the
// DOM. Filtering reuses the palette's subsequence mechanics (FR-6) — never
// duplicated here.

import type { SessionId, SlashCommandInfo } from '../contract/common';
import { filterRank } from './palette';

// ---------- registry cache (spec §6, FR-10 / edge 7) ----------
// Module-level like paletteData: session.commands events land here for EVERY
// session; the visible composer additionally mirrors its own entry into state.

const commandsBySession: Record<SessionId, SlashCommandInfo[]> = {};

/** Idempotent replace (FR-10) — also for non-visible sessions (edge 7). */
export function setSessionCommands(sessionId: SessionId, commands: SlashCommandInfo[]): void {
  commandsBySession[sessionId] = commands;
}

export function getSessionCommands(sessionId: SessionId): SlashCommandInfo[] {
  return commandsBySession[sessionId] ?? [];
}

// ---------- trigger (FR-5) ----------

/**
 * The token after '/' when the composer text is exactly one slash token
 * (`^/\S*$` — leading slash, no whitespace yet); null when not eligible.
 */
export function slashToken(text: string): string | null {
  return /^\/\S*$/.test(text) ? text.slice(1) : null;
}

// ---------- filtering (FR-6) ----------

/** Palette subsequence filter against the token after '/'; '' = full registry in FR-3 order. */
export function filterCommands(registry: readonly SlashCommandInfo[], token: string): SlashCommandInfo[] {
  return filterRank(registry, token, (c) => c.name);
}

/** FR-6 source tag: 'francois' for builtin, the skill's scope for skill, 'cli' for cli. */
export function sourceTag(c: SlashCommandInfo): string {
  if (c.source === 'builtin') return 'francois';
  if (c.source === 'skill') return c.scope ?? 'skill';
  return 'cli';
}

// ---------- visibility (FR-5/9/12) ----------

/** The popup renders iff eligible AND ≥1 match AND not dismissed at this token AND composer enabled. */
export function popupVisible(args: {
  token: string | null;
  matchCount: number;
  dismissedToken: string | null;
  disabled: boolean;
}): boolean {
  return args.token !== null && args.matchCount > 0 && args.dismissedToken !== args.token && !args.disabled;
}

/**
 * FR-9: dismissal holds only while the token stays exactly the dismissed one;
 * any token change (typing/deleting, incl. leaving slash-token shape — e.g. a
 * send clearing the input) clears it. Session switch clears by remount.
 */
export function nextDismissed(dismissedToken: string | null, token: string | null): string | null {
  return dismissedToken !== null && dismissedToken === token ? dismissedToken : null;
}

// ---------- selection (FR-7/10) ----------

/** ↑/↓ movement with wrap in both directions. */
export function moveSelection(count: number, idx: number, delta: 1 | -1): number {
  if (count <= 0) return 0;
  return (idx + delta + count) % count;
}

/** FR-10: keep the previously selected name across a registry refresh; first row when it vanished. */
export function refreshSelection(filtered: readonly SlashCommandInfo[], selectedName: string | null): number {
  if (selectedName === null) return 0;
  const idx = filtered.findIndex((c) => c.name === selectedName);
  return idx >= 0 ? idx : 0;
}

// ---------- completion (FR-8/11) ----------

/**
 * Enter runs the bare '/name' — byte-identical to typing it (FR-11). Tab
 * completes to '/name ' whose trailing space ends the token (popup closes).
 */
export function completionText(name: string, mode: 'run' | 'complete'): string {
  return mode === 'run' ? `/${name}` : `/${name} `;
}

// ---------- keys (FR-8/9) ----------

export type PopupKeyAction = 'up' | 'down' | 'run' | 'complete' | 'dismiss';

/**
 * Key mapping while the popup is rendered. null = the composer behaves
 * normally (characters keep filtering; shift+enter stays a newline).
 */
export function popupKeyAction(key: string, shiftKey: boolean): PopupKeyAction | null {
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  if (key === 'Enter' && !shiftKey) return 'run';
  if (key === 'Tab' && !shiftKey) return 'complete';
  if (key === 'Escape') return 'dismiss';
  return null;
}
