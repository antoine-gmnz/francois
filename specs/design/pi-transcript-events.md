# DESIGN BRIEF — Pi transcript and events (`pi-transcript-events`)

**Goal:** expose the behaviour specified in [the task](../pi-transcript-events.md) inside the existing François UI.
**Status:** frozen; validated with the specification on 2026-09-18.
**Design system:** existing UI kit and PIPELINE.md design conventions; English product copy.

## Screens / views

SESSION transcript; tool detail disclosure. Local desktop user; no server roles.

## States

Streaming: text updates without scroll/focus reset. Tool pending/running/succeeded/failed/cancelled/unknown distinct. Interrupted output remains visible. Missing attachment renders a named placeholder.

## Flows

Click or Enter/Space expands tool details; preserve scroll anchor when paging. Render text with existing markdown safety, never raw tool HTML. Queued intent stays in composer strip.

## Responsive

Native desktop app, minimum 720 px. Keep existing 1120/840 px overflow tiers.
At narrow widths stack modal fields and use the existing overflow menu; no clipped controls.
Keyboard focus and Stop remain reachable. No mobile/web redesign is part of this task.

## Data shown

RuntimeToolCall: name, status, inputText, outputText, truncation and timing; message text/outcome; attachment references; notice tone/text.

## Notes / constraints

Use current flat tonal surfaces: canvas #0a0b0e, chrome #171b22, rails #12161c.
Accent #9cb45f marks the focused live control; attention #d0a45c marks action required.
Use existing typography/tokens, font weight at most 600, existing focus rings.
No new in-flow border/shadow treatment, motion, icon system or remote assets.
Status uses text as well as colour. Preserve reduced-motion and existing theme support.
Reuse the current local design mirrors; no external mockup is required to specify this behaviour.
