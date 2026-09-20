# DESIGN BRIEF — Pi skills and capability states (`pi-skills-capabilities`)

**Goal:** expose the behaviour specified in [the task](../pi-skills-capabilities.md) inside the existing François UI.
**Status:** frozen; validated with the specification on 2026-09-18.
**Design system:** existing UI kit and PIPELINE.md design conventions; English product copy.

## Screens / views

Skills tab/slash menu; existing Agents/MCP/Flows notices; New Session policy. Local desktop user; no server roles.

## States

No skills differs from disabled project resources. Unsupported action shows factual reason. Baseline has extensions disabled and no François tool approval controls.

## Flows

Filter and Enter/Run invoke exact Pi command through composer admission. Disabled tabs/keyboard/palette agree. Show: Pi tools run with your user permissions; François does not approve each tool call.

## Responsive

Native desktop app, minimum 720 px. Keep existing 1120/840 px overflow tiers.
At narrow widths stack modal fields and use the existing overflow menu; no clipped controls.
Keyboard focus and Stop remain reachable. No mobile/web redesign is part of this task.

## Data shown

Skill name/description/invocation/source/scope/loaded; CapabilityState reason; RuntimeResourcePolicy.

## Notes / constraints

Use current flat tonal surfaces: canvas #0a0b0e, chrome #171b22, rails #12161c.
Accent #9cb45f marks the focused live control; attention #d0a45c marks action required.
Use existing typography/tokens, font weight at most 600, existing focus rings.
No new in-flow border/shadow treatment, motion, icon system or remote assets.
Status uses text as well as colour. Preserve reduced-motion and existing theme support.
Reuse the current local design mirrors; no external mockup is required to specify this behaviour.
