---
id: <feature-id>
title: <Feature title>
status: draft            # draft → frozen → in-progress → in-review → shipped · blocked (see SCHEMA.md §Spec status)
branch: feat/<feature-id>
created: <YYYY-MM-DD>
depends_on: []           # feature ids this spec builds on
reviewed_base:           # merge-base sha at the last SHIP verdict — freshness-gate anchor (written by /cohorte-review)
reviewed_digest:         # sha256 (16 hex) of the reviewed source diff vs reviewed_base, specs excluded — /cohorte-ship re-checks
design_files: []         # design page links — full URLs https://claude.ai/design/p/<projectId>?file=<file>; blank until designed; omit if no UI
---

# <Feature title>

## 1. Summary

One paragraph: what this feature is and why it exists.

## 2. Goals & non-goals

- **Goals**: bullet list.
- **Non-goals**: what is explicitly out of scope for this feature (and where it lives instead, if known).

## 3. User stories / flows

Concrete flows, step by step, from the user's point of view. Include keyboard and mouse paths.

## 4. Functional requirements

Numbered `FR-1`, `FR-2`, … Each requirement testable and unambiguous.

## 5. API contract

The exact interface that will live in `contract/<id>.ts` (mechanism: canonical TypeScript payload types mirrored by serde structs in the Rust core, bound to Tauri commands/events — see PIPELINE.md). Must include:

- Every IPC channel: name (`francois:<domain>:<verb>`), direction, payload type, `Result<T>` data shape, and every error code it can return.
- Every event this feature emits or consumes (tagged-union member names).
- Exact TypeScript type definitions (import shared types from `contract/common.ts`; never redefine them).

Frontend and backend must each be able to build from this section with zero further questions.

## 6. Data & state

State owned by this feature (Rust core and frontend), persistence (if any), and derived state.

## 7. Edge cases & errors

Enumerate failure modes and the exact behavior for each (UI state + error code).

## 8. Design brief

Self-contained brief for the design step (see `.claude/templates/design-brief.md`): screens, components with their states, exact tokens/colors/glyphs from the mock, interactions, motion, responsive/resize behavior. Reference `Claude Terminal.dc.html` regions.

## 9. Acceptance criteria

Checkbox list; each maps to one or more FRs and is verifiable by a human or an e2e test.

## Remediation

(Empty until a review returns findings.)
