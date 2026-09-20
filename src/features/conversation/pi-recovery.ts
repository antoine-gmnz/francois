// pi-session-durability §8 — pure state→presentation + submit logic for the
// Pi recovery banner. `missing`/`corrupt`/`incompatible`/`account-missing`
// refuse resume with ONE cause plus Retry/Create new session (FR-3/FR-7);
// `ready`/`disconnected` need no banner here — the next send (or an explicit
// reconnect) re-attaches transparently, and Claude's own ResumeFailBanner
// (session.resumeFailed) is untouched and unrelated — `recovery` is only ever
// present on a Pi session (contract/common.ts's SessionMeta.recovery).
// Extracted so PiRecoveryBanner.tsx is DOM assembly only, matching
// permission-card.ts's split of decision logic off its card component.

import type { Result, RuntimeRecovery, SessionMeta } from '../../../contract/common';

/** The four RuntimeRecovery states FR-3 refuses to resume automatically. */
export type BlockingRecoveryState = 'missing' | 'corrupt' | 'incompatible' | 'account-missing';

const BLOCKING_STATES = new Set<RuntimeRecovery['state']>(['missing', 'corrupt', 'incompatible', 'account-missing']);

/** True when `recovery` needs the blocking Retry/Create-new-session banner. */
export function isBlockingRecovery(
  recovery: RuntimeRecovery | undefined,
): recovery is RuntimeRecovery & { state: BlockingRecoveryState } {
  return recovery !== undefined && BLOCKING_STATES.has(recovery.state);
}

/**
 * The banner's single cause line (design brief: "one cause"). `message` is
 * documented present for every non-ready state (contract/common.ts), so the
 * fallback below is defensive only — never expected to actually render.
 */
export function recoveryCauseText(recovery: RuntimeRecovery): string {
  return recovery.message ?? 'this session’s native conversation cannot be resumed';
}

export interface RecoverySubmitArgs {
  /** Bound sessionReconnect/sessionNewFrom call. */
  action: () => Promise<Result<SessionMeta>>;
  /** Banner in-flight flag — both actions disabled while true (no duplicate submissions). */
  setBusy: (busy: boolean) => void;
  /** Inline, transient error line; `null` clears it. */
  setError: (message: string | null) => void;
  /** setTimeout injection point (fake in tests). */
  schedule: (fn: () => void, ms: number) => void;
}

/**
 * One reconnect/newFrom call. Unlike PermissionCard's submitDecision, BOTH
 * outcomes clear busy here: a successful reconnect flips THIS session's own
 * recovery to 'ready' via the accompanying session.meta event, so the
 * blocking banner unmounts on its own — but a successful newFrom mints a
 * DIFFERENT session and never touches this one's recovery, so nothing else
 * would ever re-enable these buttons if busy stayed latched past success.
 * Failure surfaces the Result's message inline for 4s, independently of
 * whatever `recovery.message` an accompanying session.meta may also carry.
 */
export async function submitRecoveryAction(a: RecoverySubmitArgs): Promise<void> {
  a.setBusy(true);
  a.setError(null);
  let failure: string | null = null;
  try {
    const res = await a.action();
    if (!res.ok) failure = res.error.message;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  a.setBusy(false);
  if (failure === null) return;
  a.setError(failure);
  a.schedule(() => a.setError(null), 4000);
}
