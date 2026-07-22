// usage-bar (specs/usage-bar.md §8) — the always-mounted plan-limit strip that
// sits between the native OS caption and the content grid.
//
// Pure chrome: it is NOT a focusable pane (FR-3 — no tabIndex, no key handling,
// no focus ring, absent from the 1–5 cycle) and it has NO motion at all (FR-25 —
// no @keyframes, no animation, no transition anywhere in this file; the webview
// may fall back to software compositing, where permanent chrome that animates
// repaints forever). Its height is a fixed 28px in every state (FR-2), so no
// state change ever reflows the grid below.
//
// All logic lives in ./usage (covered by src/usage.test.ts); this file only maps
// the view model onto §8's tokens.

import { useEffect, useState } from 'react';
import { useStore } from './store';
import { requestUsageRefresh, startUsageFeed, usageBarView, type MeterChipView } from './usage';

// §8 tokens
const T = {
  // App-root shell color: the OS caption is DWM-tinted to the same value
  // (src-tauri/src/main.rs), so caption + bar read as one continuous surface.
  bg: '#0f1015',
  border: '#24262d',
  track: '#24262d',
  label: '#868a93',
  faint: '#565a63',
  error: '#c46b62',
};

function MeterChip({ chip }: { chip: MeterChipView }) {
  return (
    <span title={chip.title} style={{ display: 'flex', alignItems: 'center', gap: 7, flex: '0 0 auto' }}>
      <span style={{ color: T.label, whiteSpace: 'nowrap' }}>{chip.label}</span>
      <span style={{ width: 52, height: 4, borderRadius: 2, background: T.track, overflow: 'hidden', flex: '0 0 auto' }}>
        {/* renders straight at its final width — no transition (FR-25) */}
        <span style={{ display: 'block', height: '100%', width: `${chip.fillPercent}%`, background: chip.color }} />
      </span>
      <span style={{ color: chip.color, fontVariantNumeric: 'tabular-nums' }}>{chip.percentText}</span>
    </span>
  );
}

export default function UsageBar() {
  const snapshot = useStore((s) => s.usage);
  const setUsage = useStore((s) => s.setUsage);
  const [now, setNow] = useState(() => Date.now());
  const [freshHover, setFreshHover] = useState(false);

  // FR-21/22: seed once from the core cache, then follow francois://app/event;
  // the returned teardown unsubscribes on unmount (§7 #12).
  useEffect(() => startUsageFeed(setUsage), [setUsage]);

  // Trailing-label granularity only (the reset countdown, FR-30): one text tick a
  // minute. Not motion — a single setState/min, no repaint loop (contrast with an
  // animation, FR-25). The countdown's finest unit is the minute, so this matches.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const view = usageBarView(snapshot, now);
  const fullError = view.error && !view.error.compact ? view.error : null;

  return (
    <div
      style={{
        height: 28,
        flex: '0 0 28px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '0 12px',
        background: T.bg,
        borderBottom: `1px solid ${T.border}`,
        fontSize: 10.5,
      }}
    >
      {/* meter region — the whole strip left of the freshness label is the click target (FR-27) */}
      <div
        onClick={requestUsageRefresh}
        // Keep focus where it was: a bare div steals it to <body> on mousedown, and
        // App.tsx's global keys only stand down while focus is in an input/terminal —
        // so without this the next keystroke after a click fires `n`/`d`/`t` (FR-3).
        onMouseDown={(e) => e.preventDefault()}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          cursor: 'pointer',
          minWidth: 0,
          overflow: 'hidden',
          // loading WITH data: a plain opacity swap, nothing else (FR-25)
          opacity: view.dimmed ? 0.45 : 1,
        }}
      >
        {fullError ? (
          // no stale data to protect → the one-line affordance replaces the meters (FR-26)
          <span title={fullError.message} style={{ color: T.error, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <span>⚠</span>
            <span>usage unavailable</span>
          </span>
        ) : (
          <>
            {/* stale meters survive an error; the glyph shrinks to bare ⚠ beside them (FR-26) */}
            {view.error && (
              <span title={view.error.message} style={{ color: T.error, flex: '0 0 auto' }}>
                ⚠
              </span>
            )}
            {view.empty ? (
              <span style={{ color: T.faint, whiteSpace: 'nowrap' }}>usage —</span>
            ) : (
              view.chips.map((chip, i) => <MeterChip key={`${chip.label}:${i}`} chip={chip} />)
            )}
          </>
        )}
      </div>

      {/* freshness + session reset countdown, joined by ' · ' (FR-30); degrades to
          whichever half exists — doubles as the refresh affordance (§8) */}
      <span
        onClick={requestUsageRefresh}
        onMouseDown={(e) => e.preventDefault()} // see the meter region above (FR-3)
        onMouseEnter={() => setFreshHover(true)}
        onMouseLeave={() => setFreshHover(false)}
        title={view.resetTitle}
        style={{
          color: freshHover ? T.label : T.faint,
          flex: '0 0 auto',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {view.trailing}
      </span>
    </div>
  );
}
