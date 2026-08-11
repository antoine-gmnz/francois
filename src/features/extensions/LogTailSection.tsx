// FR-38..FR-45: the `log-tail` primitive — an append-only, bottom-latched,
// monospace block fed by a core-owned stream, and the ONE place in an extension
// tab where the acid accent appears (a single live indicator in the header
// while the stream is running; design brief §2).
//
// The buffer itself lives in the store, not here: FR-43 keeps a stream alive for
// 10 s after its tab stops being the active one, and leaving the tab unmounts
// this component. What this component owns is the LIFECYCLE — open on a target,
// re-open on a target change, schedule the grace close on unmount, and cancel
// that timer if the user comes back in time.
//
// FR-12 is the exception to that grace: a project-scoped stream is scoped to
// the SESSION it was opened for, and a session change discards it immediately
// — that discard happens synchronously in sessionsStore's `setActiveSessionId`
// (before this component's cleanup ever runs), not here.

import { useEffect, useRef, useState } from 'react';
import { EXT_STREAM_GRACE_MS, type ExtensionInfo, type PanelInfo } from '../../../contract/extensions';
import { extensionsCloseStream, extensionsOpenStream } from '../../lib/api';
import { useStore } from '../../lib/store';
import { StatusDot } from '../../ui/StatusDot';
import ExtSectionError from './ExtSectionError';
import { SELECT_ROW_COPY, SELECT_SESSION_COPY, earlierLinesNotice, notAvailableCopy, panelRoot, sectionGate } from './extensions';

/**
 * FR-43: pending grace closes, keyed by panel. Module-level because the
 * component that scheduled one is gone by the time it fires — that is the whole
 * point of the grace period.
 */
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelGrace(panelId: string): void {
  const t = graceTimers.get(panelId);
  if (t !== undefined) {
    clearTimeout(t);
    graceTimers.delete(panelId);
  }
}

/** Kill a stream for good — the core forgets it, the store drops its buffer. */
function killStream(panelId: string, streamId: string | null): void {
  if (streamId) void extensionsCloseStream({ streamId }).catch(() => {});
  useStore.getState().dropExtStream(panelId);
}

export interface LogTailSectionProps {
  extension: ExtensionInfo;
  panel: PanelInfo;
  root: string | null;
  /** FR-12: the active session's id, or null — see ExtensionView's sectionKey. */
  sessionId: string | null;
  detected: boolean;
  projectName: string | null;
  /** FR-38: the value read off the source panel's selected row, or null. */
  token: string | null;
}

