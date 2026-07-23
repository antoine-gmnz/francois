// usage-bar (specs/usage-bar.md) — frontend unit tests.
// Covers the zustand `usage` slice (§6), the contract-typed invoke wrappers +
// the francois://app/event subscription helper (§5.1, FR-21/22/27), and every
// render derivation the bar depends on (FR-23/24/25/26/29, §7 #11/#12).
// No DOM framework is wired — UsageBar.tsx itself is a thin renderer over these.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent, UsageSnapshot } from '../contract/usage-bar';
import type { UsageMeter } from '../contract/common';

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

import { appGetUsage, appRefreshUsage, onAppEvent } from './api';
import { useStore } from './store';
import {
  formatCountdown,
  meterChipView,
  meterChipViews,
  parseResetAt,
  requestUsageRefresh,
  sessionResetLabel,
  startUsageFeed,
  usageBarView,
} from './usage';

const EMPTY: UsageSnapshot = { status: 'empty', meters: [], fetchedAt: null, error: null };

const meter = (label: string, percentUsed: number, resetsAt = 'Jul 22, 5:29pm (Europe/Paris)'): UsageMeter => ({
  label,
  percentUsed,
  resetsAt,
});

const ready = (meters: UsageMeter[], fetchedAt = 1_000_000): UsageSnapshot => ({
  status: 'ready',
  meters,
  fetchedAt,
  error: null,
});

