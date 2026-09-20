// runtimeCapability (multi-provider-openai FR-20) — the one place src/ reads
// contract/multi-provider-seam's runtimeCapabilities() table for a session.
// Every disabled-pane consumer (panes [3]-[6], the usage bar, the slash menu)
// goes through sessionCapability, so nowhere else compares `agentRuntime`/
// `protocol` to a literal — the table is the only source (spec §9's grep check).

import type { SessionMeta } from '../../contract/common';
import { runtimeCapabilities, type CapabilityState, type RuntimeCapability } from '../../contract/multi-provider-seam';
import { PI_BASELINE_UNAVAILABLE, PI_UNRESTRICTED_TOOLS_NOTICE } from '../../contract/pi-skills-capabilities';

/**
 * pi-skills-capabilities FR-3/FR-4: the sentence a capability clamped off Pi
 * shows. Generic on purpose — it is only ever reached when a live snapshot
 * CLAIMS something FR-3 pins off, i.e. when the core is wrong about itself, and
 * a per-capability sentence would be writing copy for a state that is a bug.
 * A snapshot that disables the capability keeps its own, better reason.
 */
const PI_CLAMPED_REASON = "This isn't available on a Pi session.";

const PI_CLAMPED: ReadonlySet<RuntimeCapability> = new Set(PI_BASELINE_UNAVAILABLE);

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
  // after that, its core-supplied snapshot is the authoritative capability set
  // — but only INSIDE the FR-3 baseline. That row is a disconnected
  // placeholder rather than a ceiling, so it cannot do the narrowing job the
  // other runtimes' rows do, and the seven capabilities the spec pins off
  // ("can never exceed by name or manifest claim") are clamped here instead.
  if (meta.agentRuntime === 'pi') {
    const state = live ?? baseline;
    if (state.available && PI_CLAMPED.has(capability)) {
      return { available: false, reason: PI_CLAMPED_REASON };
    }
    return state;
  }
  if (!live || !baseline.available) return baseline;
  return live.available ? baseline : live;
}

/**
 * Sandbox selection is separate from interactive approval support. For Pi
 * (pi-skills-capabilities FR-5) this is not "not built yet" — there is no
 * François-enforced sandbox for a permission mode to select, so the reason is
 * the same FR-5 notice every Pi surface shows, not a generic unavailability line.
 */
export function sandboxSelectionCapability(meta: SessionMeta | null | undefined): CapabilityState {
  return meta?.agentRuntime === 'pi'
    ? { available: false, reason: PI_UNRESTRICTED_TOOLS_NOTICE }
    : { available: true };
}
