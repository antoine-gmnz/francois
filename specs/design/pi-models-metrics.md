# DESIGN BRIEF — Pi models and usage (`pi-models-metrics`)

**Goal:** expose the behaviour specified in [the task](../pi-models-metrics.md) inside the existing François UI.
**Status:** frozen; validated with the specification on 2026-09-18.
**Design system:** existing UI kit and PIPELINE.md design conventions; English product copy.

## Screens / views

New Session model field; run-chip model picker; context details. Local desktop user; no server roles.

## States

Loading/empty/stale/error catalogue; saved unavailable model remains disabled. Busy session explains idle-only switching. Unknown metrics use an em dash; estimated cost says Estimated, never Plan quota.

## Flows

Search provider and model labels; arrow keys move, Enter selects, Escape closes. Favorites/recents are preferences. Refresh is explicit. Keep Stop reachable at all widths.

## Responsive

Native desktop app, minimum 720 px. Keep existing 1120/840 px overflow tiers.
At narrow widths stack modal fields and use the existing overflow menu; no clipped controls.
Keyboard focus and Stop remain reachable. No mobile/web redesign is part of this task.

## Data shown

RuntimeModelDescriptor provider/model/displayName/context/input/auth/availability; RuntimeMetrics counts/context/cost/basis/stale.

## Notes / constraints

Use current flat tonal surfaces: canvas #0a0b0e, chrome #171b22, rails #12161c.
Accent #9cb45f marks the focused live control; attention #d0a45c marks action required.
Use existing typography/tokens, font weight at most 600, existing focus rings.
No new in-flow border/shadow treatment, motion, icon system or remote assets.
Status uses text as well as colour. Preserve reduced-motion and existing theme support.
Reuse the current local design mirrors; no external mockup is required to specify this behaviour.
