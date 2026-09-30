import type { CohorteCommandResponse, CohorteGate, CohorteGateActionId } from '../../../contract/cohorte-integration';
import { cohorteAnswer, cohorteApprove, cohorteDeny, cohorteSendToFix } from '../../lib/api';

/** Project requests have an exact request id, but no run id. */
export function resolvePreparation(root: string, gate: CohorteGate, response: { answer: string } | { action: CohorteGateActionId }): Promise<CohorteCommandResponse> {
  const request = { root, runId: '', approvalId: gate.request.approvalId };
  if ('answer' in response) {
    if (gate.request.kind === 'question' && response.answer.trim()) return cohorteAnswer({ ...request, answer: response.answer.trim() });
  } else if (gate.actions.some(action => action.id === response.action)) {
    if (response.action === 'approve') return cohorteApprove(request);
    if (response.action === 'fix') return cohorteSendToFix(request);
    return cohorteDeny({ ...request, stopRun: false });
  }
  return Promise.resolve({ ok: false, error: { code: 'INVALID_INPUT', message: 'This reply is not available for the project request.' } });
}

export function initializationSummary(analysis: unknown): string[] {
  if (!analysis || typeof analysis !== 'object' || !('surfaces' in analysis) || !Array.isArray(analysis.surfaces)) return [];
  return analysis.surfaces.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') return [];
    const surface = value as { id: string; paths?: unknown; role_profile?: unknown; checks?: unknown };
    const paths = Array.isArray(surface.paths) ? surface.paths.filter(path => typeof path === 'string').join(', ') : '';
    const checks = Array.isArray(surface.checks) ? surface.checks.length : null;
    return [[surface.id, paths, typeof surface.role_profile === 'string' ? surface.role_profile : '', checks === null ? '' : `${checks} check${checks === 1 ? '' : 's'}`].filter(Boolean).join(' · ')];
  });
}
