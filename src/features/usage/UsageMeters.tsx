// usage-bar (specs/usage-bar.md §8) — the always-mounted plan-limit control.
//
// The app bar used to spell every meter out inline (`Session ▬ 42%  Week ▬
// 72%  …`); with several Claude Code accounts that ran out of room. It is now
// ONE 28px icon button — same data, same events, same click-to-refresh
// affordance — that opens a popover with the detail on demand. The icon signals
// a problem WITHOUT text (danger tint + a 5px dot, `update`'s `.upd-dot`
// pattern) when a meter is high or the probe is a full error; the popover's
// `title` carries the one-line summary for anyone who reads before clicking.
//
// Pure chrome: NOT a focusable pane (FR-3 — no tabIndex on the trigger beyond
// the button itself, no key handling beyond Escape/outside-click to dismiss)
// and NO motion at all (FR-25 — no @keyframes, no animation, no transition
// anywhere in this file; the webview may fall back to software compositing,
// where permanent chrome that animates repaints forever).
//
// All logic lives in ./usage (covered by src/features/usage/usage.test.ts); this
// file only maps the view model onto §8's tokens.

import { useEffect, useRef, useState } from 'react';
import type { UsageMeter } from '../../../contract/common';
import { focusedSessionId } from '../../lib/layoutStore';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { sessionCapability } from '../../lib/runtimeCapability';
import { useStore } from '../../lib/store';
import { Icon } from '../../ui/Icon';
import { IconButton } from '../../ui/IconButton';
import { Meter } from '../../ui/Meter';
import { accountDisplayLabel, findAccount, usageAccountId } from '../accounts/accounts';
import { EMPTY_USAGE } from '../../lib/usageStore';
import './usage.css';
import {
  USAGE_ERROR,
  meterResetLine,
  requestUsageRefresh,
  seedAccountUsage,
  startUsageFeed,
  usageBarView,
  usageIconAttention,
  usageIconSummary,
  type MeterChipView,
  type UsageBarView,
} from './usage';

function MeterRow({ chip, meter, now }: { chip: MeterChipView; meter: UsageMeter | undefined; now: number }) {
  return (
    <div className="usage-popover__row">
      <div className="usage-popover__row-head">
        <span className="usage-popover__label truncate">{chip.label}</span>
        <span className="usage-popover__percent">{chip.percentText}</span>
      </div>
      <Meter fraction={chip.fillPercent / 100} tone={chip.color === USAGE_ERROR ? 'danger' : 'default'} />
      {meter && <span className="usage-popover__reset">{meterResetLine(meter, now)}</span>}
    </div>
  );
}

// The shape MeterRow needs off UsageMeter — kept local so this file does not
// import the contract type twice under two names.
function PopoverBody({
  view,
  now,
  meters,
  accountLabel,
  split,
  focusedName,
  onRefresh,
}: {
  view: UsageBarView;
  now: number;
  meters: UsageMeter[];
  accountLabel: string | null;
  split: boolean;
  focusedName: string | null;
  onRefresh: () => void;
}) {
  const fullError = view.error && !view.error.compact ? view.error : null;

  return (
    <div role="dialog" aria-label="Plan usage" className="usage-popover">
      <div className="usage-popover__head">
        <span className="usage-popover__title">Plan usage</span>
        {accountLabel && <span className="usage-popover__account truncate">{accountLabel}</span>}
        {split && focusedName && <span className="usage-popover__focused truncate">focused · {focusedName}</span>}
      </div>

      {fullError ? (
        <div className="usage-popover__error">{fullError.message}</div>
      ) : view.empty ? (
        <div className="usage-popover__empty">No usage data yet</div>
      ) : (
        <>
          {view.error && <div className="usage-popover__warning">{view.error.message}</div>}
          <div className={view.dimmed ? 'usage-popover__rows usage-popover__rows--dimmed' : 'usage-popover__rows'}>
            {view.chips.map((chip, i) => (
              <MeterRow key={`${chip.label}:${i}`} chip={chip} meter={meters[i]} now={now} />
            ))}
          </div>
        </>
      )}

      <div className="usage-popover__foot">
        <span className="usage-popover__freshness">{view.freshness}</span>
        <button type="button" className="usage-popover__refresh" onClick={onRefresh}>
          Refresh
        </button>
      </div>
    </div>
  );
}

export default function UsageMeters() {
  const setAccountUsage = useStore((s) => s.setAccountUsage);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useDismiss(rootRef, { onEscape: () => setOpen(false), onOutsideClick: () => setOpen(false), enabled: open });

  const sessions = useStore((s) => s.sessions);
  // split-session FR-7: the meters follow the FOCUSED session, which equals
  // activeSessionId whenever the app is not split.
  const activeSessionId = useStore((s) => focusedSessionId(s));
  const split = useStore((s) => s.extraPanes.length > 0);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  // multi-provider-openai FR-20 design brief §2: the focused session's own
  // usageBar capability — the popover shows the reason instead of the meters.
  const usageCapability = sessionCapability(activeSession, 'usageBar');

  // multi-account FR-30: the popover follows the SELECTED session's account —
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

  // One text tick a minute for the reset countdowns — not motion (FR-25): a
  // single setState/min, no repaint loop.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const view = usageBarView(snapshot, now, accountLabel ?? undefined);
  const refresh = () => requestUsageRefresh(accountId);

  if (!usageCapability.available) {
    // multi-provider-openai FR-20 design brief §2: the icon stays put (same hit
    // target, no layout shift on focus change); the popover carries the reason.
    return (
      <div ref={rootRef} className="usage-trigger">
        <IconButton
          title={usageCapability.reason ?? 'Plan usage unavailable'}
          aria-haspopup="dialog"
          aria-expanded={open}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="usage" size={16} />
        </IconButton>
        {open && (
          <div role="dialog" aria-label="Plan usage" className="usage-popover">
            <div className="usage-popover__head">
              <span className="usage-popover__title">Plan usage</span>
            </div>
            <div className="usage-popover__empty">{usageCapability.reason ?? 'Plan usage unavailable'}</div>
          </div>
        )}
      </div>
    );
  }

  const attention = usageIconAttention(view);
  const summary = usageIconSummary(view);

  return (
    <div ref={rootRef} className="usage-trigger">
      <IconButton
        title={summary}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={attention ? 'usg-icon-btn usg-icon-btn--attention' : 'usg-icon-btn'}
        // Keep focus where it was: a bare button can steal it via click, and
        // App.tsx's global keys only stand down while focus is in an
        // input/terminal — so without this the next keystroke after a click
        // fires `n`/`d`/`t` (FR-3, carried over from the inline meters).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="usage" size={16} />
        {attention && <span className="usg-dot" />}
      </IconButton>
      {open && (
        <PopoverBody
          view={view}
          now={now}
          meters={snapshot.meters}
          accountLabel={accountLabel}
          split={split}
          focusedName={activeSession?.name ?? null}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}
