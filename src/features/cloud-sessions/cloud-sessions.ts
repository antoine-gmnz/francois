// cloud-sessions (specs/cloud-sessions.md) — the feature's pure logic. The core
// owns the teleport PTY; this module owns how a ref is read, how the list
// degrades, how the adoption's phases are folded into one record, and what the
// user is told when it fails.
//
// Two rules run through the whole file:
//  - Nothing is ever synthesized. Every field the REST list returns can be null
//    (spec §7 #3), so an absent title falls back to the short id and an absent
//    repo/branch is simply not rendered.
//  - The phrase "Remote Control" must never reach this feature's UI (§7 #4).
//    Teleport rides the same infrastructure, so the CLI's own auth errors say
//    it — every CLOUD_* code below therefore gets Francois' own wording, and
//    anything else is scrubbed on the way out.

import type { AppError, CloudProvenance, ErrorCode, ProjectId, Result, SessionId } from '../../../contract/common';
import { formatRelativeTime } from '../../../contract/fleet-board';
import {
  CLOUD_ADOPT_STEPS,
  type CloudAdoptRequest,
  type CloudAdoptStep,
  type CloudDestination,
  type CloudEvent,
  type CloudListData,
  type CloudSession,
  type CloudSessionId,
} from '../../../contract/cloud-sessions';

// ---------- FR-3: reading the ref the user pasted ----------

