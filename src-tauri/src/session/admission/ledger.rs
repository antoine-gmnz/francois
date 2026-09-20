//! session/admission/ledger.rs — pi-turn-controls: the admit/consume/clear/
//! unqueue state machine — `AdmissionLedger`'s own behavioural methods. Split
//! out of the former single-file `admission.rs` purely for CLAUDE.md's
//! ~1000-line file cap; no behaviour changed by the split.

use super::*;

impl AdmissionLedger {
    pub(crate) fn is_closed(&self) -> bool {
        self.close_depth > 0
    }

    /// FR-6: the first step of Stop — and of `session_clear_queue`'s own
    /// bracket. Nesting (see `close_depth`): two brackets may overlap, and the
    /// ledger stays closed until the LAST of them reopens it.
    pub(crate) fn close(&mut self) {
        self.close_depth += 1;
    }

    /// FR-6/FR-7: reopen once the bracket that closed admission has settled —
    /// a session is not permanently disabled by a Stop. Saturating, so a
    /// reopen with no matching close is a no-op rather than a depth that
    /// underflows and swallows the next real close.
    pub(crate) fn reopen(&mut self) {
        self.close_depth = self.close_depth.saturating_sub(1);
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
        // FR-6: "Reject while stopping" — the AUTHORITATIVE check, deliberately
        // here rather than only in `admit_and_deliver`, which probes
        // `is_closed` in one lock acquisition and calls this in another: a Stop
        // landing between the two would otherwise admit and dispatch a message
        // AFTER the abort, starting a new turn the user just stopped. This runs
        // under the same lock acquisition as the insert below, so it cannot be
        // raced. It sits AFTER the idempotent-retry branch on purpose — a retry
        // of a known id creates no new delivery, so it stays answerable while
        // closed — and before validation, so a race is reported as the race it
        // is rather than as a content complaint.
        if self.is_closed() {
            return Err(AdmitError::Closed);
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
    ///
    /// FR-6/FR-7: only a still-`Admitting` entry may be settled by its own
    /// dispatch. The dispatch happens with no lock held, so a Stop (or a
    /// `session_clear_queue`) can settle the entry `cancelled`/
    /// `delivery-unknown` while the wire call is still out; that outcome is
    /// already published AND persisted, so a late result must not overwrite
    /// it — the user pressed Stop, saw the message cancelled, and it would
    /// otherwise come back as `queued` and survive a restart. Anything already
    /// settled is left exactly as it is, and its CURRENT receipt is returned.
    pub(crate) fn mark_dispatch_result(
        &mut self,
        client_message_id: &str,
        outcome: DispatchOutcome,
    ) -> Option<RuntimeMessageReceipt> {
        {
            let entry = self.find_mut(client_message_id)?;
            if entry.state == AdmissionState::Admitting {
                entry.state = match outcome {
                    DispatchOutcome::Accepted => AdmissionState::Queued,
                    DispatchOutcome::Rejected => AdmissionState::Rejected,
                    DispatchOutcome::Uncertain => AdmissionState::DeliveryUnknown,
                };
            }
        }
        // Read the receipt BEFORE the eviction pass: this entry may itself be
        // the one evicted (it just became terminal), and the caller still needs
        // the outcome it is reporting.
        let receipt = self.receipt_for(client_message_id);
        self.evict_terminal_overflow();
        receipt
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

    /// FR-3: settle the admission a consumed `message.user` corresponds to.
    /// `echoed` is the `clientMessageId` Pi put on that event (`normalize`
    /// already parses it off the wire).
    ///
    /// HIGH (review): the echo is the ONLY exact association there is, and it
    /// is not "matching on text" — `seq` is ADMISSION order, which is not wire
    /// order, so the moment Pi consumes out of order (a steer jumping the
    /// line, or its own queue reordering) oldest-first settles the wrong row
    /// and strands the real one pending forever. Oldest-first survives ONLY as
    /// the fallback for an echo that carries no id at all — FR-3's "Pi has no
    /// assumed echoed request ID on message events", which covers an older Pi
    /// build and every `message.user` Pi generates itself rather than from one
    /// of our submissions.
    ///
    /// `None` when there is nothing to settle: an empty ledger, an echo naming
    /// an id this session never admitted (not ours — settling an unrelated row
    /// would be exactly the mis-association this guards against), or one whose
    /// entry is already terminal (a late echo must not resurrect a draft the
    /// user already saw cancelled). Consumed removes the entry from the ledger
    /// entirely — contract clarification: "a 'consumed' entry drops out of the
    /// array — its transcript block replaces it," unlike the recoverable
    /// terminal states below.
    pub(crate) fn mark_consumed(&mut self, echoed: Option<&str>) -> Option<RuntimeMessageReceipt> {
        let pending =
            |e: &&Entry| matches!(e.state, AdmissionState::Admitting | AdmissionState::Queued);
        let entry = match echoed {
            Some(id) => self.find(id).filter(pending)?.clone(),
            None => self
                .entries
                .iter()
                .filter(pending)
                .min_by_key(|e| e.seq)?
                .clone(),
        };
        self.entries
            .retain(|e| e.client_message_id != entry.client_message_id);
        let mut consumed = entry;
        consumed.state = AdmissionState::Consumed;
        Some(consumed.receipt(None))
    }

    /// FR-9 (review): keep at most [`MAX_TERMINAL_DRAFTS`] recoverable
    /// terminal entries, oldest (by admission order) evicted first. Run after
    /// every transition that CREATES one — `mark_dispatch_result`, `clear`,
    /// `mark_all_pending_unknown`, and the sidecar's own `hydrate_from_drafts`
    /// — so the ledger, and the whole-file sidecar snapshot behind it, has a
    /// real upper bound rather than the one its doc claimed.
    ///
    /// It NEVER evicts a non-terminal entry: an `admitting`/`queued` message
    /// is live work Pi may still consume, not a draft to drop.
    pub(super) fn evict_terminal_overflow(&mut self) {
        let mut seqs: Vec<u64> = self
            .entries
            .iter()
            .filter(|e| e.state.is_recoverable_terminal())
            .map(|e| e.seq)
            .collect();
        if seqs.len() <= MAX_TERMINAL_DRAFTS {
            return;
        }
        seqs.sort_unstable();
        let oldest_kept = seqs[seqs.len() - MAX_TERMINAL_DRAFTS];
        self.entries
            .retain(|e| !e.state.is_recoverable_terminal() || e.seq >= oldest_kept);
    }

    /// FR-5/FR-6: bulk clear — every non-terminal entry becomes `Cancelled`.
    /// Contract clarification (lead, post-freeze): a cancelled entry STAYS in
    /// the ledger, text intact, as a recoverable draft — it is never silently
    /// dropped, only removed later by an explicit `unqueue`. That is the ONE
    /// removal path: Discard calls it directly, and a Resend mints a NEW id
    /// (see `unqueue`'s own doc above) and then unqueues the stale row — a
    /// fresh `admit` reusing the id would never replace the draft anyway, it
    /// returns the existing receipt or `IdConflict`. Returns just the entries
    /// THIS call cancelled, for `RuntimeQueueClearOutput.entries`.
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
        self.evict_terminal_overflow();
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
        self.evict_terminal_overflow();
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

/// FR-6: the close/reopen bracket, held as a GUARD rather than as paired
/// calls. `reopen` runs when this drops, so an early return — or a panic —
/// anywhere inside the bracket (the Stop sequence, `session_clear_queue`)
/// cannot leave `close_depth` permanently above zero, which would refuse
/// every later submit on that session with "the session is stopping" until
/// the app restarts. Same shape, and for the same reason, as
/// `adapter::pi::recovery::RecoveryClaim`.
///
/// Nesting still works: the guard only ever adds one to the depth and takes
/// one back off, so two overlapping brackets behave exactly as `close_depth`
/// describes.
pub(crate) struct AdmissionClose<'a> {
    engine: &'a Engine,
    session_id: String,
}

impl<'a> AdmissionClose<'a> {
    /// Close admission for `session_id` and hand back the guard that reopens
    /// it. Taking the guard IS the close — there is no way to close without
    /// one, which is what makes the leak unreachable rather than merely
    /// unlikely.
    pub(crate) fn hold(engine: &'a Engine, session_id: &str) -> Self {
        engine.with_admissions(session_id, |l| l.close());
        Self {
            engine,
            session_id: session_id.to_string(),
        }
    }
}

impl Drop for AdmissionClose<'_> {
    fn drop(&mut self) {
        self.engine
            .with_admissions(&self.session_id, |l| l.reopen());
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
        l.mark_consumed(None);
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
    fn mark_consumed_with_no_echo_picks_admission_order_never_text_equality() {
        let mut l = AdmissionLedger::default();
        // Two DISTINCT ids, IDENTICAL text — consumption must key on order,
        // not on matching the text (FR-3).
        l.admit("first", "same text", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        l.admit("second", "same text", DeliveryMode::FollowUp, &ids(), 1)
            .unwrap();
        let consumed = l.mark_consumed(None).unwrap();
        assert_eq!(consumed.client_message_id, "first");
        assert_eq!(consumed.state, AdmissionState::Consumed);
        // The remaining entry is unaffected and still pending.
        assert_eq!(l.snapshot_pending().len(), 1);
        assert_eq!(l.snapshot_pending()[0].receipt.client_message_id, "second");
    }

    #[test]
    fn mark_consumed_on_an_empty_ledger_is_a_quiet_no_op() {
        let mut l = AdmissionLedger::default();
        assert!(l.mark_consumed(None).is_none());
    }

    /// HIGH (review): `seq` is ADMISSION order, which is not WIRE order. Pi
    /// echoes the `clientMessageId` on the `message.user` it consumed, and
    /// `normalize` already parses it — ignoring it settled the wrong row the
    /// moment Pi consumed out of order, and stranded the real one pending.
    #[test]
    fn an_echoed_client_message_id_consumes_that_entry_not_the_oldest() {
        let mut l = AdmissionLedger::default();
        l.admit("a", "first", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        l.admit("b", "second", DeliveryMode::FollowUp, &ids(), 1)
            .unwrap();
        let consumed = l
            .mark_consumed(Some("b"))
            .expect("the echoed id names the entry exactly");
        assert_eq!(consumed.client_message_id, "b");
        assert_eq!(consumed.state, AdmissionState::Consumed);
        let pending = l.snapshot_pending();
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].receipt.client_message_id, "a",
            "the entry Pi did not consume must stay pending"
        );
    }

    #[test]
    fn an_echo_naming_an_unknown_or_already_terminal_entry_settles_nothing() {
        let mut l = AdmissionLedger::default();
        l.admit("a", "m", DeliveryMode::Normal, &ids(), 0).unwrap();
        assert!(
            l.mark_consumed(Some("not-ours")).is_none(),
            "a message.user that is not one of our submissions must not consume a row"
        );
        assert_eq!(l.snapshot_pending().len(), 1);
        l.clear();
        assert!(
            l.mark_consumed(Some("a")).is_none(),
            "a late echo must not resurrect a draft the user already saw cancelled"
        );
        assert_eq!(l.snapshot_pending().len(), 1);
    }

    // ---------- FR-9 (review): the recoverable drafts are bounded ----------

    /// The sidecar's doc claimed "capped at 20 entries" while nothing capped
    /// the terminal half at all — every Stop added drafts that only an
    /// explicit Discard ever removed, and the whole-file sidecar was rewritten
    /// with all of them on every change.
    #[test]
    fn terminal_drafts_are_capped_oldest_first() {
        let mut l = AdmissionLedger::default();
        let mut admit_and_cancel = |from: usize, count: usize| {
            for i in from..from + count {
                l.admit(
                    &format!("c{i}"),
                    "m",
                    DeliveryMode::Normal,
                    &ids(),
                    i as u64,
                )
                .unwrap();
            }
            l.clear();
        };
        admit_and_cancel(0, MAX_TERMINAL_DRAFTS);
        admit_and_cancel(MAX_TERMINAL_DRAFTS, 5);

        let pending = l.snapshot_pending();
        assert_eq!(pending.len(), MAX_TERMINAL_DRAFTS);
        // The five OLDEST went; the newest five are the ones still on record.
        assert_eq!(pending[0].receipt.client_message_id, "c5");
        assert_eq!(
            pending[MAX_TERMINAL_DRAFTS - 1].receipt.client_message_id,
            format!("c{}", MAX_TERMINAL_DRAFTS + 4)
        );
    }

    #[test]
    fn the_terminal_cap_never_evicts_a_live_entry() {
        let mut l = AdmissionLedger::default();
        // One entry Pi has ACCEPTED, admitted first so it is the oldest of all
        // — exactly what an oldest-first eviction would reach for.
        l.admit("live", "still queued", DeliveryMode::Normal, &ids(), 0)
            .unwrap();
        l.mark_dispatch_result("live", DispatchOutcome::Accepted);
        for round in 0..2 {
            for i in 0..MAX_TERMINAL_DRAFTS {
                let id = format!("d{round}-{i}");
                l.admit(&id, "m", DeliveryMode::Normal, &ids(), 1).unwrap();
                l.mark_dispatch_result(&id, DispatchOutcome::Rejected);
            }
        }
        let pending = l.snapshot_pending();
        assert_eq!(pending.len(), MAX_TERMINAL_DRAFTS + 1);
        assert_eq!(pending[0].receipt.client_message_id, "live");
        assert_eq!(pending[0].receipt.state, AdmissionState::Queued);
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
        l.mark_consumed(None); // consumed entries are removed from the ledger
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
        l.mark_consumed(None);
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

    /// FR-6: Stop and `session_clear_queue` both bracket their wire calls with
    /// close/reopen, so the two can overlap. With a boolean flag the inner
    /// bracket's `reopen` would reopen admission while the outer one is still
    /// mid-sequence — a depth counter is what makes the bracket composable.
    #[test]
    fn close_nests_so_an_overlapping_bracket_cannot_reopen_early() {
        let mut l = AdmissionLedger::default();
        l.close();
        l.close();
        l.reopen();
        assert!(
            l.is_closed(),
            "the outer bracket is still open; only its own reopen may unclose the ledger"
        );
        l.reopen();
        assert!(!l.is_closed(), "the last reopen settles the ledger open");
    }

    // ---------- FR-6 (review): the bracket is a guard, not paired calls ----------

    /// LOW (review): `close()` and `reopen()` used to be written out by hand
    /// around the wire calls, so an early return — or a panic — between them
    /// leaked a close. A leaked close refuses EVERY later submit on that
    /// session with "the session is stopping", for the life of the app.
    #[test]
    fn a_panic_inside_the_admission_bracket_still_reopens_it() {
        let engine =
            crate::session::testutil::test_engine_with(crate::session::testutil::test_session());
        // The panic below prints, as any caught panic does — it is the point
        // of the test, not a failure.
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _closed = AdmissionClose::hold(&engine, "s1");
            assert!(engine.with_admissions("s1", |l| l.is_closed()));
            panic!("the bracket's body blew up");
        }));
        assert!(panicked.is_err());
        assert!(
            !engine.with_admissions("s1", |l| l.is_closed()),
            "a session must not be left permanently unable to accept a submit"
        );
    }

    #[test]
    fn two_overlapping_guards_keep_the_ledger_closed_until_the_last_one_drops() {
        let engine =
            crate::session::testutil::test_engine_with(crate::session::testutil::test_session());
        let outer = AdmissionClose::hold(&engine, "s1");
        {
            let _inner = AdmissionClose::hold(&engine, "s1");
        }
        assert!(
            engine.with_admissions("s1", |l| l.is_closed()),
            "the outer bracket is still open"
        );
        drop(outer);
        assert!(!engine.with_admissions("s1", |l| l.is_closed()));
    }

    #[test]
    fn reopen_on_an_already_open_ledger_never_underflows() {
        let mut l = AdmissionLedger::default();
        l.reopen();
        assert!(!l.is_closed());
        // A stray reopen must not leave a "negative" depth that swallows the
        // next real close.
        l.close();
        assert!(l.is_closed());
    }

    // ---------- FR-6: a closed ledger admits nothing new ----------

    /// `admit_and_deliver` probes `is_closed` in one lock acquisition and calls
    /// `admit` in another; a Stop landing between the two must still be caught,
    /// so the authoritative check is the one INSIDE `admit` — under the same
    /// lock acquisition as the insert.
    #[test]
    fn a_closed_ledger_refuses_a_brand_new_admission() {
        let mut l = AdmissionLedger::default();
        l.close();
        assert!(
            matches!(
                l.admit("c1", "m", DeliveryMode::Normal, &ids(), 0),
                Err(AdmitError::Closed)
            ),
            "a submit racing a Stop must not be admitted after admission closed"
        );
        assert!(
            l.snapshot_pending().is_empty(),
            "the refused admission leaves no entry behind"
        );
        l.reopen();
        assert!(l.admit("c1", "m", DeliveryMode::Normal, &ids(), 0).is_ok());
    }

    /// A retry of a KNOWN id creates no new delivery, so it stays answerable
    /// while closed — the idempotent branch runs before the closed check.
    #[test]
    fn a_retry_of_a_known_id_is_still_answered_while_closed() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "m", DeliveryMode::Normal, &ids(), 0).unwrap();
        l.close();
        let (receipt, is_new) = l
            .admit("c1", "m", DeliveryMode::Normal, &ids(), 0)
            .expect("a retry of a known id is answerable while closed");
        assert!(!is_new);
        assert_eq!(receipt.client_message_id, "c1");
        // And a conflicting retry is still a conflict, not a Closed.
        assert!(matches!(
            l.admit("c1", "different", DeliveryMode::Normal, &ids(), 0),
            Err(AdmitError::IdConflict)
        ));
    }

    // ---------- FR-6: a settled entry is never resurrected ----------

    /// The race: a submit blocks in its wire dispatch, a Stop cancels the entry
    /// meanwhile (published AND persisted), then the dispatch returns and marks
    /// its result. The user pressed Stop and saw it cancelled — it must not
    /// come back as `queued`.
    #[test]
    fn mark_dispatch_result_never_resurrects_a_cancelled_entry() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "m", DeliveryMode::Normal, &ids(), 0).unwrap();
        l.clear();
        let receipt = l
            .mark_dispatch_result("c1", DispatchOutcome::Accepted)
            .expect("the entry is still on record as a recoverable draft");
        assert_eq!(
            receipt.state,
            AdmissionState::Cancelled,
            "a late dispatch result must not undo the Stop the user already saw"
        );
        assert_eq!(
            l.snapshot_pending()[0].receipt.state,
            AdmissionState::Cancelled
        );
    }

    #[test]
    fn mark_dispatch_result_leaves_a_delivery_unknown_entry_alone() {
        let mut l = AdmissionLedger::default();
        l.admit("c1", "m", DeliveryMode::Normal, &ids(), 0).unwrap();
        l.mark_all_pending_unknown();
        let receipt = l
            .mark_dispatch_result("c1", DispatchOutcome::Rejected)
            .unwrap();
        assert_eq!(receipt.state, AdmissionState::DeliveryUnknown);
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
