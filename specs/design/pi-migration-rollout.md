# DESIGN BRIEF — Pi profiles and migration (`pi-migration-rollout`)

**Goal:** expose the behaviour specified in [the task](../pi-migration-rollout.md) inside the existing François UI.
**Status:** frozen; validated with the specification on 2026-09-18.
**Design system:** existing UI kit and PIPELINE.md design conventions; English product copy.

## Screens / views

Profiles modal; Create Pi copy review; New Session profile field. Local desktop user; no server roles.

## States

Legacy profiles remain editable under their existing schema. Pi mismatches offer Create Pi copy. Missing paths/invalid tools show field errors. Migration failure preserves original data and shows Pi unavailable.

## Flows

Tab/keyboard navigation follows existing modal. Copy produces a new profile after review; it does not modify the source. Model/account defaults remain project settings. Tool selection never implies a sandbox.

## Responsive

Native desktop app, minimum 720 px. Keep existing 1120/840 px overflow tiers.
At narrow widths stack modal fields and use the existing overflow menu; no clipped controls.
Keyboard focus and Stop remain reachable. No mobile/web redesign is part of this task.

## Data shown

Profile kind/name; PiProfileSettings prompt mode/text/paths/tools/project resources; omitted legacy args in copy review.

## Notes / constraints

Use current flat tonal surfaces: canvas #0a0b0e, chrome #171b22, rails #12161c.
Accent #9cb45f marks the focused live control; attention #d0a45c marks action required.
Use existing typography/tokens, font weight at most 600, existing focus rings.
No new in-flow border/shadow treatment, motion, icon system or remote assets.
Status uses text as well as colour. Preserve reduced-motion and existing theme support.
Reuse the current local design mirrors; no external mockup is required to specify this behaviour.
