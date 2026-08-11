// usage-bar (specs/usage-bar.md §8) — the always-mounted plan-limit meters.
//
// design 7a: this used to be the whole titlebar (`UsageBar`, brand cluster
// included). 7a's app row owns the brand, the nav and the account cluster, so
// what is left here is exactly the meter region — same data, same events, same
// click-to-refresh affordance, mounted by AppRow instead of by App.
//
// Pure chrome: NOT a focusable pane (FR-3 — no tabIndex, no key handling, no
// focus ring) and NO motion at all (FR-25 — no @keyframes, no animation, no
// transition anywhere in this file; the webview may fall back to software
// compositing, where permanent chrome that animates repaints forever).
//
// All logic lives in ./usage (covered by src/features/usage/usage.test.ts); this
// file only maps the view model onto §8's tokens.

import { useEffect, useState } from 'react';
import { focusedSessionId } from '../../lib/layoutStore';
import { useStore } from '../../lib/store';
import { accountDisplayLabel, findAccount, usageAccountId } from '../accounts/accounts';
import { EMPTY_USAGE } from '../../lib/usageStore';
import './usage.css';
import { requestUsageRefresh, seedAccountUsage, startUsageFeed, usageBarView, type MeterChipView } from './usage';

function MeterChip({ chip }: { chip: MeterChipView }) {
  return (
    <span title={chip.title} className="usage-chip">
      <span className="usage-chip-label">{chip.label}</span>
      <span className="usage-track">
        {/* renders straight at its final width — no transition (FR-25) */}
        <span className="usage-fill" style={{ width: `${chip.fillPercent}%`, background: chip.color }} />
      </span>
      {/* No inline colour: the fill above carries the severity hue, the figure
          stays neutral (--text-hint) as in the mock — design-refresh FR-4. */}
      <span className="usage-percent">{chip.percentText}</span>
    </span>
  );
}

export default function UsageMeters() {
  const setAccountUsage = useStore((s) => s.setAccountUsage);
  const [now, setNow] = useState(() => Date.now());
  const [freshHover, setFreshHover] = useState(false);

  const sessions = useStore((s) => s.sessions);
  // split-session FR-7: the meters follow the FOCUSED session, which equals
  // activeSessionId whenever the app is not split.
  const activeSessionId = useStore((s) => focusedSessionId(s));
  const split = useStore((s) => s.extraPanes.length > 0);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  // multi-account FR-30: the bar renders the SELECTED session's account —
  // derived, never stored, so it can never drift from the session cache.
  const accounts = useStore((s) => s.accounts);
  const accountId = usageAccountId(accounts, sessions, activeSessionId);
  const account = findAccount(accounts, accountId);
  const accountLabel = account ? accountDisplayLabel(account) : null;
  const snapshot = useStore((s) => s.usageByAccount[accountId]) ?? EMPTY_USAGE;

  // FR-21/22: follow francois://app/event for every account's snapshot; the
  // returned teardown unsubscribes on unmount (§7 #12).
  useEffect(() => startUsageFeed(setAccountUsage), [setAccountUsage]);

  // FR-21 + multi-account FR-27: seed the cache for whichever account is on
  // screen. Re-runs on an account switch; the teardown makes a resolution that
  // lands after the switch a no-op.
  useEffect(() => seedAccountUsage(accountId, setAccountUsage), [accountId, setAccountUsage]);

  // Trailing-label granularity only (the reset countdown, FR-30): one text tick a
  // minute. Not motion — a single setState/min, no repaint loop (contrast with an
  // animation, FR-25). The countdown's finest unit is the minute, so this matches.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const view = usageBarView(snapshot, now, accountLabel ?? undefined);
  const fullError = view.error && !view.error.compact ? view.error : null;
  const refresh = () => requestUsageRefresh(accountId);

  return (
    <div
      onClick={refresh}
      // Keep focus where it was: a bare div steals it to <body> on mousedown, and
      // App.tsx's global keys only stand down while focus is in an input/terminal —
      // so without this the next keystroke after a click fires `n`/`d`/`t` (FR-3).
      onMouseDown={(e) => e.preventDefault()}
      // loading WITH data: a plain opacity swap, nothing else (FR-25)
      className={`usage-meters${view.dimmed ? ' usage-meters--dimmed' : ''}`}
    >
      {/* split-session §8: while split the quota cluster says WHOSE quota it
          is showing — the meters silently follow the focused pane otherwise. */}
      {split && activeSession && <span className="usage-focused-label truncate">focused · {activeSession.name}</span>}
      {fullError ? (
        // no stale data to protect → the one-line affordance replaces the meters (FR-26)
        <span title={fullError.message} className="usage-error-full">
          <span>⚠</span>
          <span>usage unavailable</span>
        </span>
      ) : (
        <>
          {/* stale meters survive an error; the glyph shrinks to bare ⚠ beside them (FR-26) */}
          {view.error && (
            <span title={view.error.message} className="usage-error-glyph">
              ⚠
            </span>
          )}
          {view.empty ? (
            <span className="usage-empty">usage —</span>
          ) : (
            view.chips.map((chip, i) => <MeterChip key={`${chip.label}:${i}`} chip={chip} />)
          )}
        </>
      )}
      {/* freshness + session reset countdown, joined by ' · ' (FR-30); degrades to
          whichever half exists — doubles as the refresh affordance (§8) */}
      <span
        onClick={refresh}
        onMouseDown={(e) => e.preventDefault()} // see the meter region above (FR-3)
        onMouseEnter={() => setFreshHover(true)}
        onMouseLeave={() => setFreshHover(false)}
        title={view.resetTitle}
        className={`usage-fresh${freshHover ? ' usage-fresh--hover' : ''}`}
      >
        {view.trailing}
      </span>
    </div>
  );
}
