// new-session-form — pure helpers shared by NewSessionModal's extracted
// hooks (useProjectDefaults derives the session name from a project's root;
// useDirectoryPicker derives it from a picked/typed path).

import type { Account } from '../../../contract/multi-account';
import type { RuntimeModelRef } from '../../../contract/common';
import type { SessionProfile } from '../../../contract/session-profiles';

/** Last path segment, tolerant of both `/` and `\` separators. Falls back to
 * the input itself when it has no segments (e.g. an empty string). */
export function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

// ---------- pi-migration-rollout §5/§7: profile/account runtime mismatch ----------

/**
 * A legacy profile paired with a Pi account, or a Pi profile paired with any
 * other account, is refused by the core as `PROFILE_RUNTIME_MISMATCH` (§5/§7).
 * Surfaced here BEFORE submit, off the same two kinds the core itself checks,
 * so the inline warning and the core's own rejection never say different
 * things. `offerCreatePiCopy` is true only for the one direction with a
 * documented recovery (§7): legacy profile + Pi account.
 */
export interface ProfileRuntimeMismatch {
  reason: string;
  offerCreatePiCopy: boolean;
}

export function profileRuntimeMismatch(
  profile: SessionProfile | null,
  account: Account | null,
): ProfileRuntimeMismatch | null {
  if (!profile || !account) return null;
  const accountIsPi = account.kind === 'pi';
  if (profile.kind === 'legacy' && accountIsPi) {
    return { reason: 'this is a Claude profile — it cannot run on a Pi account', offerCreatePiCopy: true };
  }
  if (profile.kind === 'pi' && !accountIsPi) {
    return { reason: 'this is a Pi profile — it needs a Pi account', offerCreatePiCopy: false };
  }
  return null;
}

// ---------- pi-models-metrics FR-4: model selection must match the account's runtime ----------

/**
 * FR-4: a Pi account requires an EXACT provider/model pair (`runtimeModel`)
 * from a fresh available snapshot — `modelId` alone is invalid for Pi, and
 * the reverse holds for every other runtime. Supplying both, or the wrong
 * one, is refused by the core as INVALID_INPUT (session-engine.ts
 * SessionCreateInput). Surfaced here so a form can disable Create before that
 * round-trip rather than after it — `null` ⇒ the selection matches the account.
 */
export function modelSelectionMismatch(
  account: Account | null,
  modelId: string,
  runtimeModel: RuntimeModelRef | undefined,
): string | null {
  const accountIsPi = account?.kind === 'pi';
  if (accountIsPi && !runtimeModel) return 'a Pi account needs an exact provider/model pair, not a model id';
  if (!accountIsPi && runtimeModel) return 'runtimeModel is only valid for a Pi account';
  if (accountIsPi && modelId) return 'a Pi account cannot submit both modelId and runtimeModel';
  return null;
}
