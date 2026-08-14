# DESIGN BRIEF — OpenAI-compatible sessions (`multi-provider-openai`)

> The "spec return". Paste into the design tool (see `PIPELINE.md` §design). This is §8 of
> `specs/multi-provider-openai.md`, standalone.

**Goal:** Run a session on an OpenAI-compatible endpoint that reads as an ordinary Francois session —
same transcript, same approval cards — while the panes that genuinely cannot work say why instead of
sitting empty.

**Design system:** use the existing UI kit (`src/ui/`, tokens in `src/styles.css`). Visual source of
truth: `Francois Redesign.dc.html` + `Francois Design System v2.dc.html`. Native desktop terminal app —
JetBrains Mono, dense, keyboard-first. **There is no new screen in this feature.** Everything lands
inside chrome that already exists.

**Two rules this brief exists to hold:**

1. *Provider is metadata, not identity.* No vendor colour, no logo, no second species of session card.
   A GPT session and a Claude session are visually the same object. Acid `#c3f53f` is not spent on
   provider anywhere.
2. *A pane that cannot work must say why.* Never an empty box, never a disabled-looking control with
   no explanation, never a silently missing pane.

## Screens / views

### 1. Disabled pane treatment (the primary new surface)

One treatment, applied identically to panes [3] `agents`, [4] `mcp`, [5] `skills`, [6] `workflows`,
the usage bar, and the slash menu. Consistency is the point: the user learns it once.

- Elements
  - The pane's **normal frame and header, unchanged** — same title, same collapse affordance
    (`collapse-right-column` keeps working).
  - In place of the pane's content: **one dim line**, left-aligned, vertically centred in the content
    area, wrapping to at most two lines. The text is the `reason` string verbatim from
    `providerCapabilities()` — e.g. *"Subagents aren't available on this provider yet."*
  - No icon, no illustration, no button, no link. This is a statement, not a call to action.
- States
  - **Off** — the dim line. The pane header does *not* dim: the pane is a real pane, just empty of
    things this provider can do.
  - **On** — the pane's existing content, untouched.
  - **Collapsed** — the existing collapsed treatment wins; the reason is not shown in the collapsed
    rail.
- Deliberately **not** an `EmptyPane` variant if that primitive implies "nothing here yet, something
  may arrive" — this is permanent for the session. Reuse it only if its copy slot and tone fit;
  otherwise extend it rather than building a parallel component.

### 2. Usage bar — off state

The bar sits under the system title bar and is app-scoped, but plan meters are meaningless here.

- When the focused session's provider has `usageBar: false`: the bar's **meters** are replaced by the
  reason line *"This provider bills per token, not against a plan."* at dim, in the bar's existing
  height. The bar does not collapse, and the layout above/below must not shift when focus moves
  between a Claude session and an endpoint session — that shift is the bug to avoid.

### 3. SESSION tab — first-turn notice

- The existing **dim `notice` card** (`CommandCard { kind: 'notice' }`), rendered exactly as an
  unknown-command or model-switch-ack notice already renders. Text: *"Francois runs its own agent
  loop on this provider — tool use and formatting differ from Claude Code."*
- Position: the first block of the transcript, above the first user message. Once per session, then
  it scrolls away with everything else. It is **not** sticky, not dismissible, and not a banner.

### 4. Approval cards — unchanged, and that is the requirement

The permission card for a Francois-loop tool call must be **indistinguishable** from a Claude Code
one: same layout, same four actions, same tool name (`Bash`, `Edit`, …), same pattern label. No
provider marker anywhere on the card. If a reviewer can tell which adapter produced a card by looking
at it, that is a bug.

### 5. Model picker — provider grouping

- Elements: a **neutral group heading** per provider (dim, small-caps or the existing section-label
  treatment), models listed under it as they are today.
- The session's own provider's group is listed; models from other providers are **not** offered as
  switch targets in v1.
- The heading is text only — no chip, no accent, no icon.

### 6. Account pickers — block removed

The disabled endpoint row from `multi-provider-endpoint` §3 is **deleted**. Endpoint rows become
ordinary, fully selectable, keyboard-reachable rows with no reason line.

## Flows

1. New Session modal → pick an endpoint account (now selectable) → create → SESSION tab opens.
2. First turn: the dim notice card, then assistant text streams in — identical rendering to a Claude
   session.
3. The model asks for `Bash(npm test)` → the ordinary approval card → *Allow once* → the tool runs,
   the transcript shows the ordinary tool block → the loop continues.
4. The user glances right: pane [3] reads *"Subagents aren't available on this provider yet."*, pane
   [4] its own reason, and so on — four panes, one treatment.
5. Quit and reopen → the transcript is there, the next turn continues the thread.

## Resize behaviour

Desktop-only; no mobile breakpoint. The reason line wraps to at most two lines and then
middle-truncates with a `title` tooltip carrying the full sentence. In a two-pane split, both panes'
right columns render their own session's capability state independently — a Claude session and an
endpoint session side by side must each show their own truth, which is the layout worth testing.

## Data shown

Matches `specs/multi-provider-openai.md` §5: `SessionMeta.provider`,
`providerCapabilities(provider)[capability].available` and `.reason`, `ModelInfo` (`id`, `label`,
`contextTokens`), and the existing `PermissionAsk` fields on cards. `contextUsedTokens` /
`contextLimitTokens` render in the existing context meter with no change — the limit may be a
fallback estimate, and the UI does not mark it as such.

## Notes / constraints

- **Copy is English**, sentence case. The reason strings are **owned by the contract**
  (`contract/multi-provider-seam.ts`), not by the components — a component must never hard-code or
  reword one, and a copy change happens in the table.
- **Accessibility:** the reason line is ordinary readable text inside the pane, not `aria-hidden`
  decoration; panes keep their existing headings and landmark structure so the pane list still
  navigates.
- **No component branches on `provider`** — the capability table is the only input. A design that
  needs a provider check is a design that needs a new capability member.
- **No inline `style={{}}`**; BEM-lite classes in each feature's own stylesheet.
- Icons `lucide-react` by name, `currentColor` only.
