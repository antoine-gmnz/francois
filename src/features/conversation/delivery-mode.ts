// pi-turn-controls §3/§4 (FR-1/FR-2) — pure delivery-mode decisions for the
// Pi composer. Idle: Enter always sends 'normal'. Busy: the composer exposes
// a Steer now / Follow up toggle and Enter follows it; Alt+Enter is an
// explicit follow-up regardless of busy state (FR-1's idle+followUp case is a
// real, valid combination — submitted as a normal prompt while the recorded
// intent stays 'followUp'). Existing (non-Pi) runtimes never reach this
// module — their composer behaviour is untouched.

import type { DeliveryMode, SessionStatus } from '../../../contract/common';
import { isBusyStatus } from '../../../contract/fleet-board';

/** The two modes the composer's toggle offers while a Pi turn is running. */
export type DeliveryChoice = 'steer' | 'followUp';

/** FR-2: steering is never an immediate tool kill — the one line the composer
 *  shows for it, next to the toggle. */
export const STEERING_EXPLAINER = "takes effect at Pi's next steering opportunity, not an immediate stop";

/**
 * FR-1: the toggle's live selection, clamped to what the session's live
 * capabilities actually allow — a persisted 'steer' choice on a session that
 * only ever advertised followUps must not silently vanish from the request.
 * Prefers the persisted choice when it is still valid, else falls back to
 * whichever mode remains available. `null` ⇔ neither mode is available right
 * now (the composer disables sending while busy).
 */
export function resolveEffectiveChoice(choice: DeliveryChoice, canSteer: boolean, canFollowUp: boolean): DeliveryChoice | null {
  if (choice === 'steer' && canSteer) return 'steer';
  if (choice === 'followUp' && canFollowUp) return 'followUp';
  if (canFollowUp) return 'followUp';
  if (canSteer) return 'steer';
  return null;
}

/**
 * FR-1/§3: what one Enter/Send press resolves to. Alt+Enter is ALWAYS an
 * explicit follow-up, idle or busy. Plain Enter/Send sends 'normal' while
 * idle and follows the toggle's effective choice while busy; `null` only
 * when busy and neither mode is currently available — callers must treat
 * that as "nothing to send" rather than falling back to 'normal' (FR-1:
 * normal while busy is refused with SESSION_BUSY).
 */
export function resolveKeyDelivery(status: SessionStatus, altKey: boolean, effectiveChoice: DeliveryChoice | null): DeliveryMode | null {
  if (altKey) return 'followUp';
  if (!isBusyStatus(status)) return 'normal';
  return effectiveChoice;
}
