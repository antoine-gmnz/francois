// session-settings-sheet — the pure half of the sheet: the working draft, what
// counts as "changed" against the session's current values (FR-14), the patch
// Apply sends (FR-16), the foot's change count + timing sentence (FR-15), the
// `▣ FIXED AT SPAWN` block's lines (FR-12), and the ten values `New session
// from these ↗` carries into create mode (FR-13).
//
// `nextProjectDefaults`/`canSetProjectDefault` moved here from run-chip.ts
// (FR-17) — the run chip's own "Set as project default" footer action is gone
// with its popover (FR-20), and the sheet's foot is the only caller left.
// `nextProjectDefaults` now reads a `SettingsDraft`, not a `SessionMeta`: FR-17
// writes "the sheet's current values, including unapplied edits", not the
// session's last-persisted ones.

import type { AccountId, ClaudeRuntime, PermissionMode, ProjectDefaults, ProjectId, ResponseMode, SessionMeta } from '../../../contract/common';
import { NEXT_TURN_KEYS, SETTING_LABELS, type SessionSettingsPatch } from '../../../contract/session-settings-sheet';
import type { Account } from '../../../contract/multi-account';
import type { ProjectMeta } from '../../../contract/projects';
import { wslUncToLinux } from '../../../contract/wsl-filesystem';
import { accountDisplayLabel, findAccount, middleTruncate } from '../accounts/accounts';

/** The six rows the sheet keeps live in both modes — everything FR-14 can dirty. */
export interface SettingsDraft {
  name: string;
  modelId: string;
  effort: string; // '' = model default
  permissionMode: PermissionMode;
  responseMode: ResponseMode;
  allowGit: boolean;
}

type DraftKey = keyof SettingsDraft;

/** FR-14/§6: the draft seeded from — and the baseline compared against — a session. */
export function draftFromSession(session: SessionMeta): SettingsDraft {
  return {
    name: session.name,
    modelId: session.model.id,
    effort: session.effort ?? '',
    permissionMode: session.permissionMode,
    responseMode: session.responseMode,
    allowGit: session.allowGit,
  };
}

/** FR-14: a row whose value differs from the session's current one, in field order. */
export function dirtyKeys(draft: SettingsDraft, baseline: SettingsDraft): (keyof SessionSettingsPatch)[] {
  const keys: (keyof SessionSettingsPatch)[] = [];
  if (draft.name.trim() !== baseline.name) keys.push('name');
  if (draft.modelId !== baseline.modelId) keys.push('modelId');
  if (draft.effort !== baseline.effort) keys.push('effort');
  if (draft.permissionMode !== baseline.permissionMode) keys.push('permissionMode');
  if (draft.responseMode !== baseline.responseMode) keys.push('responseMode');
  if (draft.allowGit !== baseline.allowGit) keys.push('allowGit');
  return keys;
}

/** FR-16: Apply sends exactly the changed keys, name trimmed. */
export function buildPatch(draft: SettingsDraft, baseline: SettingsDraft): SessionSettingsPatch {
  const patch: SessionSettingsPatch = {};
  for (const key of dirtyKeys(draft, baseline)) {
    switch (key) {
      case 'name':
        patch.name = draft.name.trim();
        break;
      case 'modelId':
        patch.modelId = draft.modelId;
        break;
      case 'effort':
        patch.effort = draft.effort;
        break;
      case 'permissionMode':
        patch.permissionMode = draft.permissionMode;
        break;
      case 'responseMode':
        patch.responseMode = draft.responseMode;
        break;
      case 'allowGit':
        patch.allowGit = draft.allowGit;
        break;
    }
  }
  return patch;
}

/**
 * FR-18: a live `session.meta` rebases the baseline; a field the user has NOT
 * touched follows it, a touched field holds the user's pending value.
 */
export function rebaseDraft(draft: SettingsDraft, nextBaseline: SettingsDraft, touched: ReadonlySet<DraftKey>): SettingsDraft {
  return {
    name: touched.has('name') ? draft.name : nextBaseline.name,
    modelId: touched.has('modelId') ? draft.modelId : nextBaseline.modelId,
    effort: touched.has('effort') ? draft.effort : nextBaseline.effort,
    permissionMode: touched.has('permissionMode') ? draft.permissionMode : nextBaseline.permissionMode,
    responseMode: touched.has('responseMode') ? draft.responseMode : nextBaseline.responseMode,
    allowGit: touched.has('allowGit') ? draft.allowGit : nextBaseline.allowGit,
  };
}

/**
 * EditSheet correctness: does the newly picked model still support `effort`?
 * '' (model default) is always supported. Mirrors CreateSheet's own inline
 * reset check (§7 case 22) so a model swap that drops the current level
 * clears it instead of letting Apply send an incompatible modelId/effort pair.
 */
export function effortSupportedByModel(effort: string, modelEfforts: string[]): boolean {
  return effort === '' || modelEfforts.includes(effort);
}

/** `<n> change(s)`, accent text in the foot (FR-15). */
export function changeCountLabel(n: number): string {
  return `${n} change${n === 1 ? '' : 's'}`;
}

