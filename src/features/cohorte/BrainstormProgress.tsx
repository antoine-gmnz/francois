// Brainstorm sheet — what the panel is doing while `cohorte brainstorm` runs
// (often minutes): the reply being sent, an elapsed clock and a timestamped log.

import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { clockLabel, elapsedLabel, type BrainstormLogLine } from './brainstorm-progress';
import './cohorte.css';

interface BrainstormProgressProps {
  /** What was sent — the idea, the reply, or the carry-on message. */
  pending: string | null;
  log: BrainstormLogLine[];
  /** Set while the panel works; null once it has answered. */
  startedAt: number | null;
}

export function BrainstormProgress({ pending, log, startedAt }: BrainstormProgressProps): JSX.Element | null {
  const now = useElapsedClock(startedAt !== null);
  if (log.length === 0) return null;
  const lines = <ol className="cohorte-brainstorm-log__lines">{log.map((line, index) => <li key={index}><time>{clockLabel(line.at)}</time> {line.text}</li>)}</ol>;
  if (startedAt === null) {
    return <details className="cohorte-preparation__card cohorte-brainstorm-log"><summary>Journal du panel</summary>{lines}</details>;
  }
  return <section className="cohorte-preparation__card cohorte-brainstorm-log" aria-live="polite">
    {pending && <p className="cohorte-brainstorm-log__pending">Vous : {pending}</p>}
    <h3><span className="cohorte-brainstorm-log__pulse" aria-hidden="true" /> Le panel réfléchit · {elapsedLabel(now - startedAt)}</h3>
    {lines}
  </section>;
}
