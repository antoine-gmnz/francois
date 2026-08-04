import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { SessionId } from '../../../contract/common';
import type { ShellEnsureData, ShellId } from '../../../contract/shell-terminal';
import { onShellEvent, shellEnsure, shellResize, shellRestart, shellWrite } from '../../lib/api';
import { shellShortcutFor } from './shell';
import { dispatchShellShortcut } from './shellActions';
import { useShellStore } from './shellStore';
import { buildTheme } from './xterm-theme';
import { useStore } from '../../lib/store';

const FAINT = '\x1b[38;2;107;115;133m'; // #6b7385 — design-refresh FR-13, new --text-muted
const RESET = '\x1b[0m';

// The theme itself moved to ./xterm-theme so multi-account's embedded login
// terminal (FR-12) can render the real `claude` TUI with the identical theme
// object — behavior here is unchanged.

export interface ShellTerminalProps {
  sessionId: SessionId;
  shellId: ShellId;
  /** FR-13: every shell of the active session stays mounted while the SHELL
   * tab is open; only the displayed one is visible (CSS, never unmount). */
  visible: boolean;
  /**
   * The `ShellEnsureData` ShellTabView's own attach() already fetched for
   * THIS shellId (its create-if-none/re-attach round trip) — read once, at
   * mount, so this mount's `ensure()` skips a second redundant `shell_ensure`
   * call. `undefined` for every shell ShellTabView didn't just attach to
   * (newly created shells, or any shell besides the one just resolved).
   */
  initialData?: ShellEnsureData;
}

