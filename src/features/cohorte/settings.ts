// cohorte-integration FR-80..FR-82 — the Settings · Cohorte page's pure half:
// the detection card's sub-line segments, its head copy per detection state,
// the doctor chip, and the check-row glyph. Unit-tested.

import type { CohorteCheckStatus, CohorteDetection, CohorteDoctorReport } from '../../../contract/cohorte-integration';
import type { StateKind } from '../../ui/state-kind';
import type { ChipTone } from './run-view';

/** `.cohorte/ · cohorte 3.4.1 · runtime Pi · state SQLite` — unknown segments omitted. */
export function detectionSegments(d: CohorteDetection): string[] {
  const out = ['.cohorte/'];
  if (d.cli.version) out.push(`cohorte ${d.cli.version}`);
  if (d.runtime) out.push(`runtime ${d.runtime}`);
  if (d.stateBackend === 'sqlite') out.push('state SQLite');
  return out;
}

export type PageMode = 'detected' | 'not-detected' | 'checking';

/** Which frame the page draws: 27 (found, whatever the CLI says) or 28. */
export function pageMode(d: CohorteDetection | null): PageMode {
  if (!d) return 'checking';
  return d.state === 'detected' || d.state === 'cli-missing' || d.state === 'cli-incompatible' ? 'detected' : 'not-detected';
}

export interface DetectionHead {
  title: string;
  tone: 'success' | 'danger' | 'attention';
  /** a mono hint beside the title (`npm i -g cohorte`), when there is one */
  hint?: string;
}

export function detectionHead(d: CohorteDetection): DetectionHead {
  if (d.state === 'cli-missing') return { title: 'Cohorte CLI not found', tone: 'danger', hint: 'npm i -g cohorte' };
  if (d.state === 'cli-incompatible') {
    return { title: `Cohorte ${d.cli.version ?? '?'} is not supported — Francois needs ${d.cli.supportedRange}`, tone: 'attention' };
  }
  return { title: 'Cohorte detected in this project', tone: 'success' };
}

/** FR-81: the doctor state chip, or null while it runs / before it ran. */
export function doctorChip(report: CohorteDoctorReport | null): { label: string; tone: ChipTone; glyph: StateKind } | null {
  if (!report) return null;
  const statuses = report.checks.map((c) => c.status);
  if (statuses.includes('error')) return { label: 'doctor failed', tone: 'danger', glyph: 'failed' };
  const warnings = statuses.filter((s) => s === 'warning').length;
  if (warnings > 0) return { label: `doctor: ${warnings} warning${warnings === 1 ? '' : 's'}`, tone: 'attention', glyph: 'approval' };
  return report.ok ? { label: 'doctor passed', tone: 'success', glyph: 'done' } : { label: 'doctor failed', tone: 'danger', glyph: 'failed' };
}

export type CheckGlyph = 'ok' | 'warning' | 'error' | 'skipped';

export function checkGlyph(status: CohorteCheckStatus): CheckGlyph {
  const known: readonly CheckGlyph[] = ['ok', 'warning', 'error'];
  return known.find((g) => g === status) ?? 'skipped';
}

export const COHORTE_DOCS_URL = 'https://github.com/TheBidouilleAgency/cohorte#readme';

/** FR-80/FR-82: nav dot on only for a `detected` project root. */
export function navDotOn(d: CohorteDetection | null): boolean {
  return d?.state === 'detected';
}

/** R-16: a doctor run started for `ranFor` is stale once the page shows another root. */
export function doctorResultApplies(ranFor: string, shownRoot: string | null): boolean {
  return ranFor === shownRoot;
}

/** R2-9: the note a failed `cohorte doctor` leaves on the page — only for a timeout. */
export function doctorErrorNote(code: string): string | null {
  return code === 'COHORTE_TIMEOUT'
    ? 'cohorte doctor did not finish — known issue in Cohorte 3.0.0-dev.1 on Windows when run without a terminal; run it in a shell'
    : null;
}
