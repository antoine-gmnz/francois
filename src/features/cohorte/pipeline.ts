// cohorte-actions FR-61/FR-62 — the Pipeline view's cards, derived from the
// project's features and its runs. Pure and unit-tested; CohortePanelSection
// only renders what this returns.

import { COHORTE_FROZEN_STATUSES, type CohorteFeatureChoice } from '../../../contract/cohorte-actions';
import type { CohorteRun } from '../../../contract/cohorte-integration';

export type PipelineTone = 'neutral' | 'attention' | 'success' | 'danger' | 'running';

export type PipelineActionId = 'answer-gate' | 'open-run' | 'start' | 'brainstorm' | 'write-spec';

export interface PipelineAction {
  id: PipelineActionId;
  label: string;
  /** shipped/failed runs still open — but as a quiet, ghost control (FR-61). */
  ghost: boolean;
}

export interface PipelineCard {
  featureId: string;
  title: string;
  /** 0..5, six-segment track position (FR-62). */
  stage: number;
  stageLabel: string;
  tone: PipelineTone;
  runId: string | null;
  action: PipelineAction;
  updatedAt: number;
}

function latestRun(runs: readonly CohorteRun[], featureId: string): CohorteRun | null {
  let best: CohorteRun | null = null;
  for (const r of runs) if (r.specId === featureId && (best === null || r.startedAt > best.startedAt)) best = r;
  return best;
}

const OPEN_RUN: PipelineAction = { id: 'open-run', label: 'Open run', ghost: false };
const OPEN_RUN_GHOST: PipelineAction = { id: 'open-run', label: 'Open run', ghost: true };

function cardForRun(feature: CohorteFeatureChoice, run: CohorteRun): PipelineCard {
  const base = { featureId: feature.id, title: feature.title, runId: run.runId, updatedAt: feature.updatedAt };
  if (run.view === 'gate') {
    return { ...base, stage: 4, stageLabel: 'run · gate', tone: 'attention', action: { id: 'answer-gate', label: 'Answer gate', ghost: false } };
  }
  if (run.view === 'completed') {
    return { ...base, stage: 5, stageLabel: 'shipped', tone: 'success', action: OPEN_RUN_GHOST };
  }
  if (run.view === 'failed' || run.view === 'cancelled' || run.view === 'blocked') {
    return { ...base, stage: 4, stageLabel: 'run · failed', tone: 'danger', action: OPEN_RUN_GHOST };
  }
  return { ...base, stage: 4, stageLabel: 'run', tone: 'running', action: OPEN_RUN };
}

function cardForFeature(feature: CohorteFeatureChoice): PipelineCard {
  const base = { featureId: feature.id, title: feature.title, runId: null, updatedAt: feature.updatedAt };
  if (COHORTE_FROZEN_STATUSES.includes(feature.status)) {
    return { ...base, stage: 3, stageLabel: 'frozen', tone: 'neutral', action: { id: 'start', label: 'Start run', ghost: false } };
  }
  if (feature.status === 'draft') {
    if (feature.kind === 'patch') {
      return { ...base, stage: 2, stageLabel: 'spec · draft', tone: 'neutral', action: { id: 'write-spec', label: 'Write spec', ghost: false } };
    }
    return { ...base, stage: 0, stageLabel: 'intake', tone: 'neutral', action: { id: 'brainstorm', label: 'Brainstorm', ghost: false } };
  }
  // FR-61 "anything else → 2 + the raw status" — no next action is specified for
  // this bucket; Brainstorm is the closest fit (see the frontend handoff).
  return { ...base, stage: 2, stageLabel: feature.status, tone: 'neutral', action: { id: 'brainstorm', label: 'Brainstorm', ghost: false } };
}

function rank(card: PipelineCard): number {
  if (card.action.id === 'answer-gate') return 0; // gate first
  if (card.stageLabel === 'shipped') return 3; // shipped last
  if (card.tone === 'running') return 1; // then running
  return 2; // then everything else, by updatedAt desc
}

/** FR-61 — one card per feature, in order: gate, running, everything else (updatedAt desc), shipped last. */
export function derivePipeline(features: readonly CohorteFeatureChoice[], runs: readonly CohorteRun[]): PipelineCard[] {
  const cards = features.map((f) => {
    const run = latestRun(runs, f.id);
    return run ? cardForRun(f, run) : cardForFeature(f);
  });
  return cards.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra !== rb ? ra - rb : b.updatedAt - a.updatedAt;
  });
}
