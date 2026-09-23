// cohorte-integration FR-61..FR-65 — a pending Cohorte gate, answerable in place.
//
//   full     (frame 25 `154:15465`) the inline transcript card: head, question,
//            findings with file:line, md buttons with 1/2/3, the CLI hint of
//            the focused/hovered action, the deny confirm, the step outcome.
//   compact  (frame 25 panel) head + summary + sm buttons + the approve CLI.
//
// Every action is the CLI through the core; the hint shows the exact argv.

import { useState } from 'react';
import type { CohorteGate, CohorteGateActionId, CohorteRun } from '../../../contract/cohorte-integration';
import { formatRelativeTime } from '../../../contract/fleet-board';
import { useCohorteStore } from '../../lib/cohorteStore';
import { useElapsedClock } from '../../lib/hooks/useElapsedClock';
import { Button } from '../../ui/Button';
import { StateIcon } from '../../ui/StateIcon';
import { Tag } from '../../ui/Tag';
import { answerGate, copyCli } from './actions';
import { FindingRow } from './CohorteParts';
import './cohorte.css';
import { ACTION_KEYS, ACTION_VARIANT, actionLabel, compactActionLabel, gateHint, gateKindLabel, gateQuestion, gateSummary, runSpecName } from './gate-view';
import { stepLine } from './outcome';
import { shortRunId } from './run-view';
import { useGateKeys } from './useGateKeys';

const PREVIEW_LINES = 8;

export interface GateCardProps {
  run: CohorteRun;
  gate: CohorteGate;
  variant: 'full' | 'compact';
  /** the origin session — its composer draft is the fix step's note (FR-64) */
  sessionId?: string | null;
  /** FR-63: the card is on screen in the focused main pane (compact never takes keys) */
  keysActive?: boolean;
}

