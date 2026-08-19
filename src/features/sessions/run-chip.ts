// design 11c ("the run chip's menu") — the pure half of the session row's run chip.
//
// 10a's bar carried the model and the permission mode as two chips with two
// popovers. 11c merges them into one control, because they are the two halves of a
// single question — what is about to run, and how much it is allowed to do — and
// splitting them meant the answer lived in two places that could disagree.
//
// The panel it opens holds exactly those two things, in the chip's own order:
// model on top, permission mode under it. Nothing else from the run cluster joins
// — context and branch are readouts, not settings, and a panel that mixes the two
// teaches you to click things that cannot be clicked.
//
// Effort is a property of the MODEL, so it lives inside the selected model's row
// rather than beside it, and only exists for models that advertise one.

import type { ModelInfo, PermissionMode, ProjectDefaults, SessionMeta } from '../../../contract/common';
import { permissionModeOption } from '../permissions/permission-mode';

export const APPLIES_COPY = 'Applies from the next turn';
export const SET_PROJECT_DEFAULT_COPY = 'Set as project default';

export interface RunChipParts {
  /** The model's display label — `Opus 5`. */
  model: string;
  /** The permission mode's compact form — `bypass`, `edits-ok`, `plan`, `default`. */
  mode: string;
  /** The effort level, or null when the model runs at its own default. */
  effort: string | null;
  /** True only for `bypassPermissions` — the one mode the chip tints. */
  danger: boolean;
}

/** What the chip renders, left to right. */
export function runChipParts(session: SessionMeta): RunChipParts {
  const option = permissionModeOption(session.permissionMode);
  return {
    model: session.model.label,
    mode: option.short,
    effort: session.effort ?? null,
    danger: option.danger === true,
  };
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

/** The footer's second action needs somewhere to write to. */
export function canSetProjectDefault(session: SessionMeta): boolean {
  return typeof session.projectId === 'string' && session.projectId.length > 0;
}

/**
 * `defaults` REPLACES the whole object on the wire (ProjectUpdateRequest), so this
 * merges rather than patches. The three keys the panel owns are written from the
 * session; an absent effort DELETES the key rather than leaving the project's old
 * level behind — "make this project look like this session" has to include the
 * parts of this session that are unset, or the button quietly lies.
 */
export function nextProjectDefaults(current: ProjectDefaults, session: SessionMeta): ProjectDefaults {
  const next: ProjectDefaults = {
    ...current,
    modelId: session.model.id,
    permissionMode: session.permissionMode as PermissionMode,
  };
  if (session.effort) next.effort = session.effort;
  else delete next.effort;
  return next;
}
