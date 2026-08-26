//! core-architecture-wave3 FR-3 — bench 1 of 2: **per-delta streaming cost**.
//!
//! `core-architecture-fixes` FR-2 fixed a real O(n²): `handle_text_delta` used
//! to re-derive the streamed UTF-16 offset by re-encoding the WHOLE accumulated
//! block on every delta, so a 100 KB code block (~25,000 deltas) visibly
//! decelerated as it lengthened. It was fixed by tracking the offset
//! incrementally — and then nothing in the tree could prove it stayed fixed,
//! because there was no bench target and `parse_stream` was not reachable from
//! outside the crate. Both of those are what FR-2/FR-3 changed.
//!
//! Not a CI gate (spec §4, FR-3): `cargo bench` runs it, `cargo test` does not.
//! It still exits non-zero on a blow-up, because a bench nobody can fail is a
//! log line, and the whole reason this file exists is that the regression it
//! watches for went unnoticed once already.
//!
//! `harness = false` (Cargo.toml): `#[bench]` is nightly-only and criterion
//! would be the largest dependency in this tree for two measurements.

use francois::session::parse_stream;
use francois::session::testenv::TestEnv;
use francois::session::testutil::{starting_session, test_engine_with};
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// One text block streamed in `deltas` chunks. The chunk is a realistic size
/// for a `text_delta` and deliberately multi-byte at the end: the offset being
/// tracked is UTF-16, and an ASCII-only fixture would let a byte-count
/// regression pass.
fn stream_of(deltas: usize) -> String {
    let sid = "feed0000-0000-4000-8000-000000000001";
    let chunk = "fn handle(x: u32) -> u32 { x + 1 } // é";
    let mut lines = Vec::with_capacity(deltas + 3);
    lines.push(format!(
        r#"{{"type":"system","subtype":"init","cwd":"/x","session_id":"{sid}","tools":[]}}"#
    ));
    lines.push(format!(
        r#"{{"type":"stream_event","event":{{"type":"content_block_start","index":0,"content_block":{{"type":"text","text":""}}}},"session_id":"{sid}"}}"#
    ));
    for _ in 0..deltas {
        lines.push(format!(
            r#"{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"{chunk}"}}}},"session_id":"{sid}"}}"#
        ));
    }
    lines.push(format!(
        r#"{{"type":"stream_event","event":{{"type":"content_block_stop","index":0}},"session_id":"{sid}"}}"#
    ));
    lines.join("\n")
}

/// Nanoseconds per delta for a stream of `deltas` chunks.
fn ns_per_delta(deltas: usize) -> f64 {
    let ndjson = stream_of(deltas);
    let env = TestEnv {
        engine: test_engine_with(starting_session()),
        ..Default::default()
    };
    let started = Instant::now();
    parse_stream(
        &env,
        "s1",
        Cursor::new(ndjson.into_bytes()),
        &Arc::new(Mutex::new(None)),
        &Arc::new(Mutex::new(HashMap::new())),
        &Arc::new(Mutex::new(HashMap::new())),
        None,
    );
    started.elapsed().as_nanos() as f64 / deltas as f64
}

fn main() {
    // A warm-up run first: the first `parse_stream` of the process pays for
    // lazily-initialised statics, and attributing that to the smallest size
    // would make every later size look artificially flat.
    ns_per_delta(500);

    let sizes = [2_000usize, 8_000, 32_000];
    let mut measured = Vec::new();
    println!("per-delta streaming cost (core-architecture-fixes FR-2)");
    println!("{:>10}  {:>12}", "deltas", "ns/delta");
    for n in sizes {
        let ns = ns_per_delta(n);
        println!("{n:>10}  {ns:>12.1}");
        measured.push(ns);
    }

    // The shape, not the absolute number: an unloaded laptop and a shared CI
    // runner disagree about ns/delta by an order of magnitude, but neither can
    // make a quadratic curve look flat. The old code's cost grew with the
    // accumulated length, so 16× the deltas meant ~16× the per-delta cost.
    let (small, large) = (measured[0], measured[measured.len() - 1]);
    let growth = large / small;
    println!("\n16x the deltas cost {growth:.2}x per delta (flat is ~1.0)");
    if growth > 4.0 {
        eprintln!(
            "REGRESSION: per-delta cost grows with block length ({growth:.2}x over 16x the \
             deltas). This is the O(n^2) core-architecture-fixes FR-2 removed — look for a \
             whole-accumulation scan (encode_utf16, chars().count(), a clone) back in \
             handle_text_delta."
        );
        std::process::exit(1);
    }
}
