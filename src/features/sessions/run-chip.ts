// design 11c ("the run chip's menu") — the pure half of the session row's run chip.
//
// 10a's bar carried the model and the permission mode as two chips with two
// popovers. 11c merges them into one control, because they are the two halves of a
// single question — what is about to run, and how much it is allowed to do — and
// splitting them meant the answer lived in two places that could disagree.
//
// The panel it opens holds those two things plus response-mode's writing style, in
// the chip's own order: model on top, permission mode, then response. Nothing else
// from the run cluster joins — context and branch are readouts, not settings, and
// a panel that mixes the two teaches you to click things that cannot be clicked.
//
// Effort is a property of the MODEL, so it lives inside the selected model's row
// rather than beside it, and only exists for models that advertise one.

import type { ModelInfo, ResponseMode, SessionMeta } from '../../../contract/common';
import { RESPONSE_MODE_OPTIONS, type ResponseModeOption } from '../../../contract/response-mode';
import { permissionModeOption } from '../permissions/permission-mode';

export interface RunChipParts {
  /** The model's display label — `Opus 5`. */
  model: string;
  /** The permission mode's compact form — `bypass`, `edits-ok`, `plan`, `default`. */
  mode: string;
  /** The effort level, or null when the model runs at its own default. */
  effort: string | null;
  /** True only for `bypassPermissions` — the one mode the chip tints. */
  danger: boolean;
  /**
   * response-mode FR-15: the mode's `short` — `concise`, `explain`, `learn` — or
   * null on 'default'. Null rather than 'default' so the face renders nothing at
   * all for the common case and the row never widens for a setting nobody set.
   */
  response: string | null;
}

/** What the chip renders, left to right. */
export function runChipParts(session: SessionMeta): RunChipParts {
  const option = permissionModeOption(session.permissionMode);
  return {
    model: session.model.label,
    mode: option.short,
    effort: session.effort ?? null,
    danger: option.danger === true,
    response: session.responseMode === 'default' ? null : responseModeOption(session.responseMode).short,
  };
}

/**
 * response-mode FR-13: the option row for a mode — the single source for every
 * presentation of it, exactly as `permissionModeOption` is for permissions. The
 * fallback is the 'default' row, so a persisted record carrying a string outside
 * the union renders as default rather than blank (spec §7).
 */
export function responseModeOption(mode: ResponseMode): ResponseModeOption {
  return RESPONSE_MODE_OPTIONS.find((o) => o.mode === mode) ?? RESPONSE_MODE_OPTIONS[0]!;
}

/** The levels a model's row offers. Empty ⇒ the row shows no segmented track at all. */
export function effortLevels(model: ModelInfo): string[] {
  return model.efforts ?? [];
}

/**
 * The mono note on an UNSELECTED model row — the mock's `low → high` / `no effort`.
 * It exists so the cost of switching model is visible before you switch: picking a
 * model that advertises no effort silently drops the level you had set.
 */
export function effortHint(model: ModelInfo): string {
  const levels = effortLevels(model);
  if (levels.length === 0) return 'no effort';
  if (levels.length === 1) return levels[0]!;
  return `${levels[0]} → ${levels[levels.length - 1]}`;
}

/** A 24h local wall clock, zero-padded — `18:41`. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The second line under `bypass`, and only under `bypass`: how long full access has
 * been live and which tree it is live in. This is the information you would want
 * before walking away from a session, which is exactly when nobody goes looking for
 * it — so the row states it unprompted.
 *
 * Null when the stamp is missing (a record written before the core tracked it):
 * better no line than a confident `on since 01:00` dated from the epoch.
 */
export function bypassNote(session: SessionMeta): string | null {
  if (session.permissionMode !== 'bypassPermissions') return null;
  if (!session.permissionModeSince) return null;
  const since = `on since ${formatClock(session.permissionModeSince)}`;
  return session.worktree ? `${since} · worktree ${session.worktree.branch}` : since;
}

