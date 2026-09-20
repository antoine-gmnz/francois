# DESIGN BRIEF — Pi message delivery and controls (`pi-turn-controls`)

**Goal:** expose the behaviour specified in [the task](../pi-turn-controls.md) inside the existing François UI.
**Status:** frozen; validated with the specification on 2026-09-18.
**Design system:** existing UI kit and PIPELINE.md design conventions; English product copy.

## Screens / views

Composer mode selector; queue strip; Stop; compact action. Local desktop user; no server roles.

## States

Idle normal send; busy steer/follow-up choices; admitting/queued/consumed/cancelled/unknown/rejected states. Stopping locks admission. Compaction shows progress and retains errors/history.

## Flows

Enter uses selected mode; Alt+Enter sends follow-up. Shortcuts apply only to composer, not PTY. Individual removal is only for locally unsent intent; Clear queued messages handles Pi-owned pending entries. Stop remains visible until confirmed.

## Responsive

Native desktop app, minimum 720 px. Keep existing 1120/840 px overflow tiers.
At narrow widths stack modal fields and use the existing overflow menu; no clipped controls.
Keyboard focus and Stop remain reachable. No mobile/web redesign is part of this task.

## Data shown

DeliveryMode, RuntimeQueueEntry receipt/text/state/position; compaction and retry state.

## Notes / constraints

Use current flat tonal surfaces: canvas #0a0b0e, chrome #171b22, rails #12161c.
Accent #9cb45f marks the focused live control; attention #d0a45c marks action required.
Use existing typography/tokens, font weight at most 600, existing focus rings.
No new in-flow border/shadow treatment, motion, icon system or remote assets.
Status uses text as well as colour. Preserve reduced-motion and existing theme support.
Reuse the current local design mirrors; no external mockup is required to specify this behaviour.
