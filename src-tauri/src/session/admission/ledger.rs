//! session/admission/ledger.rs — pi-turn-controls: the admit/consume/clear/
//! unqueue state machine — `AdmissionLedger`'s own behavioural methods. Split
//! out of the former single-file `admission.rs` purely for CLAUDE.md's
//! ~1000-line file cap; no behaviour changed by the split.

use super::*;

impl AdmissionLedger {
    pub(crate) fn is_closed(&self) -> bool {
        self.closed
    }

    /// FR-6: the first step of Stop.
    pub(crate) fn close(&mut self) {
        self.closed = true;
    }

    /// FR-6/FR-7: reopen once Stop's sequence has settled — a session is not
    /// permanently disabled by a Stop.
    pub(crate) fn reopen(&mut self) {
        self.closed = false;
    }

    fn find(&self, client_message_id: &str) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|e| e.client_message_id == client_message_id)
    }

    fn find_mut(&mut self, client_message_id: &str) -> Option<&mut Entry> {
        self.entries
            .iter_mut()
            .find(|e| e.client_message_id == client_message_id)
    }

    fn pending_count(&self) -> usize {
        self.entries
            .iter()
            .filter(|e| matches!(e.state, AdmissionState::Admitting | AdmissionState::Queued))
            .count()
    }

    /// FR-4: 1-based rank among `Queued` entries, in admission order —
    /// `None` for anything not currently `Queued` (an `Admitting` entry
    /// carries no position; contract: "present iff state is 'queued'").
    fn queued_position(&self, client_message_id: &str) -> Option<u32> {
        let target = self.find(client_message_id)?;
        if target.state != AdmissionState::Queued {
            return None;
        }
        let mut queued: Vec<&Entry> = self
            .entries
            .iter()
            .filter(|e| e.state == AdmissionState::Queued)
            .collect();
        queued.sort_by_key(|e| e.seq);
        queued
            .iter()
            .position(|e| e.client_message_id == client_message_id)
            .map(|i| (i + 1) as u32)
    }

    fn receipt_for(&self, client_message_id: &str) -> Option<RuntimeMessageReceipt> {
        let entry = self.find(client_message_id)?;
        Some(entry.receipt(self.queued_position(client_message_id)))
    }

    /// FR-4: idempotent retry / same-id-different-content conflict / the
    /// 20-pending cap, then admits a fresh `Admitting` entry. Returns
    /// `(receipt, is_new)` — `is_new == false` is a retry: the caller must
    /// not attempt delivery again.
    pub(crate) fn admit(
        &mut self,
        client_message_id: &str,
        text: &str,
        delivery: DeliveryMode,
        attachment_ids: &[String],
        now_ms: u64,
    ) -> Result<(RuntimeMessageReceipt, bool), AdmitError> {
        if let Some(existing) = self.find(client_message_id) {
            return if existing.text == text
                && existing.delivery == delivery
                && existing.attachment_ids == attachment_ids
            {
                Ok((self.receipt_for(client_message_id).unwrap(), false))
            } else {
                Err(AdmitError::IdConflict)
            };
        }
        if text.trim().is_empty() {
            return Err(AdmitError::Empty);
        }
        if text.len() > MAX_TEXT_BYTES {
            return Err(AdmitError::TooLarge);
        }
        if self.pending_count() >= MAX_PENDING {
            return Err(AdmitError::QueueFull);
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        let entry = Entry {
            client_message_id: client_message_id.to_string(),
            text: text.to_string(),
            delivery,
            attachment_ids: attachment_ids.to_vec(),
            state: AdmissionState::Admitting,
            created_at: now_ms,
            seq,
        };
        let receipt = entry.receipt(None);
        self.entries.push(entry);
        Ok((receipt, true))
    }

    /// The dispatch attempt for `client_message_id` resolved — settle its
    /// state accordingly. `None` if the id is unknown (should not happen for
    /// a caller that just admitted it).
    pub(crate) fn mark_dispatch_result(
        &mut self,
        client_message_id: &str,
        outcome: DispatchOutcome,
    ) -> Option<RuntimeMessageReceipt> {
        {
            let entry = self.find_mut(client_message_id)?;
            entry.state = match outcome {
                DispatchOutcome::Accepted => AdmissionState::Queued,
                DispatchOutcome::Rejected => AdmissionState::Rejected,
                DispatchOutcome::Uncertain => AdmissionState::DeliveryUnknown,
            };
        }
        self.receipt_for(client_message_id)
    }

    /// pi-turn-controls contract clarification (lead, post-freeze): removes
    /// any entry Pi does NOT own — a still-local `Admitting` intent, or a
    /// terminal recoverable draft (`Cancelled`/`DeliveryUnknown`/`Rejected`).
    /// A Pi-ACCEPTED `Queued` entry stays `Unsupported` (FR-5: never
    /// clear-and-re-enqueue a live queue, which can duplicate consumed work);
    /// a missing id is `NotFound` (never an error — matches the legacy
    /// `session_unqueue`'s "already drained" semantics). This is how the
    /// strip's Discard, and the cleanup after a Resend minted a new id,
    /// forgets a row.
    pub(crate) fn unqueue(&mut self, client_message_id: &str) -> UnqueueOutcome {
        let Some(entry) = self.find(client_message_id) else {
            return UnqueueOutcome::NotFound;
        };
        if entry.state == AdmissionState::Queued {
            return UnqueueOutcome::Unsupported;
        }
        self.entries
            .retain(|e| e.client_message_id != client_message_id);
        UnqueueOutcome::Removed
    }

    /// FR-3: associate consumption with the OLDEST still-pending entry, by
    /// admission order alone — never by matching text or an echoed id. `None`
    /// when nothing is pending (a message.user with no matching admission —
    /// not an error, just nothing for the ledger to settle). Consumed removes
    /// the entry from the ledger entirely — contract clarification: "a
    /// 'consumed' entry drops out of the array — its transcript block
    /// replaces it," unlike the recoverable terminal states below.
    pub(crate) fn mark_consumed_oldest(&mut self) -> Option<RuntimeMessageReceipt> {
        let entry = self
            .entries
            .iter()
            .filter(|e| matches!(e.state, AdmissionState::Admitting | AdmissionState::Queued))
            .min_by_key(|e| e.seq)?
            .clone();
        self.entries
            .retain(|e| e.client_message_id != entry.client_message_id);
        let mut consumed = entry;
        consumed.state = AdmissionState::Consumed;
        Some(consumed.receipt(None))
    }

    /// FR-5/FR-6: bulk clear — every non-terminal entry becomes `Cancelled`.
    /// Contract clarification (lead, post-freeze): a cancelled entry STAYS in
    /// the ledger, text intact, as a recoverable draft — it is never silently
    /// dropped, only removed later by an explicit `unqueue` (Discard) or a
    /// fresh `admit` reusing its id (Resend). Returns just the entries THIS
    /// call cancelled, for `RuntimeQueueClearOutput.entries`.
    pub(crate) fn clear(&mut self) -> Vec<RuntimeQueueEntry> {
        let mut cleared = Vec::new();
        for entry in self.entries.iter_mut() {
            if matches!(
                entry.state,
                AdmissionState::Admitting | AdmissionState::Queued
            ) {
                entry.state = AdmissionState::Cancelled;
                cleared.push(RuntimeQueueEntry {
                    receipt: entry.receipt(None),
                    text: entry.text.clone(),
                    attachment_ids: entry.attachment_ids.clone(),
                    created_at: entry.created_at,
                });
            }
        }
        cleared
    }

    /// FR-6/FR-9: every entry still pending (uncertain cleanup, or a crash)
    /// becomes `delivery-unknown` — kept in the ledger as a recoverable draft
    /// (FR-9: never silently dropped, never auto-resent).
    pub(crate) fn mark_all_pending_unknown(&mut self) -> Vec<RuntimeMessageReceipt> {
        let mut out = Vec::new();
        for entry in self.entries.iter_mut() {
            if matches!(
                entry.state,
                AdmissionState::Admitting | AdmissionState::Queued
            ) {
                entry.state = AdmissionState::DeliveryUnknown;
                out.push(entry.receipt(None));
            }
        }
        out
    }

    /// The composer's queue strip: contract clarification (lead, post-freeze)
    /// — `queue.changed.entries` is the FULL unresolved ledger, in admission
    /// order: `admitting`/`queued` PLUS the recoverable terminal states
    /// (`cancelled`/`delivery-unknown`/`rejected`), which stay listed with
    /// their text intact until the user removes them. A `consumed` entry is
    /// never in `self.entries` at all (removed the instant it settles), so
    /// this is simply every entry still on record, oldest first.
    pub(crate) fn snapshot_pending(&self) -> Vec<RuntimeQueueEntry> {
        let mut all: Vec<&Entry> = self.entries.iter().collect();
        all.sort_by_key(|e| e.seq);
        all.iter()
            .map(|e| RuntimeQueueEntry {
                receipt: e.receipt(self.queued_position(&e.client_message_id)),
                text: e.text.clone(),
                attachment_ids: e.attachment_ids.clone(),
                created_at: e.created_at,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> Vec<String> {
        Vec::new()
    }

    #[test]
    fn admits_a_fresh_entry_as_admitting_with_no_position() {
        let mut l = AdmissionLedger::default();
        let (receipt, is_new) = l
            .admit("c1", "hi", DeliveryMode::Normal, &ids(), 1_000)
            .unwrap();
        assert!(is_new);
        assert_eq!(receipt.state, AdmissionState::Admitting);
        assert!(receipt.queue_position.is_none());
    }

    #[test]
    fn empty_and_oversized_text_are_refused() {
        let mut l = AdmissionLedger::default();
        assert!(matches!(
            l.admit("c1", "   ", DeliveryMode::Normal, &ids(), 0),
            Err(AdmitError::Empty)
        ));
        let huge = "x".repeat(MAX_TEXT_BYTES + 1);
        assert!(matches!(
            l.admit("c2", &huge, DeliveryMode::Normal, &ids(), 0),
            Err(AdmitError::TooLarge)
        ));
    }

    #[test]
    fn retrying_the_same_id_and_content_returns_the_current_receipt_without_a_new_entry() {
        let mut l = AdmissionLedger::default();
        let (first, _) = l
            .admit("c1", "hi", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        l.mark_dispatch_result("c1", DispatchOutcome::Accepted);
        let (second, is_new) = l
            .admit("c1", "hi", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        assert!(!is_new);
        assert_eq!(second.state, AdmissionState::Queued);
        assert_eq!(first.client_message_id, second.client_message_id);
    }

    #[test]
    fn the_same_id_with_different_content_is_a_conflict() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "hi", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        assert!(matches!(
            l.admit("c1", "bye", DeliveryMode::Normal, &ids(), 0),
            Err(AdmitError::IdConflict)
        ));
        assert!(matches!(
            l.admit("c1", "hi", DeliveryMode::Steer, &ids(), 0),
            Err(AdmitError::IdConflict)
        ));
    }

    #[test]
    fn identical_text_with_distinct_ids_is_admitted_as_two_separate_entries() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "same", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        let (_, is_new) = l
            .admit("c2", "same", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        assert!(is_new);
        assert_eq!(l.snapshot_pending().len(), 2);
    }

    #[test]
    fn the_twenty_first_pending_intent_is_refused_with_queue_full() {
        let mut l = AdmissionLedger::default();
        for i in 0..MAX_PENDING {
            l.admit(&format!("c{i}"), "m", DeliveryMode::Normal, &ids(), 0)
                .unwrap();
        }
        assert!(matches!(
            l.admit("c-overflow", "m", DeliveryMode::Normal, &ids(), 0),
            Err(AdmitError::QueueFull)
        ));
    }

    #[test]
    fn a_consumed_or_cancelled_entry_does_not_count_against_the_cap() {
        let mut l = AdmissionLedger::default();
        for i in 0..MAX_PENDING {
            l.admit(&format!("c{i}"), "m", DeliveryMode::Normal, &ids(), 0)
                .unwrap();
        }
        l.mark_dispatch_result("c0", DispatchOutcome::Accepted);
        l.mark_consumed_oldest();
        assert!(l
            .admit("c-fits-now", "m", DeliveryMode::Normal, &ids(), 0)
            .is_ok());
    }

    #[test]
    fn dispatch_outcomes_settle_the_entry_and_a_queued_entry_carries_its_position() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "m", DeliveryMode::Normal, &ids(), 0).unwrap();
        l.admit("c2", "m", DeliveryMode::Steer, &ids(), 0).unwrap();
        let r1 = l
            .mark_dispatch_result("c1", DispatchOutcome::Accepted)
            .unwrap();
        assert_eq!(r1.state, AdmissionState::Queued);
        assert_eq!(r1.queue_position, Some(1));
        let r2 = l
            .mark_dispatch_result("c2", DispatchOutcome::Accepted)
            .unwrap();
        assert_eq!(r2.queue_position, Some(2));

        let mut rejected = AdmissionLedger::default();
        rejected
            .admit("c3", "m", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        let r3 = rejected
            .mark_dispatch_result("c3", DispatchOutcome::Rejected)
            .unwrap();
        assert_eq!(r3.state, AdmissionState::Rejected);
        assert!(r3.queue_position.is_none());

        let mut uncertain = AdmissionLedger::default();
        uncertain
            .admit("c4", "m", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        let r4 = uncertain
            .mark_dispatch_result("c4", DispatchOutcome::Uncertain)
            .unwrap();
        assert_eq!(r4.state, AdmissionState::DeliveryUnknown);
    }

    #[test]
    fn mark_consumed_oldest_picks_admission_order_never_text_equality() {
        let mut l = AdmissionLedger::default();
        // Two DISTINCT ids, IDENTICAL text — consumption must key on order,
        // not on matching the text (FR-3).
        l.admit("first", "same text", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        l.admit("second", "same text", DeliveryMode::FollowUp, &ids(), 1)
            .unwrap();
        let consumed = l.mark_consumed_oldest().unwrap();
        assert_eq!(consumed.client_message_id, "first");
        assert_eq!(consumed.state, AdmissionState::Consumed);
        // The remaining entry is unaffected and still pending.
        assert_eq!(l.snapshot_pending().len(), 1);
        assert_eq!(l.snapshot_pending()[0].receipt.client_message_id, "second");
    }

    #[test]
    fn mark_consumed_oldest_on_an_empty_ledger_is_a_quiet_no_op() {
        let mut l = AdmissionLedger::default();
        assert!(l.mark_consumed_oldest().is_none());
    }

    #[test]
    fn unqueue_removes_a_still_admitting_entry() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "m", DeliveryMode::Normal, &ids(), 0).unwrap();
        assert!(matches!(l.unqueue("c1"), UnqueueOutcome::Removed));
        assert!(l.snapshot_pending().is_empty());
    }

    #[test]
    fn unqueue_refuses_a_pi_owned_queued_entry() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "m", DeliveryMode::Normal, &ids(), 0).unwrap();
        l.mark_dispatch_result("c1", DispatchOutcome::Accepted);
        assert!(matches!(l.unqueue("c1"), UnqueueOutcome::Unsupported));
        // Never removed by the refused attempt.
        assert_eq!(l.snapshot_pending().len(), 1);
    }

    #[test]
    fn unqueue_on_an_unknown_or_already_consumed_id_is_not_found_never_an_error() {
        let mut l = AdmissionLedger::default();
        assert!(matches!(l.unqueue("nope"), UnqueueOutcome::NotFound));
        l.admit("c1", "m", DeliveryMode::Normal, &ids(), 0).unwrap();
        l.mark_dispatch_result("c1", DispatchOutcome::Accepted);
        l.mark_consumed_oldest(); // consumed entries are removed from the ledger
        assert!(matches!(l.unqueue("c1"), UnqueueOutcome::NotFound));
    }

    /// Contract clarification (lead, post-freeze): `unqueue` also removes a
    /// TERMINAL recoverable draft, not just a still-local `Admitting` one.
    #[test]
    fn unqueue_removes_a_cancelled_entry_the_same_way_as_a_local_one() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "m", DeliveryMode::Normal, &ids(), 0).unwrap();
        l.mark_dispatch_result("c1", DispatchOutcome::Accepted);
        l.clear(); // now Cancelled, still on record
        assert_eq!(l.snapshot_pending().len(), 1);
        assert!(matches!(l.unqueue("c1"), UnqueueOutcome::Removed));
        assert!(l.snapshot_pending().is_empty());
    }

    #[test]
    fn unqueue_removes_a_rejected_or_delivery_unknown_entry_too() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "m", DeliveryMode::Normal, &ids(), 0).unwrap();
        l.mark_dispatch_result("c1", DispatchOutcome::Rejected);
        assert!(matches!(l.unqueue("c1"), UnqueueOutcome::Removed));

        let mut l2 = AdmissionLedger::default();
        l2.admit("c2", "m", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        l2.mark_dispatch_result("c2", DispatchOutcome::Uncertain);
        assert!(matches!(l2.unqueue("c2"), UnqueueOutcome::Removed));
    }

    /// Contract clarification (lead, post-freeze): a `clear_queue` no longer
    /// empties the ledger — cancelled entries stay listed, text intact, until
    /// an explicit `unqueue` (Discard) or a fresh `admit` reusing the id
    /// (Resend) removes them. This is what makes them survive into the NEXT
    /// `queue.changed` after a Stop.
    #[test]
    fn clear_cancels_every_pending_entry_and_keeps_it_on_record() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "keep my text", DeliveryMode::Normal, &ids(), 5)
            .unwrap();
        l.admit("c2", "second", DeliveryMode::FollowUp, &ids(), 6)
            .unwrap();
        l.mark_dispatch_result("c2", DispatchOutcome::Accepted);
        let cleared = l.clear();
        assert_eq!(cleared.len(), 2);
        assert!(cleared
            .iter()
            .all(|e| e.receipt.state == AdmissionState::Cancelled));
        assert_eq!(cleared[0].text, "keep my text");

        // Still on record — the very next queue.changed snapshot shows both,
        // cancelled, text intact.
        let pending = l.snapshot_pending();
        assert_eq!(pending.len(), 2);
        assert!(pending
            .iter()
            .all(|e| e.receipt.state == AdmissionState::Cancelled));
        assert_eq!(pending[0].text, "keep my text");
        assert_eq!(pending[1].text, "second");

        // A second clear finds nothing left to cancel — already terminal.
        assert!(l.clear().is_empty());
    }

    #[test]
    fn clear_never_touches_a_consumed_entry() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "m", DeliveryMode::Normal, &ids(), 0).unwrap();
        l.mark_dispatch_result("c1", DispatchOutcome::Accepted);
        l.mark_consumed_oldest();
        let cleared = l.clear();
        assert!(cleared.is_empty());
        assert!(l.snapshot_pending().is_empty());
    }

    #[test]
    fn stop_admission_closes_and_reopens() {
        let mut l = AdmissionLedger::default();
        assert!(!l.is_closed());
        l.close();
        assert!(l.is_closed());
        l.reopen();
        assert!(!l.is_closed());
    }

    #[test]
    fn mark_all_pending_unknown_settles_every_non_terminal_entry_and_keeps_it_as_a_draft() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "draft one", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        l.admit("c2", "draft two", DeliveryMode::Steer, &ids(), 1)
            .unwrap();
        l.mark_dispatch_result("c2", DispatchOutcome::Accepted);
        let unknowns = l.mark_all_pending_unknown();
        assert_eq!(unknowns.len(), 2);
        assert!(unknowns
            .iter()
            .all(|r| r.state == AdmissionState::DeliveryUnknown));
        // Still visible in the pending snapshot — a recoverable draft, not dropped.
        assert_eq!(l.snapshot_pending().len(), 2);
    }
}
