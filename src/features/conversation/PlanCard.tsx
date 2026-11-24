// plan-view — the session's latest plan, drawn as a card between the
// turn's prose and its next tool calls (the Claude app's plan view). Which
// block earns the card is decided in ./plan-view; this file is DOM only.

import { memo } from 'react';
import { CircleCheck, CircleDashed, CircleDot, LoaderCircle } from 'lucide-react';
import type { PlanItem } from '../../../contract/common';
import { planStepLabel } from './plan-view';
import './conversation.css';

function StepIcon({ status, live }: { status: PlanItem['status']; live: boolean }) {
  if (status === 'completed') return <CircleCheck className="plancard__icon" size={14} aria-hidden />;
  if (status === 'pending') return <CircleDashed className="plancard__icon" size={14} aria-hidden />;
  // The spinner only spins while the turn is still running — a plan left
  // in-progress by a stopped turn must not keep claiming work is happening.
  return live ? (
    <LoaderCircle className="plancard__icon plancard__icon--spin" size={14} aria-hidden />
  ) : (
    <CircleDot className="plancard__icon" size={14} aria-hidden />
  );
}

function PlanCardImpl({ plan, live }: { plan: PlanItem[]; live: boolean }) {
  return (
    <ul className="plancard" aria-label="Plan">
      {plan.map((item, i) => (
        <li key={item.id ?? i} className={`plancard__step plancard__step--${item.status}`}>
          <StepIcon status={item.status} live={live} />
          <span className="plancard__label">{planStepLabel(item)}</span>
        </li>
      ))}
    </ul>
  );
}

export const PlanCard = memo(PlanCardImpl);
