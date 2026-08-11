// The two app-wide seams for `extensions`: the registry feed (FR-4/FR-11 — one
// `extensions_list` per project root, re-run when the active session's root
// changes) and the single subscription to francois://extensions/event, which
// routes every log-tail chunk into the store (FR-44's ownership check lives
// there, not here).
//
// The event feed is app-wide rather than per-section on purpose: FR-43 keeps a
// stream alive for 10 s after its tab stops being active, and the section that
// opened it is unmounted for that whole window — a subscription owned by the
// section would drop exactly the chunks the grace period exists to keep.

import type { SessionMeta } from '../../../contract/common';
import { extensionsList, onExtensionEvent } from '../../lib/api';
import { useStore } from '../../lib/store';

/**
 * FR-3/FR-11: the root detection is evaluated against. A session's cwd IS its
 * root — a worktree session's cwd is its own checkout, which is the tree its
 * `git`/`cohorte` panels must read. `null` (no active session) makes every
 * extension report `detected: false`, which governs whether a NEW tab is
 * offered; an already-open tab's lifecycle is FR-12/FR-13/FR-14, not this.
 */
export function detectionRoot(session: SessionMeta | null): string | null {
  return session?.cwd ?? null;
}

/**
 * Bumped on every call and compared on resolution, the same `reqRef` pattern
 * `PanelSection` uses — a stale `extensions_list(rootA)` answer must never
 * overwrite the store once a newer `extensions_list(rootB)` has been issued.
 */
let refreshReqId = 0;

/** One `extensions_list` for a root, folded into the store. Never throws. */
export function refreshExtensions(root: string | null): Promise<void> {
  const reqId = ++refreshReqId;
  return extensionsList({ root })
    .then((res) => {
      if (reqId !== refreshReqId) return; // a newer root was requested meanwhile
      if (res.ok) useStore.getState().setExtensions(res.data);
    })
    .catch(() => {
      // A bridge failure leaves the previous list standing: the strip must not
      // lose its tabs because one probe could not reach the core.
    });
}

let eventFeedStarted = false;

/** Idempotent — called once at app mount, like initShellEvents/initNotifications. */
export function initExtensionEvents(): void {
  if (eventFeedStarted) return;
  eventFeedStarted = true;
  void onExtensionEvent((e) => {
    const st = useStore.getState();
    switch (e.type) {
      case 'ext.stream.chunk':
        st.appendExtStream(e.streamId, e.lines);
        break;
      case 'ext.stream.ended':
        st.endExtStream(e.streamId, e.exitCode);
        break;
      case 'ext.stream.error':
        st.failExtStream(e.streamId, e.error);
        break;
      case 'ext.stream.started':
        // The streamId is already known from the open call's response; this
        // event carries nothing the frontend does not have.
        break;
    }
  }).catch(() => {
    eventFeedStarted = false;
  });
}
