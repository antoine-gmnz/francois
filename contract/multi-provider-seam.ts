// contract/multi-provider-seam.ts — the provider capability table.
// Authored from specs/multi-provider-seam.md §5. Pure, no IPC: same idiom as
// isBusyStatus in contract/fleet-board.ts. Imports shared vocabulary from
// common.ts; never redefines it.

import type { SessionProvider } from './common';

export type ProviderCapability =
  | 'mcp'
  | 'subagents'
  | 'skills'
  | 'workflows'
  | 'interactiveCommands'
  | 'remoteControl'
  | 'usageBar'
  | 'compaction';

/** `reason` is present iff `available` is false; it is what a disabled pane renders. */
export interface CapabilityState {
  available: boolean;
  reason?: string;
}

/** Exhaustive over ProviderCapability — a new member without both values must not compile. */
export type ProviderCapabilities = Record<ProviderCapability, CapabilityState>;

const CAPABILITIES: Record<SessionProvider, ProviderCapabilities> = {
  'claude-code': {
    mcp: { available: true },
    subagents: { available: true },
    skills: { available: true },
    workflows: { available: true },
    interactiveCommands: { available: true },
    remoteControl: { available: true },
    usageBar: { available: true },
    compaction: { available: true },
  },
  'openai-compatible': {
    mcp: { available: false, reason: "MCP servers aren't available on this provider yet." },
    subagents: { available: false, reason: "Subagents aren't available on this provider yet." },
    skills: { available: false, reason: 'Skills are a Claude Code feature.' },
    workflows: { available: false, reason: 'Workflows are a Claude Code feature.' },
    interactiveCommands: { available: false, reason: 'Slash commands are a Claude Code feature.' },
    remoteControl: { available: false, reason: 'Remote Control is an Anthropic service.' },
    usageBar: { available: false, reason: "This provider bills per token, not against a plan." },
    compaction: { available: false, reason: "Compaction isn't available on this provider yet." },
  },
};

export function providerCapabilities(provider: SessionProvider): ProviderCapabilities {
  return CAPABILITIES[provider];
}
