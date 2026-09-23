// cohorte-integration FR-62 — the copy a gate card reads, by approval kind.
// Pure: the card, the roster card, the palette and the notification all word a
// gate through here, so the four cannot drift.

import type { CohorteGate, CohorteGateAction, CohorteGateActionId, CohorteRun } from '../../../contract/cohorte-integration';

interface KindCopy {
  label: string;
  /** null ⇒ the question is the request's own `reason`. */
  question: ((spec: string) => string) | null;
  approve: string;
}

const KINDS: Record<string, KindCopy> = {
  ship: { label: 'SHIP APPROVAL', question: (spec) => `Ship ${spec}?`, approve: 'Approve · ship' },
  'review-leftovers': {
    label: 'REVIEW VERDICT',
    question: (spec) => `Ship ${spec}, or send it back to fix?`,
    approve: 'Approve · ship',
  },
  'contract-change': { label: 'CONTRACT CHANGE', question: () => 'A fix touches the contract. Allow it?', approve: 'Approve' },
  'loop-stalled': {
    label: 'LOOP STALLED',
    question: () => 'The fix loop stopped making progress. Continue?',
    approve: 'Approve · continue',
  },
  budget: { label: 'BUDGET', question: () => 'The run hit a budget limit. Raise it and continue?', approve: 'Approve · continue' },
  'spec-not-ready': { label: 'SPEC NOT READY', question: () => 'The spec is not ready to build. Proceed anyway?', approve: 'Approve' },
  tool: { label: 'TOOL APPROVAL', question: null, approve: 'Allow once' },
  'shared-path': { label: 'SHARED PATH', question: null, approve: 'Allow once' },
  'unowned-path': { label: 'UNOWNED PATH', question: null, approve: 'Allow once' },
  'provision-network': { label: 'NETWORK', question: null, approve: 'Allow once' },
  'api-billing': { label: 'API BILLING', question: null, approve: 'Allow once' },
  'blocked-ack': { label: 'BLOCKED', question: null, approve: 'Acknowledge' },
};

/** `COHORTE GATE · <label>` — an unknown kind upper-cased, `-` read as a space. */
export function gateKindLabel(kind: string): string {
  return KINDS[kind]?.label ?? kind.toUpperCase().replace(/-/g, ' ');
}

/** The question line; generic kinds read the request's own reason. */
export function gateQuestion(gate: CohorteGate, spec: string): string {
  const q = KINDS[gate.request.kind]?.question;
  return q ? q(spec) : gate.request.reason;
}

export function actionLabel(action: CohorteGateAction, kind: string): string {
  if (action.id === 'approve') return KINDS[kind]?.approve ?? 'Approve';
  if (action.id === 'fix') return 'Send to fix';
  return action.stopsRun ? 'Deny · stop run' : 'Deny';
}

/** The compact card's short labels (frame 25 panel): Approve · Send to fix · Deny. */
export function compactActionLabel(action: CohorteGateAction): string {
  return action.id === 'approve' ? 'Approve' : action.id === 'fix' ? 'Send to fix' : 'Deny';
}

export const ACTION_KEYS: Record<CohorteGateActionId, '1' | '2' | '3'> = { approve: '1', fix: '2', deny: '3' };
export const ACTION_VARIANT: Record<CohorteGateActionId, 'attention' | 'secondary' | 'ghost'> = {
  approve: 'attention',
  fix: 'secondary',
  deny: 'ghost',
};

export function gateAction(gate: CohorteGate, id: CohorteGateActionId): CohorteGateAction | null {
  return gate.actions.find((a) => a.id === id) ?? null;
}

/** The compact card's summary line: "Review found 4 issues, 1 blocking. Cohorte waits…". */
export function gateSummary(gate: CohorteGate): string {
  const n = gate.findings.length;
  if (n === 0) return gate.request.reason;
  const blocking = gate.findings.filter((f) => f.blocking).length;
  const issues = `${n} issue${n === 1 ? '' : 's'}`;
  return `Review found ${issues}${blocking > 0 ? `, ${blocking} blocking` : ''}. Cohorte waits for your verdict before it ships.`;
}

/** The spec a gate names — the spec id, else the run title. */
export function runSpecName(run: Pick<CohorteRun, 'specId' | 'title'>): string {
  return run.specId || run.title;
}

/** FR-87: the notification body — no agent text. */
export function gateNotificationBody(run: Pick<CohorteRun, 'specId' | 'title'>, gate: CohorteGate): string {
  return `${runSpecName(run)} · Cohorte gate: ${gateKindLabel(gate.request.kind).toLowerCase()}`;
}

/** FR-61: `file:line` for a finding row, or null when it names no file. */
export function findingLocation(f: { file?: string; line?: number }): string | null {
  if (!f.file) return null;
  return f.line !== undefined ? `${f.file}:${f.line}` : f.file;
}

/**
 * FR-61 / R-16: the CLI hint lines — the hovered/focused action's, else
 * approve's, else the first offered. Never Cohorte's own `request.cli` (it
 * lacks the runId the real CLI needs): with no action, the approve argv is
 * built from the ids, and a gate that offers nothing shows nothing.
 */
export function gateHint(gate: CohorteGate, hovered: CohorteGateActionId | null): string[] {
  const action = gate.actions.find((a) => a.id === hovered) ?? gate.actions.find((a) => a.id === 'approve') ?? gate.actions[0];
  if (action) return action.cli;
  return gate.request.allowedDecisions.includes('allow-once') ? [`cohorte approve ${gate.runId} ${gate.request.approvalId}`] : [];
}

/** FR-85: the roster card's one-word labels (four sm buttons share ~236px); the title carries the argv. */
export function rosterActionLabel(action: CohorteGateAction): string {
  return action.id === 'approve' ? 'Approve' : action.id === 'fix' ? 'Fix' : 'Deny';
}
