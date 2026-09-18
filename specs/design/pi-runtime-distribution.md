# DESIGN BRIEF — Pi installation and compatibility (`pi-runtime-distribution`)

**Goal:** expose the behaviour specified in [the task](../pi-runtime-distribution.md) inside the existing François UI.
**Status:** frozen; validated with the specification on 2026-09-18.
**Design system:** existing UI kit and PIPELINE.md design conventions; English product copy.

## Screens / views

Accounts → Pi setup. Local desktop user; no server roles.

## States

Missing: Copy installation command + Retry. Incompatible: detected/certified versions. Probe failure: inline error + Retry. Ready: path and version, with unverified provenance if applicable.

## Flows

Tab to Copy/Retry; Enter activates. Copy does not execute the command. Authentication state is separate from installation.

## Responsive

Native desktop app, minimum 720 px. Keep existing 1120/840 px overflow tiers.
At narrow widths stack modal fields and use the existing overflow menu; no clipped controls.
Keyboard focus and Stop remain reachable. No mobile/web redesign is part of this task.

## Data shown

RuntimeInstallStatus: state, detectedVersion, supportedVersions, executablePath, nodeVersion, provenance, checkedAt.

## Notes / constraints

Use current flat tonal surfaces: canvas #0a0b0e, chrome #171b22, rails #12161c.
Accent #9cb45f marks the focused live control; attention #d0a45c marks action required.
Use existing typography/tokens, font weight at most 600, existing focus rings.
No new in-flow border/shadow treatment, motion, icon system or remote assets.
Status uses text as well as colour. Preserve reduced-motion and existing theme support.
Reuse the current local design mirrors; no external mockup is required to specify this behaviour.
