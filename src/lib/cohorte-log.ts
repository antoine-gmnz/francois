// cohorte-integration FR-69 / §5.1 — the run activity log's pure half: how a
// wire event becomes one `CohorteLogEntry`, how an entry is tinted, and how the
// per-run buffer grows. Every wire member produces exactly one row; the
// payload-dependent tints of §5.1 (a failed check, an errored tool call, …) are
// folded into the entry's `severity` here, because the row keeps no payload.

import { type CohorteLogEntry } from '../../contract/cohorte-integration';
import { COHORTE_WIRE_EVENT_TYPES, type CohorteWireEvent } from '../../contract/cohorte-events';

/** The core's ring holds 500 per run (FR-26); the frontend mirror never holds more. */
export const COHORTE_LOG_CAP = 500;

/** §5.1: the event types whose row is always warning-tinted. */
const WARNING_TYPES: ReadonlySet<string> = new Set([
  'runtime.warning',
  'escalation.applied',
  'tool.denied',
  'budget.exceeded',
  'retry.scheduled',
  'lock.stolen',
]);

/** §5.1: the event types whose row is always error-tinted. */
const ERROR_TYPES: ReadonlySet<string> = new Set([
  'command.rejected',
  'git.worktree.quarantined',
  'git.merge.conflicted',
  'repo.change.detected',
]);

/** The severity a wire event's log row carries — §5.1's tint column. */
export function wireSeverity(e: CohorteWireEvent): string {
  if (WARNING_TYPES.has(e.type)) return 'warning';
  if (ERROR_TYPES.has(e.type)) return 'error';
  switch (e.type) {
    case 'check.completed':
      return e.payload.status === 'failed' || e.payload.status === 'errored' ? 'error' : e.severity;
    case 'tool.completed':
      return e.payload.isError || e.payload.timedOut ? 'error' : e.severity;
    case 'model.responded':
      return e.payload.status === 'error' ? 'error' : e.severity;
    case 'agent.failed':
      return e.payload.willRetry ? 'warning' : 'error';
    case 'error':
      return e.payload.fatal ? 'error' : e.severity;
    default:
      return e.severity;
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line?.trim() ?? '';
}

/** One row per wire event (FR-69). `unknown` rows carry the Cohorte type verbatim. */
export function logEntryFromEvent(e: CohorteWireEvent): CohorteLogEntry {
  let summary = e.summary;
  if (e.type === 'agent.message.completed') summary = firstLine(e.payload.preview) || e.summary;
  else if (e.type === 'agent.message.delta') summary = `+${e.payload.delta.length} chars`;
  const entry: CohorteLogEntry = {
    runId: e.runId,
    sequence: e.sequence,
    sub: e.sub,
    at: e.at,
    type: e.type === 'unknown' ? e.cohorteType : e.type,
    severity: wireSeverity(e),
    summary,
  };
  if (e.agent) entry.agentId = e.agent.agentId;
  if (e.phase) entry.phase = e.phase.state;
  return entry;
}

export type LogTone = 'error' | 'warning' | 'normal';

/** The row tint (FR-69): only warning and error are tinted. */
export function logTone(entry: Pick<CohorteLogEntry, 'severity'>): LogTone {
  if (entry.severity === 'error') return 'error';
  if (entry.severity === 'warning') return 'warning';
  return 'normal';
}

const KNOWN_TYPES: ReadonlySet<string> = new Set(COHORTE_WIRE_EVENT_TYPES);

/** §5.1 `unknown`: a row whose type is outside the catalogue reads "unrecognised". */
export function isUnrecognisedType(type: string): boolean {
  return !KNOWN_TYPES.has(type);
}

function after(a: Pick<CohorteLogEntry, 'sequence' | 'sub'>, b: Pick<CohorteLogEntry, 'sequence' | 'sub'>): boolean {
  return a.sequence > b.sequence || (a.sequence === b.sequence && a.sub > b.sub);
}

/**
 * Appends one row in `(sequence, sub)` order — never by time (FR-20). A row at
 * or before the newest one is a duplicate of what the fetched ring already
 * holds (the fetch and the live stream overlap) and is dropped. Capped at
 * COHORTE_LOG_CAP, oldest out first.
 */
export function appendLog(list: readonly CohorteLogEntry[], entry: CohorteLogEntry): CohorteLogEntry[] {
  const last = list[list.length - 1];
  if (last && !after(entry, last)) return list as CohorteLogEntry[];
  const next = [...list, entry];
  return next.length > COHORTE_LOG_CAP ? next.slice(next.length - COHORTE_LOG_CAP) : next;
}
