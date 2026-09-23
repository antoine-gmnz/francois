// cohorte-integration FR-69 — the run's activity log in the panel ("Tail logs"):
// the core's ring (≤200 fetched), then live rows from the wire stream. Rows are
// `hh:mm:ss · type · summary`, tinted for warning/error; unknown types read
// "unrecognised". Auto-scrolls unless the reader scrolled up.

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { CohorteRun } from '../../../contract/cohorte-integration';
import { isUnrecognisedType, logTone } from '../../lib/cohorte-log';
import { useCohorteStore } from '../../lib/cohorteStore';
import { Button } from '../../ui/Button';
import { SidePanelBody } from '../../ui/SidePanel';
import { copyCli, loadRunLog } from './actions';
import './cohorte.css';

function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function RunLog({ run, onBack }: { run: CohorteRun; onBack: () => void }): JSX.Element {
  const log = useCohorteStore((s) => s.logs[run.runId]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  useEffect(() => {
    void loadRunLog(run);
    // Fetched once per open; live rows append through the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.runId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  const cli = `cohorte tail ${run.runId} --json`;
  return (
    <div className="cohorte-log">
      <div className="cohorte-log__head">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back to run
        </Button>
        <button type="button" className="cohorte-cli truncate" title="Copy" onClick={() => copyCli(cli)}>
          {cli}
        </button>
      </div>
      {run.tailTruncated && <div className="cohorte-log__notice">Cohorte 3.0 shows the first 1000 events</div>}
      <SidePanelBody className="cohorte-log__body">
        <div
          ref={scroller}
          className="cohorte-log__rows"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {log === undefined && <div className="cohorte-log__empty">Loading…</div>}
          {log?.length === 0 && <div className="cohorte-log__empty">No events yet</div>}
          {log?.map((row) => {
            const unknown = isUnrecognisedType(row.type);
            return (
              <div key={`${row.sequence}:${row.sub}`} className={`cohorte-log__row cohorte-log__row--${logTone(row)}`} title={row.summary}>
                <span className="cohorte-log__at">{clock(row.at)}</span>
                <span className={unknown ? 'cohorte-log__type cohorte-log__type--unknown' : 'cohorte-log__type'}>
                  {row.type}
                  {unknown && ' · unrecognised'}
                </span>
                <span className="cohorte-log__summary">{row.summary}</span>
              </div>
            );
          })}
        </div>
      </SidePanelBody>
    </div>
  );
}
