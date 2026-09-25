---
id: cohorte-actions
feature_id: cohorte-actions
title: Cohorte actions — drive the pipeline from Francois
status: frozen
branch: feat/add-cohorte-actions
created: 2026-09-24
depends_on: [cohorte-integration, multiple-shells, shell-terminal, command-palette, conversation-view, slash-menu]
contract: contract/cohorte-actions.ts
reviewed_base:
reviewed_digest:
design_files:
  - "Figma YEY4c6AiWq1bKYuaju9qdV — 35 Actions menu `217:20049` (L35 `219:29443`), 36 Action sheet · Intake `217:20118` (L36 `219:29593`), 37 Pipeline in the panel `217:20187` (L37 `219:29740`), note `219:31149`"
---

# Cohorte actions — drive the pipeline from Francois

## 1. Summary

`cohorte-integration` lets Francois *observe* Cohorte runs and answer their gates, but every step
that moves a feature forward — intake, brainstorm, spec, start, patch, fleet, audit, retro — is a
CLI verb. A Claude session can't reach them from a prompt. This feature adds one **Cohorte actions
menu** (composer chip, `/cohorte`, `⌘⇧C`, palette), a **form sheet** per action that shows the
exact command before it runs, an inline **result card** in the session, and a **Pipeline** view in
the session panel's Cohorte tab (one card per feature, one next action per card).

The Python Cohorte CLI (`cohorte 1.0.0a3`, the `cohorte/1` service already used by
`python_service.rs`) was checked verb by verb. The verbs split three ways, and each group gets its
own execution path:

| Verb | CLI reality (verified 2026-09-24) | Francois runs it as |
|---|---|---|
| `intake` | `cohorte --json intake --text|--file|--url --title` → `{ok,data:{feature_id,report:{triage,reasons,questions,…}}}`, sub-second, no model call | **core, argv, JSON** (FR-10) |
| `brainstorm` | JSON mode needs `--feature-id --idea` + ≥1 `--answer`; otherwise "run in a terminal for guided mode" | **terminal tab** (FR-20) |
| `spec` | "spec is interactive; use spec-freeze-request for JSON" | **terminal tab** (FR-20) |
| start run | CLI `start` is interactive; the service's `runs.start` is not (already wrapped by `cohorte_v3_start`) | **existing `cohorte_v3_start`** (FR-25) |
| `patch`, `fleet`, `audit`, `retro` | require `--profile --worktrees --run-id --output …` plumbing | **terminal tab, command typed, not executed** (FR-21) |

Amends `cohorte-integration` §2.2 "No new-run UI": Francois may now start runs and pipeline steps,
still only through the CLI or the `cohorte/1` service — it never writes `.cohorte/` itself.

## 2. Goals & non-goals

- **Goals**
  - One menu reaching every pipeline verb, grouped by stage, with context-aware suggestions first.
  - Intake from a form (text, file or URL), result shown inline, next step one click away.
  - Guided verbs (brainstorm, spec) launch in a session terminal tab, running the real interactive CLI.
  - A Pipeline view listing the project's features with a stage track and exactly one next action.
