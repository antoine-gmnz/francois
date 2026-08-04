import { useEffect, useState } from 'react';
import type { SessionId } from '../../contract/common';
import type { ShellEnsureData, ShellId } from '../../contract/shell-terminal';
import ShellStrip from '../features/shell/ShellStrip';
import ShellTerminal from '../features/shell/ShellTerminal';
import { useActiveShellId, useShellsFor, useShellStore } from '../features/shell/shellStore';
import { useShellShortcuts } from '../features/shell/useShellShortcuts';
import { shellEnsure } from '../lib/api';
import { EmptyPane } from '../ui/EmptyPane';
import { StatusDot } from '../ui/StatusDot';
import { shellFooterPath } from './appShell';

export interface ShellTabViewProps {
  sessionId: SessionId;
  home: string;
}

/** The SHELL main tab's body: the sub-tab strip (multiple-shells), the PTY
 * terminal(s) — every shell of the session stays mounted while this tab is
 * (FR-13) — and the footer (alive dot, shell name + cwd, interrupt/clear hints). */
export default function ShellTabView({ sessionId, home }: ShellTabViewProps) {
  const shells = useShellsFor(sessionId);
  const activeShellId = useActiveShellId(sessionId);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Flow 1: a brand-new session's very first attach (create-if-none) is the
  // only time `shells` is genuinely empty AND nothing is wrong — this guards
  // the EmptyPane (FR-23) from flashing "No shells" during that round trip.
  const [attaching, setAttaching] = useState(true);
  // This effect's own `shell_ensure` response, threaded into the matching
  // ShellTerminal mount as `initialData` so it skips a second, redundant
  // `shell_ensure` for the shell we just resolved (every other shell of the
  // roster still ensures itself, unchanged).
  const [initialAttach, setInitialAttach] = useState<{ shellId: ShellId; data: ShellEnsureData } | null>(null);

  // FR-19/FR-21: ⌘T/⌘W/⌃⇥/⌃⇧⇥ reachable from anywhere in this tab, not just an
  // unfocused terminal (ShellTerminal's own key handler covers that case).
  useShellShortcuts(sessionId, true);

  // Flow 1/5/7: learn (or create-if-none attach) the session's shell roster —
  // once per mount (tab open / session change). Each ShellTerminal ensures
  // ITSELF for its own replay (per-mount, unchanged from shell-terminal); this
  // effect's only job is discovering which shellIds exist to mount at all.
  useEffect(() => {
    let cancelled = false;
    setAttachError(null);
    setAttaching(true);
    setInitialAttach(null);

    const attach = async (shellId: string | undefined): Promise<void> => {
      try {
        const res = await shellEnsure({ sessionId, shellId });
        if (cancelled) return;
        if (!res.ok) {
          // §7: a stale remembered shellId (another session's, or long gone) —
          // clear it and retry once attaching to the session's first shell.
          if (res.error.code === 'SHELL_NOT_FOUND' && shellId) {
            useShellStore.getState().clearActiveShellId(sessionId);
            await attach(undefined);
            return;
          }
          setAttachError(res.error.message);
          setAttaching(false);
          return;
        }
        useShellStore.getState().setShells(sessionId, res.data.shells);
        useShellStore.getState().setActiveShellId(sessionId, res.data.shellId);
        setInitialAttach({ shellId: res.data.shellId, data: res.data });
        setAttaching(false);
      } catch (e) {
        // IPC-layer rejection (not a domain Result:false) — same treatment as
        // shellActions.ts's create/rename catch branches.
        if (cancelled) return;
        setAttachError(String(e));
        setAttaching(false);
      }
    };

    void attach(useShellStore.getState().activeShellId[sessionId]);
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const active = shells.find((s) => s.id === activeShellId) ?? null;

  if (shells.length === 0 && attaching) {
    return <div className="app-shell-view" />;
  }

  if (shells.length === 0) {
    return (
      <div className="app-shell-view">
        <ShellStrip sessionId={sessionId} shells={shells} activeShellId={activeShellId} forceVisible />
        <EmptyPane className="shell-empty">
          <div>No shells</div>
          <div className="shell-empty__hint">{attachError ? `${attachError} · ` : ''}⌘T to open one</div>
        </EmptyPane>
      </div>
    );
  }

  return (
    <div className="app-shell-view">
      <ShellStrip sessionId={sessionId} shells={shells} activeShellId={activeShellId} />
      <div className="app-shell-terminal-wrap">
        {shells.map((s) => (
          <ShellTerminal
            key={s.id}
            sessionId={sessionId}
            shellId={s.id}
            visible={s.id === activeShellId}
            initialData={initialAttach?.shellId === s.id ? initialAttach.data : undefined}
          />
        ))}
      </div>
      <div className="app-shell-footer">
        <StatusDot color={active?.alive ? 'var(--success)' : 'var(--error)'} size={7} />
        <span>
          {active?.shellName || 'shell'}
          {active?.cwd && (
            <>
              {' '}
              <span className="app-text-faint">·</span> {shellFooterPath(active.cwd, active.shellName, home)}
            </>
          )}
        </span>
        <span className="app-flex-spacer" />
        <span>
          <span className="app-text-hint">⌃C</span> interrupt
        </span>
        <span>
          <span className="app-text-hint">⌃L</span> clear
        </span>
      </div>
    </div>
  );
}
