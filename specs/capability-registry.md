---
id: capability-registry
title: Capability registry & discovery
status: draft
branch:
created: 2026-08-14
depends_on: [multi-provider-seam, multi-provider-openai, skills-panel, mcp-panel, agents-panel, projects, session-engine]
loop_pass: 0
loop_phase:
reviewed_base:
reviewed_digest:
design_files: []
---

# Capability registry & discovery

> **DRAFT — not ready to freeze.** Captured 2026-08-14 from an architecture review against
> `multi-provider-agent-architecture.md`, while the reasoning was fresh and before
> `multi-provider-openai` is built. It is a design record with open questions (§10), not a
> dispatchable spec. Freeze it only after the openai arc lands, when the second runtime is real
> enough to test the abstraction against instead of guessing at it.

## 1. Summary

Francois discovers skills, MCP servers and subagents today — but it discovers them **as Claude
Code's**. `session/skills.rs` walks `.claude/skills`, `~/.claude/skills` and plugin/marketplace
`SKILL.md` files to populate pane [5], and "install" means flipping a plugin on in Claude Code's
`~/.claude/settings.json`. `session/mcp.rs` writes the project's `.mcp.json` and lets Claude Code
own the connection; the panel shows the last runtime status the CLI reported. Both are **control
surfaces for another program's configuration**, not an internal model.

