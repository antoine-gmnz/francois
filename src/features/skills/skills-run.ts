// pi-skills-capabilities §5 — skills_run's Pi-only fields. Every caller (the
// Run modal, the palette's "Run skill" step) mints its own clientMessageId and
// picks delivery itself: 'normal' while idle, 'followUp' while busy — the same
// state rule pi-turn-controls gives session_submit. These fields are REQUIRED
// for a Pi session and ignored by every other runtime (skills-panel.ts §5), so
// it is safe to send them unconditionally rather than branching on agentRuntime.

import type { DeliveryMode, SessionStatus } from '../../../contract/common';
import { isBusyStatus } from '../../../contract/fleet-board';

export function piSkillDelivery(status: SessionStatus): DeliveryMode {
  return isBusyStatus(status) ? 'followUp' : 'normal';
}
