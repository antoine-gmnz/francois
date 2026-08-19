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
  /**
   * multi-provider-codex FR-11: whether Francois' OWN approval cards + rules
   * editor govern this runtime's tool calls. True for 'claude-code' (Claude Code
   * asks over the control channel and we render the card) and for 'francois'
   * (that adapter IS the gate — multi-provider-openai FR-9..FR-13). False for
   * 'codex', whose transport is non-interactive: `codex exec` takes its prompt on
   * stdin and then closes it, so there is no channel to park an ask on. Its
   * enforcement is the sandbox `permissionMode` selects (FR-9), which is real
   * enforcement — just not ours, and the UI has to say so rather than render a
   * rules editor that governs nothing.
   */
  | 'permissions'
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
    permissions: { available: true },
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
    // This adapter IS the permission gate (multi-provider-openai FR-9..FR-13):
    // nothing executes without our approval step, so the cards and the rules
    // editor govern it exactly as they govern a Claude session.
    permissions: { available: true },
    remoteControl: { available: false, reason: 'Remote Control is an Anthropic service.' },
    usageBar: { available: false, reason: 'This provider bills per token, not against a plan.' },
    compaction: { available: false, reason: "Compaction isn't available on this provider yet." },
  },
  // multi-provider-codex FR-16. Codex owns its own loop like claude-code, but
  // over a NON-INTERACTIVE transport (`codex exec --json`, prompt on stdin, stdin
  // then closed), which is what drives most of these falses: with no channel back
  // into a live turn there is nothing to ask on, install through, or drive a slash
  // command over.
  //
  // Two reasons here deliberately DIVERGE from the francois row rather than being
  // copied, because the same word would be false:
  //   - usageBar: a Codex session authenticated with `codex login` bills against a
  //     ChatGPT PLAN. "Bills per token, not against a plan" would be a lie — this
  //     is a gap we have not built, so it reads "yet" like the other gaps.
  //   - permissions: not a gap at all. Codex enforces with an OS-level sandbox
  //     chosen from permissionMode (FR-9). Stating that is honest; "isn't
  //     available yet" would imply the calls run ungoverned, which is the opposite
  //     of the truth.
  codex: {
    mcp: { available: false, reason: "MCP servers aren't available on this provider yet." },
    subagents: { available: false, reason: "Subagents aren't available on this provider yet." },
    // Codex has its own skills dir, but the panes read Claude Code's control
    // surface; inverting discovery is capability-registry, not this feature.
    skills: { available: false, reason: "Skills aren't available on this provider yet." },
    skillsInstall: {
      available: false,
      reason: "Installing skills isn't available on this provider yet.",
    },
    workflows: { available: false, reason: "Workflows aren't available on this provider yet." },
    interactiveCommands: {
      available: false,
      reason: "Slash commands aren't available on this provider yet.",
    },
    permissions: {
      available: false,
      reason: 'Codex enforces permissions with its own sandbox.',
    },
    remoteControl: { available: false, reason: 'Remote Control is an Anthropic service.' },
    usageBar: { available: false, reason: "Plan limits aren't available on this provider yet." },
    compaction: { available: false, reason: "Compaction isn't available on this provider yet." },
  },
  // multi-provider-grok FR-26. Grok owns its own loop like claude-code and codex,
  // over the same shape of NON-INTERACTIVE transport as codex (`grok -p
  // --output-format streaming-json`, prompt on stdin, stdin then closed) — so the
  // same reasoning drives most of these falses.
  //
  // `permissions` DIVERGES from both other rows for the same reason codex's does:
  // not a gap, Grok enforces with an OS-level sandbox chosen from permissionMode
  // (FR-9). `usageBar` diverges from BOTH: a Grok CLI session bills against a
  // SuperGrok / X Premium+ plan, which is neither francois' "bills per token, not
  // against a plan" nor codex's ChatGPT wording — so it gets its own sentence
  // rather than reusing either.
  grok: {
    mcp: { available: false, reason: "MCP servers aren't available on this provider yet." },
    subagents: { available: false, reason: "Subagents aren't available on this provider yet." },
    // Grok has its own MCP-configured skills-adjacent surface, but the panes read
    // Claude Code's control surface; inverting discovery is capability-registry.
    skills: { available: false, reason: "Skills aren't available on this provider yet." },
    skillsInstall: {
      available: false,
      reason: "Installing skills isn't available on this provider yet.",
    },
    workflows: { available: false, reason: "Workflows aren't available on this provider yet." },
    interactiveCommands: {
      available: false,
      reason: "Slash commands aren't available on this provider yet.",
    },
    permissions: {
      available: false,
      reason: 'Grok enforces permissions with its own sandbox.',
    },
    remoteControl: { available: false, reason: 'Remote Control is an Anthropic service.' },
    usageBar: {
      available: false,
      reason: 'A Grok CLI session bills against your SuperGrok / X Premium+ plan.',
    },
    compaction: { available: false, reason: "Compaction isn't available on this provider yet." },
  },
};

export function runtimeCapabilities(runtime: AgentRuntime): RuntimeCapabilities {
  return CAPABILITIES[runtime];
}
