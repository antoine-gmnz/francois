// Run settings popover — the pure half. Redesign "Graphite & Signal", Figma
// "20 · Run settings (model · effort · permissions)" (139:7373, light 142:16053).
// The run chip opens it: Model (one row per family, versions in a segmented
// track), then its own Effort section for the selected model, then the four
// permission modes as radio rows, `bypass` tinted with a line saying how long
// it has been on and where. RunSettingsPopover.tsx renders this.

import type { ModelInfo, PermissionMode, SessionMeta } from '../../../contract/common';
import { PERMISSION_MODE_OPTIONS } from '../../../contract/session-permission-mode';

export interface PermissionRow {
  mode: PermissionMode;
  label: string;
  /** What the mode means in practice — the design's one-line gloss. */
  note: string;
  danger: boolean;
}

const PERMISSION_COPY: Record<PermissionMode, { label: string; note: string }> = {
  default: { label: 'Default', note: 'ask for risky tools' },
  plan: { label: 'Plan', note: 'read-only, proposes a plan' },
  acceptEdits: { label: 'Accept edits', note: 'edits run, shell asks' },
  bypassPermissions: { label: 'Bypass', note: 'nothing asks' },
};

/** The four modes in the contract's order, with the design's labels. */
export function permissionRows(): PermissionRow[] {
  return PERMISSION_MODE_OPTIONS.map((o) => ({
    mode: o.mode,
    label: PERMISSION_COPY[o.mode]?.label ?? o.label,
    note: PERMISSION_COPY[o.mode]?.note ?? o.hint,
    danger: o.danger === true,
  }));
}

/**
 * The faint note after a model's name: `project default` when it is the model
 * the session's project defaults to, otherwise the catalogue's own brief (the
 * design's `faster, cheaper`), otherwise nothing.
 */
export function modelNote(model: ModelInfo, projectDefaultModelId: string | undefined): string {
  if (projectDefaultModelId !== undefined && model.id === projectDefaultModelId) return 'project default';
  return model.brief ?? '';
}

/** `under a minute` · `14 min` · `2 h 5 min` · `3 d` — how long a mode has been on. */
export function formatSince(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  }
  return `${Math.floor(hours / 24)} d`;
}

/** The tree bypass is live in — the worktree's branch, else the checkout's folder name. */
function whereItRuns(session: SessionMeta): string {
  if (session.worktree?.branch) return session.worktree.branch;
  const parts = session.cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? session.cwd;
}

/**
 * The second line of the bypass row, only while bypass is in force:
 * `On for 14 min in feat/auth-retry · every tool runs without asking`.
 * Null for any other mode, or when the core never stamped the switch.
 */
export function bypassSinceLine(session: SessionMeta, now: number): string | null {
  if (session.permissionMode !== 'bypassPermissions' || !session.permissionModeSince) return null;
  return `On for ${formatSince(now - session.permissionModeSince)} in ${whereItRuns(session)} · every tool runs without asking`;
}

/**
 * Whether switching to `next` keeps the effort in force. A model that does not
 * advertise the current level (or none at all) would leave a level the next turn
 * cannot honour, so the caller clears it after the switch.
 */
export function effortSurvivesSwitch(effort: string | undefined, next: ModelInfo | undefined): boolean {
  if (!effort) return true;
  return (next?.efforts ?? []).includes(effort);
}

/** One version of a model family — the version label shown in the segmented
 *  track, carrying the exact `ModelInfo` it stands for. */
export interface ModelFamilyVersion {
  label: string;
  model: ModelInfo;
}

/** A group of models sharing a family name (`Opus`, `Sonnet`, …), versions
 *  newest first. A label with no parseable version is its own single-version
 *  family, keyed by the whole label. */
export interface ModelFamily {
  family: string;
  versions: ModelFamilyVersion[];
}

/**
 * Splits a display label into `family` (everything before the first token
 * that looks like a version number) and `version` (that token plus anything
 * after it, so a suffix like `(1M)`/`[1m]` rides along as part of the version
 * label). No such token ⇒ `version: null` — the whole label is the family.
 */
function splitFamilyVersion(label: string): { family: string; version: string | null } {
  const tokens = label.split(' ');
  const versionIdx = tokens.findIndex((t) => /^\d/.test(t));
  if (versionIdx <= 0) return { family: label, version: null };
  return { family: tokens.slice(0, versionIdx).join(' '), version: tokens.slice(versionIdx).join(' ') };
}

/** The leading dotted numeric run of a version label — `4.5` out of `4.5 (1M)`. */
function versionSortKey(version: string): number[] {
  const numeric = version.match(/^[\d.]+/)?.[0] ?? '';
  return numeric
    .split('.')
    .filter((s) => s !== '')
    .map(Number);
}

/** Numeric, per-dotted-segment, newest first — `5.10` sorts above `5.2`, unlike a string compare. */
function compareVersionsDesc(a: string, b: string): number {
  const ka = versionSortKey(a);
  const kb = versionSortKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const diff = (kb[i] ?? 0) - (ka[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Groups a catalogue into families so the run settings model list shows one
 * row per family (`Opus`, `Sonnet`, …) instead of every version flattened
 * out. Families keep the catalogue's first-appearance order (how the core
 * advertises them); versions within a family sort newest first. Every
 * `ModelInfo` is preserved exactly — grouping never drops or merges models
 * across families, only within the same parsed family name.
 */
export function groupModelFamilies(models: ModelInfo[]): ModelFamily[] {
  const order: string[] = [];
  const map = new Map<string, ModelFamilyVersion[]>();
  for (const model of models) {
    const { family, version } = splitFamilyVersion(model.label);
    if (!map.has(family)) {
      map.set(family, []);
      order.push(family);
    }
    map.get(family)!.push({ label: version ?? model.label, model });
  }
  return order.map((family) => ({
    family,
    versions: [...map.get(family)!].sort((a, b) => compareVersionsDesc(a.label, b.label)),
  }));
}

/**
 * The note under a family row: `project default` when the project's default
 * model is any version in the family, else the brief of the selected version
 * (falling back to the family's newest), else nothing.
 */
export function familyNote(family: ModelFamily, projectDefaultModelId: string | undefined, selectedModelId: string): string {
  if (projectDefaultModelId !== undefined && family.versions.some((v) => v.model.id === projectDefaultModelId)) return 'project default';
  const version = family.versions.find((v) => v.model.id === selectedModelId) ?? family.versions[0];
  return version ? modelNote(version.model, undefined) : '';
}

/**
 * Where the popover sits: right-aligned to the chip and opening upwards (the chip
 * lives in the composer at the bottom of the pane), below it only when there is
 * no room above, clamped inside the window.
 */
export function runSettingsPlacement(
  chip: { top: number; right: number; bottom: number },
  viewport: { width: number; height: number },
  size: { width: number; height: number },
  gap = 8,
): { right: number; top: number } {
  const right = Math.max(8, viewport.width - chip.right);
  const above = chip.top - gap - size.height;
  const top = above >= 8 ? above : Math.min(chip.bottom + gap, Math.max(8, viewport.height - size.height - 8));
  return { right, top };
}
