// remote-control (specs/remote-control.md §8) — the SESSION-header chip that hosts
// Claude Code's native Remote Control for the active session.
//
// Off → click starts a host. While `starting`/`active` the chip is live; clicking it
// opens a popover with the full claude.ai URL to copy (that URL is what the phone or
// browser opens) and a stop action.

import { useEffect, useRef, useState } from 'react';
import type { SessionId } from '../../../contract/common';
import { remoteGet, remoteStart, remoteStop } from '../../lib/api';
import { useStore } from '../../lib/store';
import './remote.css';
import {
  isRemoteLive,
  remoteDotTone,
  remoteFailure,
  remoteLabel,
  remoteSessionHandle,
  remoteStateOf,
  remoteUrlOf,
} from './remote-control';

const TONE: Record<ReturnType<typeof remoteDotTone>, string> = {
  idle: 'var(--text-disabled)',
  pending: 'var(--warn)',
  ok: 'var(--success)',
  error: 'var(--error)',
};

export function RemoteControlBadge({ sessionId }: { sessionId: SessionId }) {
  const state = useStore((s) => remoteStateOf(s.remote, sessionId));
  const mergeRemoteSeed = useStore((s) => s.mergeRemoteSeed);
  const mergeRemoteResult = useStore((s) => s.mergeRemoteResult);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed from the core: a host survives switching sessions and re-mounting, so the
  // chip must not read as `off` just because this component is new. A seed only
  // fills a hole (mergeRemoteSeed) — it must never overwrite an entry the event
  // stream has since populated (H2 #1).
  useEffect(() => {
    mounted.current = true;
    void remoteGet(sessionId).then((res) => {
      if (mounted.current && res.ok) mergeRemoteSeed(res.data);
    });
    return () => {
      mounted.current = false;
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
    };
  }, [sessionId, mergeRemoteSeed]);

  // Close the popover when the chip goes cold, so a stopped host leaves nothing open.
  useEffect(() => {
    if (state.phase === 'off') setOpen(false);
  }, [state.phase]);

  // Escape closes the popover while it's open (matches the palette / project
  // switcher convention).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const live = isRemoteLive(state);
  const url = remoteUrlOf(state);
  const handle = remoteSessionHandle(state);

  async function start() {
    if (busy) return;
    setBusy(true);
    const res = await remoteStart(sessionId);
    if (!mounted.current) return;
    if (res.ok) mergeRemoteResult(res.data);
    else mergeRemoteResult({ sessionId, state: remoteFailure('', res.error) });
    setOpen(true);
    setBusy(false);
  }

  async function toggle() {
    if (busy) return;
    // Live (or failed-and-showing) → the chip is a disclosure, not a switch; only a
    // cold chip starts a host. Stopping is the explicit action in the popover.
    if (live || state.phase === 'failed') {
      setOpen((v) => !v);
      return;
    }
    await start();
  }

  function onChipKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void toggle();
    }
  }

  async function stop() {
    if (busy) return;
    setBusy(true);
    const res = await remoteStop(sessionId);
    if (!mounted.current) return;
    if (res.ok) {
      mergeRemoteResult(res.data);
      setOpen(false);
    } else {
      // A failed stop is the dangerous half: a chip that reads `active` while the
      // stop actually failed would hide a live remote session from the user (H5).
      mergeRemoteResult({ sessionId, state: remoteFailure('', res.error) });
      setOpen(true);
    }
    setBusy(false);
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      if (mounted.current) {
        setCopied(true);
        if (copyTimeout.current) clearTimeout(copyTimeout.current);
        copyTimeout.current = setTimeout(() => {
          if (mounted.current) setCopied(false);
        }, 1200);
      }
    } catch {
      /* clipboard denied — the URL is on screen to copy by hand */
    }
  }

  return (
    <span className="rc-badge">
      <span
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => void toggle()}
        onKeyDown={onChipKeyDown}
        title={remoteLabel(state)}
        className={`rc-chip${busy ? ' rc-chip--busy' : ''}${live ? ' rc-chip--live' : ''}`}
      >
        <span className="rc-dot" style={{ background: TONE[remoteDotTone(state)] }} />
        rc
        {handle && (
          <span title={handle} className="rc-handle">
            {/* the short handle is enough to tell two remote sessions apart */}
            {handle.replace('session_', '').slice(0, 6)}
          </span>
        )}
      </span>

      {open && (
        <div className="rc-popover">
          <div className="rc-popover-title">{remoteLabel(state)}</div>

          {state.phase === 'starting' && (
            <div className="rc-popover-note">
              registering with claude.ai — the URL appears here in a moment
            </div>
          )}

          {url && (
            <>
              <div className="rc-url-box">{url}</div>
              <div className="rc-popover-note">
                Open it on your phone or in any browser to continue this same session.
              </div>
            </>
          )}

          {state.phase === 'failed' && <div className="rc-popover-error">{state.error.message}</div>}

          <div className="rc-btn-row">
            {url && (
              <button className="rc-btn" onClick={() => void copy()}>
                {copied ? 'copied' : 'copy url'}
              </button>
            )}
            {state.phase === 'failed' && (
              <button className="rc-btn" onClick={() => void start()} disabled={busy}>
                retry
              </button>
            )}
            <button className="rc-btn rc-btn--danger" onClick={() => void stop()} disabled={busy}>
              {state.phase === 'failed' ? 'dismiss' : 'stop'}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
