// cohorte-integration FR-87 — whether a `francois.gate.opened` fires a desktop
// notification. Pure; the feed supplies the facts.

/** A gate that opened this long before its run was first seen is backfill. */
export const BACKFILL_GRACE_MS = 60_000;

export interface GateNotifyFacts {
  prefOn: boolean;
  alreadyNotified: boolean;
  /** when this window first saw the run (epoch ms) */
  firstSeenAt: number;
  requestedAt: number;
  windowFocused: boolean;
  /** the gate's origin session is on screen */
  originVisible: boolean;
}

export function shouldNotifyGate(f: GateNotifyFacts): boolean {
  if (!f.prefOn || f.alreadyNotified) return false;
  if (f.firstSeenAt - f.requestedAt > BACKFILL_GRACE_MS) return false;
  return !f.windowFocused || !f.originVisible;
}