export default function LogTailSection({
  extension,
  panel,
  root,
  sessionId,
  detected,
  projectName,
  token,
}: LogTailSectionProps) {
  const stream = useStore((s) => s.extStreams[panel.id]);
  const scroller = useRef<HTMLDivElement>(null);
  const gate = sectionGate(panel, { root, detected, token });
  const streamRoot = panelRoot(panel, root);
  // FR-49: Retry re-triggers the open effect below even when the target itself
  // has not changed — the effect always restarts once `streamId` is null (an
  // ended/errored stream), so bumping this is enough.
  const [retryTick, setRetryTick] = useState(0);
  const retry = () => setRetryTick((n) => n + 1);
  // FR-12 only re-scopes PROJECT panels on a session change — a fleet panel
  // takes no root and stays untouched, so it takes no session either.
  const streamSessionId = panel.scope === 'fleet' ? null : sessionId;

  // Open / re-open. Keyed on the target: a different row, a different root, a
  // different SESSION (FR-12 — two sessions can share a root) or a fresh mount
  // past the grace window all restart from an EMPTY buffer (FR-42).
  useEffect(() => {
    if (gate !== 'ready') return;
    cancelGrace(panel.id);
    const existing = useStore.getState().extStreams[panel.id];
    // Same target, still alive (we came back inside the grace window) — adopt it
    // and keep the lines the user was reading.
    if (
      existing &&
      existing.token === token &&
      existing.root === streamRoot &&
      existing.sessionId === streamSessionId &&
      existing.streamId !== null
    )
      return;
    if (existing) killStream(panel.id, existing.streamId);

    useStore.getState().startExtStream(panel.id, streamRoot, streamSessionId, token);
    let cancelled = false;
    void extensionsOpenStream({ panelId: panel.id, root: streamRoot, token })
      .then((res) => {
        if (res.ok) {
          if (cancelled) void extensionsCloseStream({ streamId: res.data }).catch(() => {});
          else useStore.getState().attachExtStream(panel.id, res.data);
        } else if (!cancelled) {
          // The open produced no streamId (EXT_NOT_ENABLED, EXT_INVALID_TOKEN,
          // EXT_PATH_OUTSIDE_ROOT…), so the panel is addressed directly.
          useStore.getState().failExtStreamPanel(panel.id, res.error);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      // FR-12: a real session change already closed this panel's stream
      // synchronously, in sessionsStore's `setActiveSessionId` — well before
      // this cleanup runs (the session switch that triggers it runs before
      // React's render/commit, and a project-scoped section is keyed on the
      // session, so this IS an unmount, not a same-instance re-open). Nothing
      // is left to grace: scheduling a timer here would key off a stale
      // `streamId` of `null` and could later match a brand-new stream that
      // also has not attached its real id yet.
      const at = useStore.getState().extStreams[panel.id];
      if (!at) return;
      // FR-43: leaving the tab does NOT kill the stream immediately — it gets a
      // 10 s grace period, so flipping to DIFF and back keeps the buffer. The
      // timer checks the streamId it was scheduled for, so a re-open in the
      // meantime (a new row, a new root) can never be killed by it.
      const streamId = at.streamId;
      graceTimers.set(
        panel.id,
        setTimeout(() => {
          graceTimers.delete(panel.id);
          const now = useStore.getState().extStreams[panel.id];
          if (now && now.streamId === streamId) killStream(panel.id, streamId);
        }, EXT_STREAM_GRACE_MS),
      );
    };
  }, [gate, panel.id, streamRoot, streamSessionId, token, retryTick]);

  // Bottom-latched: the newest line is what a tail is for.
  const lineCount = stream?.log.lines.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lineCount]);

  const live = stream?.streamId !== null && stream?.streamId !== undefined;
  const notice = earlierLinesNotice(stream?.log.dropped ?? 0);

  return (
    <section className="ext-section">
      <div className="ext-section__header">
        <span className="ext-section__label">{panel.label}</span>
        <span className="ext-section__header-right">
          {gate === 'ready' && live && (
            // The ONE acid accent in the tab: the live thing (design brief §2).
            <span className="ext-live">
              <StatusDot color="var(--accent)" size={5} pulsing />
              <span>live</span>
            </span>
          )}
        </span>
      </div>
      <div className="ext-section__body">
        {gate === 'no-session' && <div className="ext-note">{SELECT_SESSION_COPY}</div>}
        {gate === 'unavailable' && <div className="ext-note ext-note--recessed">{notAvailableCopy(projectName)}</div>}
        {/* FR-38: not an error, and nothing spawned — it points back at its source. */}
        {gate === 'no-selection' && <div className="ext-note">{SELECT_ROW_COPY}</div>}
        {gate === 'ready' && (
          <>
            <div className="ext-log scz" ref={scroller}>
              {notice && <div className="ext-log__notice">{notice}</div>}
              {lineCount === 0 && !stream?.error && <div className="ext-log__waiting">{panel.emptyCopy}</div>}
              {stream?.log.lines.map((line, i) => (
                // FR-40: keyed by a monotonic line number (dropped-count + index
                // within the retained slice), not the array index — the ring
                // buffer drops from the front, which would otherwise shift every
                // remaining row's index and key.
                <div className="ext-log__line" key={(stream.log.dropped ?? 0) + i}>
                  {line}
                </div>
              ))}
            </div>
            {/* FR-45/FR-49: an exit or an error renders BELOW the retained
                buffer, never over it — both go through the one shared error
                treatment (cause, resolved command, detail, Retry). */}
            {stream?.error && (
              <ExtSectionError error={stream.error} minVersionLabel={extension.minVersionLabel} onRetry={retry} />
            )}
            {!stream?.error && stream?.exitCode !== null && stream?.exitCode !== undefined && stream.exitCode !== 0 && (
              <ExtSectionError
                error={{ code: 'EXT_PROVIDER_EXIT', message: '', detail: { code: stream.exitCode } }}
                minVersionLabel={extension.minVersionLabel}
                onRetry={retry}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}
