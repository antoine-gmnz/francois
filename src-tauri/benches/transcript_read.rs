//! core-architecture-wave3 FR-3 — bench 2 of 2: **the boot transcript read**.
//!
//! `core-architecture-fixes` FR-8 bounded what boot reads: a session with 50,000
//! persisted blocks used to leave the window unpainted for tens of seconds while
//! the whole file was read and quadratically trimmed on the main thread. The
//! fix was a bounded tail read plus a `parse_transcript` whose input is bounded
//! — but `parse_transcript` itself is still O(blocks x distinct block ids),
//! because it upserts by scanning `out` for each line, and that is exactly the
//! quadratic that would come back if the tail window ever grew.
//!
//! Not a CI gate (spec §4, FR-3). Exits non-zero on a blow-up, for the reason
//! the sibling bench documents.

use francois::session::parse_transcript;
use std::time::Instant;

/// `lines` persisted assistant blocks, every one a distinct block id — the
/// worst case for the upsert scan, and the realistic one: a long session's
/// transcript is almost entirely blocks it will never see again.
fn transcript_of(lines: usize) -> String {
    let text = "The change is in `src/session/stream/blocks.rs`; see the note above it.";
    (0..lines)
        .map(|i| {
            format!(
                r#"{{"kind":"assistant","blockId":"b{i:08}","text":"{text}","at":1756000000000}}"#
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn ns_per_block(lines: usize) -> f64 {
    let content = transcript_of(lines);
    let started = Instant::now();
    let blocks = parse_transcript(&content);
    let elapsed = started.elapsed();
    assert_eq!(blocks.len(), lines, "the fixture must parse in full");
    elapsed.as_nanos() as f64 / lines as f64
}

fn main() {
    ns_per_block(200); // warm-up, same reasoning as the sibling bench

    // 400 is TRANSCRIPT_BUFFER_CAP, the size boot actually restores; 1,600 and
    // 6,400 are what a widened tail window would hand it.
    let sizes = [400usize, 1_600, 6_400];
    let mut measured = Vec::new();
    println!("boot transcript read (core-architecture-fixes FR-8)");
    println!("{:>10}  {:>12}  {:>12}", "blocks", "ns/block", "total ms");
    for n in sizes {
        let ns = ns_per_block(n);
        println!("{n:>10}  {ns:>12.1}  {:>12.2}", ns * n as f64 / 1e6);
        measured.push(ns);
    }

    let (small, large) = (measured[0], measured[measured.len() - 1]);
    let growth = large / small;
    println!("\n16x the blocks cost {growth:.2}x per block (linear parse is ~1.0)");
    // Deliberately loose: `parse_transcript`'s upsert IS a scan, so some growth
    // is expected and honest. What this catches is the difference between "a
    // scan over a bounded window" and "the thing that made boot take tens of
    // seconds" — i.e. the tail bound being removed rather than the scan itself.
    if growth > 8.0 {
        eprintln!(
            "REGRESSION: per-block parse cost grows sharply with transcript length \
             ({growth:.2}x over 16x the blocks). Either TRANSCRIPT_TAIL_BYTES grew, or \
             parse_transcript's upsert-by-scan needs a block-id index."
        );
        std::process::exit(1);
    }
}
