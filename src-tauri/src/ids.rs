//! Wall clock and identifier minting — the two helpers every domain reaches for
//! and no domain owns.
//!
//! core-architecture-wave3 FR-9: both used to live in `session/mod.rs`, which
//! made `account/` say `crate::session::now_ms()` twelve times over. Reading a
//! clock is not asking the session engine anything, so those twelve references
//! were not coupling anyone had chosen — they were an accident of where the
//! function happened to be typed, and they were half of what kept
//! `session ↔ account` cyclic.
//!
//! `session` re-exports both, so every `crate::session::now_ms()` /
//! `crate::session::uuid()` inside that domain still resolves unchanged; this
//! module is simply where they now live, and it depends on nothing.

use std::time::{SystemTime, UNIX_EPOCH};

/// Epoch milliseconds — the timestamp unit the whole contract uses
/// (`PIPELINE.md` §Conventions: "Timestamps: epoch milliseconds").
///
/// `0` when the system clock is before the epoch, rather than a panic: a
/// nonsense clock must not be able to take the app down, and every consumer
/// already renders `0` as "unknown".
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A uuid-v4 string — the id form the contract specifies for every entity.
pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_ms_is_a_plausible_epoch_millisecond_reading() {
        // Not "close to a hard-coded date" — that expires. The two ends that
        // never do: it is after the app existed, and it is in MILLISECONDS
        // rather than seconds, which is the mistake that would actually happen.
        let now = now_ms();
        assert!(now > 1_700_000_000_000, "before this app existed: {now}");
        assert!(now < 100_000_000_000_000, "not milliseconds: {now}");
    }

    #[test]
    fn uuid_is_v4_and_never_repeats() {
        let a = uuid();
        assert_eq!(a.len(), 36, "{a}");
        assert_eq!(a.as_bytes()[14], b'4', "version nibble: {a}");
        assert_ne!(a, uuid());
    }
}
