// cohorte-actions FR-51 — the intake result card, mounted in the transcript's
// trailing slot (same pattern as CohorteInlineGate in ConversationView). Up to
// 5 cards per session (cohorteActionsStore), newest last; each answers with
// 1/2/3 — reusing the gate-keys editable-target guard rather than a new one.

import { useEffect, useState } from 'react';
import type { SessionId } from '../../../contract/common';
import { useCohorteActionsStore, type CohorteResultEntry } from '../../lib/cohorteActionsStore';
import { isEditableTarget } from './gate-keys';
import { formatDuration } from './run-view';
import { cohorteIntakeContinueArgs } from './command-display';
import { intakeNextAction } from './intake-validate';
import { openCohorteTerminal } from './terminal';
import './cohorte.css';

export function CohorteActionResultCards({ sessionId, keysActive }: { sessionId: SessionId; keysActive: boolean }): JSX.Element | null {
  const results = useCohorteActionsStore((s) => s.results[sessionId]);
  if (!results || results.length === 0) return null;
  const lastId = results[results.length - 1].id;
  return (
    <>
      {results.map((entry) => (
        <ResultCard key={entry.id} sessionId={sessionId} entry={entry} keysActive={keysActive && entry.id === lastId} />
      ))}
    </>
  );
}

function ResultCard({ sessionId, entry, keysActive }: { sessionId: SessionId; entry: CohorteResultEntry; keysActive: boolean }): JSX.Element {
  const { result } = entry;
  const needsAnswers = intakeNextAction(result) === null;
  const [answers, setAnswers] = useState<string[]>(() => result.questions.map(() => ''));
  const [route, setRoute] = useState<'feature' | 'patch' | ''>('');
  const [opening, setOpening] = useState(false);
  const dismiss = () => useCohorteActionsStore.getState().dismissResult(sessionId, entry.id);
  const brainstorm = () => useCohorteActionsStore.getState().openSheet({ action: 'brainstorm', sessionId, featureId: result.featureId });
  const writeSpec = () => useCohorteActionsStore.getState().openSheet({ action: 'spec', sessionId, featureId: result.featureId });
  const continueIntake = () => {
    if (opening) return;
    setOpening(true);
    void openCohorteTerminal(sessionId, `cohorte intake --continue ${result.featureId}`, {
      execute: true,
      argv: cohorteIntakeContinueArgs(result.featureId, answers, route),
    }).finally(() => setOpening(false));
  };

  useEffect(() => {
    if (!keysActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.defaultPrevented) return;
      if (isEditableTarget(document.activeElement as HTMLElement | null)) return;
      if (e.key === '1') {
        e.preventDefault();
        if (needsAnswers) continueIntake();
        else brainstorm();
      } else if (e.key === '2') {
        e.preventDefault();
        if (!needsAnswers) writeSpec();
      } else if (e.key === '3') {
        e.preventDefault();
        dismiss();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysActive, entry.id, needsAnswers, answers, route, opening]);

  return (
    <div className="conv-item cohorte-result cohorte-result--success">
      <div className="cohorte-result__head">
        <span className="cohorte-result__kicker">COHORTE · INTAKE</span>
        <span className="cohorte-spacer" />
        <span className="cohorte-result__meta">exit 0 · {formatDuration(result.durationMs)}</span>
      </div>
      <p className="cohorte-result__title">Brief stored as {result.featureId}</p>
      <p className="cohorte-result__row">
        <span className="cohorte-label">TRIAGE</span> {result.triage}
      </p>
      {result.reasons.length > 0 && (
        <ul className="cohorte-result__list">
          {result.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {needsAnswers && (
        <div className="cohorte-intake-answers">
          {result.questions.map((question, index) => (
            <label key={`${index}:${question}`} className="cohorte-intake-answers__field">
              <span>{index + 1}. {question}</span>
              <input
                className="cohorte-sheet__input"
                value={answers[index] ?? ''}
                maxLength={4000}
                onChange={event => setAnswers(current => current.map((value, at) => at === index ? event.target.value : value))}
                placeholder="Your answer — leave blank to answer in the terminal"
              />
            </label>
          ))}
          <label className="cohorte-intake-answers__field">
            <span>Continue as</span>
            <select className="cohorte-sheet__input" value={route} onChange={event => setRoute(event.target.value as 'feature' | 'patch' | '')}>
              <option value="">Choose in the terminal</option>
              <option value="feature">Feature</option>
              <option value="patch">Patch</option>
            </select>
          </label>
        </div>
      )}
      <p className="cohorte-cli">{result.command}</p>
      <div className="cohorte-result__actions">
        <button type="button" className="btn btn--primary btn--sm" disabled={opening} onClick={needsAnswers ? continueIntake : brainstorm}>
          {needsAnswers ? 'Continue intake in terminal' : 'Brainstorm'} <span className="composer-hint__key">1</span>
        </button>
        {!needsAnswers && <button type="button" className="btn btn--secondary btn--sm" onClick={writeSpec}>
          Write spec <span className="composer-hint__key">2</span>
        </button>}
        <button type="button" className="btn btn--ghost btn--sm" onClick={dismiss}>
          Dismiss <span className="composer-hint__key">3</span>
        </button>
      </div>
    </div>
  );
}
