// runtimeCapability (multi-provider-openai FR-20) — the one place src/ reads
// contract/multi-provider-seam's runtimeCapabilities() table for a session.
// Every disabled-pane consumer (panes [3]-[6], the usage bar, the slash menu)
// goes through sessionCapability, so nowhere else compares `agentRuntime`/
// `protocol` to a literal — the table is the only source (spec §9's grep check).

import type { SessionMeta } from '../../contract/common';
import { runtimeCapabilities, type CapabilityState, type RuntimeCapability } from '../../contract/multi-provider-seam';

/**
 * The capability state for one session's runtime. `meta` absent (no session
 * focused, or the session isn't bound to a pane yet) reads as available —
 * there is nothing session-specific to gate without one, and every
 * pre-existing empty state already covers that case on its own.
 */
export function sessionCapability(
  meta: SessionMeta | null | undefined,
  capability: RuntimeCapability,
): CapabilityState {
  if (!meta) return { available: true };
  const baseline = runtimeCapabilities(meta.agentRuntime)[capability];
  const live = meta.effectiveCapabilities?.[capability];
  // The core's live snapshot may only narrow the contract's static default. A
  // runtime must never acquire a UI action merely because an incomplete or
  // optimistic child snapshot says it can do something.
  // Pi deliberately has a fully-disabled static fallback until it connects;
  // after that, its core-supplied snapshot is the authoritative capability set.
  if (meta.agentRuntime === 'pi') return live ?? baseline;
  if (!live || !baseline.available) return baseline;
  return live.available ? baseline : live;
}

/** Sandbox selection is separate from interactive approval support. */
export function sandboxSelectionCapability(meta: SessionMeta | null | undefined): CapabilityState {
  return meta?.agentRuntime === 'pi'
    ? { available: false, reason: 'Runtime sandbox selection is unavailable.' }
    : { available: true };
}
