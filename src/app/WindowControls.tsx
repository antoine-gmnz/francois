// App bar 126:2 / "Window controls" 180:17326 — the Windows-style caption
// buttons this bar draws itself now that Windows/Linux are frameless
// (lib.rs's `set_decorations(false)`, macOS-only exempt — see window.rs/main.rs).
// Flush with the bar's right edge, 46×48 each, glyphs drawn inline (no assets):
// minimize is a line, maximize a square outline, close an X. Close alone gets
// the danger hover — the other two just step up a surface (`--bg-selected`).
//
// AppBar.tsx only mounts this when `hasTauriRuntime()` — `getCurrentWindow()`
// reads `window.__TAURI_INTERNALS__` synchronously and throws without it — but
// the same check guards every call here too, so this component stays safe to
// render standalone (a test, a future call site).

import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { hasTauriRuntime } from '../lib/platform';
import './app-bar.css';

function MinimizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M0 5H10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/** Two overlapping squares — the "restore" swap when already maximized. */
function RestoreGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <rect x="2.5" y="0.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1" />
      <path d="M0.5 2.5V9.5H7.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M0 0L10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

/** Windows/Linux frameless caption buttons — never rendered on macOS. */
export function WindowControls(): JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaximized);
    void win.onResized(() => {
      void win.isMaximized().then(setMaximized);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const minimize = () => {
    if (!hasTauriRuntime()) return;
    void getCurrentWindow().minimize();
  };
  const toggleMaximize = () => {
    if (!hasTauriRuntime()) return;
    void getCurrentWindow().toggleMaximize();
  };
  const close = () => {
    if (!hasTauriRuntime()) return;
    void getCurrentWindow().close();
  };

  return (
    <div className="win-controls">
      <button type="button" className="win-controls__btn" title="Minimize" aria-label="Minimize" onClick={minimize}>
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        className="win-controls__btn"
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={toggleMaximize}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        type="button"
        className="win-controls__btn win-controls__btn--close"
        title="Close"
        aria-label="Close"
        onClick={close}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}
