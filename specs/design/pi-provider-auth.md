# DESIGN BRIEF — Pi accounts and provider authentication (`pi-provider-auth`)

**Goal:** expose the behaviour specified in [the task](../pi-provider-auth.md) inside the existing François UI.
**Status:** frozen; validated with the specification on 2026-09-18.
**Design system:** existing UI kit and PIPELINE.md design conventions; English product copy.

## Screens / views

Accounts modal Pi tile/detail; embedded Pi setup terminal. Local desktop user; no server roles.

## States

Untrusted configuration: explain consent. Configured is not verified. Failed auth offers Open Pi setup then Refresh. Local providers do not demand OAuth. Removing an in-use account explains why it is blocked.

## Flows

Use the existing account/login PTY flow. Copy states that setup is Pi-owned. Disconnect removes the François reference; provider logout is a separate action. No terminal output is saved.

## Responsive

Native desktop app, minimum 720 px. Keep existing 1120/840 px overflow tiers.
At narrow widths stack modal fields and use the existing overflow menu; no clipped controls.
Keyboard focus and Stop remain reachable. No mobile/web redesign is part of this task.

## Data shown

Account label/config directory/environment/trust; provider auth observation state/time; no key values.

## Notes / constraints

Use current flat tonal surfaces: canvas #0a0b0e, chrome #171b22, rails #12161c.
Accent #9cb45f marks the focused live control; attention #d0a45c marks action required.
Use existing typography/tokens, font weight at most 600, existing focus rings.
No new in-flow border/shadow treatment, motion, icon system or remote assets.
Status uses text as well as colour. Preserve reduced-motion and existing theme support.
Reuse the current local design mirrors; no external mockup is required to specify this behaviour.