- **Non-goals**
  - Re-implementing guided brainstorm/spec dialogs in the UI (the CLI's terminal mode owns them).
  - Building forms for `patch`/`fleet`/`audit`/`retro` plumbing args (terminal prefill only).
  - Persisting result cards across restarts (they are session-local and in memory).
  - Any new `cohorte/1` RPC method; any direct write to `.cohorte/`.

## 3. User stories / flows

1. **Open the menu.** In a session whose cwd is inside a detected Cohorte project, the composer shows
   a **Cohorte** chip (Icon/cohorte + `⌘⇧C`). Clicking it, pressing `⌘⇧C` (Ctrl+Shift+C on
   Windows/Linux), or typing `/cohorte` as the whole composer text opens the actions popover above
   the composer. `↑/↓` move, `⏎` opens the highlighted action, `Esc` closes. Clicking outside closes it.
2. **Intake.** Pick *Intake* → sheet opens. Source segmented `Text | File | URL` (Text prefilled
   from the composer draft if the draft is non-empty and is not `/cohorte…`), Title, the source
   field, and a live **Command** preview. `⌘⏎`/**Run intake** runs it; the sheet shows busy; on
   success it closes, the composer draft is cleared if it was used, and a result card appears at the
   bottom of the session transcript: triage, feature id, reasons/questions, and buttons
   **Brainstorm** (primary), **Write spec**, **Dismiss**.
3. **Brainstorm / Write spec.** Pick either from the menu, a result card, or a Pipeline card → a
   small sheet with a feature select (brainstorm also allows "New idea") and the command preview →
   **Open in terminal** creates a new shell tab in the session, switches the main pane to SHELL,
   and runs the command. The user completes the guided flow in the terminal.
4. **Start run.** Pick *Start run* (or a Pipeline card's **Start run**) → sheet with a feature
   select → **Start run** calls `cohorte_v3_start`, then opens the run view (`cohorte:<runId>`).
5. **Plumbing verbs.** Pick *Patch*, *Fleet*, *Audit* or *Retro* → a new shell tab opens with
   `cohorte <verb> ` typed at the prompt, **not** executed, plus a toast "Complete the arguments,
   then press Enter — `cohorte <verb> --help` lists them".
6. **Pipeline view.** The Cohorte tab in the session panel gets a `This run | Pipeline` toggle.
   With no linked run the tab opens on Pipeline. Each feature card shows its id, a stage label,
   a six-segment track, a one-line status, and one next-action button.

## 4. Functional requirements

### 4.1 Core — `[core]`

- **FR-1** New module `src-tauri/src/cohorte/actions_cli.rs` (the existing `actions.rs` is the gate
  module — do not grow it). It owns argv building (pure, unit-tested) and the intake command.
- **FR-2** Executable: the same resolution as `python_rpc::cli()` (`COHORTE_PYTHON_CLI` env or
  `cohorte`), spawned through `process_util` (login-shell PATH). When `COHORTE_PYTHON_DATA_DIR` is
  set, pass `--data-dir <dir>` exactly as `service_endpoint()` does. `cwd` = the request's `root`.
- **FR-10** `cohorte_action_intake(req: CohorteIntakeRequest) -> Result<CohorteIntakeResult>`.
  argv = `[--data-dir D]? --json intake <source flag> <value> --title <title>`, where the source flag
  is `--text`, `--file` or `--url`. No shell is involved (argv array).
  - Validation before spawn, all returning `INVALID_INPUT`:
    title trimmed 1–200 chars; text trimmed 1–24 000 chars (Windows command-line cap — the error
    message says "Text is too long for the command line — save it to a file and use File"); file
    path absolute, exists, is a regular file; URL starts with `http://` or `https://`, ≤ 2 000 chars.
  - Timeout 30 s (`COHORTE_TIMEOUT`), stdout cap 4 MiB (`COHORTE_OUTPUT_CAPPED`).
  - stdout parsed as `{ok, data | error}`. `ok:false` → `COHORTE_REJECTED` with
    `message = error.message`, `detail = { cohorteCode: error.code }`. Unparseable →
    `COHORTE_OUTPUT_INVALID`. Spawn failure (not found) → `COHORTE_CLI_MISSING`.
  - Success maps `data.feature_id`, `data.report.{title,triage,reasons,questions}` into
    `CohorteIntakeResult`, plus `command` (the display string, FR-3) and `durationMs`.
- **FR-3** `display` string = `cohorte ` + args joined by spaces, each arg containing whitespace or
  quotes rendered in double quotes; `--text` values longer than 60 chars render as
  `<text, N lines>`. `--data-dir` and `--json` are omitted from the display. Same function backs
  `cohorte_action_preview` (FR-4) so the sheet preview and the executed argv can't drift.
- **FR-4** `cohorte_action_preview(req: CohorteIntakeRequest) -> Result<CohorteCommandPreview>`
  returns `{ command }` without spawning (validation errors still returned). The frontend may
  instead mirror FR-3 in TS; if it does, the TS function carries the same unit tests as the Rust one.
- **FR-5** `cohorte_v3_features` gains `kind` on each `FeatureChoice` (from the service's
  `features.list` item `kind`, default `"unknown"`), plus `updatedAt` (epoch ms, from `updated_at`,
  0 when missing). Existing callers are unaffected (additive fields).
- **FR-6** Register the new commands in `main.rs` next to the other `cohorte_v3_*` commands.

### 4.2 Frontend — `[front]`

**Menu (frame 35)**
- **FR-30** New `src/features/cohorte/actions-menu.ts` (pure): builds the menu model from
  `{ detection, linkedRun, features }`: groups **Capture** (Intake, Brainstorm), **Spec** (Write spec),
  **Run** (Start run, Patch, Fleet), **Improve** (Audit, Retro). Each item: `id`, `label`,
  `description`, `command` hint (e.g. `cohorte intake`), `kind: 'sheet' | 'terminal-prefill'`.
- **FR-31** Suggestions (top group "Suggested for this session", max 2, in this order):
  (a) linked run has a pending gate with an `approve` action → "Approve & ship <specId>", command
  hint = the gate's existing CLI hint, runs `answerGate(run, 'approve')` directly (attention tone);
  (b) the most recently updated feature with a frozen status (`frozen`, `ready`, `approved`) and no
  run in the store for it (`run.specId === feature.id`) → "Start run · <id>";
  (c) the most recently updated `draft` feature → "Brainstorm · <id>". Unit-tested.
- **FR-32** `CohorteActionsMenu.tsx` renders the popover above the composer (anchored, full
  composer width minus nothing — max 580px), head row (Icon/cohorte, "Cohorte", project name,
  health dot + version from the detection), groups, footer hints (`↑↓ navigate`, `⏎ open`,
  `Esc close`) and the line "runs the CLI · not a Claude turn". Keyboard per flow 1; the list wraps.
- **FR-33** Entry points: the composer chip (only when the session's cwd has a Cohorte detection),
  `⌘⇧C`/`Ctrl+Shift+C` while the session view has focus (not in the terminal), the composer text
  being exactly `/cohorte` followed by `⏎` or by the slash-menu selecting a `/cohorte` entry (add a
  Francois-local `/cohorte` entry to the slash menu registry when a detection exists), and a palette
  command "Cohorte: Actions…".

**Sheets (frame 36)**
- **FR-40** `CohorteActionSheet.tsx` — one modal (reuse `src/ui/Modal`) with a stage strip
  (`Intake › Brainstorm › Spec › Freeze › Run › Ship`, current stage highlighted), fields, a
  **Command** block (mono, `--bg-terminal`) and a footer (`Cancel Esc`, primary action `⌘⏎`).
- **FR-41** Intake sheet: fields per flow 2; the command block updates as fields change (FR-3
  mirrored). Primary disabled while invalid or busy. Errors render inline under the fields
  (`role="alert"`), the sheet stays open.
- **FR-42** Brainstorm sheet: feature select (features whose status is `draft`, newest first) plus a
  "New idea (guided)" option; command `cohorte brainstorm --feature-id <id>` or `cohorte brainstorm`.
  Write-spec sheet: feature select (all non-frozen features); command `cohorte spec <id>`.
  Start-run sheet: frozen features; primary "Start run".
- **FR-43** Feature ids interpolated into a terminal line must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`;
  otherwise the action is disabled with the note "This feature id can't be passed to a shell safely".
  No free text is ever written to a terminal.

**Terminal actions**
- **FR-20** `openCohorteTerminal(sessionId, line, { execute })` in `src/features/cohorte/terminal.ts`:
  creates a session shell via the existing `shellCreate({kind:'session', sessionId})` path used by
  `shellActions.ts` (reuse its helper; do not duplicate tab bookkeeping), names it `cohorte <verb>`
  via `shellRename`, switches the main pane to SHELL on that shell, then `shellWrite(shellId, line + (execute ? '\r' : ''))`.
- **FR-21** Patch/Fleet/Audit/Retro call FR-20 with `execute: false` and line `cohorte <verb> `, then
  toast per flow 5.

**Result card**
- **FR-50** `cohorteActionsStore` (zustand, in `src/lib/`), in memory only: results keyed by
  sessionId, max 5 per session, newest last. Entry: `{ id, verb:'intake', at, result }`.
- **FR-51** `CohorteActionResultCard.tsx` renders below the transcript (same mount point pattern as
  `CohorteInlineGate` in `ConversationView.tsx`): success tint (`--tint-success` fill,
  `--tint-success-line` border), head "COHORTE · INTAKE" + `exit 0 · 1.8s`, title
  "Brief stored as <featureId>", rows `triage`, `reasons`/`questions` (bulleted), `next` (command hint),
  buttons **Brainstorm** `1` (primary), **Write spec** `2`, **Dismiss** `3`. Digit keys only when no
  editable element has focus (reuse the gate-keys guard).

**Pipeline view (frame 37)**
- **FR-60** In `CohortePanelSection.tsx`, a `This run | Pipeline` segmented toggle; default Pipeline
  when there's no linked run, This run otherwise. The existing NoRun feature-select start UI is
  replaced by the Pipeline view.
- **FR-61** `pipeline.ts` (pure, unit-tested) derives cards from `features` + `runs`:
  stage index 0..5 and label:
  - a run with `specId === feature.id` exists (latest by `startedAt`): pending gate → stage 4 "run · gate"
    (attention), running/paused → 4 "run", completed/shipped → 5 "shipped" (success), failed/cancelled → 4 "run · failed" (danger);
  - else status `frozen|ready|approved` → 3 "frozen"; `draft` with kind `patch` → 2 "spec · draft";
    other `draft` → 0 "intake"; anything else → 2 + the raw status.
  Next action: gate → **Answer gate** (opens the run view); running → **Open run**; shipped/failed →
  **Open run** (ghost); frozen → **Start run**; draft (not patch) → **Brainstorm**; draft patch →
  **Write spec**. Order: gate first, then running, then by `updatedAt` desc; shipped last.
- **FR-62** Card layout per frame 37: mono id, stage label right, 6-segment track (done =
  `--state-success` at 60%, current = stage colour, future = `--line-default`), status line, button.
  A feature created by intake in this app session shows a `NEW` tag until the app restarts.
- **FR-63** A **Project** block below the list: *Audit* and *Retro* rows with a ghost **Run** button
  (FR-21). The footer shows `Cohorte <version> · healthy|<issue>`, **New feature…** (opens the
  Intake sheet) and **All actions** (opens the menu).
- **FR-64** Features are refetched via `cohorteFeatures(root)` when the tab mounts, after any action
  succeeds, and whenever a run for that root is upserted in the store (debounced 1 s).

## 5. API contract — `contract/cohorte-actions.ts`

```ts
import type { Result } from './common';

/** francois:cohorte:actionIntake → Tauri `cohorte_action_intake` */
export type CohorteIntakeSource =
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string };

