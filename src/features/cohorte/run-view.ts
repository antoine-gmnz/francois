// cohorte-integration FR-60/FR-67/FR-68/FR-71..FR-73 — how a run projection
// reads on screen: its short id, its state chip, the panel's summary line,
// each phase's glyph/meta/bar and each step's state word. Pure, unit-tested.

import type { CohortePhase, CohorteRun } from '../../../contract/cohorte-integration';
import type { StateKind } from '../../ui/state-kind';
import { gateKindLabel } from './gate-view';

/** `run_` + the first 6 hex (spec §6 "short id"). */
export function shortRunId(runId: string): string {
  return runId.slice(0, 10);
}

export type ChipTone = 'attention' | 'success' | 'danger' | 'neutral' | 'running';

export interface RunChip {
  label: string;
  tone: ChipTone;
  glyph: StateKind;
}

/**
 * FR-60 — the session header's state chip for a linked run, or null when the
 * run chip alone speaks (running · completed · cancelled · idle · waiting).
 * `replacesStatus` is true only for the gate, which stands in for the
 * session's own status pill.
 */
export function headerStateChip(run: Pick<CohorteRun, 'view'>): (RunChip & { replacesStatus: boolean }) | null {
  switch (run.view) {
    case 'gate':
      return { label: 'Gate · needs your verdict', tone: 'attention', glyph: 'approval', replacesStatus: true };
    case 'paused':
      return { label: 'Run paused', tone: 'neutral', glyph: 'idle', replacesStatus: false };
    case 'auth':
      return { label: 'Cohorte needs login', tone: 'attention', glyph: 'approval', replacesStatus: false };
    case 'quota':
      return { label: 'Cohorte quota reached', tone: 'attention', glyph: 'approval', replacesStatus: false };
    case 'failed':
      return { label: 'Run failed', tone: 'danger', glyph: 'failed', replacesStatus: false };
    case 'blocked':
      return { label: 'Run blocked', tone: 'danger', glyph: 'failed', replacesStatus: false };
    default:
      return null;
  }
}

const VERBS: Record<string, string> = {
  BRAINSTORM: 'Brainstorming',
  SPEC: 'Writing spec',
  PREFLIGHT: 'Preflight',
  BUILD: 'Building',
  TEST: 'Testing',
  REVIEW: 'Reviewing',
  FIX: 'Fixing',
  SHIP: 'Shipping',
};

export function phaseVerb(state: string | undefined): string {
  if (!state) return 'Running';
  return VERBS[state] ?? state.charAt(0) + state.slice(1).toLowerCase();
}

/** FR-71 — the run view header's chip: FR-60 wording, plus every other view. */
export function runViewChip(run: Pick<CohorteRun, 'view' | 'currentPhase' | 'stop'>): RunChip {
  const header = headerStateChip(run);
  if (header) return { label: header.label, tone: header.tone, glyph: header.glyph };
  switch (run.view) {
    case 'running':
      return { label: `Running · ${phaseVerb(run.currentPhase)}`, tone: 'running', glyph: 'running' };
    case 'completed':
      return { label: completedWord(run), tone: 'success', glyph: 'done' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', glyph: 'idle' };
    case 'waiting':
      return { label: 'Waiting for approval', tone: 'attention', glyph: 'approval' };
    default:
      return { label: 'Idle', tone: 'neutral', glyph: 'idle' };
  }
}

function completedWord(run: Pick<CohorteRun, 'stop'>): string {
  return !run.stop || run.stop.reason === 'review-clean' ? 'Shipped' : 'Completed';
}

/** 1-based index of the run's current phase in its phase list, when it has one. */
export function currentPhaseIndex(run: Pick<CohorteRun, 'phases' | 'currentPhase'>): number | null {
  const i = run.phases.findIndex((p) => p.state === run.currentPhase);
  return i === -1 ? null : i + 1;
}

export interface SummaryLine {
  text: string;
  tone: ChipTone;
  glyph: StateKind;
}

/** FR-67 — the panel run header's row 2, derived from real state (not the mock's). */
export function panelSummary(run: CohorteRun): SummaryLine {
  switch (run.view) {
    case 'gate':
      return {
        text: `Waiting at the ${run.gate ? gateKindLabel(run.gate.request.kind).toLowerCase() : 'approval'} gate`,
        tone: 'attention',
        glyph: 'approval',
      };
    case 'running': {
      const i = currentPhaseIndex(run);
      const verb = phaseVerb(run.currentPhase);
      return { text: i !== null ? `${verb} · phase ${i} of ${run.phases.length}` : verb, tone: 'running', glyph: 'running' };
    }
    case 'paused':
      return { text: 'Paused', tone: 'neutral', glyph: 'idle' };
    case 'auth':
      return { text: 'Needs login', tone: 'attention', glyph: 'approval' };
    case 'quota':
      return { text: 'Quota reached', tone: 'attention', glyph: 'approval' };
    case 'failed':
    case 'blocked': {
      const word = run.view === 'failed' ? 'Failed' : 'Blocked';
      return { text: run.stop?.reason ? `${word} · ${run.stop.reason}` : word, tone: 'danger', glyph: 'failed' };
    }
    case 'completed':
      return { text: completedWord(run), tone: 'success', glyph: 'done' };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'neutral', glyph: 'idle' };
    case 'waiting':
      return { text: 'Waiting for approval', tone: 'attention', glyph: 'approval' };
    default:
      return { text: 'Idle', tone: 'neutral', glyph: 'idle' };
  }
}

/** The glyph for a phase or step status (FR-68). */
export function statusGlyph(status: string): StateKind {
  switch (status) {
    case 'completed':
      return 'done';
    case 'running':
      return 'running';
    case 'waiting-approval':
      return 'approval';
    case 'failed':
    case 'blocked':
      return 'failed';
    case 'paused':
      return 'idle';
    default:
      return 'pending';
  }
}

