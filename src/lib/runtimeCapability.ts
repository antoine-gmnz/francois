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
  return runtimeCapabilities(meta.agentRuntime)[capability];
}