export interface CohorteIntakeRequest {
  root: string;              // detected project root (cwd for the spawn)
  title: string;
  source: CohorteIntakeSource;
}

export type CohorteIntakeTriage = 'patch' | 'feature' | 'questions';

export interface CohorteIntakeResult {
  featureId: string;
  title: string;
  triage: CohorteIntakeTriage | string; // forward-compatible
  reasons: string[];
  questions: string[];
  command: string;           // FR-3 display string
  durationMs: number;
}

/** francois:cohorte:actionPreview → Tauri `cohorte_action_preview` (no spawn) */
export interface CohorteCommandPreview { command: string }

/** Additive fields on the existing cohorte_v3_features items (FR-5). */
export interface CohorteFeatureChoice {
  id: string;
  title: string;
  status: string;
  kind: string;
  updatedAt: number;
}

export type CohorteActionId =
  | 'intake' | 'brainstorm' | 'spec' | 'start' | 'patch' | 'fleet' | 'audit' | 'retro';

export const COHORTE_ACTION_LIMITS = {
  titleMax: 200,
  textMax: 24_000,
  urlMax: 2_000,
  timeoutMs: 30_000,
} as const;

export const COHORTE_SAFE_FEATURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type CohorteIntakeResponse = Result<CohorteIntakeResult>;
export type CohortePreviewResponse = Result<CohorteCommandPreview>;
```

Error codes returned: `INVALID_INPUT` (validation), `COHORTE_CLI_MISSING`,
`COHORTE_TIMEOUT`, `COHORTE_OUTPUT_CAPPED`, `COHORTE_OUTPUT_INVALID`, `COHORTE_REJECTED`
(detail `{ cohorteCode }`), `COHORTE_COMMAND_FAILED` (non-zero exit with no JSON). No new events.

## 6. Data & state

- Core: stateless (each call spawns once).
- Frontend: `cohorteActionsStore` — `{ menuOpenFor: SessionId | null; sheet: { action, sessionId, featureId? } | null; results: Record<SessionId, ResultEntry[]>; newFeatureIds: Set<string> }`.
  Nothing persisted.

## 7. Edge cases & errors

- No detection for the session cwd → no chip, `/cohorte` not offered, palette command hidden; `⌘⇧C` is a no-op.
- Project detected but not registered with the service → `cohorteFeatures` fails: Pipeline shows the
  error line and a **Run cohorte init** link to Settings · Cohorte; intake shows Cohorte's message.
- No features → Pipeline shows "No features yet" + **New feature…**.
- Intake `ok:false` (e.g. not a git checkout) → sheet stays open with Cohorte's message.
- Terminal creation fails → toast with the error; nothing else changes.
- Two quick `⏎`s on the primary → one spawn (busy guard).
- Feature id unsafe for a shell → FR-43.

## 8. Design brief

Frames 35/36/37 (+ L35–L37) in the Figma file are the source. Tokens: popover `--bg-popover`,
`--line-default` border, radius 8, floating shadow; selected row `--bg-selected`; group labels
10px SemiBold uppercase `--text-faint` +6% tracking; command hints Geist Mono 11 `--text-faint`
(`--text-secondary` on the selected row); attention suggestion uses `--state-attention-text` and a
`gate` tag on `--tint-attention-strong`. Sheet: 620px, stage strip on `--bg-rail`, inputs
`--bg-input` + `--line-default`, command block `--bg-terminal`. Result card: `--tint-success` at 7%,
`--tint-success-line` at 26%. Pipeline cards `--bg-card` radius 6; the gate card uses the attention
tint + border. Both themes via existing tokens only.

## 9. Acceptance criteria

- [ ] Chip, `⌘⇧C`, `/cohorte` and the palette each open the menu in a detected project; none show otherwise (FR-33).
- [ ] Suggestions follow FR-31 order and rules (unit tests).
- [ ] Intake from text/file/URL spawns exactly the previewed argv and renders the result card (FR-10, FR-3, FR-51).
- [ ] Validation errors for each field, including the 24 000-char text cap (FR-10).
- [ ] Brainstorm and Write spec open a named session terminal that runs the command (FR-20, FR-42).
- [ ] Patch/Fleet/Audit/Retro type the command without executing it (FR-21).
- [ ] Unsafe feature ids never reach a terminal (FR-43, unit test).
- [ ] Pipeline stages, next actions and ordering match FR-61 (unit tests).
- [ ] `cohorte_v3_features` returns `kind` and `updatedAt` (serde test).
- [ ] Rust argv/display builders are unit-tested; the spawn path is tested with the existing `Runner` fake.
- [ ] `npm run quality`, `npm test`, `cargo test` green.

## Remediation

(Empty until a review returns findings.)
