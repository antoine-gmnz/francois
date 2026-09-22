import type { RuntimeModelRef } from '../../../contract/common';
import type { Account } from '../../../contract/multi-account';
import type { SessionProfile } from '../../../contract/session-profiles';
import { accountIsRetired, profileIsRetired } from '../../lib/runtimeCapability';

/** Last segment of a POSIX or Windows path. */
export function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export interface ProfileRuntimeMismatch { reason: string; offerCreatePiCopy: false }

/** Saved Pi selections stay visible until the user explicitly replaces them. */
export function profileRuntimeMismatch(profile: SessionProfile | null, account: Account | null): ProfileRuntimeMismatch | null {
  return profileIsRetired(profile) || accountIsRetired(account)
    ? { reason: 'Pi is unavailable. Choose an available account and profile.', offerCreatePiCopy: false }
    : null;
}

export function modelSelectionMismatch(account: Account | null, _modelId: string, runtimeModel: RuntimeModelRef | undefined): string | null {
  if (accountIsRetired(account)) return 'Pi is unavailable. Choose an available account.';
  if (runtimeModel) return 'Choose an available account and model explicitly.';
  return null;
}
