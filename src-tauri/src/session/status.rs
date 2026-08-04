//! The `SessionStatus` vocabulary, mirroring `contract/common.ts`.
//!
//! `Session.status` is a `String` on the wire (see `SessionMeta`), so every
//! comparison used to be a bare literal. That was survivable while the union was
//! `running | idle | done | error`, but three of the seven values now mean "a
//! turn is in flight" — `starting` and both `awaiting_*` states join `running` —
//! and a stray `== RUNNING` would read a session parked on an approval as free,
//! letting a second turn spawn on top of a live child process.
//!
//! So: never compare `status` to a literal. Use the predicates below.

/// Spawned; no stream line has arrived yet.
pub(crate) const STARTING: &str = "starting";
/// The stream is live (system/init seen).
pub(crate) const RUNNING: &str = "running";
/// Parked on a gated tool call (permission-guardrails FR-2).
pub(crate) const AWAITING_APPROVAL: &str = "awaiting_approval";
/// Parked on an AskUserQuestion (session-questions FR-6).
pub(crate) const AWAITING_INPUT: &str = "awaiting_input";
/// No turn in flight; ready for the next message.
pub(crate) const IDLE: &str = "idle";
/// Terminal: the session was closed out.
#[cfg(test)]
pub(crate) const DONE: &str = "done";
/// Terminal: the session failed.
pub(crate) const ERROR: &str = "error";

/// A turn is in flight — the claude child is alive, whether it is streaming or
/// parked on the user. The guard for "can this session accept a new turn?".
pub(crate) fn is_busy(status: &str) -> bool {
    matches!(
        status,
        STARTING | RUNNING | AWAITING_APPROVAL | AWAITING_INPUT
    )
}

/// The session is over for good and accepts no further turns.
pub(crate) fn is_terminal(status: &str) -> bool {
    matches!(status, "done" | ERROR)
}

/// The status a turn should carry given what it is parked on, or `None` when
/// nothing is pending and it should read as plainly `running`.
///
/// Approval outranks question deliberately: a permission ask blocks a concrete
/// tool call the assistant is mid-way through, while a question can sit behind
/// it. With both pending the user wants to see the more specific one.
pub(crate) fn parked_status(
    pending_permissions: usize,
    pending_questions: usize,
) -> Option<&'static str> {
    if pending_permissions > 0 {
        Some(AWAITING_APPROVAL)
    } else if pending_questions > 0 {
        Some(AWAITING_INPUT)
    } else {
        None
    }
}

/// The whole decision behind `refresh_parked_status`, as a pure function:
/// given the session's CURRENT status and how many asks are still pending, what
/// should it become? `None` means "leave it alone".
///
/// The two guards are the load-bearing part:
///  - a session that is no longer busy owns its terminal status, so a late
///    resolution (a drain, a lost claim race) can never resurrect it as
///    `running`;
///  - an unchanged status yields `None` so no redundant `session.status` event
///    goes out on every decision.
pub(crate) fn next_parked_status(
    current: &str,
    pending_permissions: usize,
    pending_questions: usize,
) -> Option<&'static str> {
    if !is_busy(current) {
        return None;
    }
    let next = parked_status(pending_permissions, pending_questions).unwrap_or(RUNNING);
    (current != next).then_some(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [&str; 7] = [
        STARTING,
        RUNNING,
        AWAITING_APPROVAL,
        AWAITING_INPUT,
        IDLE,
        DONE,
        ERROR,
    ];

    #[test]
    fn busy_covers_every_in_flight_state_including_the_parked_ones() {
        // The whole point of the module: a session waiting on an approval is NOT
        // free. If this ever narrows back to `running`, a second turn can spawn
        // on top of a live child.
        for s in [STARTING, RUNNING, AWAITING_APPROVAL, AWAITING_INPUT] {
            assert!(is_busy(s), "{s} must count as busy");
        }
        for s in [IDLE, DONE, ERROR] {
            assert!(!is_busy(s), "{s} must not count as busy");
        }
    }

    #[test]
    fn terminal_is_exactly_done_and_error() {
        for s in [DONE, ERROR] {
            assert!(is_terminal(s));
        }
        for s in [STARTING, RUNNING, AWAITING_APPROVAL, AWAITING_INPUT, IDLE] {
            assert!(!is_terminal(s));
        }
    }

    #[test]
    fn every_status_is_exactly_one_of_busy_terminal_idle() {
        for s in ALL {
            let n = u8::from(is_busy(s)) + u8::from(is_terminal(s)) + u8::from(s == IDLE);
            assert_eq!(n, 1, "{s} landed in {n} buckets");
        }
    }

    #[test]
    fn parked_status_prefers_an_approval_over_a_question() {
        assert_eq!(parked_status(1, 1), Some(AWAITING_APPROVAL));
        assert_eq!(parked_status(2, 0), Some(AWAITING_APPROVAL));
        assert_eq!(parked_status(0, 3), Some(AWAITING_INPUT));
    }

    #[test]
    fn parked_status_is_none_when_nothing_is_pending() {
        // None is what sends a resolved turn back to `running` rather than
        // stranding it as blocked.
        assert_eq!(parked_status(0, 0), None);
    }

    #[test]
    fn parking_a_running_turn_moves_it_to_the_matching_awaiting_state() {
        assert_eq!(next_parked_status(RUNNING, 1, 0), Some(AWAITING_APPROVAL));
        assert_eq!(next_parked_status(RUNNING, 0, 1), Some(AWAITING_INPUT));
        // A turn can park before its init line ever lands.
        assert_eq!(next_parked_status(STARTING, 0, 1), Some(AWAITING_INPUT));
    }

    #[test]
    fn resolving_the_last_ask_returns_the_turn_to_running() {
        assert_eq!(next_parked_status(AWAITING_APPROVAL, 0, 0), Some(RUNNING));
        assert_eq!(next_parked_status(AWAITING_INPUT, 0, 0), Some(RUNNING));
    }

    #[test]
    fn resolving_one_of_two_asks_falls_through_to_the_other() {
        // Answering the approval while a question is still parked must NOT read
        // as "back to work" — the turn is still stalled on the user.
        assert_eq!(
            next_parked_status(AWAITING_APPROVAL, 0, 1),
            Some(AWAITING_INPUT)
        );
        // And a question resolved under a live approval stays on the approval.
        assert_eq!(
            next_parked_status(AWAITING_INPUT, 1, 0),
            Some(AWAITING_APPROVAL)
        );
    }

    #[test]
    fn an_unchanged_status_yields_none_so_no_redundant_event_is_emitted() {
        assert_eq!(next_parked_status(AWAITING_APPROVAL, 1, 0), None);
        assert_eq!(next_parked_status(AWAITING_APPROVAL, 2, 1), None);
        assert_eq!(next_parked_status(RUNNING, 0, 0), None);
    }

    #[test]
    fn a_settled_turn_is_never_resurrected_by_a_late_resolution() {
        // The turn-end drains resolve every orphaned ask AFTER the session may
        // already have settled. Without this guard an interrupted session would
        // flash back to `running` on its way out.
        for s in [IDLE, DONE, ERROR] {
            assert_eq!(next_parked_status(s, 0, 0), None, "{s} must stay put");
            assert_eq!(next_parked_status(s, 1, 0), None, "{s} must stay put");
        }
    }
}