/** Whether this phase is the one the run's gate waits at. */
export function isGatePhase(run: Pick<CohorteRun, 'gate' | 'view' | 'currentPhase'>, phase: Pick<CohortePhase, 'state' | 'status'>): boolean {
  if (phase.status === 'waiting-approval') return true;
  const gatePhase = run.gate?.request.phase?.state;
  if (gatePhase) return gatePhase === phase.state;
  return run.view === 'gate' && run.currentPhase === phase.state;
}

/** `m:ss` (and `h:mm:ss` past an hour). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** `mm:ss` — the live clock in the phases list. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  return `${String(m).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export interface PhaseMeta {
  text: string;
  live: boolean;
}

/**
 * FR-68 (panel, `timeline:false`) / FR-72 (timeline, `timeline:true`): running
 * → elapsed (live in the panel), the gate's phase → "waiting", completed →
 * duration (panel) or "done" (timeline), anything not started → "—".
 */
export function phaseMeta(run: CohorteRun, phase: CohortePhase, now: number, timeline: boolean): PhaseMeta {
  if (isGatePhase(run, phase)) return { text: 'waiting', live: false };
  if (phase.status === 'running') {
    const elapsed = now - (phase.startedAt ?? now);
    return { text: timeline ? formatDuration(elapsed) : formatClock(elapsed), live: !timeline };
  }
  if (phase.status === 'completed') {
    if (timeline) return { text: 'done', live: false };
    const ms = phase.durationMs ?? (phase.endedAt !== undefined && phase.startedAt !== undefined ? phase.endedAt - phase.startedAt : undefined);
    return { text: ms !== undefined ? formatDuration(ms) : 'done', live: false };
  }
  if (phase.status === 'failed' || phase.status === 'blocked') return { text: phase.status, live: false };
  return { text: '—', live: false };
}

export type BarTone = 'success' | 'running' | 'attention' | 'danger' | 'idle';

/** FR-72 — the 4px bar's colour. */
export function phaseBarTone(run: CohorteRun, phase: CohortePhase): BarTone {
  if (isGatePhase(run, phase)) return 'attention';
  switch (phase.status) {
    case 'completed':
      return 'success';
    case 'running':
      return 'running';
    case 'failed':
    case 'blocked':
      return 'danger';
    default:
      return 'idle';
  }
}

/** Whether a phase has started (name reads primary, not muted). */
export function phaseStarted(phase: Pick<CohortePhase, 'status'>): boolean {
  return phase.status !== 'pending' && phase.status !== 'skipped';
}

export function donePhaseCount(phases: readonly Pick<CohortePhase, 'status'>[]): number {
  return phases.filter((p) => p.status === 'completed' || p.status === 'skipped').length;
}

const STEP_WORDS: Record<string, string> = {
  completed: 'Done',
  running: 'Running',
  pending: 'Pending',
  failed: 'Failed',
  'waiting-approval': 'Waiting',
  paused: 'Paused',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
  skipped: 'Skipped',
};

/** FR-73 — a step's state word. Unknown statuses read as-is. */
export function stepStateLabel(status: string): string {
  return STEP_WORDS[status] ?? status;
}

export function isTerminalView(view: CohorteRun['view']): boolean {
  return view === 'completed' || view === 'cancelled';
}

/** FR-67/FR-71 — which run controls a view offers. */
export function runControls(view: CohorteRun['view']): { pause: boolean; resume: boolean; cancel: boolean } {
  if (isTerminalView(view)) return { pause: false, resume: false, cancel: false };
  const resume = view === 'paused' || view === 'failed' || view === 'blocked' || view === 'auth' || view === 'quota';
  return { pause: !resume, resume, cancel: true };
}

/** FR-76: a live run whose host is gone. */
export function hostDead(run: Pick<CohorteRun, 'view' | 'host'>): boolean {
  return !isTerminalView(run.view) && !run.host.alive;
}

/** FR-67 footer: `<runtime> runtime · snapshot pinned`, or null with no pinned runtime. */
export function runtimeLine(run: Pick<CohorteRun, 'runtime'>): string | null {
  if (!run.runtime) return null;
  return run.runtime.pinDigest ? `${run.runtime.id} runtime · snapshot pinned` : `${run.runtime.id} runtime`;
}

/** First 6 of the snapshot digest (after any `sha256:` prefix). */
export function shortDigest(digest: string | undefined): string | null {
  if (!digest) return null;
  return digest.replace(/^[a-z0-9]+:/, '').slice(0, 6);
}

/** Every step of every phase, in phase order then start time (FR-73). */
export function orderedSteps(run: CohorteRun) {
  return run.phases.flatMap((p) =>
    [...p.steps].sort((a, b) => (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER)),
  );
}

/** A step's duration so far — live for a running one. */
export function stepDurationMs(step: { status: string; startedAt?: number; endedAt?: number; durationMs?: number }, now: number): number | null {
  if (step.durationMs !== undefined) return step.durationMs;
  if (step.startedAt === undefined) return null;
  return (step.endedAt ?? (step.status === 'running' ? now : step.startedAt)) - step.startedAt;
}

/** FR-74: the policy line — the first two gated steps, "gates on ship + push". */
export function policyLine(gatedSteps: readonly string[] | undefined): string | null {
  if (!gatedSteps || gatedSteps.length === 0) return null;
  return `gates on ${gatedSteps.slice(0, 2).join(' + ')}`;
}

/** R2-7: the login hint — the `auth.required` event's own `cli`, else the CLI's default. */
export function authHint(cli: string | undefined): string {
  return cli && cli.trim() !== '' ? cli : 'cohorte auth login';
}
