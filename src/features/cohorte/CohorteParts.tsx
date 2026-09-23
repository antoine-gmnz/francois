// cohorte-integration §8 — the small shared pieces: the Cohorte mark, the state
// chip, the run chip and a finding row. The mark keeps its brand orange inside
// the SVG and is never recoloured (design brief §0).

import type { CohorteFinding } from '../../../contract/cohorte-events';
import { useCohorteStore } from '../../lib/cohorteStore';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { StateIcon } from '../../ui/StateIcon';
import type { StateKind } from '../../ui/state-kind';
import './cohorte.css';
import { findingLocation } from './gate-view';
import { ANSWERED_BY_MS, answeredByLine } from './outcome';
import type { ChipTone } from './run-view';
import { shortRunId } from './run-view';

export function CohorteMark({ size = 16, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      className={className ? `cohorte-mark ${className}` : 'cohorte-mark'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M5.1875 6.9375H3.0625C2.4757 6.9375 2 7.4132 2 8C2 8.5868 2.4757 9.0625 3.0625 9.0625H5.1875C5.7743 9.0625 6.25 8.5868 6.25 8C6.25 7.4132 5.7743 6.9375 5.1875 6.9375Z"
        fill="#F5851F"
      />
      <path
        d="M11.0075 5.77C10.5764 5.38209 10.0422 5.12743 9.46941 5.03684C8.89663 4.94624 8.30987 5.02359 7.78014 5.25954C7.25041 5.49548 6.80041 5.87989 6.48461 6.36626C6.16881 6.85263 6.00074 7.4201 6.00074 8C6.00074 8.5799 6.16881 9.14737 6.48461 9.63374C6.80041 10.1201 7.25041 10.5045 7.78014 10.7405C8.30987 10.9764 8.89663 11.0538 9.46941 10.9632C10.0422 10.8726 10.5764 10.6179 11.0075 10.23"
        stroke="#F5851F"
        strokeWidth="2.125"
      />
    </svg>
  );
}

/** 20px chip: an 11px state glyph + a Small Medium label, tinted by tone. */
export function CohorteStateChip({ label, tone, glyph }: { label: string; tone: ChipTone; glyph: StateKind }): JSX.Element {
  return (
    <span className={`cohorte-chip cohorte-chip--${tone}`} title={label}>
      <StateIcon kind={glyph} size={11} />
      <span className="cohorte-chip__label">{label}</span>
    </span>
  );
}

/** FR-60: mark + short id; the whole chip opens the run view. */
export function CohorteRunChip({ runId, title, onOpen }: { runId: string; title: string; onOpen: () => void }): JSX.Element {
  return (
    <button type="button" className="cohorte-run-chip" title={`${runId} — ${title}`} onClick={onOpen}>
      <CohorteMark size={7.5} />
      <span className="cohorte-run-chip__id">{shortRunId(runId)}</span>
    </button>
  );
}

/** A finding: dot · title · file:line (full only) · label, tinted by label. */
export function FindingRow({ finding, variant }: { finding: CohorteFinding; variant: 'full' | 'compact' }): JSX.Element {
  const where = variant === 'full' ? findingLocation(finding) : null;
  return (
    <div className={`cohorte-finding cohorte-finding--${variant} cohorte-finding--${finding.label}`} title={finding.actual || finding.rule}>
      <span className="cohorte-finding__dot" />
      <span className="cohorte-finding__title truncate">{finding.title}</span>
      {where && <span className="cohorte-finding__where truncate">{where}</span>}
      <span className="cohorte-finding__label">{finding.label}</span>
    </div>
  );
}

/** R-15: "Answered by <actor> · <decision>" when someone else answered the gate. */
export function AnsweredBy({ runId, className }: { runId: string; className?: string }): JSX.Element | null {
  const resolution = useCohorteStore((s) => s.resolutions[runId]);
  const fresh = resolution !== undefined && !resolution.byThisWindow && Date.now() - resolution.at <= ANSWERED_BY_MS;
  const now = useElapsedClock(fresh);
  const line = answeredByLine(resolution, fresh ? Math.max(now, resolution.at) : Date.now());
  if (!line) return null;
  return (
    <div className={className ? `cohorte-answered ${className}` : 'cohorte-answered'} role="status">
      {line}
    </div>
  );
}
