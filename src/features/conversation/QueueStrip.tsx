import type { RuntimeQueueEntry } from '../../../contract/common';
import { firstLine } from './pending-queue';
import { clearableCount, isLocalOnly, needsResend, queueEntryStatusLabel } from '../../lib/pi-queue';
import './conversation.css';
import './pi-turn-controls.css';

export interface QueueStripProps {
  /** This session's visible ledger rows (pi-queue's useQueueEntries — already
   *  filtered: no 'consumed' rows; recoverable terminal rows stay listed
   *  until the user removes them). */
  entries: readonly RuntimeQueueEntry[];
  /** split-session: an unfocused pane renders the rows but no controls — same
   *  gate the legacy pending strip and the composer bar use. */
  inert: boolean;
  /**
   * FR-5 (amended): a local ('admitting') row's ✕, or a terminal row's
   * "Discard" — both are the SAME `session_unqueue` call (blockId =
   * clientMessageId): it removes any entry Pi does not own. The following
   * `queue.changed` is what actually clears the row.
   */
  onUnqueue: (clientMessageId: string) => void;
  /** A terminal row's "Resend" — mints a NEW clientMessageId (FR-3). */
  onResend: (entry: RuntimeQueueEntry) => void;
  /** FR-5: "Clear queued messages" — every entry Pi has already accepted. */
  onClearAll: () => void;
  /**
   * frontend fix loop (double-Resend defect): clientMessageIds currently
   * awaiting a Resend or Discard round trip — that row's Resend AND Discard
   * both render disabled while its id is a member, so a fast double click
   * cannot submit (or discard) the same row twice.
   */
  resendingIds: ReadonlySet<string>;
}

/**
 * pi-turn-controls design brief: the Pi twin of transcript-perf's legacy
 * pending strip — same full-bleed row geometry (`.composer-pending`), but
 * rendering the LIVE admissions ledger (RuntimeQueueEntry) instead of a
 * client-only park list, with per-state actions (FR-3/FR-5).
 */
export default function QueueStrip({ entries, inert, onUnqueue, onResend, onClearAll, resendingIds }: QueueStripProps) {
  if (entries.length === 0) return null;
  const clearable = clearableCount(entries);
  return (
    <div className="composer-pending">
      {clearable > 0 && !inert && (
        <button type="button" className="composer-pending__clear-all" onClick={onClearAll}>
          Clear queued messages ({clearable})
        </button>
      )}
      {entries.map((entry) => {
        // frontend fix loop (double-Resend defect): this row's own Resend/
        // Discard round trip is in flight — both actions render disabled
        // until the `finally` in ComposerPane releases the claim.
        const busy = resendingIds.has(entry.clientMessageId);
        return (
          <div key={entry.clientMessageId} className="composer-pending__row" title={entry.text}>
            <span className="composer-pending__glyph" aria-hidden="true">
              ⟳
            </span>
            <span className="composer-pending__text">{firstLine(entry.text)}</span>
            <span className="composer-pending__status">{queueEntryStatusLabel(entry)}</span>
            {!inert && (
              <span className="composer-pending__actions">
                {isLocalOnly(entry) && (
                  <button
                    type="button"
                    className="composer-pending__remove"
                    aria-label="remove queued message"
                    disabled={busy}
                    onClick={() => onUnqueue(entry.clientMessageId)}
                  >
                    ✕
                  </button>
                )}
                {needsResend(entry) && (
                  <>
                    <button
                      type="button"
                      className={busy ? 'composer-pending__action is-disabled' : 'composer-pending__action'}
                      disabled={busy}
                      onClick={() => onResend(entry)}
                    >
                      Resend
                    </button>
                    <button
                      type="button"
                      className={busy ? 'composer-pending__action is-disabled' : 'composer-pending__action'}
                      disabled={busy}
                      onClick={() => onUnqueue(entry.clientMessageId)}
                    >
                      Discard
                    </button>
                  </>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