// sessionId/shellId are REQUIRED — multiple-shells re-keys the whole domain
// onto ShellId; a silent fallback here could attach the wrong shell.
export default function ShellTerminal({ sessionId, shellId, visible, initialData }: ShellTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const sendResizeRef = useRef<() => void>(() => {});
  // Guards the becoming-visible effect below: true once this mount's own
  // shell_ensure has settled (success, refusal, or rejection), so that effect
  // never races a resize ahead of the ensure that establishes the PTY size.
  const ensureSettledRef = useRef(false);
  // Re-theme the live terminal when the app theme flips (store-owned by the
  // theme slice). We only need the value to trigger the effect — buildTheme()
  // reads the freshly-applied CSS variables from the DOM.
  const theme = useStore((s) => (s as unknown as { theme?: string }).theme);

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
    fitRef.current = fit;

    const exitedRef = { current: false };
    let lastCols = -1;
    let lastRows = -1;
    let resizeTimer: number | undefined;

    // Store status updates (alive/exitCode) happen HERE — driven by this
    // component's own RPC responses — and in the single global shell-event
    // listener (shellStore.ts) for a live shell.exit. This function only
    // renders the dim line into THIS mounted terminal.
    const enterExited = (line: string) => {
      exitedRef.current = true;
      term.write(`\r\n${FAINT}${line}${RESET}\r\n`);
    };

    const sendResize = () => {
      if (exitedRef.current) return;
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      void shellResize(shellId, term.cols, term.rows).catch(() => {});
    };
    sendResizeRef.current = sendResize;

    const ensure = async () => {
      fit();
      try {
        // Skip the round trip entirely when ShellTabView already resolved
        // this exact shellId's attach (its own `shell_ensure`) before this
        // mount — `initialData` is read once, from this effect's closure, so
        // a later prop update (this component staying mounted) never re-reads it.
        const res = initialData ? ({ ok: true, data: initialData } as const) : await shellEnsure({ sessionId, shellId });
        if (!res.ok) {
          useShellStore.getState().setShellStatus(sessionId, shellId, false, undefined);
          enterExited(`${res.error.message} — press ⏎ to retry`);
          return;
        }
        const d = res.data;
        exitedRef.current = false;
        // §6: every ensure refreshes the WHOLE roster, not just this shell.
        useShellStore.getState().setShells(sessionId, d.shells);
        if (d.scrollbackReplay) term.write(d.scrollbackReplay);
        lastCols = -1;
        lastRows = -1;
        fit();
        sendResize();
        if (d.exitCode !== undefined) {
          enterExited(`process exited (code ${d.exitCode}) — press ⏎ to restart`);
        }
        // FR-13's own focus (become-visible effect below) covers the rest —
        // reading the `visible` prop here would close over its MOUNT-time
        // value forever, since this effect never reruns while mounted.
      } catch (e) {
        useShellStore.getState().setShellStatus(sessionId, shellId, false, undefined);
        enterExited(`failed to reach shell backend: ${String(e)} — press ⏎ to retry`);
      } finally {
        ensureSettledRef.current = true;
      }
    };

    // FR-7/FR-17: ⏎ while exited always calls shell_restart — same id, name
    // and strip position, fresh PTY, empty ring — never the old dispose+ensure
    // dance, and it doubles as the retry path for an attach failure above.
    const restart = async () => {
      try {
        const res = await shellRestart(shellId);
        if (!res.ok) {
          enterExited(`${res.error.message} — press ⏎ to retry`);
          useShellStore.getState().setShellStatus(sessionId, shellId, false, undefined);
          return;
        }
        exitedRef.current = false;
        term.reset();
        useShellStore.getState().setShellStatus(sessionId, shellId, true, undefined);
        lastCols = -1;
        lastRows = -1;
        fit();
        sendResize();
        // Focus was never lost — restart only fires from a keydown the
        // terminal's own textarea was already focused for.
      } catch (e) {
        enterExited(`failed to reach shell backend: ${String(e)} — press ⏎ to retry`);
      }
    };

    // Keyboard capture — FR-19/20/21 (shell carve-outs) + shell-terminal's own
    // ⌘K carve-out + the exited-mode lock (FR-16/FR-17).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      // ⌘K / Ctrl+K carve-out: don't forward, don't stopPropagation → bubbles
      // to app-shell's global handler (command palette). shell-terminal FR-20.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) return false;
      const combo = shellShortcutFor(e.key, e.metaKey, e.ctrlKey, e.shiftKey);
      if (combo) {
        e.preventDefault();
        // FR-20/21: handled directly here — stop the bubble so the
        // document-level listener (useShellShortcuts) never double-fires it.
        e.stopPropagation();
        dispatchShellShortcut(combo, sessionId);
        return false;
      }
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

    // Forwarded input → PTY (shell-terminal FR-10/FR-19). onData carries
    // translated bytes (typed keys, paste, IME) exactly as they should hit stdin.
    const dataDisp = term.onData((data) => {
      if (exitedRef.current) return;
      void shellWrite(shellId, data).catch(() => {});
    });

    // Per-mount listener: render live output; handle exit (FR-13/FR-15). Only
    // this shell's own events — the roster-wide status update happens in the
    // single global listener (shellStore.ts's initShellEvents).
    const unlisten = onShellEvent((p) => {
      if (p.sessionId !== sessionId || p.shellId !== shellId) return;
      if (p.type === 'shell.data') {
        term.write(p.data);
      } else {
        enterExited(`process exited (code ${p.exitCode}) — press ⏎ to restart`);
      }
    });

    // Resize propagation — shell-terminal FR-27: fit on every change, debounced core resize.
    const ro = new ResizeObserver(() => {
      if (!hostRef.current || hostRef.current.offsetParent === null) return;
      fit();
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(sendResize, 120);
    });
    ro.observe(hostRef.current!);

    ensureSettledRef.current = false;
    void ensure();

    return () => {
      ro.disconnect();
      window.clearTimeout(resizeTimer);
      dataDisp.dispose();
      void unlisten.then((u) => u());
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId, shellId]);

  // FR-13: a shell whose xterm has just become visible runs one immediate
  // fit + resize + focus — no new ensure call, so no new ring replay. FR-14:
  // becoming the displayed shell always clears its unread mark, whatever
  // caused the switch (an explicit chip click, a keyboard cycle, or simply
  // being the auto-selected active chip when this tab/session comes back
  // into view) — the store methods above already handle the explicit paths;
  // this covers every other way `visible` can flip to true.
  useEffect(() => {
    if (!visible) return;
    useShellStore.getState().clearUnread(shellId);
    fitRef.current();
    // Skip the resize on this mount's very first becoming-visible pass: the
    // per-mount `ensure()` above hasn't necessarily landed yet, and it will
    // fit + resize itself once it does — sending one here first would just
    // be immediately superseded.
    if (ensureSettledRef.current) sendResizeRef.current();
    termRef.current?.focus();
  }, [visible, shellId]);

  // Light/dark switch: rebuild the theme from the now-current CSS variables and
  // apply it to the live terminal (canvas can't observe the var change itself).
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = buildTheme();
  }, [theme]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: '14px 16px', display: visible ? undefined : 'none' }} />;
}
