// Figma "Switch" (125:7953): 30×18 track + 14px knob. On = --action-primary track
// with a --text-inverse knob; off = --bg-strong track with a --state-idle knob.
// A real role="switch" button, so it is keyboard- and screen-reader-operable.

import './ui.css';

export interface SwitchProps {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name — the switch renders no visible text. */
  label: string;
  className?: string;
}

export function Switch({ on, onChange, disabled, label, className }: SwitchProps): JSX.Element {
  const base = on ? 'switch switch--on' : 'switch';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={className ? `${base} ${className}` : base}
      onClick={() => onChange(!on)}
    >
      <span className="switch__knob" />
    </button>
  );
}
