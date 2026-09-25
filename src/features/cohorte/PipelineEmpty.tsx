// The Pipeline view before any feature exists — frame 38 (Figma 225:22467).
// Teaches the one move that starts everything (Intake), shows the six stages
// a feature will travel, and offers the CLI equivalent for terminal people.

import type { SessionId } from '../../../contract/common';
import { useCohorteActionsStore } from '../../lib/cohorteActionsStore';
import { Button } from '../../ui/Button';

const STAGES = ['Intake', 'Brainstorm', 'Spec', 'Freeze', 'Run', 'Ship'] as const;

const NEXT_STEPS = [
  { title: 'Intake', detail: 'triages what arrived into a brief' },
  { title: 'Brainstorm · Spec', detail: 'guided, in a terminal tab' },
  { title: 'Run', detail: 'build → review → fix, then ship' },
] as const;

export function PipelineEmpty({ sessionId }: { sessionId: SessionId }): JSX.Element {
  const actions = useCohorteActionsStore.getState;
  return (
    <div className="cohorte-pipeline-empty">
      <div className="cohorte-pipeline-empty__ghost" aria-hidden="true">
        <div className="cohorte-pipeline-empty__track">
          {STAGES.map((stage, i) => (
            <span key={stage} className={i === 0 ? 'cohorte-pipeline-empty__seg cohorte-pipeline-empty__seg--start' : 'cohorte-pipeline-empty__seg'} />
          ))}
        </div>
        <div className="cohorte-pipeline-empty__stages">
          {STAGES.map((stage, i) => (
            <span key={stage} className={i === 0 ? 'cohorte-pipeline-empty__stage cohorte-pipeline-empty__stage--start' : 'cohorte-pipeline-empty__stage'}>
              {stage}
            </span>
          ))}
        </div>
      </div>

      <div className="cohorte-pipeline-empty__copy">
        <h3 className="cohorte-pipeline-empty__title">No features yet</h3>
        <p className="cohorte-pipeline-empty__text">
          Every feature starts as a brief. Paste a ticket, an email or a stack trace — Cohorte triages it into a
          feature or a patch, and it shows up here with its next step.
        </p>
      </div>

      <div className="cohorte-pipeline-empty__actions">
        <Button size="sm" variant="primary" onClick={() => actions().openSheet({ action: 'intake', sessionId })}>
          Start with intake
        </Button>
        <Button size="sm" variant="ghost" onClick={() => actions().openMenu(sessionId)}>
          All actions
        </Button>
      </div>

      <div className="cohorte-pipeline-empty__terminal">
        <span className="cohorte-pipeline-empty__label">Or from a terminal</span>
        <code className="cohorte-pipeline-empty__cmd">$ cohorte intake --title … --text …</code>
      </div>

      <div className="cohorte-pipeline-empty__next">
        <span className="cohorte-pipeline-empty__label">What happens next</span>
        <ol className="cohorte-pipeline-empty__steps">
          {NEXT_STEPS.map((step, i) => (
            <li key={step.title} className="cohorte-pipeline-empty__step">
              <span className="cohorte-pipeline-empty__num">{i + 1}</span>
              <span className="cohorte-pipeline-empty__step-text">
                <span className="cohorte-pipeline-empty__step-title">{step.title}</span>
                <span className="cohorte-pipeline-empty__step-detail">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
