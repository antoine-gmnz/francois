// session-worktree (specs/session-worktree.md) — pure frontend logic for the New
// Session modal's worktree group, the session card / status-bar branch chip, the
// SESSION banner, the DIFF sibling line, and the delete-confirm removal step.
// The byte-for-byte-pinned helpers (worktreeSlug, previewWorktreePath,
// siblingWorktreeSessions, WORKTREE_NOTICE_STORAGE_KEY) live in the contract and
// are re-exported/used here, never re-implemented.

import type { AppError, SessionMeta, SessionWorktree } from '../../../contract/common';
import type { WorktreeListEntry, WorktreeProbeData, WorktreeStatusData } from '../../../contract/session-worktree';
import { WORKTREE_NOTICE_STORAGE_KEY, siblingWorktreeSessions } from '../../../contract/session-worktree';
import { isPathInside } from '../../../contract/projects';

/** basename(path), either separator — mirrors NewSessionModal's own helper. */
export function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function kebab(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * FR-2: `feat/<kebab-slug of the session name>`, falling back to
 * `feat/<kebab-slug of basename(cwd)>` when the name is empty (after trim).
 */
export function defaultWorktreeBranch(sessionName: string, cwd: string): string {
  const base = sessionName.trim() ? kebab(sessionName) : kebab(basenameOf(cwd));
  return `feat/${base}`;
}

/**
 * FR-3 convenience check only — the core is the source of truth
 * (`git check-ref-format --branch`). Rejects the common invalid shapes so the
 * form can disable Create before a round-trip, without trying to be exhaustive.
 */
export function isValidBranchName(branch: string): boolean {
  const b = branch.trim();
  if (!b) return false;
  if (b === '@') return false;
  if (b.startsWith('/') || b.endsWith('/')) return false;
  if (b.startsWith('-')) return false;
  if (b.includes('..')) return false;
  if (b.includes('@{')) return false;
  if (/[\s~^:?*[\\]/.test(b)) return false;
  if (b.endsWith('.lock') || b.endsWith('.')) return false;
  if (b.split('/').some((seg) => seg === '' || seg.startsWith('.'))) return false;
  return true;
}

/**
 * FR-1/FR-3: whether Create should be blocked by the worktree group's own gate,
 * independent of `canCreate`'s other fields. `probeIsRepo` is the LAST KNOWN
 * probe result (sticky across a transient error — never collapses to a plain,
 * silent non-worktree create just because a probe request failed or hasn't
 * resolved yet). While a probe is in flight (`probing`) or the last one errored
 * (`probeErrored`), Create stays blocked rather than letting `worktreeEnabled`
 * silently degrade into `worktree: undefined`.
 */
export interface WorktreeGateState {
  worktreeEnabled: boolean;
  probeIsRepo: boolean | null;
  probing: boolean;
  probeErrored: boolean;
  branch: string;
  branchValid: boolean;
  recoveryPath: string | null;
}

export function worktreeCreateBlocked(state: WorktreeGateState): boolean {
  if (!state.worktreeEnabled) return false;
  if (state.probing || state.probeErrored) return true;
  // `null` is "still pending/unknown" — stays blocked. A confirmed `false` means
  // the probe settled and the cwd is definitely not a repo, so the worktree gate
  // has nothing to block: allow the plain (non-worktree) create through.
  if (state.probeIsRepo === null) return true;
  if (state.probeIsRepo === false) return false;
  if (state.recoveryPath !== null) return true;
  if (state.branch.trim() === '') return true;
  if (!state.branchValid) return true;
  return false;
}

/**
 * FR-5 recovery-offer gate: whether "Open a session there instead" may fire.
 * Shares `canCreate`'s non-worktree guards (name/model/project-root/in-flight
 * submit) plus its own re-entrancy guard (`recovering`) — see `canCreate` in
 * NewSessionModal. It ALSO carries the same probe-staleness guard as
 * `worktreeCreateBlocked`: `liveWorktreeProbe` only invalidates the probe on a
 * **cwd** change, never on a **branch** change (see `liveWorktreeProbe` above),
 * so during the 250ms debounce + round-trip after a branch edit the amber
 * recovery card can still be showing the PREVIOUS branch's
 * `branchCheckedOutAt` path while the currently-typed branch differs from it.
 * Blocking on `probing`/`probeErrored` here — exactly like the plain-create
 * gate — closes that window instead of opening a session at a stale path.
 */
export interface WorktreeRecoveryGateState {
  name: string;
  modelId: string;
  projectRootMissing: boolean;
  submitting: boolean;
  recovering: boolean;
  probing: boolean;
  probeErrored: boolean;
}

export function canOpenWorktreeRecovery(state: WorktreeRecoveryGateState): boolean {
  return (
    state.name.trim() !== '' &&
    state.modelId !== '' &&
    !state.projectRootMissing &&
    !state.submitting &&
    !state.recovering &&
    !state.probing &&
    !state.probeErrored
  );
}

/**
 * FR-1: a probe result belongs to the cwd it was requested for. Storing that cwd
 * WITH the data is what makes a cwd change invalidate it in the SAME render —
 * a plain `WorktreeProbeData` would keep rendering repo A's `isRepo`, branch,
 * hint and path preview for repo B through the whole debounce + round-trip
 * window (and could show the "Isolate in worktree" control for a cwd that is not
 * a repo at all, which FR-1 forbids).
 */
export interface WorktreeProbeState {
  /** The (trimmed) cwd this probe was requested for. */
  cwd: string;
  /** Last SUCCESSFUL response for that cwd — sticky across a transient failure. */
  data: WorktreeProbeData | null;
  /** The last request for that cwd failed. */
  errored: boolean;
}

/** The probe view valid for `cwd` right now: empty as soon as the cwd differs. */
export function liveWorktreeProbe(
  state: WorktreeProbeState | null,
  cwd: string,
): { data: WorktreeProbeData | null; errored: boolean } {
  if (!state || state.cwd !== cwd.trim()) return { data: null, errored: false };
  return { data: state.data, errored: state.errored };
}

/**
 * §7 "Branch checked out between probe and create (race)": `session_create` can fail
 * AFTER a clean probe when another process checks the branch out first. Narrows
 * `error.detail` to the `{ path }` the core sends with `WORKTREE_BRANCH_IN_USE`, so the
 * caller can merge it into `probe.branchCheckedOutAt` and reuse the SAME recovery-offer
 * UI that FR-5's probe-time detection drives. Returns null for any other error/shape.
 */
export function worktreeBranchInUsePath(error: AppError): string | null {
  if (error.code !== 'WORKTREE_BRANCH_IN_USE') return null;
  const detail = error.detail as { path?: unknown } | undefined;
  return typeof detail?.path === 'string' ? detail.path : null;
}

/**
 * §7 race path, continued: what the modal's red submit banner should show for a
 * failed `session_create`. `null` ⇔ show nothing, because the error already
 * became the FR-5 amber recovery offer ("the form transitions to the same
 * recovery offer") and stacking the raw `WORKTREE_BRANCH_IN_USE` message on top
 * of it would read as a dead end. A `WORKTREE_BRANCH_IN_USE` with no usable
 * `{ path }` yields no offer, so it still surfaces as an error.
 */
export function submitErrorBanner(error: AppError): AppError | null {
  return worktreeBranchInUsePath(error) === null ? error : null;
}

/**
 * FR-18/19: the disabled-checkbox reason for the delete-session confirm. `null`
 * ⇔ removal is allowed (clean and pushed).
 */
export function worktreeRemovalBlockReason(status: WorktreeStatusData): string | null {
  const parts: string[] = [];
  if (status.dirty) {
    parts.push(`${status.dirtyCount} uncommitted file${status.dirtyCount === 1 ? '' : 's'}`);
  }
  if (status.unpushed) {
    if (status.unpushedCount === 0) {
      // Contract §WorktreeStatusData sentinel: `unpushed: true` with a count of 0
      // means the core could NOT determine push status (no upstream and no
      // reliable base ref). Removal still hard-blocks (FR-19), but the reason must
      // name the cause — rendering the count literally would claim "0 commits".
      parts.push(status.upstream ? 'push status unknown' : 'push status unknown — no upstream configured');
    } else {
      const upstream = status.upstream ?? 'its upstream';
      parts.push(`${status.unpushedCount} commit${status.unpushedCount === 1 ? '' : 's'} not on ${upstream}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** FR-14: the extra banner line when the create-time fetch failed. */
export function worktreeFetchWarningLine(worktree: SessionWorktree): string | null {
  return worktree.fetchError ? `could not fetch — forked from local \`${worktree.baseRef}\`` : null;
}

/**
 * FR-7b/FR-14: the extra banner line when the branch was forked from the FETCHED base rather
 * than the source checkout's local copy of it — so the worktree being ahead of the parent
 * checkout's `main` reads as intended, not as drift. Null when the two are the same ref.
 */
export function worktreeBaseLine(worktree: SessionWorktree): string | null {
  if (!worktree.baseResolved) return null;
  const shown = worktree.baseResolved.replace(/^refs\/remotes\//, '');
  return `forked from \`${shown}\` — the fetched tip, not the local \`${worktree.baseRef}\``;
}

// ---------- FR-14 per-session dismissal (localStorage) ----------

function readDismissed(): string[] {
  try {
    const raw = localStorage.getItem(WORKTREE_NOTICE_STORAGE_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function isWorktreeNoticeDismissed(sessionId: string): boolean {
  return readDismissed().includes(sessionId);
}

export function dismissWorktreeNotice(sessionId: string): void {
  try {
    const arr = readDismissed();
    if (!arr.includes(sessionId)) {
      localStorage.setItem(WORKTREE_NOTICE_STORAGE_KEY, JSON.stringify([...arr, sessionId]));
    }
  } catch {
    /* ignore — the banner simply reappears next launch */
  }
}

// ---------- FR-15 DIFF sibling line ----------

/** `N worktree sessions · feat/auth, feat/parser`, or null when there are none. */
export function siblingWorktreeSummaryLine(
  session: SessionMeta,
  all: SessionMeta[],
  caseInsensitive: boolean,
): string | null {
  const siblings = siblingWorktreeSessions(session, all, caseInsensitive);
  if (siblings.length === 0) return null;
  const branches = siblings.map((s) => s.worktree?.branch ?? '').join(', ');
  return `${siblings.length} worktree session${siblings.length === 1 ? '' : 's'} · ${branches}`;
}

// ---------- FR-13 branch chip ----------

/** Left-truncates a long branch name for the card/status-bar chip; full value goes in `title`. */
export function truncateBranchLeft(branch: string, maxLen = 26): string {
  if (branch.length <= maxLen) return branch;
  return '…' + branch.slice(branch.length - (maxLen - 1));
}

// ---------- command-palette FR-16 handoff ----------
// "New session in worktree…" opens the SAME modal pre-checked (no new component,
// no store slice — the modal consumes this one-shot flag on mount, exactly like
// paletteData.ts's non-store caches).

let presetWorktreeOnOpen = false;

export function requestWorktreePreset(): void {
  presetWorktreeOnOpen = true;
}

/** One-shot read: consumes (and clears) the pending preset. */
export function consumeWorktreePreset(): boolean {
  const v = presetWorktreeOnOpen;
  presetWorktreeOnOpen = false;
  return v;
}

// ---------- attach-to-worktree (specs/attach-to-worktree.md) ----------

export type WorktreeMode = 'off' | 'create' | 'attach';

/** FR-9/FR-10/FR-11: one picker row, ready to render. */
export interface WorktreeRow {
  path: string;
  /** branch name, or `HEAD @ 1a2b3c4` when detached (`HEAD @ ?` when head is null). */
  label: string;
  /** FR-10: the live session already sitting in this directory, if any. */
  inUseBy: string | null;
  locked: boolean;
  /** FR-11: prunable => the row is disabled. */
  disabled: boolean;
  /** `directory missing` · `locked` · `in use by "x"`, joined with ` · `; '' when none apply. */
  note: string;
}

/** `cwd`/`path` normalize to the same directory (both directions of isPathInside => equal). */
function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  return isPathInside(a, b, caseInsensitive) && isPathInside(b, a, caseInsensitive);
}

function worktreeRowLabel(entry: WorktreeListEntry): string {
  if (entry.detached) return `HEAD @ ${entry.head ? entry.head.slice(0, 7) : '?'}`;
  return entry.branch ?? '';
}

/** FR-9..FR-11. `sessions` is the live roster; `caseInsensitive` mirrors projects' path rules. */
export function worktreeRows(entries: WorktreeListEntry[], sessions: SessionMeta[], caseInsensitive: boolean): WorktreeRow[] {
  return entries.map((entry) => {
    const inUseSession = sessions.find((s) => samePath(s.cwd, entry.path, caseInsensitive));
    const inUseBy = inUseSession ? inUseSession.name : null;
    const notes: string[] = [];
    if (entry.prunable) notes.push('directory missing');
    if (entry.locked) notes.push('locked');
    if (inUseBy) notes.push(`in use by "${inUseBy}"`);
    return {
      path: entry.path,
      label: worktreeRowLabel(entry),
      inUseBy,
      locked: entry.locked,
      disabled: entry.prunable,
      note: notes.join(' · '),
    };
  });
}

/** FR-12: the name to prefill from a selected row — the row's label. */
export function attachNamePrefill(row: WorktreeRow): string {
  return row.label;
}

/**
 * FR-12: row selection may only prefill the session name "if the name is
 * still empty AND untouched" — never overwrite a name that already has
 * content, even if that content was itself a prefill (e.g. from
 * useProjectDefaults/useDirectoryPicker setting an untouched
 * project/directory basename) rather than something the user typed.
 */
export function attachNameShouldPrefill(name: string, nameTouched: boolean): boolean {
  return !nameTouched && name.trim() === '';
}

/** FR-17: the attach half of the Create gate. Mirrors `worktreeCreateBlocked`'s staleness rule. */
export interface WorktreeAttachGateState {
  mode: WorktreeMode;
  probing: boolean;
  probeErrored: boolean;
  selectedPath: string | null;
  rows: WorktreeRow[];
  caseInsensitive: boolean;
}

export function worktreeAttachBlocked(state: WorktreeAttachGateState): boolean {
  if (state.mode !== 'attach') return false;
  if (state.probing || state.probeErrored) return true;
  if (state.selectedPath === null) return true;
  const stillPresent = state.rows.some((r) => samePath(r.path, state.selectedPath as string, state.caseInsensitive));
  return !stillPresent;
}

/** FR-19: the chip/status-bar label for a session's worktree. */
export function worktreeChipLabel(worktree: SessionWorktree): string {
  return worktree.detached ? `HEAD @ ${worktree.branch}` : worktree.branch;
}
