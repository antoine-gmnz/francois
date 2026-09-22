// cloud-sessions FR-7/FR-15 §8 — the five-step phase list the modal renders
// INSTEAD of a spinner.
//
// Adoption takes up to 180s (FR-9). A silent spinner over that is how this
// feature earns a bug report, so every transition the core emits shows up here
// as a row: done · current · pending, and the row it stopped on when it failed.
// `aria-live="polite"` because progress the user cannot see is progress they do
// not have — and every row carries a text label, so state is never colour alone.

import { CLOUD_ADOPT_STEPS } from '../../../contract/cloud-sessions';
import { LoaderOrbit } from '../../ui/Loader';
import { StatusDot } from '../../ui/StatusDot';
import { ADOPT_STEP_LABELS, cloudErrorMessage, stepDotColor, stepState, type AdoptProgress } from './cloud-sessions';
import './cloud-sessions.css';

export function AdoptPhaseList({ progress }: { progress: AdoptProgress }): JSX.Element {
  return (
    <div className="adopt-phases">
      <div className="adopt-phases__steps" aria-live="polite">
        {CLOUD_ADOPT_STEPS.map((step) => {
          const state = stepState(step, progress);
          const label = ADOPT_STEP_LABELS[step];
          return (
            <div key={step} className={`adopt-phases__row adopt-phases__row--${state}`}>
              {/* The CURRENT row is work this view only watches (it runs in the
                  cloud), so it gets the shared Orbit rather than a pulsing dot;
                  done/pending/failed stay the static glyph. */}
              {state === 'current' ? <LoaderOrbit size={14} title={`${label} — in progress`} /> : <StatusDot color={stepDotColor(state)} size={6} />}
              <span className="adopt-phases__label">{label}</span>
            </div>
          );
        })}
      </div>
      {progress.error && <div className="adopt-phases__error">{cloudErrorMessage(progress.error)}</div>}
    </div>
  );
}
