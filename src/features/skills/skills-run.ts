// pi-skills-capabilities §5 — skills_run's Pi-only fields. Every caller (the
// Run modal, the palette's "Run skill" step) mints its own clientMessageId and
// picks delivery itself: 'normal' while idle, 'followUp' while busy — the same
// state rule pi-turn-controls gives session_submit. These fields are REQUIRED
// for a Pi session and ignored by every other runtime (skills-panel.ts §5), so
// it is safe to send them unconditionally rather than branching on agentRuntime.

import type { DeliveryMode, SessionId, SessionStatus, SkillInfo } from '../../../contract/common';
import { isBusyStatus } from '../../../contract/fleet-board';
import type { SkillsRunRequest } from '../../../contract/skills-panel';

export function piSkillDelivery(status: SessionStatus): DeliveryMode {
  return isBusyStatus(status) ? 'followUp' : 'normal';
}

/**
 * pr-142 §6 (frontend half): the ONE place every caller builds a skills_run
 * request from a LISTED `SkillInfo` — so a run always carries that entry's
 * own `invocation`, never the derived (and collision-prone) `name` alone.
 * `invocation` is absent for every non-Pi entry, which the core ignores
 * exactly as it does today; nothing else changes for them.
 */
export function buildSkillsRunRequest(
  sessionId: SessionId,
  skill: Pick<SkillInfo, 'name' | 'invocation'>,
  args: string | undefined,
  pi: { clientMessageId: string; delivery: DeliveryMode },
): SkillsRunRequest {
  return {
    sessionId,
    name: skill.name,
    invocation: skill.invocation,
    args,
    clientMessageId: pi.clientMessageId,
    delivery: pi.delivery,
  };
}