/** `session_…` / `cse_…`, the two id shapes the cloud API mints. */
const ID_RE = /^(?:session|cse)_[A-Za-z0-9._-]+$/;
/** A claude.ai/code link, with or without scheme, `www.`, trailing slash, query or hash. */
const URL_RE = /^(?:https?:\/\/)?(?:www\.)?claude\.ai\/code\/([A-Za-z0-9._-]+)(?:[/?#].*)?$/;

/**
 * The cloud session id inside `raw`, or null when it is not a ref at all.
 *
 * This MIRRORS the core's FR-3 normalization rather than replacing it: the core
 * normalizes the ref it is sent and is the authority. The frontend parses only
 * so it can (a) show the short id on a row and (b) avoid firing a `cloud_resolve`
 * on every keystroke of half-typed text. A ref this refuses is still submittable
 * — the Adopt guard asks for a non-empty ref, not for a parseable one, so a
 * shape the CLI learns before Francois does is never blocked here.
 */
export function parseCloudRef(raw: string): CloudSessionId | null {
  const ref = raw.trim();
  if (ref === '') return null;
  if (ID_RE.test(ref)) return ref;
  const m = URL_RE.exec(ref);
  return m ? m[1] : null;
}

/** The id with its `session_`/`cse_` prefix dropped, trimmed to a legible head. */
export function shortCloudId(id: CloudSessionId): string {
  const bare = id.replace(/^(?:session|cse)_/, '');
  return bare.slice(0, 8);
}

// ---------- honest rows (§Data shown) ----------

/** The row's headline: the API's title, else the short id. Never invented. */
export function cloudRowTitle(session: CloudSession): string {
  const title = session.title?.trim();
  return title ? title : shortCloudId(session.id);
}

/**
 * The row's secondary line, as a list of the fields that are actually present:
 * repo, branch, relative updated-at. An absent field is HIDDEN, not rendered as
 * a dash or a guess.
 */
export function cloudRowMeta(session: CloudSession, now: number = Date.now()): string[] {
  const parts: string[] = [];
  if (session.repo) parts.push(session.repo);
  if (session.branch) parts.push(session.branch);
  if (typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)) {
    parts.push(formatRelativeTime(session.updatedAt, now));
  }
  return parts;
}

// ---------- FR-2 / FR-17: the list degrades to empty, never to wrong ----------

export interface CloudListView {
  sessions: CloudSession[];
  /** true ⇒ render the one calm line, never an error state. */
  degraded: boolean;
  /** Non-null ONLY for the auth refusals, which are the actionable ones. */
  error: AppError | null;
}

function isCloudSession(value: unknown): value is CloudSession {
  return typeof value === 'object' && value !== null && typeof (value as CloudSession).id === 'string';
}

/**
 * Fold a `cloud_list` response into what the modal renders.
 *
 * A malformed payload is treated exactly like the core's own `degraded: true`:
 * the list is a convenience (spec §7 #3) and a wrong guess about its shape must
 * cost the list, never the paste path. Only `ok:false` — the FR-1 auth failures
 * — becomes an error, because that is the one the user can act on.
 */
export function cloudListView(res: Result<CloudListData>): CloudListView {
  if (!res.ok) return { sessions: [], degraded: false, error: res.error };
  const data = res.data as CloudListData | null | undefined;
  if (!data || !Array.isArray(data.sessions)) return { sessions: [], degraded: true, error: null };
  return { sessions: data.sessions.filter(isCloudSession), degraded: data.degraded === true, error: null };
}

/** What `useCloudList` holds while and after it fetches. */
export interface CloudListState extends CloudListView {
  /** Skeleton rows while true — the paste field stays usable throughout. */
  loading: boolean;
}

/**
 * What the list REGION renders. Four states, and the order below is the point:
 * an auth refusal outranks both quiet lines, because "No cloud sessions on this
 * account yet" is a claim about the account — and when auth refused we never got
 * to look. Saying it anyway sends the user hunting for sessions they have, and
 * contradicts the actionable message in the same breath. The refusal is shown
 * where the list would be, next to the thing it is about.
 */
export type CloudListRender =
  | { kind: 'loading' }
  | { kind: 'rows' }
  /** Calm, `--text-disabled`, no icon: degraded (FR-17) or genuinely empty. */
  | { kind: 'note'; line: string }
  /** The FR-1 auth refusals — the only list failure a user can act on. */
  | { kind: 'error'; line: string };

export function cloudListRender(state: CloudListState): CloudListRender {
  if (state.loading) return { kind: 'loading' };
  if (state.error !== null) return { kind: 'error', line: cloudErrorMessage(state.error) };
  if (state.degraded) return { kind: 'note', line: DEGRADED_LINE };
  if (state.sessions.length === 0) return { kind: 'note', line: EMPTY_LIST_LINE };
  return { kind: 'rows' };
}

// ---------- FR-7 / FR-15: phases, not a spinner ----------

/**
 * One adoption in flight. Only one runs at a time (spec §6), so this is a single
 * record rather than a map.
 *
 * `step` is the last phase REACHED — it is kept when the adoption fails, which
 * is what lets the phase list stop on the row that broke instead of collapsing
 * to a bare error.
 */
export interface AdoptProgress {
  /** The ref this adoption was started with — events carry it back verbatim. */
  ref: string;
  step: CloudAdoptStep;
  error: AppError | null;
  sessionId: SessionId | null;
}

export function startAdopt(ref: string): AdoptProgress {
  return { ref, step: 'resolving', error: null, sessionId: null };
}

/**
 * Terminal ⇒ no further event may change it (a late phase must not revive a
 * failure). Exported because the runner needs the same test for the COMMAND's
 * own result: `cloud_adopt` resolves ok:false after the `failed` event that
 * already carried the detailed error, and the coarser one must not win.
 */
export function isAdoptTerminal(progress: AdoptProgress): boolean {
  return progress.error !== null || progress.sessionId !== null;
}

/**
 * Fold a `cloud.adopt` event. Events for another ref are ignored: a second
 * adoption (or a stale one from a previous open) must never hijack this modal.
 */
export function applyCloudEvent(progress: AdoptProgress | null, event: CloudEvent): AdoptProgress | null {
  if (progress === null) return null;
  if (event.type !== 'cloud.adopt' || event.ref !== progress.ref) return progress;
  if (isAdoptTerminal(progress)) return progress;
  const state = event.state;
  switch (state.phase) {
    case 'ready':
      return { ...progress, step: 'ready', sessionId: state.sessionId, error: null };
    case 'failed':
      return { ...progress, error: state.error };
    default:
      return { ...progress, step: state.phase };
  }
}

/**
 * Fold a command-level refusal (`cloud_adopt` resolving ok:false). Some
 * failures — an unparseable ref, a missing confirmation — never produce a
 * `failed` event because the core refuses before the adoption starts.
 */
export function failAdopt(progress: AdoptProgress | null, error: AppError): AdoptProgress | null {
  if (progress === null) return null;
  return { ...progress, error };
}

export type StepState = 'done' | 'current' | 'failed' | 'pending';

export function stepState(step: CloudAdoptStep, progress: AdoptProgress): StepState {
  const at = CLOUD_ADOPT_STEPS.indexOf(step);
  const here = CLOUD_ADOPT_STEPS.indexOf(progress.step);
  if (at < here) return 'done';
  if (at > here) return 'pending';
  if (progress.error !== null) return 'failed';
  return step === 'ready' && progress.sessionId !== null ? 'done' : 'current';
}

/** The step labels the phase list reads out — each row has a text label, never colour alone. */
export const ADOPT_STEP_LABELS: Record<CloudAdoptStep, string> = {
  resolving: 'Resolving',
  preparing: 'Preparing',
  teleporting: 'Teleporting',
  hydrating: 'Loading history',
  ready: 'Ready',
};

/**
 * The dot tone per step state. Acid is reserved for the CURRENT row — the one
 * live thing in this view (design system: one acid per view) — so `done` takes
 * ready-green and `pending` the disabled step.
 */
export function stepDotColor(state: StepState): string {
  switch (state) {
    case 'done':
      return 'var(--success)';
    case 'current':
      return 'var(--accent)';
    case 'failed':
      return 'var(--error)';
    case 'pending':
      return 'var(--text-disabled)';
  }
}

// ---------- FR-12 / FR-14: what makes Adopt clickable ----------

export interface AdoptForm {
  ref: string;
  /** '' ⇒ nothing chosen; the selector is required (FR-14). */
  projectId: ProjectId | '';
  destination: CloudDestination;
  /** The checkout landing's explicit tick (FR-12). */
  confirmed: boolean;
}

/**
 * FR-12/FR-14. The ref only has to be NON-EMPTY, not parseable: the core
 * normalizes and is the authority on what a ref is, so a shape Francois does
 * not know yet is refused there with an honest INVALID_INPUT rather than
 * silently greyed out here.
 */
export function canAdopt(form: AdoptForm): boolean {
  if (form.ref.trim() === '') return false;
  if (form.projectId === '') return false;
  if (form.destination === 'checkout' && !form.confirmed) return false;
  return true;
}

/**
 * The request for a form the guard above accepted. `confirmed` is sent ONLY for
 * a checkout landing — a stale tick from a landing the user switched away from
 * must not travel with a worktree adoption.
 */
export function adoptRequest(form: AdoptForm, accountId?: string): CloudAdoptRequest {
  const req: CloudAdoptRequest = {
    ref: form.ref.trim(),
    projectId: form.projectId,
    destination: form.destination,
  };
  if (form.destination === 'checkout') req.confirmed = true;
  if (accountId) req.accountId = accountId;
  return req;
}

/**
 * Which project the selector shows after a `cloud_resolve` landed.
 *
 * A hand-picked project always wins — resolving happens as the user types, and
 * a late response must not overwrite the choice they just made. Otherwise the
 * matched project fills in quietly, and a ref that matched NOTHING clears the
 * field: leaving the previous ref's match behind would silently land the
 * session in the wrong repo.
 */
export function projectAfterResolve(
  current: ProjectId | '',
  matched: ProjectId | null,
  userPicked: boolean,
): ProjectId | '' {
  if (userPicked) return current;
  return matched ?? '';
}

// ---------- §7 #4: honest text, and never the phrase "Remote Control" ----------

/**
 * Teleport rides Remote Control's infrastructure, so the CLI's own errors say
 * "Remote Control session expired" / "Access denied". That is a DIFFERENT object
 * — echoing it sends the user looking for a feature that has nothing to do with
 * this one. Every message that reaches the UI passes through here.
 */
function scrub(message: string): string {
  return message.replace(/remote[\s-]control/gi, 'cloud session');
}

function repoMismatchLine(detail: unknown): string {
  const d = detail as { sessionRepo?: unknown; currentRepo?: unknown } | null | undefined;
  const sessionRepo = typeof d?.sessionRepo === 'string' ? d.sessionRepo : null;
  const currentRepo = typeof d?.currentRepo === 'string' ? d.currentRepo : null;
  if (sessionRepo && currentRepo) {
    return `This is a different repository — the cloud session belongs to ${sessionRepo}, this checkout is ${currentRepo}. Adopt it from a checkout of the same repository (a fork will not do).`;
  }
  return 'This is a different repository from the one the cloud session belongs to. Adopt it from a checkout of that repository (a fork will not do).';
}

function stalledLine(detail: unknown): string {
  const d = detail as { phase?: unknown } | null | undefined;
  const phase = typeof d?.phase === 'string' ? d.phase : null;
  const label = phase && phase in ADOPT_STEP_LABELS ? ADOPT_STEP_LABELS[phase as CloudAdoptStep] : null;
  const where = label ? ` while ${label.toLowerCase()}` : '';
  return `Adoption stopped${where}: Claude Code is waiting on a decision Francois will not make for you. Finish it in a terminal, then try again.`;
}

const CLOUD_MESSAGES: Partial<Record<ErrorCode, string>> = {
  CLOUD_AUTH_REQUIRED: 'Cloud sessions need a claude.ai login — API key auth is not sufficient.',
  CLOUD_AUTH_EXPIRED: 'Your claude.ai login has expired. Run a turn, or sign in again with /login, and retry.',
  CLOUD_DEVICE_UNTRUSTED: 'This device is not enrolled for cloud sessions yet. Enrol it with /login, then retry.',
  CLOUD_POLICY_DENIED: 'Your organization has turned cloud sessions off for this account.',
  CLOUD_SESSION_NOT_FOUND: 'No cloud session with that id — check the link, or that this account can see it.',
  CLOUD_ADOPT_FAILED: 'Claude Code exited before the session was ready. Check that the branch is pushed to the remote.',
};

/**
 * What the modal shows for a failed adoption or a refused list.
 *
 * Every CLOUD_* code gets Francois' own wording — the core's message is
 * deliberately NOT used for those, because that is exactly where the CLI's
 * Remote Control phrasing leaks in. Other codes keep their own message
 * (scrubbed), since those are already specific (`NOT_A_GIT_REPO`,
 * `WORKTREE_BRANCH_IN_USE`, …) and re-wording them would lose detail.
 */
export function cloudErrorMessage(error: AppError): string {
  if (error.code === 'CLOUD_REPO_MISMATCH') return repoMismatchLine(error.detail);
  if (error.code === 'CLOUD_ADOPT_STALLED') return stalledLine(error.detail);
  const mapped = CLOUD_MESSAGES[error.code];
  if (mapped) return mapped;
  const own = scrub(error.message ?? '').trim();
  return own === '' ? 'Adoption failed for an unknown reason.' : own;
}

// ---------- copy the design brief pins ----------

/** FR-17 / §Notes: the common state for anyone offline. Calm, no icon, no error tone. */
export const DEGRADED_LINE = "Couldn't load your cloud sessions — paste a link instead.";

/**
 * The OTHER empty list: the fetch worked and this account has no cloud sessions.
 * Distinct from DEGRADED_LINE on purpose — telling someone we couldn't load a
 * list we loaded fine sends them debugging a network that is working.
 */
export const EMPTY_LIST_LINE = 'No cloud sessions on this account yet.';

export const PASTE_PLACEHOLDER = 'Paste a claude.ai/code link or session id';

/**
 * FR-16 / §7 #8: load-bearing copy, not a footnote. If the UI implies the phone
 * still sees the session, users lose work believing it does.
 */
export const CLOUD_ONE_WAY_LINE =
  'Adopted from a cloud session. Work you do here does not go back to claude.ai.';

/**
 * The same rule, in the tense of a decision the user has not made yet — what the
 * modal says under the paste field. The chip's line above is retrospective, and
 * §7 #8 is about the MOMENT of choosing as much as about the session afterwards.
 */
export const ADOPT_ONE_WAY_HINT =
  'One-way: after adopting, this session lives here and claude.ai no longer sees your work.';

/** The destructive landing's inline warning — it names the branch it will check out. */
export function checkoutWarning(projectName: string, branch: string | null): string {
  const where = branch ? branch : "the cloud session's branch";
  return `Teleport will stash uncommitted changes in ${projectName} and check out ${where}.`;
}

/** "3m ago" / "just now" — `formatRelativeTime` returns a bare 'now' for the recent case. */
function ago(at: number, now: number): string {
  const rel = formatRelativeTime(at, now);
  return rel === 'now' ? 'just now' : `${rel} ago`;
}

/**
 * The chip's tooltip: the one-way rule verbatim, then the provenance itself.
 * The chip FACE carries neither the id nor the timestamp (§Data shown) — a
 * provenance chip states a fact, it is not a readout.
 */
export function cloudChipTitle(cloud: CloudProvenance, now: number = Date.now()): string {
  return `${CLOUD_ONE_WAY_LINE}\n${cloud.cloudSessionId} · adopted ${ago(cloud.adoptedAt, now)}`;
}
