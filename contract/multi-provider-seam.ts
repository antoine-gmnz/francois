// contract/multi-provider-seam.ts — the runtime capability table.
// Authored from specs/multi-provider-seam.md §5. Pure, no IPC: same idiom as
// isBusyStatus in contract/fleet-board.ts. Imports shared vocabulary from
// common.ts; never redefines it.
//
// FR-14 (amended 2026-08-14): the table keys on the AGENT RUNTIME, not the
// protocol. `mcp`, `subagents`, `skills`, `workflows`, `interactiveCommands`
// and `compaction` are properties of who owns the loop — a `francois`-runtime
// session has the same gaps whichever dialect it speaks. `remoteControl` and
// `usageBar` are genuinely vendor-shaped rather than runtime-shaped, but stay
// here anyway: both are false for every non-Anthropic configuration, and
// splitting one table into two to express that would cost more than it says.
//
// Reserved name: `ProviderCapabilities` is deliberately NOT spent here. It
// belongs to the model-level flag set (streaming, vision, reasoning,
// parallel_tool_calls, structured_output) a later feature will need.

import type { AgentRuntime } from './common';

export type RuntimeCapability =
  | 'mcp'
  | 'subagents'
  | 'skills'
  | 'skillsInstall'
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

/** Exhaustive over RuntimeCapability — a new member without both values must not compile. */
export type RuntimeCapabilities = Record<RuntimeCapability, CapabilityState>;

const CAPABILITIES: Record<AgentRuntime, RuntimeCapabilities> = {
  'claude-code': {
    mcp: { available: true },
    subagents: { available: true },
    skills: { available: true },
    skillsInstall: { available: true },
    workflows: { available: true },
    interactiveCommands: { available: true },
    remoteControl: { available: true },
    usageBar: { available: true },
    compaction: { available: true },
  },
  // Every `false` here is a CURRENT gap, not a permanent property of the runner,
  // except `remoteControl` and `usageBar` — those two are genuinely Anthropic
  // services with nothing to port. The wording carries that difference: a gap
  // reads "yet", a vendor service states what it is. Interoperable capabilities
  // are the point of the whole arc (specs/capability-registry.md), so a reason
  // line that reads "X is a Claude Code feature" would be writing the gap into
  // the architecture.
  francois: {
    mcp: { available: false, reason: "MCP servers aren't available on this provider yet." },
    subagents: { available: false, reason: "Subagents aren't available on this provider yet." },
    // multi-provider-openai FR-23..FR-27: a skill is markdown instructions, and
    // the Francois loop injects the installed set into its system message —
    // the one capability that actually ports across runtimes. See
    // OpenAiAdapter's skills.rs for the injection and specs/multi-provider-
    // openai.md §4 "Core — skills" for why this is the sole exception.
    skills: { available: true },
    // FR-26: install is a DIFFERENT capability from skills, and it does not
    // open up with it. Enabling a plugin writes Claude Code's own
    // `~/.claude/settings.json` — that runner's control surface, not ours —
    // so this stays a gap even once the model can see and follow skills.
    skillsInstall: {
      available: false,
      reason: "Installing skills isn't available on this provider yet.",
    },
    workflows: { available: false, reason: "Workflows aren't available on this provider yet." },
    interactiveCommands: {
      available: false,
      reason: "Slash commands aren't available on this provider yet.",
    },
    remoteControl: { available: false, reason: 'Remote Control is an Anthropic service.' },
    usageBar: { available: false, reason: 'This provider bills per token, not against a plan.' },
    compaction: { available: false, reason: "Compaction isn't available on this provider yet." },
  },
};

export function runtimeCapabilities(runtime: AgentRuntime): RuntimeCapabilities {
  return CAPABILITIES[runtime];
}
