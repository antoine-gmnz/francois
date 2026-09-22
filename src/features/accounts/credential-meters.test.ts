// Settings / Accounts — a login card's meters (Figma "Meters", 140:7742): one
// column per meter, each with its OWN reset line.

import { describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '../../../contract/usage-bar';
import { credentialMeterViews } from './credential-meters';

const NOW = new Date(2026, 6, 22, 14, 19, 0).getTime(); // Jul 22, 14:19

const snap = (meters: UsageSnapshot['meters']): UsageSnapshot => ({ status: 'ready', meters, fetchedAt: NOW, error: null });

describe('credentialMeterViews', () => {
  it('no snapshot → nothing to draw', () => {
    expect(credentialMeterViews(undefined, NOW)).toEqual([]);
  });

  it('one view per meter, in core order, each with a countdown to its own reset', () => {
    const views = credentialMeterViews(
      snap([
        { label: 'Current session', percentUsed: 34, resetsAt: 'Jul 22, 5:29pm (Europe/Paris)' },
        { label: 'Current week (all models)', percentUsed: 61, resetsAt: 'Jul 27, 9am' },
      ]),
      NOW,
    );
    expect(views.map((v) => v.label)).toEqual(['Current session', 'Current week (all models)']);
    expect(views[0]).toMatchObject({ percentText: '34%', fillPercent: 34, high: false, reset: 'resets in 3h 10m' });
    expect(views[1].reset).toBe('resets in 4d 18h');
  });

  it('keeps unparseable reset text verbatim', () => {
    const [v] = credentialMeterViews(snap([{ label: 'Weekly', percentUsed: 10, resetsAt: 'soon' }]), NOW);
    expect(v.reset).toBe('resets soon');
  });

  it('flags a high meter and clamps the fill, but keeps the verbatim figure', () => {
    const [v] = credentialMeterViews(snap([{ label: 'Opus', percentUsed: 130, resetsAt: 'Jul 27' }]), NOW);
    expect(v).toMatchObject({ high: true, fillPercent: 100, percentText: '130%' });
  });
});
