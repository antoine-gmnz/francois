# DESIGN BRIEF — Pi session recovery (`pi-session-durability`)

**Goal:** expose the behaviour specified in [the task](../pi-session-durability.md) inside the existing François UI.
**Status:** frozen; validated with the specification on 2026-09-18.
**Design system:** existing UI kit and PIPELINE.md design conventions; English product copy.

## Screens / views

SESSION recovery banner and pending draft strip. Local desktop user; no server roles.

## States

Disconnected: readable history, reconnect on send. Missing/corrupt/incompatible/account-missing: one cause plus Retry or Create new session. Recovery progress disables duplicate actions.

## Flows

Retry reconnects the same session; Create new session creates a distinct ID and sends nothing. Preserve draft text; never label an unknown delivery as unsent without evidence.

## Responsive

Native desktop app, minimum 720 px. Keep existing 1120/840 px overflow tiers.
At narrow widths stack modal fields and use the existing overflow menu; no clipped controls.
Keyboard focus and Stop remain reachable. No mobile/web redesign is part of this task.

## Data shown

RuntimeRecovery state/message/lastVerifiedAt; last rendered history; unsent or delivery-unknown draft text.

## Notes / constraints

Use current flat tonal surfaces: canvas #0a0b0e, chrome #171b22, rails #12161c.
Accent #9cb45f marks the focused live control; attention #d0a45c marks action required.
Use existing typography/tokens, font weight at most 600, existing focus rings.
No new in-flow border/shadow treatment, motion, icon system or remote assets.
Status uses text as well as colour. Preserve reduced-motion and existing theme support.
Reuse the current local design mirrors; no external mockup is required to specify this behaviour.
