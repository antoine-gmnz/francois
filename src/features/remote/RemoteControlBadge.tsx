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
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <span
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => void toggle()}
        onKeyDown={onChipKeyDown}
        title={remoteLabel(state)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1,
          color: live ? 'var(--text-hint)' : 'var(--text-faint)',
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: TONE[remoteDotTone(state)],
            flexShrink: 0,
          }}
        />
        rc
        {handle && (
          <span title={handle} style={{ color: 'var(--text-faint)' }}>
            {/* the short handle is enough to tell two remote sessions apart */}
            {handle.replace('session_', '').slice(0, 6)}
          </span>
        )}
      </span>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 20,
            right: 0,
            zIndex: 40,
            minWidth: 300,
            padding: 10,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--bg-hover)',
            borderRadius: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          }}
        >
          <div style={{ color: 'var(--text-hint)', fontSize: 10.5 }}>{remoteLabel(state)}</div>

          {state.phase === 'starting' && (
            <div style={{ color: 'var(--text-faint)', fontSize: 10 }}>
              registering with claude.ai — the URL appears here in a moment
            </div>
          )}

          {url && (
            <>
              <div
                style={{
                  color: 'var(--text-2)',
                  fontSize: 10,
                  wordBreak: 'break-all',
                  background: 'var(--bg-deep)',
                  padding: '6px 7px',
                  borderRadius: 4,
                }}
              >
                {url}
              </div>
              <div style={{ color: 'var(--text-faint)', fontSize: 10 }}>
                Open it on your phone or in any browser to continue this same session.
              </div>
            </>
          )}

          {state.phase === 'failed' && (
            <div style={{ color: 'var(--error-bright)', fontSize: 10 }}>{state.error.message}</div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            {url && (
              <button
                onClick={() => void copy()}
                style={{
                  fontSize: 10,
                  padding: '4px 9px',
                  background: 'var(--bg-raised)',
                  color: 'var(--text-hint)',
                  border: '1px solid var(--bg-hover)',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {copied ? 'copied' : 'copy url'}
              </button>
            )}
            {state.phase === 'failed' && (
              <button
                onClick={() => void start()}
                disabled={busy}
                style={{
                  fontSize: 10,
                  padding: '4px 9px',
                  background: 'var(--bg-raised)',
                  color: 'var(--text-hint)',
                  border: '1px solid var(--bg-hover)',
                  borderRadius: 4,
                  cursor: busy ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                retry
              </button>
            )}
            <button
              onClick={() => void stop()}
              disabled={busy}
              style={{
                fontSize: 10,
                padding: '4px 9px',
                background: 'transparent',
                color: 'var(--error)',
                border: '1px solid var(--bg-hover)',
                borderRadius: 4,
                cursor: busy ? 'default' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {state.phase === 'failed' ? 'dismiss' : 'stop'}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