/** Flush the microtask queue so promise chains inside the helpers settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  useStore.setState({ usage: EMPTY });
});

// ---------------------------------------------------------------- store slice

describe('usage store slice (§6)', () => {
  it('starts empty — the contract-shaped snapshot, nothing derived', () => {
    expect(useStore.getState().usage).toEqual(EMPTY);
  });

  it('setUsage replaces the whole snapshot and stores no derived state', () => {
    const snap = ready([meter('Current session', 42)]);
    useStore.getState().setUsage(snap);
    const stored = useStore.getState().usage;
    expect(stored).toEqual(snap);
    expect(Object.keys(stored).sort()).toEqual(['error', 'fetchedAt', 'meters', 'status']);
  });

  it('stores an error snapshot verbatim, keeping the stale meters the core retained (FR-18)', () => {
    const stale = [meter('Current week (all models)', 91)];
    useStore.getState().setUsage(ready(stale));
    useStore.getState().setUsage({
      status: 'error',
      meters: stale,
      fetchedAt: 1_000_000,
      error: { code: 'USAGE_UNAVAILABLE', message: 'Timed out fetching usage.' },
    });
    const stored = useStore.getState().usage;
    expect(stored.status).toBe('error');
    expect(stored.meters).toEqual(stale);
    expect(stored.fetchedAt).toBe(1_000_000);
  });
});

// ------------------------------------------------------------- api wrappers

describe('api wrappers (§5.1 physical binding)', () => {
  it('appGetUsage invokes app_get_usage with no payload and returns the Result verbatim', async () => {
    const snap = ready([meter('Current session', 42)]);
    invokeMock.mockResolvedValue({ ok: true, data: snap });
    await expect(appGetUsage()).resolves.toEqual({ ok: true, data: snap });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('app_get_usage', undefined);
  });

  it('appRefreshUsage invokes app_refresh_usage and resolves the ack', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { started: false } });
    await expect(appRefreshUsage()).resolves.toEqual({ ok: true, data: { started: false } });
    expect(invokeMock).toHaveBeenCalledWith('app_refresh_usage', undefined);
  });

  it('appGetUsage surfaces an ok:false Result rather than throwing', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'poisoned' } });
    const res = await appGetUsage();
    expect(res.ok).toBe(false);
  });

  it('onAppEvent listens on francois://app/event and unwraps the payload', async () => {
    let handler: ((e: { payload: AppEvent }) => void) | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation((_name: string, cb: (e: { payload: AppEvent }) => void) => {
      handler = cb;
      return Promise.resolve(unlisten);
    });
    const seen: AppEvent[] = [];
    const off = await onAppEvent((e) => seen.push(e));
    expect(listenMock).toHaveBeenCalledWith('francois://app/event', expect.any(Function));

    const snap = ready([meter('Current session', 7)]);
    handler?.({ payload: { type: 'usage.state', snapshot: snap } });
    expect(seen).toEqual([{ type: 'usage.state', snapshot: snap }]);

    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------- feed / event handler

describe('startUsageFeed (FR-21/22, §7 #12/#13)', () => {
  let handler: ((e: { payload: AppEvent }) => void) | undefined;
  let unlisten: ReturnType<typeof vi.fn>;
  let listenResolve: ((u: () => void) => void) | undefined;

  beforeEach(() => {
    handler = undefined;
    listenResolve = undefined;
    unlisten = vi.fn();
    listenMock.mockImplementation((_name: string, cb: (e: { payload: AppEvent }) => void) => {
      handler = cb;
      return new Promise<() => void>((resolve) => {
        listenResolve = resolve;
      });
    });
    invokeMock.mockResolvedValue({ ok: true, data: EMPTY });
  });

  const settleListen = () => listenResolve?.(unlisten);

  it('seeds from the cached snapshot exactly once and subscribes (FR-21)', async () => {
    const cached = ready([meter('Current session', 42)]);
    invokeMock.mockResolvedValue({ ok: true, data: cached });
    const applied: UsageSnapshot[] = [];

    const stop = startUsageFeed((s) => applied.push(s));
    settleListen();
    await tick();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('app_get_usage', undefined);
    expect(listenMock).toHaveBeenCalledWith('francois://app/event', expect.any(Function));
    expect(applied).toEqual([cached]);
    stop();
  });

  it('applies the snapshot from every usage.state event', async () => {
    const applied: UsageSnapshot[] = [];
    const stop = startUsageFeed((s) => applied.push(s));
    settleListen();
    await tick();
    applied.length = 0;

    const loading: UsageSnapshot = { status: 'loading', meters: [], fetchedAt: null, error: null };
    const done = ready([meter('Current session', 42)]);
    handler?.({ payload: { type: 'usage.state', snapshot: loading } });
    handler?.({ payload: { type: 'usage.state', snapshot: done } });

    expect(applied).toEqual([loading, done]);
    stop();
  });

  it('ignores an app event that is not usage.state (the union is extensible)', async () => {
    const applied: UsageSnapshot[] = [];
    const stop = startUsageFeed((s) => applied.push(s));
    settleListen();
    await tick();
    applied.length = 0;

    handler?.({ payload: { type: 'something.else' } as unknown as AppEvent });
    expect(applied).toEqual([]);
    stop();
  });

  it('does not let a late seed clobber a newer event', async () => {
    let resolveGet: ((r: unknown) => void) | undefined;
    invokeMock.mockImplementation(() => new Promise((r) => (resolveGet = r)));
    const applied: UsageSnapshot[] = [];
    const stop = startUsageFeed((s) => applied.push(s));
    settleListen();
    await tick();

    const fresh = ready([meter('Current session', 42)]);
    handler?.({ payload: { type: 'usage.state', snapshot: fresh } });
    resolveGet?.({ ok: true, data: EMPTY }); // stale cache read lands after the event
    await tick();

    expect(applied).toEqual([fresh]);
    stop();
  });

  it('tears the subscription down on stop and applies nothing afterwards (§7 #12)', async () => {
    const applied: UsageSnapshot[] = [];
    const stop = startUsageFeed((s) => applied.push(s));
    settleListen();
    await tick();
    applied.length = 0;

    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
    handler?.({ payload: { type: 'usage.state', snapshot: ready([meter('Current session', 42)]) } });
    expect(applied).toEqual([]);
  });

  it('unsubscribes even when stop() runs before listen() resolves', async () => {
    const applied: UsageSnapshot[] = [];
    const stop = startUsageFeed((s) => applied.push(s));
    stop();
    settleListen();
    await tick();

    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([]); // the seed must not land on an unmounted bar either
  });

  it('survives an ok:false seed and a rejected seed without throwing', async () => {
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'poisoned' } });
    const applied: UsageSnapshot[] = [];
    const stop1 = startUsageFeed((s) => applied.push(s));
    settleListen();
    await tick();
    expect(applied).toEqual([]);
    stop1();

    invokeMock.mockRejectedValue(new Error('ipc down'));
    const stop2 = startUsageFeed((s) => applied.push(s));
    settleListen();
    await tick();
    expect(applied).toEqual([]);
    stop2();
  });
});

// ------------------------------------------------------------- manual refresh

describe('requestUsageRefresh (FR-27/28)', () => {
  it('fires app_refresh_usage and returns nothing — the UI reacts to events, not the ack', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { started: true } });
    expect(requestUsageRefresh()).toBeUndefined();
    await tick();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('app_refresh_usage', undefined);
  });

  it('ignores { started: false } (a probe was already in flight, §7 #6)', async () => {
    invokeMock.mockResolvedValue({ ok: true, data: { started: false } });
    requestUsageRefresh();
    await tick();
    expect(useStore.getState().usage).toEqual(EMPTY); // no local state change from the ack
  });

  it('swallows an ok:false ack and a rejected call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'poisoned' } });
    requestUsageRefresh();
    await tick();
    invokeMock.mockRejectedValue(new Error('ipc down'));
    requestUsageRefresh();
    await tick();
    warn.mockRestore();
  });
});

// -------------------------------------------------------------- meter chips

describe('meterChipView (FR-23/24/29, §7 #11)', () => {
  it('is accent below 80% and error red at 80% — fill and number matching (FR-24)', () => {
    expect(meterChipView(meter('a', 79)).color).toBe('var(--accent)');
    expect(meterChipView(meter('a', 80)).color).toBe('var(--error)');
    expect(meterChipView(meter('a', 79)).fillPercent).toBe(79);
  });

  it('clamps the fill to 100% while printing the verbatim number (§7 #11)', () => {
    const chip = meterChipView(meter('Current session', 130));
    expect(chip.fillPercent).toBe(100);
    expect(chip.percentText).toBe('130%');
    expect(chip.color).toBe('var(--error)');
  });

  it('clamps a negative fill to 0% and prints it verbatim', () => {
    const chip = meterChipView(meter('Current session', -5));
    expect(chip.fillPercent).toBe(0);
    expect(chip.percentText).toBe('-5%');
  });

  it('carries the FR-29 tooltip built from the verbatim label and reset text', () => {
    const chip = meterChipView(meter('Current week (all models)', 12, 'Jul 28, 9:00am (Europe/Paris)'));
    expect(chip.title).toBe('Current week (all models) — resets Jul 28, 9:00am (Europe/Paris)');
    expect(chip.label).toBe('Current week (all models)');
  });

  it('renders every meter in core order, unfiltered and unrelabelled (FR-23)', () => {
    const meters = [meter('Current session', 42), meter('Current week (all models)', 91), meter('Opus weekly', 0)];
    const chips = meterChipViews(meters);
    expect(chips.map((c) => c.label)).toEqual(['Current session', 'Current week (all models)', 'Opus weekly']);
    expect(chips.map((c) => c.percentText)).toEqual(['42%', '91%', '0%']);
  });
});

// --------------------------------------------------------------- bar view

describe('usageBarView (FR-25/26, §8 states)', () => {
  const now = 1_000_000;

  it('empty → the "usage —" placeholder, no chips, no error, freshness "never"', () => {
    const v = usageBarView(EMPTY, now);
    expect(v.empty).toBe(true);
    expect(v.chips).toEqual([]);
    expect(v.error).toBeNull();
    expect(v.dimmed).toBe(false);
    expect(v.freshness).toBe('never');
  });

  it('ready → chips, no dim, no error, timestamped freshness', () => {
    const v = usageBarView(ready([meter('Current session', 42)], now - 120_000), now);
    expect(v.empty).toBe(false);
    expect(v.chips).toHaveLength(1);
    expect(v.dimmed).toBe(false);
    expect(v.error).toBeNull();
    expect(v.freshness).toBe('updated 2m ago');
  });

  it('loading WITH data → the same chips, dimmed (FR-25 — no spinner, no placeholder)', () => {
    const meters = [meter('Current session', 42)];
    const v = usageBarView({ status: 'loading', meters, fetchedAt: now - 30_000, error: null }, now);
    expect(v.dimmed).toBe(true);
    expect(v.chips).toHaveLength(1);
    expect(v.empty).toBe(false);
    expect(v.freshness).toBe('just now');
  });

  it('loading with NO data → the placeholder, never dimmed into invisibility', () => {
    const v = usageBarView({ status: 'loading', meters: [], fetchedAt: null, error: null }, now);
    expect(v.empty).toBe(true);
    expect(v.dimmed).toBe(false);
    expect(v.chips).toEqual([]);
  });

  it('error with NO data → the full one-line affordance instead of meters (FR-26)', () => {
    const v = usageBarView(
      {
        status: 'error',
        meters: [],
        fetchedAt: null,
        error: { code: 'SPAWN_FAILED', message: "Claude Code CLI not found. Install it and ensure 'claude' is on PATH." },
      },
      now,
    );
    expect(v.error).toEqual({
      compact: false,
      message: "Claude Code CLI not found. Install it and ensure 'claude' is on PATH.",
    });
    expect(v.chips).toEqual([]);
    expect(v.empty).toBe(false); // the error affordance replaces the placeholder
  });

  it('error WITH stale data → stale chips plus the compact glyph (FR-26)', () => {
    const meters = [meter('Current session', 42)];
    const v = usageBarView(
      { status: 'error', meters, fetchedAt: now - 600_000, error: { code: 'USAGE_UNAVAILABLE', message: 'Timed out fetching usage.' } },
      now,
    );
    expect(v.error).toEqual({ compact: true, message: 'Timed out fetching usage.' });
    expect(v.chips).toHaveLength(1);
    expect(v.dimmed).toBe(false);
    expect(v.freshness).toBe('updated 10m ago');
  });

  it('falls back to a readable message when an error snapshot carries none', () => {
    const v = usageBarView({ status: 'error', meters: [], fetchedAt: null, error: null }, now);
    expect(v.error?.message).toBe('usage unavailable');
  });

  it('takes the clock as a parameter — it never reads Date.now itself', () => {
    const snap = ready([meter('Current session', 42)], 0);
    expect(usageBarView(snap, 0).freshness).toBe('just now');
    expect(usageBarView(snap, 3 * 60_000).freshness).toBe('updated 3m ago');
  });
});

// FR-30 — the session reset countdown in the trailing slot. The CLI's `resetsAt`
// is verbatim free text with NO year, so the parser must degrade, never guess.
describe('reset countdown (FR-30)', () => {
  const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo, d, h, mi, 0, 0).getTime();

  describe('parseResetAt', () => {
    it('parses the full CLI form, ignoring the informational timezone', () => {
      const now = at(2026, 6, 22, 13, 0); // Jul 22 2026, 1:00pm local
      expect(parseResetAt('Jul 22, 5:29pm (Europe/Paris)', now)).toBe(at(2026, 6, 22, 17, 29));
    });

    it('parses am times and a bare date (midnight)', () => {
      const now = at(2026, 6, 22, 13, 0);
      expect(parseResetAt('Jul 25, 11:00am (Europe/Paris)', now)).toBe(at(2026, 6, 25, 11, 0));
      expect(parseResetAt('Jul 22', now)).toBe(at(2026, 6, 22, 0, 0));
    });

    it('handles the 12am/12pm boundary', () => {
      const now = at(2026, 6, 22, 13, 0);
      expect(parseResetAt('Jul 23, 12:00am', now)).toBe(at(2026, 6, 23, 0, 0));
      expect(parseResetAt('Jul 23, 12:30pm', now)).toBe(at(2026, 6, 23, 12, 30));
    });

    it('picks the year closest to now, so a Dec->Jan rollover works both ways', () => {
      // Dec 31 2026 -> a 'Jan 2' reset is NEXT year, not 11 months in the past.
      expect(parseResetAt('Jan 2, 9:00am', at(2026, 11, 31, 23, 0))).toBe(at(2027, 0, 2, 9, 0));
      // Jan 1 2027 -> a 'Dec 30' reset is LAST year.
      expect(parseResetAt('Dec 30, 9:00am', at(2027, 0, 1, 1, 0))).toBe(at(2026, 11, 30, 9, 0));
    });

    it('returns null for free text and impossible dates rather than guessing', () => {
      const now = at(2026, 6, 22, 13, 0);
      expect(parseResetAt('soon', now)).toBeNull();
      expect(parseResetAt('', now)).toBeNull();
      expect(parseResetAt('Smarch 4, 1:00pm', now)).toBeNull();
      expect(parseResetAt('Feb 30, 1:00pm', now)).toBeNull(); // must not roll into Mar 2
      expect(parseResetAt('Jul 22, 25:00', now)).toBeNull();
    });
  });

  describe('formatCountdown', () => {
    it('scales the unit to the magnitude', () => {
      expect(formatCountdown(47 * 60_000)).toBe('47m');
      expect(formatCountdown(4 * 3_600_000 + 12 * 60_000)).toBe('4h 12m');
      expect(formatCountdown(3 * 86_400_000 + 2 * 3_600_000)).toBe('3d 2h');
    });

    it('collapses sub-minute and already-past to "now" — never a negative', () => {
      expect(formatCountdown(30_000)).toBe('now');
      expect(formatCountdown(0)).toBe('now');
      expect(formatCountdown(-5 * 3_600_000)).toBe('now');
    });
  });

  describe('sessionResetLabel', () => {
    const now = at(2026, 6, 22, 13, 0);

    it('counts down the SESSION meter, not the first or the weekly one', () => {
      const meters = [meter('Current week (all models)', 34, 'Jul 25, 11:00am'), meter('Current session', 14, 'Jul 22, 5:29pm')];
      expect(sessionResetLabel(meters, now)).toBe('resets in 4h 29m');
    });

    it('falls back to the first meter when no label mentions a session', () => {
      expect(sessionResetLabel([meter('Current week (all models)', 34, 'Jul 25, 11:00am')], now)).toBe('resets in 2d 22h');
    });

    it('shows an unparseable resetsAt verbatim instead of dropping it', () => {
      expect(sessionResetLabel([meter('Current session', 14, 'soon')], now)).toBe('resets soon');
    });

    it('says "resets now" rather than "resets in now" at the boundary', () => {
      expect(sessionResetLabel([meter('Current session', 99, 'Jul 22, 1:00pm')], now)).toBe('resets now');
    });

    it('is null with no meters at all, so the bar can fall back to freshness', () => {
      expect(sessionResetLabel([], now)).toBeNull();
    });
  });

  describe('usageBarView trailing slot', () => {
    const now = at(2026, 6, 22, 13, 0);

    it('joins freshness and reset with a middot', () => {
      const v = usageBarView(ready([meter('Current session', 14, 'Jul 22, 5:29pm (Europe/Paris)')], now - 120_000), now);
      expect(v.trailing).toBe('updated 2m ago · resets in 4h 29m');
      expect(v.reset).toBe('resets in 4h 29m');
      expect(v.resetTitle).toBe('Current session — resets Jul 22, 5:29pm (Europe/Paris) · click to refresh');
    });

    it('shows freshness alone when there is no meter to derive a reset from', () => {
      const v = usageBarView({ status: 'error', meters: [], fetchedAt: now - 600_000, error: null }, now);
      expect(v.reset).toBeNull();
      expect(v.trailing).toBe('updated 10m ago');
      expect(v.resetTitle).toBe('click to refresh');
    });

    it('never renders an empty trailing slot — it is the click target', () => {
      const v = usageBarView({ status: 'empty', meters: [], fetchedAt: null, error: null }, now);
      expect(v.trailing).toBe('never');
    });

    it('drops a contradictory "never" rather than pairing it with a live reset', () => {
      // fetchedAt null WITH meters is contract-illegal; the slot must still read sanely.
      const v = usageBarView({ status: 'ready', meters: [meter('Current session', 14, 'Jul 22, 5:29pm')], fetchedAt: null, error: null }, now);
      expect(v.trailing).toBe('resets in 4h 29m');
    });

    it('still reports a reset while stale, so an error keeps the countdown readable', () => {
      const snap: UsageSnapshot = {
        status: 'error',
        meters: [meter('Current session', 14, 'Jul 22, 5:29pm')],
        fetchedAt: now - 600_000,
        error: { code: 'USAGE_UNAVAILABLE', message: 'Timed out fetching usage.' },
      };
      expect(usageBarView(snap, now).reset).toBe('resets in 4h 29m');
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