export function GateCard({ run, gate, variant, sessionId, keysActive = false }: GateCardProps): JSX.Element {
  const busy = useCohorteStore((s) => s.busy[run.runId] ?? null);
  const outcome = useCohorteStore((s) => s.lastOutcome[run.runId] ?? null);
  const [armed, setArmed] = useState(false);
  const [hover, setHover] = useState<CohorteGateActionId | null>(null);
  const now = useElapsedClock(true, 30_000);
  const deny = gate.actions.find((a) => a.id === 'deny');
  const kind = gate.request.kind;

  const run1 = (id: CohorteGateActionId) => {
    if (id === 'deny' && deny?.stopsRun && !armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    void answerGate(run, id, sessionId);
  };

  useGateKeys({
    runId: run.runId,
    active: keysActive && variant === 'full',
    offered: gate.actions.map((a) => a.id),
    denyStopsRun: deny?.stopsRun ?? false,
    armed,
    setArmed,
    onRun: (id) => void answerGate(run, id, sessionId),
  });

  const hint = gateHint(gate, hover);
  const waiting = formatRelativeTime(gate.requestedAt, now);
  const buttons = gate.actions.map((a) => (
    <Button
      key={a.id}
      variant={ACTION_VARIANT[a.id]}
      size={variant === 'full' ? 'md' : 'sm'}
      shortcut={variant === 'full' ? ACTION_KEYS[a.id] : undefined}
      disabled={busy !== null}
      title={a.cli.join('\n')}
      onMouseEnter={() => setHover(a.id)}
      onMouseLeave={() => setHover(null)}
      onFocus={() => setHover(a.id)}
      onBlur={() => setHover(null)}
      onClick={() => run1(a.id)}
    >
      {busy === a.id && <StateIcon kind="running" size={12} />}
      {variant === 'full' ? actionLabel(a, kind) : compactActionLabel(a)}
    </Button>
  ));
  const hints = (
    <span className="cohorte-gate__hints">
      {hint.map((line) => (
        <button key={line} type="button" className="cohorte-cli" title="Copy" onClick={() => copyCli(line)}>
          {line}
        </button>
      ))}
    </span>
  );
  const steps = outcome && outcome.steps.length > 0 && (
    <div className="cohorte-gate__outcome" role="status">
      {outcome.steps.map((s, i) => {
        const line = stepLine(s);
        return (
          <div key={`${s.cli}:${i}`} className={`cohorte-gate__step cohorte-gate__step--${line.tone}`}>
            {line.text}
          </div>
        );
      })}
    </div>
  );
  const confirm = armed && (
    <div className="cohorte-gate__confirm" role="alert">
      <span>
        Deny and cancel <code>{shortRunId(run.runId)}</code>?
      </span>
      <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => run1('deny')}>
        Confirm
      </Button>
      <span className="cohorte-gate__confirm-keys">3 / Enter confirm · Esc back</span>
      <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
        Back
      </Button>
    </div>
  );

  if (variant === 'compact') {
    return (
      <div className="cohorte-gate cohorte-gate--compact">
        <div className="cohorte-gate__head">
          <StateIcon kind="approval" size={14} />
          <span className="cohorte-gate__label cohorte-gate__label--grow">GATE · {gateKindLabel(kind)}</span>
          <span className="cohorte-gate__age">{waiting}</span>
        </div>
        <p className="cohorte-gate__summary">{gateSummary(gate)}</p>
        <div className="cohorte-gate__actions cohorte-gate__actions--compact">{buttons}</div>
        {confirm}
        {steps}
        {hints}
      </div>
    );
  }

  const preview = gate.request.preview;
  const showPreview = gate.findings.length === 0 && (preview.kind === 'command' || preview.kind === 'diff') && preview.text !== '';
  return (
    <section className="cohorte-gate cohorte-gate--full" aria-label="Cohorte gate">
      <div className="cohorte-gate__head">
        <StateIcon kind="approval" size={14} />
        <span className="cohorte-gate__label">COHORTE GATE · {gateKindLabel(kind)}</span>
        {gate.phaseIndex !== undefined && <Tag>{`phase ${gate.phaseIndex} of ${gate.phaseCount}`}</Tag>}
        <span className="cohorte-spacer" />
        {gate.request.expiresAt !== undefined && (
          <span className="cohorte-gate__age">
            {gate.request.expiresAt > now ? `expires in ${formatRelativeTime(now, gate.request.expiresAt)}` : 'expired'} ·{' '}
          </span>
        )}
        <span className="cohorte-gate__age">waiting {waiting}</span>
      </div>
      <h3 className="cohorte-gate__question">{gateQuestion(gate, runSpecName(run))}</h3>
      {gate.findings.length > 0 ? (
        <div className="cohorte-gate__findings">
          {gate.findings.map((f) => (
            <FindingRow key={f.id} finding={f} variant="full" />
          ))}
        </div>
      ) : (
        gate.request.reason && gateQuestion(gate, runSpecName(run)) !== gate.request.reason && <p className="cohorte-gate__reason">{gate.request.reason}</p>
      )}
      {showPreview && <PreviewBlock text={preview.text} truncated={preview.truncated} />}
      {gate.morePending > 0 && <p className="cohorte-gate__more">+{gate.morePending} more pending</p>}
      <div className="cohorte-gate__actions">
        {buttons}
        <span className="cohorte-spacer" />
        {hints}
      </div>
      {confirm}
      {steps}
    </section>
  );
}

function PreviewBlock({ text, truncated }: { text: string; truncated: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const cut = !open && lines.length > PREVIEW_LINES;
  return (
    <div className="cohorte-gate__preview">
      <pre>{cut ? lines.slice(0, PREVIEW_LINES).join('\n') : text}</pre>
      {(cut || (open && lines.length > PREVIEW_LINES)) && (
        <button type="button" className="cohorte-link" onClick={() => setOpen((o) => !o)}>
          {open ? 'show less' : 'show more'}
        </button>
      )}
      {truncated && open && <span className="cohorte-gate__age">preview truncated by Cohorte</span>}
    </div>
  );
}
