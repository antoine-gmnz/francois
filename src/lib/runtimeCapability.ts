import type { AgentRuntime, SessionMeta } from '../../contract/common';
import type { Account } from '../../contract/multi-account';
import type { SessionProfile } from '../../contract/session-profiles';
import { runtimeCapabilities, type CapabilityState, type RuntimeCapabilities, type RuntimeCapability } from '../../contract/multi-provider-seam';

export const PI_UNAVAILABLE = 'Pi is unavailable in this version. Saved history is read-only.';
// process-native-capabilities FR-4: a supported control whose transport is not
// connected reads differently from one the runtime does not support at all.
export const CAPABILITY_DISCONNECTED = 'This control needs a live runtime connection. Start or continue a turn to reconnect.';
export const CAPABILITY_INVALID = 'The runtime sent an invalid capability report. Start a new turn to refresh it.';

// Mirrors src-tauri/src/session/adapter/capabilities.rs — both are tested
// against src-tauri/src/session/adapter/capability-matrix.json.
const MAX_REASON_BYTES = 512;
const KEYS = Object.keys(runtimeCapabilities('claude-code')) as RuntimeCapability[];
// eslint-disable-next-line no-control-regex -- the check IS for control characters
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** Keys supported only while the negotiated live transport exists (FR-1/FR-2). */
function liveOnly(runtime: AgentRuntime, capability: RuntimeCapability): boolean {
  return runtime === 'codex' && capability === 'permissions';
}

function validSnapshot(caps: RuntimeCapabilities): boolean {
  const entries = Object.entries(caps);
  if (entries.length !== KEYS.length) return false;
  return KEYS.every((key) => {
    const state = caps[key] as CapabilityState | undefined;
    if (!state || typeof state.available !== 'boolean') return false;
    if (state.available) return state.reason === undefined;
    const reason = state.reason;
    return typeof reason === 'string' && reason.trim() !== '' && !UNSAFE.test(reason)
      && new TextEncoder().encode(reason).length <= MAX_REASON_BYTES;
  });
}

/**
 * process-frontend-boundaries: the retired-runtime predicates. Pi is readable
 * history only — callers ask these rather than comparing `agentRuntime`/`kind`
 * to a literal, so this module stays the one runtime-name mapping in src/.
 */
export function sessionIsRetired(meta: Pick<SessionMeta, 'agentRuntime'> | null | undefined): boolean {
  return meta?.agentRuntime === 'pi';
}

export function accountIsRetired(account: { kind?: Account['kind'] | string } | null | undefined): boolean {
  return account?.kind === 'pi';
}

export function profileIsRetired<P extends { kind?: SessionProfile['kind'] | string }>(
  profile: P | null | undefined,
): profile is P & { kind: 'pi' } {
  return profile?.kind === 'pi';
}

/**
 * Request replies (question/permission cards) that are only valid while the
 * negotiated live transport generation exists — derived from the same
 * live-only capability row sessionCapability gates on.
 */
export function requestNeedsLiveGeneration(meta: Pick<SessionMeta, 'agentRuntime'> | null | undefined): boolean {
  return !!meta && liveOnly(meta.agentRuntime, 'permissions');
}

export function sessionCapability(meta: SessionMeta | null | undefined, capability: RuntimeCapability): CapabilityState {
  if (!meta) return { available: true };
  if (sessionIsRetired(meta)) return { available: false, reason: PI_UNAVAILABLE };
  const baseline = runtimeCapabilities(meta.agentRuntime)[capability];
  if (!baseline.available && !liveOnly(meta.agentRuntime, capability)) return baseline;
  const snapshot = meta.effectiveCapabilities;
  if (snapshot && !validSnapshot(snapshot)) return { available: false, reason: CAPABILITY_INVALID };
  if (liveOnly(meta.agentRuntime, capability) && (!snapshot || !meta.runtimeGeneration)) {
    return { available: false, reason: CAPABILITY_DISCONNECTED };
  }
  const live = snapshot?.[capability];
  if (live && !live.available) return live;
  return { available: true };
}

export function sandboxSelectionCapability(meta: SessionMeta | null | undefined): CapabilityState {
  return sessionIsRetired(meta) ? { available: false, reason: PI_UNAVAILABLE } : { available: true };
}
