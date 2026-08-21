//! transcript-scale FR-1/FR-2: the `block_buffer` eviction concern, split out of
//! `session/mod.rs` per PIPELINE.md's "each child owns one concern" rule — the
//! parent was already past the ~1000-line ceiling before this module existed.
//! Everything here is a pure function over `Vec<BufBlock>` plus its own tests;
//! `Session::trim_block_buffer` (mod.rs) is the only in-tree caller.

use super::BufBlock;

/// transcript-scale FR-1: `Session.block_buffer` never holds more than this many
/// blocks once settled — bounds core memory at boot (FR-3) and at steady state
/// (FR-1/2), same shape as `AGENT_TRAIL_CAP`, different window.
pub(crate) const TRANSCRIPT_BUFFER_CAP: usize = 400;

/// transcript-scale FR-1/FR-2: evict from the HEAD of `blocks` until it is at
/// `cap`, stopping at the oldest unsettled block. A block is unsettled while
/// `streaming` is true — which is exactly the flag every `buf_question`/
/// `buf_permission` ask carries until its resolve flips it (see `BufBlock`),
/// so this single check already covers "streaming" and "unresolved ask" alike.
/// Evicting past an unsettled block would let a later event upsert it back in
/// at the tail, silently reordering the transcript — so eviction simply stops
/// there, and the buffer is allowed to exceed `cap` until it settles. Returns
/// `true` iff anything was evicted (transcript-scale FR-6: this is exactly
/// "a block older than the first held one exists in the persisted transcript",
/// since eviction only ever runs on an already-finalized, already-appended
/// block — and stays true forever once set, because the file is append-only).
pub(crate) fn trim_transcript(blocks: &mut Vec<BufBlock>, cap: usize) -> bool {
    let mut evicted = false;
    while blocks.len() > cap {
        if blocks[0].streaming {
            break;
        }
        blocks.remove(0);
        evicted = true;
    }
    evicted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::BlockKind;

    fn settled_block(id: &str) -> BufBlock {
        BufBlock {
            streaming: false,
            ..BufBlock::new(id, BlockKind::User)
        }
    }

    #[test]
    fn trim_transcript_evicts_from_the_head_down_to_the_cap() {
        let mut blocks: Vec<BufBlock> = (0..410).map(|i| settled_block(&format!("b{i}"))).collect();
        assert!(trim_transcript(&mut blocks, TRANSCRIPT_BUFFER_CAP));
        assert_eq!(blocks.len(), TRANSCRIPT_BUFFER_CAP);
        // The oldest 10 are gone; the newest TRANSCRIPT_BUFFER_CAP survive, in order.
        assert_eq!(blocks[0].block_id, "b10");
        assert_eq!(blocks.last().unwrap().block_id, "b409");
    }

    #[test]
    fn trim_transcript_is_a_noop_under_the_cap() {
        let mut blocks: Vec<BufBlock> = (0..5).map(|i| settled_block(&format!("b{i}"))).collect();
        assert!(!trim_transcript(&mut blocks, TRANSCRIPT_BUFFER_CAP));
        assert_eq!(blocks.len(), 5);
    }

    #[test]
    fn trim_transcript_stops_at_the_oldest_unsettled_block() {
        let mut blocks: Vec<BufBlock> = (0..410).map(|i| settled_block(&format!("b{i}"))).collect();
        blocks[0].streaming = true; // an unresolved ask (or in-flight stream) pinned at the head
        assert!(
            !trim_transcript(&mut blocks, TRANSCRIPT_BUFFER_CAP),
            "eviction must not pass the unsettled head block"
        );
        assert_eq!(blocks.len(), 410); // the buffer exceeds the cap while it's pinned
        assert_eq!(blocks[0].block_id, "b0");

        // Once it settles, the next trim catches back up to the cap.
        blocks[0].streaming = false;
        assert!(trim_transcript(&mut blocks, TRANSCRIPT_BUFFER_CAP));
        assert_eq!(blocks.len(), TRANSCRIPT_BUFFER_CAP);
    }
}
