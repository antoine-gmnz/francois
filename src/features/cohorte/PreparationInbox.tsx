import { useState } from 'react';
import type { CohorteDetection, CohorteGate } from '../../../contract/cohorte-integration';
import { focusedSessionId } from '../../lib/layoutStore';
import { useStore } from '../../lib/store';
import { Button } from '../../ui/Button';
import { actionLabel, gateKindLabel } from './gate-view';
import { initializationSummary, resolvePreparation } from './preparation';
import { openCohorteTerminal } from './terminal';
import { detectProject } from './useCohorte';
import './cohorte.css';

export function PreparationInbox({ detection, root }: { detection: CohorteDetection; root: string }) {
  const initialization = detection.initialization;
  const summary = initializationSummary(initialization?.analysis);
  return (
    <div className="cohorte-preparation">
      {initialization && (initialization.needsReview || initialization.questions.length > 0) && (
        <section className="cohorte-gate cohorte-preparation__card">
          <h3>Project setup needs your review</h3>
          <p>The project profile is awaiting confirmation in Cohorte.</p>
          {summary.length > 0 && <ul>{summary.map(line => <li key={line}>{line}</li>)}</ul>}
          {initialization.questions.length > 0 && <ol>{initialization.questions.map((question, index) => <li key={`${index}:${question}`}>{question}</li>)}</ol>}
          <Button size="sm" onClick={() => void openCohorteTerminal(focusedSessionId(useStore.getState()), 'cohorte init .', { execute: true, root, argv: ['init', '.'] })}>
            Review setup in terminal
          </Button>
        </section>
      )}
      {detection.pendingRequests?.map(gate => <PreparationRequest key={gate.request.approvalId} root={root} gate={gate} />)}
    </div>
  );
}

function PreparationRequest({ root, gate }: { root: string; gate: CohorteGate }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (response: Parameters<typeof resolvePreparation>[2]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void resolvePreparation(root, gate, response)
      .then(async result => {
        if (!result.ok) setError(result.error.message);
        else await detectProject(root, true);
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="cohorte-gate cohorte-preparation__card">
      <span className="cohorte-label">{gateKindLabel(gate.request.kind)}</span>
      <p>{gate.request.reason}</p>
      {gate.request.preview.text && <pre className="cohorte-preparation__preview">{gate.request.preview.text}</pre>}
      {gate.request.kind === 'question' ? (
        <form className="cohorte-intake-answers" onSubmit={event => { event.preventDefault(); submit({ answer }); }}>
          {gate.request.options?.length ? (
            <select aria-label="Your answer" className="cohorte-sheet__input" value={answer} onChange={event => setAnswer(event.target.value)}>
              <option value="">Choose an answer</option>
              {gate.request.options.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          ) : <input aria-label="Your answer" className="cohorte-sheet__input" maxLength={4000} value={answer} onChange={event => setAnswer(event.target.value)} />}
          <Button type="submit" size="sm" disabled={busy || !answer.trim()}>Send answer</Button>
        </form>
      ) : <div className="cohorte-result__actions">{gate.actions.map(action => <Button key={action.id} size="sm" disabled={busy} onClick={() => submit({ action: action.id })}>{actionLabel(action, gate.request.kind)}</Button>)}</div>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
