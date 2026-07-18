import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import '@xterm/xterm/css/xterm.css';
import type {
  Result,
  ShellEnsureData,
  ShellEnsurePayload,
  ShellEvent,
  ShellResizePayload,
  ShellWritePayload,
  ShellDisposePayload,
} from '../contract/shell-terminal';
import { DEFAULT_SESSION_ID, setShellState } from './shellStore';

const FAINT = '\x1b[38;2;86;90;99m'; // #565a63 (spec §8)
const RESET = '\x1b[0m';

// Tauri's invoke wants Record<string, unknown>; our named payload interfaces
// carry the same fields (checked via `satisfies` at each call site).
function ipc<T>(cmd: string, args: object): Promise<T> {
  return invoke<T>(cmd, args as Record<string, unknown>);
}

// ANSI 16-color mapping — specs/shell-terminal.md §8 FR-24.
const ANSI_THEME = {
  black: '#1a1c22',
  red: '#c46b62',
  green: '#7fa07a',
  yellow: '#c8a15a',
  blue: '#a9adb6',
  magenta: '#a97fa0',
  cyan: '#6f9c9a',
  white: '#c4c7ce',
  brightBlack: '#6b7079',
  brightRed: '#d68f86',
  brightGreen: '#9dbb98',
  brightYellow: '#d0a45c',
  brightBlue: '#c3c6cf',
  brightMagenta: '#c29fbb',
  brightCyan: '#8fbab8',
  brightWhite: '#dfe2e8',
} as const;

export default function ShellTerminal({ sessionId = DEFAULT_SESSION_ID }: { sessionId?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12.5,
      fontWeight: '400',
      fontWeightBold: '700',
      lineHeight: 1.35,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      theme: {
        background: '#0f1015',
        foreground: '#dfe2e8',
        cursor: '#c8a15a',
        cursorAccent: '#0f1015',
        selectionBackground: 'rgba(200,161,90,0.25)',
        ...ANSI_THEME,
      },
    });
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

    const exitedRef = { current: false };
    let lastCols = -1;
    let lastRows = -1;
    let resizeTimer: number | undefined;

    const enterExited = (line: string) => {
      exitedRef.current = true;
      term.write(`\r\n${FAINT}${line}${RESET}\r\n`);
      setShellState(sessionId, { alive: false });
    };

    const sendResize = () => {
      if (exitedRef.current) return;
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      void ipc('shell_resize', { sessionId, cols: term.cols, rows: term.rows } satisfies ShellResizePayload).catch(() => {});
    };

    const ensure = async (restart = false) => {
      fit();
      try {
        const res = await ipc<Result<ShellEnsureData>>('shell_ensure', { sessionId } satisfies ShellEnsurePayload);
        if (!res.ok) {
          // Spawn failure (PTY_ERROR / SESSION_NOT_FOUND) — FR-18 parity.
          setShellState(sessionId, { alive: false, shellName: '', cwd: '' });
          enterExited(`${res.error.message} — press ⏎ to retry`);
          return;
        }
        const d = res.data;
        exitedRef.current = false;
        if (restart) term.reset();
        setShellState(sessionId, {
          alive: d.exitCode === undefined,
          exitCode: d.exitCode,
          shellName: d.shellName,
          cwd: d.cwd,
        });
        if (d.scrollbackReplay) term.write(d.scrollbackReplay);
        // Fit to the container and push the real size to the PTY (flow 1/7).
        lastCols = -1;
        lastRows = -1;
        fit();
        sendResize();
        if (d.exitCode !== undefined) {
          enterExited(`process exited (code ${d.exitCode}) — press ⏎ to restart`);
        }
        term.focus();
      } catch (e) {
        enterExited(`failed to reach shell backend: ${String(e)} — press ⏎ to retry`);
      }
    };

    const restart = async () => {
      await ipc('shell_dispose', { sessionId } satisfies ShellDisposePayload).catch(() => {}); // FR-17: best-effort
      await ensure(true);
    };

    // Keyboard capture — FR-19/20/21 + exited-mode lock FR-16.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // ⌘K / Ctrl+K carve-out: don't forward, don't stopPropagation → bubbles
      // to app-shell's global handler (command palette). FR-20.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) return false;
      if (exitedRef.current) {
        if (e.key === 'Enter') {
          e.preventDefault();
          void restart();
        }
        return false; // swallow everything else while exited (FR-16)
      }
      e.stopPropagation(); // every forwarded key is stopPropagation'd (FR-21)
      return true;
    });

    // Forwarded input → PTY (FR-10/FR-19). onData carries translated bytes
    // (typed keys, paste, IME) exactly as they should hit stdin.
    const dataDisp = term.onData((data) => {
      if (exitedRef.current) return;
      void ipc('shell_write', { sessionId, data } satisfies ShellWritePayload).catch(() => {});
    });

    // Per-mount listener: render live output; handle exit (FR-13/FR-15).
    const unlisten = listen<ShellEvent>('francois://shell/event', (e) => {
      const p = e.payload;
      if (p.sessionId !== sessionId) return;
      if (p.type === 'shell.data') {
        term.write(p.data);
      } else {
        enterExited(`process exited (code ${p.exitCode}) — press ⏎ to restart`);
      }
    });

    // Resize propagation — FR-27: fit on every change, debounced core resize.
    const ro = new ResizeObserver(() => {
      if (!hostRef.current || hostRef.current.offsetParent === null) return;
      fit();
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(sendResize, 120);
    });
    ro.observe(hostRef.current!);

    void ensure();

    return () => {
      ro.disconnect();
      window.clearTimeout(resizeTimer);
      dataDisp.dispose();
      void unlisten.then((u) => u());
      term.dispose();
    };
  }, [sessionId]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: '14px 16px' }} />;
}
