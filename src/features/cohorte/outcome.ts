// cohorte-integration FR-65 / FR-92..FR-94 — how a command's result reads: one
// line per CLI step on the card, and the toast a failed call raises. Pure.

import type { CohorteCommandStep } from '../../../contract/cohorte-integration';
import type { AppError } from '../../../contract/common';

/** How long the step lines stay on the card (FR-65). */
export const OUTCOME_VISIBLE_MS = 8_000;
/** FR-93: a pending (exit 4) command re-enables the buttons after this, at the latest. */
export const PENDING_REENABLE_MS = 20_000;

export type StepTone = 'success' | 'pending' | 'danger' | 'muted';

export function stepLine(step: CohorteCommandStep): { text: string; tone: StepTone } {
  switch (step.outcome) {
    case 'completed':
      return { text: `✓ ${step.cli} · completed`, tone: 'success' };
    case 'pending':
      return { text: `… ${step.cli} · pending — Cohorte will apply it`, tone: 'pending' };
    case 'rejected':
      return { text: `✕ ${step.cli} · rejected: ${step.message ?? step.errorCode ?? 'refused'}`, tone: 'danger' };
    default:
      return { text: `– ${step.cli} · skipped${step.message ? `: ${step.message}` : ''}`, tone: 'muted' };
  }
}

/** Whether any step is still pending (the buttons wait for the next poll, FR-93). */
export function hasPendingStep(steps: readonly CohorteCommandStep[]): boolean {
  return steps.some((s) => s.outcome === 'pending');
}

export interface ErrorFeedback {
  message: string;
  kind: 'error' | 'info';
  /** refresh the run (`cohorte_get_run`) — the gate was answered elsewhere */
  refresh: boolean;
}

/** FR-65/FR-92/FR-94: the toast for a failed Cohorte command. */
export function commandErrorFeedback(error: AppError): ErrorFeedback {
  switch (error.code) {
    case 'COHORTE_GATE_NOT_PENDING':
      return { message: 'Already answered elsewhere', kind: 'info', refresh: true };
    case 'COHORTE_TIMEOUT':
      return { message: 'Cohorte did not answer in time — it may still apply the command', kind: 'info', refresh: false };
    case 'COHORTE_REJECTED': {
      const detail = error.detail as { message?: unknown } | undefined;
      const text = typeof detail?.message === 'string' && detail.message ? detail.message : error.message;
      return { message: `Cohorte refused: ${text}`, kind: 'error', refresh: false };
    }
    default:
      return { message: error.message || 'Cohorte command failed', kind: 'error', refresh: false };
  }
}

/** FR-64: the toast when Send to fix carried a draft Cohorte 3.0 cannot take. */
export const NOTE_DROPPED_TOAST = 'Cohorte 3.0 does not take a note — your text stays in the composer';
