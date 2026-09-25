// cohorte-actions FR-30/FR-31 — the actions menu's model: the four static
// groups (Capture, Spec, Run, Improve) plus up to two context-aware
// suggestions. Pure and unit-tested; CohorteActionsMenu.tsx only renders this.

import { COHORTE_FROZEN_STATUSES, type CohorteActionId, type CohorteFeatureChoice } from '../../../contract/cohorte-actions';
import type { CohorteGateActionId, CohorteRun } from '../../../contract/cohorte-integration';
import type { IconName } from '../../ui/icons';
import { cohorteBrainstormDisplay, cohorteStartDisplay } from './command-display';
import { shortRunId } from './run-view';

export interface CohorteMenuItem {
  id: CohorteActionId;
  label: string;
  description: string;
  /** Graphite icon set name (frame 35). */
  icon: IconName;
  commandHint: string;
  kind: 'sheet' | 'terminal-prefill';
}

export interface CohorteMenuGroup {
  label: string;
  items: CohorteMenuItem[];
}

/** FR-30 — the four fixed groups. Content, not derived: every session sees the same verbs. */
export const COHORTE_MENU_GROUPS: readonly CohorteMenuGroup[] = [
  {
    label: 'Capture',
    items: [
      { id: 'intake', label: 'Intake', description: 'Triage a ticket, email, URL or stack trace into a brief', icon: 'doc', commandHint: 'cohorte intake', kind: 'sheet' },
      { id: 'brainstorm', label: 'Brainstorm', description: 'Persona panel challenges an idea — opens a terminal', icon: 'spark', commandHint: 'cohorte brainstorm', kind: 'sheet' },
    ],
  },
  {
    label: 'Spec',
    items: [{ id: 'spec', label: 'Write spec', description: 'Guide a brief through to an approved spec — opens a terminal', icon: 'edit', commandHint: 'cohorte spec', kind: 'sheet' }],
  },
  {
    label: 'Run',
    items: [
      { id: 'start', label: 'Start run', description: 'Build → review → fix for a frozen feature', icon: 'arrow-right', commandHint: 'cohorte start', kind: 'sheet' },
      { id: 'patch', label: 'Patch', description: 'Minimal fix spec — prefills a terminal', icon: 'flow', commandHint: 'cohorte patch', kind: 'terminal-prefill' },
      { id: 'fleet', label: 'Fleet', description: 'Several frozen features in parallel worktrees', icon: 'layers', commandHint: 'cohorte fleet', kind: 'terminal-prefill' },
    ],
  },
  {
    label: 'Improve',
    items: [
      { id: 'audit', label: 'Audit', description: 'Check a surface against the project conventions', icon: 'search', commandHint: 'cohorte audit', kind: 'terminal-prefill' },
      { id: 'retro', label: 'Retro', description: 'Turn repeating review findings into rules', icon: 'refresh', commandHint: 'cohorte retro', kind: 'terminal-prefill' },
    ],
  },
];

export type CohorteMenuSuggestionAction =
  | { kind: 'gate'; gateAction: CohorteGateActionId }
  | { kind: 'start'; featureId: string }
  | { kind: 'brainstorm'; featureId: string };

export interface CohorteMenuSuggestion {
  id: string;
  label: string;
  description: string;
  icon: IconName;
  commandHint: string;
  tone: 'attention' | 'neutral';
  action: CohorteMenuSuggestionAction;
}

export interface CohorteMenuInput {
  linkedRun: CohorteRun | null;
  features: readonly CohorteFeatureChoice[];
  /** Every run known for this feature's project root (FR-31b's "no run in the store for it"). */
  runsForRoot: readonly CohorteRun[];
}

function newestBy<T>(items: readonly T[], updatedAt: (item: T) => number): T | null {
  return items.reduce<T | null>((best, item) => (best === null || updatedAt(item) > updatedAt(best) ? item : best), null);
}

