// usage-bar (specs/usage-bar.md §8) — the always-mounted plan-limit strip that
// sits between the native OS caption and the content grid. design-refresh
// FR-4 turns it into the app's custom titlebar row: left brand cluster
// (diamond glyph + wordmark + project-path button) alongside the unchanged
// usage meters on the right — same data, same events, restyled/relocated
// only. No account UI (4a is out of scope).
//
// Pure chrome: it is NOT a focusable pane (FR-3 — no tabIndex, no key handling,
// no focus ring, absent from the 1–5 cycle) and it has NO motion at all (FR-25 —
// no @keyframes, no animation, no transition anywhere in this file; the webview
// may fall back to software compositing, where permanent chrome that animates
// repaints forever). Its height is a fixed 38px in every state (FR-2/design-refresh
// FR-4), so no state change ever reflows the grid below.
//
// All logic lives in ./usage (covered by src/features/usage/usage.test.ts); this file only maps
// the view model onto §8's tokens.

import { useEffect, useRef, useState } from 'react';
import { displayWslCwd } from '../../../contract/wsl-filesystem';
import ProjectMenu from '../projects/ProjectMenu';
import { switcherLabel } from '../projects/projects';
import { useProjectRegistrySync } from '../projects/useProjectRegistrySync';
import { abbreviate } from '../../lib/path';
import { useDismiss } from '../../lib/hooks/useDismiss';
import { useStore } from '../../lib/store';
import './usage.css';
import { requestUsageRefresh, startUsageFeed, usageBarView, type MeterChipView } from './usage';

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

export default function UsageBar({ home }: { home: string }) {
  const snapshot = useStore((s) => s.usage);
  const setUsage = useStore((s) => s.setUsage);
  const [now, setNow] = useState(() => Date.now());
  const [freshHover, setFreshHover] = useState(false);
  const [pathHover, setPathHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // design-refresh FR-4: the project-path button reads whichever cwd is most
  // specific right now — the scoped project's root, else the active session's
  // cwd, else the bare home dir. No new IPC: every value is already in the store.
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? null;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const rawPath = activeProject?.root ?? activeSession?.cwd ?? home;
  // Falls back to the scope name rather than to nothing: this button is the only
  // project switcher, so it must stay clickable even before `home` has resolved
  // (and in a fresh install with no project and no session).
  const pathLabel = rawPath ? (displayWslCwd(rawPath) ?? abbreviate(rawPath, home)) : switcherLabel(activeProject);

  // The titlebar owns the project switcher, so it also owns keeping the registry
  // (and with it the restored scope, FR-26) in step with the core.
  useProjectRegistrySync();

  // Escape / outside click close the scope dropdown. The ref wraps the trigger
  // AND the panel, so a click on either is "inside" (see useDismiss).
  useDismiss(menuRef, {
    onEscape: () => setMenuOpen(false),
    onOutsideClick: () => setMenuOpen(false),
    enabled: menuOpen,
  });

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
    <div className="usage-bar">
      {/* design-refresh FR-4: left brand cluster — diamond glyph + wordmark +
          project-path button. The caret is a real disclosure: it opens the shared
          project scope menu (projects FR-25), whose last row still reaches the
          Projects modal. This is the app's only project switcher — pane [1]'s
          strip is not mounted in the refreshed shell. */}
      <div className="titlebar-brand">
        <span className="titlebar-logo" />
        <span className="titlebar-wordmark">Francois</span>
        <div ref={menuRef} className="titlebar-path-wrap">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            onMouseEnter={() => setPathHover(true)}
            onMouseLeave={() => setPathHover(false)}
            title={rawPath || undefined}
            className={pathHover ? 'titlebar-path titlebar-path--hover' : 'titlebar-path'}
          >
            <span className="titlebar-path-dot" />
            <span className="truncate titlebar-path-text">{pathLabel}</span>
            <span className="titlebar-path-caret">{menuOpen ? '▴' : '▾'}</span>
          </button>
          {menuOpen && (
            <ProjectMenu home={home} onClose={() => setMenuOpen(false)} className="pjsw-dropdown--anchored" />
          )}
        </div>
      </div>

      {/* meter region — the whole strip left of the freshness label is the click target (FR-27) */}
      <div
        onClick={requestUsageRefresh}
        // Keep focus where it was: a bare div steals it to <body> on mousedown, and
        // App.tsx's global keys only stand down while focus is in an input/terminal —
        // so without this the next keystroke after a click fires `n`/`d`/`t` (FR-3).
        onMouseDown={(e) => e.preventDefault()}
        // loading WITH data: a plain opacity swap, nothing else (FR-25)
        className={`usage-meters${view.dimmed ? ' usage-meters--dimmed' : ''}`}
      >
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
        <span
        onClick={requestUsageRefresh}
        onMouseDown={(e) => e.preventDefault()} // see the meter region above (FR-3)
        onMouseEnter={() => setFreshHover(true)}
        onMouseLeave={() => setFreshHover(false)}
        title={view.resetTitle}
        className={`usage-fresh${freshHover ? ' usage-fresh--hover' : ''}`}
      >
        {view.trailing}
      </span>
      </div>

      {/* freshness + session reset countdown, joined by ' · ' (FR-30); degrades to
          whichever half exists — doubles as the refresh affordance (§8) */}
      
    </div>
  );
}