function joinEnglishList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * FR-15: the line naming ONLY the changed fields that are next-turn, in the
 * contract's NEXT_TURN_KEYS order — e.g. "permissions and response apply from
 * the next turn". null when every change is immediate (never a blanket claim).
 */
export function timingLine(keys: (keyof SessionSettingsPatch)[]): string | null {
  const nextTurn = NEXT_TURN_KEYS.filter((k) => keys.includes(k));
  if (nextTurn.length === 0) return null;
  const labels = nextTurn.map((k) => SETTING_LABELS[k]);
  const verb = labels.length === 1 ? 'applies' : 'apply';
  return `${joinEnglishList(labels)} ${verb} from the next turn`;
}

/** One `▣ FIXED AT SPAWN` line. Omitted from the block entirely when `value` is null. */
export interface FixedAtSpawnLine {
  label: string;
  value: string;
  /** The full, untruncated value — `path`'s only, everywhere else same as `value`. */
  title?: string;
}

/**
 * FR-12: project · worktree · path · runtime (+ distro) · account · profile, each
 * omitted (not blanked) when absent. `path` and `runtime` are the only two a
 * session with none of the others still renders.
 */
export function fixedAtSpawnLines(session: SessionMeta, projects: ProjectMeta[], accounts: Account[]): FixedAtSpawnLine[] {
  const lines: FixedAtSpawnLine[] = [];

  const project = session.projectId ? (projects.find((p) => p.id === session.projectId) ?? null) : null;
  if (project) lines.push({ label: 'project', value: project.name });

  if (session.worktree) {
    const w = session.worktree;
    lines.push({ label: 'worktree', value: w.detached ? `${w.branch} (detached)` : `${w.branch} · from ${w.baseRef}` });
  }

  lines.push({ label: 'path', value: middleTruncate(session.cwd, 40), title: session.cwd });

  const distro = session.runtime === 'wsl' ? wslUncToLinux(session.cwd)?.distro : null;
  lines.push({ label: 'runtime', value: distro ? `wsl · ${distro}` : session.runtime });

  const account = findAccount(accounts, session.accountId);
  if (account) lines.push({ label: 'account', value: accountDisplayLabel(account) });

  if (session.profile) lines.push({ label: 'profile', value: session.profile.name });

  return lines;
}

/** The ten values `New session from these ↗` carries into create mode (FR-13). */
export interface SessionSettingsCarryOver {
  projectId?: ProjectId;
  /** Only set when `projectId` is absent — an unlinked session, or one whose
   *  project was removed (§7 case 12). */
  cwd?: string;
  name: string;
  modelId: string;
  effort: string;
  accountId: AccountId;
  profileId: string;
  runtime: ClaudeRuntime;
  permissionMode: PermissionMode;
  responseMode: ResponseMode;
  allowGit: boolean;
}

/**
 * FR-13 / §7 case 12: `projectId` carries over only while it still resolves in
 * the live registry — a removed project falls back to the session's own `cwd`
 * in DIRECTORY instead, exactly like opening the plain New Session modal would.
 */
export function carryOverToCreate(session: SessionMeta, projects: ProjectMeta[]): SessionSettingsCarryOver {
  const projectResolved = session.projectId !== undefined && projects.some((p) => p.id === session.projectId);
  return {
    projectId: projectResolved ? session.projectId : undefined,
    cwd: projectResolved ? undefined : session.cwd,
    name: session.name,
    modelId: session.model.id,
    effort: session.effort ?? '',
    accountId: session.accountId,
    profileId: session.profile?.id ?? '',
    runtime: session.runtime,
    permissionMode: session.permissionMode,
    responseMode: session.responseMode,
    allowGit: session.allowGit,
  };
}

// ---------- moved from run-chip.ts (FR-17/FR-20) ----------

export const SET_PROJECT_DEFAULT_COPY = 'Set as project default';
/** FR-17: the action writes five values now, so it names them all. */
export const SET_PROJECT_DEFAULT_TITLE =
  "write this model, effort, permission mode, response mode and git setting into the project's defaults";

/** The foot's second action needs somewhere to write to. */
export function canSetProjectDefault(session: SessionMeta): boolean {
  return typeof session.projectId === 'string' && session.projectId.length > 0;
}

/**
 * `defaults` REPLACES the whole object on the wire (ProjectUpdateRequest), so this
 * merges rather than patches. FR-17: written from the sheet's CURRENT draft —
 * including unapplied edits — not from the session's last-persisted meta. An
 * absent effort DELETES the key rather than leaving the project's old level behind.
 */
export function nextProjectDefaults(current: ProjectDefaults, draft: SettingsDraft): ProjectDefaults {
  const next: ProjectDefaults = {
    ...current,
    modelId: draft.modelId,
    permissionMode: draft.permissionMode,
    responseMode: draft.responseMode,
    allowGit: draft.allowGit,
  };
  if (draft.effort) next.effort = draft.effort;
  else delete next.effort;
  return next;
}