/** FR-31 — up to 2 suggestions, in order: pending gate, then a startable frozen feature, then a draft to brainstorm. */
export function buildSuggestions({ linkedRun, features, runsForRoot }: CohorteMenuInput): CohorteMenuSuggestion[] {
  const out: CohorteMenuSuggestion[] = [];

  const approve = linkedRun?.gate?.actions.find((a) => a.id === 'approve');
  if (approve) {
    out.push({
      id: 'suggest-gate',
      label: `Approve & ship ${linkedRun!.specId}`,
      description: `Review gate on ${shortRunId(linkedRun!.runId)} · ${linkedRun!.gate!.findings.length} findings`,
      icon: 'check',
      commandHint: approve.cli.join(' && '),
      tone: 'attention',
      action: { kind: 'gate', gateAction: 'approve' },
    });
  }

  const specsWithRuns = new Set(runsForRoot.map((r) => r.specId));
  const startable = features.filter((f) => COHORTE_FROZEN_STATUSES.includes(f.status) && !specsWithRuns.has(f.id));
  const toStart = newestBy(startable, (f) => f.updatedAt);
  if (toStart) {
    out.push({
      id: 'suggest-start',
      label: `Start run · ${toStart.id}`,
      description: `Spec frozen · ${toStart.title}`,
      icon: 'arrow-right',
      commandHint: cohorteStartDisplay(toStart.id),
      tone: 'neutral',
      action: { kind: 'start', featureId: toStart.id },
    });
  }

  const drafts = features.filter((f) => f.status === 'draft');
  const toBrainstorm = newestBy(drafts, (f) => f.updatedAt);
  if (toBrainstorm) {
    out.push({
      id: 'suggest-brainstorm',
      label: `Brainstorm · ${toBrainstorm.id}`,
      description: `Draft · ${toBrainstorm.title}`,
      icon: 'spark',
      commandHint: cohorteBrainstormDisplay(toBrainstorm.id),
      tone: 'neutral',
      action: { kind: 'brainstorm', featureId: toBrainstorm.id },
    });
  }

  return out.slice(0, 2);
}

export interface CohorteMenuModel {
  suggestions: CohorteMenuSuggestion[];
  groups: readonly CohorteMenuGroup[];
}

/** FR-30 — the whole menu model for a session. */
export function buildCohorteMenu(input: CohorteMenuInput): CohorteMenuModel {
  return { suggestions: buildSuggestions(input), groups: COHORTE_MENU_GROUPS };
}

// ---------- FR-33: a Francois-local `/cohorte` slash-menu entry ----------
// Not core-driven — merged client-side into the popup list only when the
// session's cwd has a Cohorte detection (see the frontend handoff for this
// assumption). Selecting it opens the actions menu instead of sending text.

import type { SlashCommandInfo } from '../../../contract/common';

export const COHORTE_SLASH_NAME = 'cohorte';

export function cohorteSlashEntry(): SlashCommandInfo {
  return { name: COHORTE_SLASH_NAME, description: 'Open the Cohorte actions menu', source: 'builtin' };
}

/** `commands` with the local `/cohorte` entry appended when `hasDetection`, else untouched. */
export function withCohorteSlashEntry(commands: readonly SlashCommandInfo[], hasDetection: boolean): SlashCommandInfo[] {
  if (!hasDetection || commands.some((c) => c.name === COHORTE_SLASH_NAME)) return [...commands];
  return [...commands, cohorteSlashEntry()];
}

// ---------- keyboard navigation (flow 1) ----------

export type CohorteMenuRow =
  | { kind: 'suggestion'; suggestion: CohorteMenuSuggestion }
  | { kind: 'item'; item: CohorteMenuItem };

/** The flat, keyboard-navigable row order: suggestions first, then each group's items in order. */
export function flattenMenu(model: CohorteMenuModel): CohorteMenuRow[] {
  const rows: CohorteMenuRow[] = model.suggestions.map((suggestion) => ({ kind: 'suggestion', suggestion }));
  for (const group of model.groups) for (const item of group.items) rows.push({ kind: 'item', item });
  return rows;
}

/** `↑`/`↓` with wrap, matching slash-menu's moveSelection. */
export function moveMenuSelection(count: number, idx: number, delta: 1 | -1): number {
  if (count <= 0) return 0;
  return (idx + delta + count) % count;
}
