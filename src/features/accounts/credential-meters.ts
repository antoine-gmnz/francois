// Settings / Accounts — a login card's meters (Figma "Meters", 140:7742). The
// usage bar shows ONE reset (the session limit's); a card has the width to give
// every meter its own "resets in 3h 10m" line, so this derives it per meter from
// the same parser the bar uses. Pure — `now` is passed in.

import type { UsageSnapshot } from '../../../contract/usage-bar';
import { formatCountdown, meterChipView, parseResetAt, USAGE_ERROR } from '../usage/usage';

export interface CredentialMeterView {
  label: string;
  /** The core's figure, verbatim ('130%' behind a full bar). */
  percentText: string;
  /** 0–100, clamped for the fill only. */
  fillPercent: number;
  /** At or over the high-water mark — the figure and fill turn danger. */
  high: boolean;
  /** `resets in 3h 10m`, or the CLI's own text when it cannot be parsed. */
  reset: string;
  title: string;
}

export function credentialMeterViews(snapshot: UsageSnapshot | undefined, now: number): CredentialMeterView[] {
  return (snapshot?.meters ?? []).map((meter) => {
    const chip = meterChipView(meter);
    const at = parseResetAt(meter.resetsAt, now);
    const countdown = at === null ? null : formatCountdown(at - now);
    const reset = countdown === null ? `resets ${meter.resetsAt}` : countdown === 'now' ? 'resets now' : `resets in ${countdown}`;
    return {
      label: chip.label,
      percentText: chip.percentText,
      fillPercent: chip.fillPercent,
      high: chip.color === USAGE_ERROR,
      reset,
      title: chip.title,
    };
  });
}