That works while there is one runtime. With a second (`agentRuntime: 'francois'`,
`multi-provider-openai`) it means every capability the user has is reachable from exactly one of
their two sessions, and the arc's central claim — *a capability survives a runtime switch* — has at
most one instance behind it (skill injection, that feature's FR-23).

This feature inverts the dependency. Discovery sources become **adapters that produce internal
records**; a `CapabilityRegistry` owns those records; both runtimes read the registry and each
translates to its own representation. Claude Code stops being where capabilities live and becomes
one consumer of them — and one *source* among several, since its on-disk formats stay the
distribution format we import.

## 2. Goals & non-goals

**Goals**

- A `CapabilityRegistry` holding normalized `Skill`, `AgentDefinition`, `McpServer` and `Tool`
  records, keyed by a stable id, with each record naming its **origin** (which source produced it).
- `DiscoveryManager` with pluggable sources: project `.claude/`, user `~/.claude/`, installed
  plugins, marketplaces, and `.mcp.json`. Adding a source is a new impl, not a new branch in a
  panel command.
- Panes [3]/[4]/[5] read the registry rather than re-walking the filesystem per command — one
  discovery pass, three consumers, no third copy of the plugin-enablement rules.
- Per-runtime **translation**: `ClaudeCodeRuntime` maps a registry record back onto the CLI's own
  mechanism (it mostly already has it); `FrancoisRuntime` injects/connects it directly.
- An explicit **compatibility verdict** per (capability, runtime) pair — `supported` ·
  `partial` · `unsupported` — replacing the hand-maintained `runtimeCapabilities` table with
  something derived from what the registry actually holds.

**Non-goals**

- A proprietary skill/plugin/marketplace **format**. Claude Code's on-disk shapes are the import
  format; we normalize on read and invent nothing the ecosystem does not already publish. A
  Francois-native format is a later decision that this feature must not foreclose — and must not
  make either.
- Writing another runner's configuration. Reading `~/.claude/settings.json` to learn which plugins
  are enabled is discovery; writing it is Claude Code's control surface and stays where it is
  (`multi-provider-openai` FR-26 makes the same cut for skill install).
- An MCP **client** in the Rust core. The registry models MCP servers; connecting to them from the
  Francois runtime is its own feature and the larger half of the work.
- Per-session capability *selection* (the `enabled_skills` / `enabled_agents` / `enabled_mcp` fields
  and their new-session-modal checkboxes). Recorded in §10 as the biggest open question — it is a
  product decision about whether capabilities stay ambient/cwd-scoped or become session state, and
  it should not ride in on a plumbing feature.

## 3. User stories / flows

**Sketch only — this is a draft.**

**One list, two runtimes.** Pane [5] shows the same installed skills whether the focused session is
`claude-code` or `francois`. Where a skill cannot work on the focused runtime, its row carries the
reason; it is not filtered out.

**A capability's origin is legible.** A skill row says where it came from — project, user, or
`<plugin>@<marketplace>` — because when two sources define the same name, the user needs to know
which one won.

**Add a marketplace.** A marketplace URL / git remote is registered once and its plugins' skills,
agents and MCP definitions appear in the registry, marked with that origin.

## 4. Functional requirements

**Sketch only — these are the shape of the work, not frozen text.**

### Core — the registry

- **FR-1** `src-tauri/src/capability/mod.rs` owns the shared model: `CapabilityId`, `Origin`
  (`Project` · `User` · `Plugin { id }` · `Marketplace { id }` · `Builtin`), and the four record
  types. Per PIPELINE §Code layout the model lives in `mod.rs` and each child owns one concern.
- **FR-2** `Skill { id, name, description, instructions, required_tools, origin, metadata }` —
  `instructions` is the `SKILL.md` body, read lazily rather than eagerly (a marketplace can hold
  hundreds; the panel needs only name + description).
- **FR-3** `AgentDefinition { id, name, description, instructions, tools, skills, model_requirement, permissions, origin }`,
  normalized from `.claude/agents/*.md` front-matter.
- **FR-4** `McpServer { id, name, transport, command/url, env, origin }`, normalized from
  `.mcp.json` and from plugins' bundled `.mcp.json`.
- **FR-5** Precedence when two sources define one name: **project > user > plugin > marketplace**,
  matching what Claude Code itself resolves, so the registry never disagrees with the CLI about
  which skill a `claude-code` session will actually load. The losing record is retained and
  reachable, not dropped — the UI shows the shadowing.
- **FR-6** The registry is rebuilt per `cwd`, cached, and invalidated on project switch and on the
  panel's existing refetch points. **No filesystem watcher** — `skills-panel` and `mcp-panel`
  already state "effects apply on the next turn", and a watcher would be a new failure mode for a
  freshness guarantee nothing asked for.

### Core — discovery

- **FR-7** `DiscoveryManager` fans out over `trait DiscoverySource { fn discover(&self, ctx) -> Vec<Record> }`.
  Sources: `ProjectSource`, `UserSource`, `PluginSource`, `MarketplaceSource`, `McpJsonSource`.
- **FR-8** Every existing walk in `session/skills.rs` and `session/mcp.rs` **moves** into a source
  and is deleted from its old home — the acceptance test is that neither file walks the filesystem
  any more, so no second copy of the plugin-enablement rules can drift.
- **FR-9** A source that fails (unreadable dir, malformed front-matter, unreachable marketplace)
  contributes nothing and does not fail the pass; the failure is surfaced per-source in the panel,
  never as an empty list with no explanation.

### Core — runtime translation

- **FR-10** `trait CapabilityTranslator` per runtime: given a registry record and a session, produce
  the runtime's representation. `claude-code` largely returns "already handled by the CLI" — the
  point is that this is *stated* rather than implicit.
- **FR-11** `francois` translates: `Skill` → system-prompt injection (`multi-provider-openai`
  FR-23..FR-27, which this feature absorbs and generalizes), `AgentDefinition` → a nested loop with
  its own instructions and tool subset, `McpServer` → an MCP client connection.
- **FR-12** `compatibility(capability, runtime) -> Verdict` (`supported` · `partial { note }` ·
  `unsupported { reason }`), and `runtimeCapabilities` (seam FR-14a) is **derived from it** rather
  than hand-maintained. Deriving is the point: a hand-written table drifts from what the code can
  actually do, and the seam's table already needed one rewording pass (seam FR-15, 2026-08-14).

## 5. API contract

Undecided. The panels' existing channels (`francois:skills:*`, `francois:mcp:*`, `francois:agents:*`)
are the natural carriers and should be **re-keyed in place** per the 2026-08-04 `api` decision rather
than joined by a `francois:capability:*` domain — unless §10's per-session-selection question
resolves toward session state, which would justify its own domain. Decide after §10.

## 6. Data & state

No new persisted state in the registry itself: it is a **cache over what is already on disk**, and
the on-disk formats stay Claude Code's. Marketplace registration is the one candidate for new
persistence, and only if marketplaces beyond `~/.claude/plugins/marketplaces` are in scope.

## 7. Edge cases & errors

Undecided. Known ones to answer at freeze: a plugin enabled in `settings.json` whose directory is
gone; two marketplaces publishing the same plugin id; a `SKILL.md` with no front-matter; a skill
whose `required_tools` name a tool no runtime provides.

## 8. Design brief

No new screen. The panes exist; they gain an origin affordance and a per-row reason line where a
capability cannot work on the focused runtime. Acid stays the one live thing per view; origin chips
are neutral, reasons are dim — the same treatment `multi-provider-endpoint` set for the kind chip.

## 9. Acceptance criteria

Not written — see the draft banner.

## 10. Open questions (resolve before freezing)

1. **Per-session capability selection.** Does a session carry `enabled_skills` / `enabled_agents` /
   `enabled_mcp` (the architecture doc's §9 and its §27 new-session checkboxes), or do capabilities
   stay ambient and cwd-scoped as they are today? This is the single biggest fork. Ambient is what
   Claude Code does and what every current pane assumes; explicit is more controllable and is what
   makes "the same capability config, a different runtime" demonstrable as a *user* action rather
   than a claim. It changes `SessionMeta`, the new-session modal, `projects` defaults, and §5's
   domain question.
2. **Lazy vs eager instruction bodies.** FR-2 says lazy. If per-session selection lands, the
   selected set is small and eager is simpler. Decide after (1).
3. **Does `ClaudeCodeRuntime` consume the registry at all**, or only publish into it? Today the CLI
   re-reads the same files itself, so a registry record is descriptive, not authoritative — the
   translator (FR-10) would be a no-op that exists for symmetry. Symmetry that does nothing is
   worth questioning; the alternative is admitting the registry is *the Francois runtime's* model
   plus a read-only view for the panels, which is smaller and more honest.
4. **Marketplace scope.** Import-only from Claude Code's existing marketplace layout, or first-class
   registration of arbitrary git/URL sources? The doc's §17 says do not invent a format — it does
   not say how many sources to support.
5. **Where MCP connection lives.** The Francois runtime needs an MCP client. In this feature, or
   split out? Leaning split — it is the larger half and has nothing to do with normalization.

## Remediation

(Empty — never reviewed; this is a draft.)
