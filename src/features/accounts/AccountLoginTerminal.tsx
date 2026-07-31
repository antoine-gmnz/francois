// multi-account FR-12: the embedded login terminal. Renders the PTY bytes the
// core streams as `account.login.data` verbatim in an xterm.js instance and
// forwards keystrokes through account:loginWrite / geometry through
// account:loginResize — the same raw-passthrough contract as the SHELL tab,
// with the same FitAddon discipline (§Responsive) and the same theme object
// (../shell/xterm-theme).
//
// TWO deliberate differences from ShellTerminal:
//  - Escape is NOT forwarded. §Notes: the modal owns Escape (it cancels the
//    login, FR-16), so the handler swallows it and lets it bubble to the modal.
//    The hint under the frame says so, because the TUI cannot.
//  - There is no restart-on-exit affordance: a PTY that exits without an
//    identity IS the failure (FR-15), and the modal renders that state instead.

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { accountLoginResize, accountLoginWrite } from '../../lib/api';
import { useStore } from '../../lib/store';
import { buildTheme } from '../shell/xterm-theme';

export interface AccountLoginTerminalProps {
  /** null until account:add resolves — the frame shows `starting claude…`. */
  loginId: string | null;
  /** Registers the byte sink; the modal's login feed pushes into it (FR-12). */
  onReady: (write: (data: string) => void) => void;
}

export default function AccountLoginTerminal({ loginId, onReady }: AccountLoginTerminalProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // The live loginId, read by the input/resize handlers below. A ref, not the
  // prop: the terminal is created ONCE (its handlers close over this) while the
  // id lands a moment later, when account:add resolves.
  const loginIdRef = useRef<string | null>(loginId);
  loginIdRef.current = loginId;
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12,
      fontWeight: '400',
      fontWeightBold: '700',
      lineHeight: 1.35,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 2000,
      theme: buildTheme(),
    });
    termRef.current = term;
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(hostRef.current!);

    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        /* container not measurable yet */
      }
    };

    let lastCols = -1;
    let lastRows = -1;
    let resizeTimer: number | undefined;

    const sendResize = () => {
      const id = loginIdRef.current;
      if (!id) return;
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      void accountLoginResize({ loginId: id, cols: term.cols, rows: term.rows }).catch(() => {});
    };

    // §Notes: keyboard focus must land in the terminal on mount — the OAuth code
    // is PASTED here, and a login that silently drops the paste is unrecoverable.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // Escape belongs to the modal (cancel, FR-16): don't forward it to the
      // TUI and don't stopPropagation, so it reaches the modal's own listener.
      if (e.key === 'Escape') return false;
      e.stopPropagation(); // every other key is the TUI's (shell-terminal FR-21)
      return true;
    });

    const dataDisp = term.onData((data) => {
      const id = loginIdRef.current;
      if (!id) return; // pre-ack keystrokes have nowhere to go
      void accountLoginWrite({ loginId: id, data }).catch(() => {});
    });

    const ro = new ResizeObserver(() => {
      if (!hostRef.current || hostRef.current.offsetParent === null) return;
      fit();
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(sendResize, 120);
    });
    ro.observe(hostRef.current!);

    fit();
    term.focus();
    onReady((data) => term.write(data));

    return () => {
      ro.disconnect();
      window.clearTimeout(resizeTimer);
      dataDisp.dispose();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The core spawns the PTY at its own default geometry (AccountLoginStarted
  // carries it); push OUR measured size as soon as the id lands, so the TUI
  // draws into the frame it is actually shown in.
  useEffect(() => {
    const term = termRef.current;
    if (!loginId || !term) return;
    void accountLoginResize({ loginId, cols: term.cols, rows: term.rows }).catch(() => {});
    term.focus();
  }, [loginId]);

  // Light/dark switch: the canvas can't observe the CSS var change itself.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = buildTheme();
  }, [theme]);

  return <div ref={hostRef} className="acc-login-term" />;
}
