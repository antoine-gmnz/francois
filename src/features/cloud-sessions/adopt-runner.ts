// cloud-sessions FR-7/FR-15 — the adoption runner.
//
// One adoption at a time (spec §6), driven as: subscribe → adopt → fold every
// `cloud.adopt` event into the single progress record the modal renders as its
// phase list. Kept out of the component for the reason every engine in this
// codebase is (see useHydratedSubscription): no DOM renderer is wired, so the
// ordering rules below are only provable as a plain function.
//
// The ordering matters. `cloud_adopt` runs for up to 180s and emits a phase on
// every transition; spawning it before the listener is live would silently drop
// the first ones, and there is no replay. So the adopt call waits for the
// subscription — exactly the seam the hydrated-subscription helper closes for
// the panels.

import type { AppError, Result } from '../../../contract/common';
import type { CloudAdoptData, CloudAdoptRequest, CloudEvent } from '../../../contract/cloud-sessions';
import { applyCloudEvent, failAdopt, isAdoptTerminal, startAdopt, type AdoptProgress } from './cloud-sessions';

export interface AdoptRunnerOptions {
  request: CloudAdoptRequest;
  /** `onCloudEvent` — resolves once the listener is actually registered. */
  subscribe: (cb: (e: CloudEvent) => void) => Promise<() => void>;
  /** `cloudAdopt` — resolves when the adoption finished, however it finished. */
  adopt: (req: CloudAdoptRequest) => Promise<Result<CloudAdoptData>>;
  /** Called with a NEW record on every change, starting with `resolving`. */
  onProgress: (progress: AdoptProgress) => void;
}

/**
 * An invoke that rejected outright — not a domain failure, so it has no mapped
 * code. Said plainly rather than as an empty error card.
 */
const IPC_FAILURE: AppError = {
  code: 'INTERNAL',
  message: 'Could not reach the adoption service. Try again.',
};

/** Starts the adoption. Returns the cancel/teardown function (idempotent). */
export function startAdoption({ request, subscribe, adopt, onProgress }: AdoptRunnerOptions): () => void {
  let progress = startAdopt(request.ref);
  let cancelled = false;
  let unlisten: (() => void) | null = null;

  const stop = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    stop();
  };

  // `applyCloudEvent` returns the SAME record when it has nothing to say (an
  // event for another ref, a late phase after a terminal one), so reference
  // equality is the whole change gate — no re-render for an ignored event.
  const update = (next: AdoptProgress | null) => {
    if (cancelled || next === null || next === progress) return;
    progress = next;
    onProgress(progress);
  };

  onProgress(progress);

  void subscribe((event) => {
    if (cancelled) return;
    update(applyCloudEvent(progress, event));
  })
    .then((unsub) => {
      if (cancelled) {
        unsub();
        return;
      }
      unlisten = unsub;
      return adopt(request)
        .then((res) => {
          if (cancelled) return;
          if (res.ok) {
            // The modal closes on the session id, so a success without one is a
            // failure with extra steps — an older core or the demo backend's
            // benign `ok(null)` would otherwise freeze the phase list silently.
            const sessionId = res.data?.sessionId;
            if (typeof sessionId !== 'string' || sessionId === '') {
              if (!isAdoptTerminal(progress)) update(failAdopt(progress, IPC_FAILURE));
              return;
            }
            // The command is the authority on success: an event stream that
            // dropped the final phase must not leave the modal on `hydrating`.
            update(
              applyCloudEvent(progress, {
                type: 'cloud.adopt',
                ref: request.ref,
                state: { phase: 'ready', sessionId },
              }),
            );
          } else if (!isAdoptTerminal(progress)) {
            // Only when nothing failed already — the `failed` EVENT carries the
            // detailed error (both repo names, the stalled phase) and the
            // command's own refusal is the coarser copy of it.
            update(failAdopt(progress, res.error));
          }
        })
        .catch(() => {
          if (!cancelled && !isAdoptTerminal(progress)) update(failAdopt(progress, IPC_FAILURE));
        })
        .finally(() => {
          // The command resolving IS the end of the run — the core emits nothing
          // after it, so holding the listener open would only leak it.
          stop();
        });
    })
    .catch(() => {
      // The subscription itself failed: nothing will ever report progress, so
      // say so instead of leaving the phase list frozen on `resolving`.
      if (!cancelled) update(failAdopt(progress, IPC_FAILURE));
    });

  return cancel;
}
