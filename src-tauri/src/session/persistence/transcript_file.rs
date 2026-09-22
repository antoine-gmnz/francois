//! session/persistence/transcript_file.rs — the per-session transcript
//! JSONL file's own write rules, over an already-resolved path.
//!
//! A child module rather than more of `persistence.rs` (already past
//! CLAUDE.md's ~1000-line cap and on the quality gate's oversized baseline).
//! `AppHandle`-free on purpose, the same split `adapter::pi::persistence`
//! draws between `native_session_root` and `native_session_dir`: the callers
//! in the parent resolve the path, these two do the writing, and the recovery
//! shell's own tests drive them against a temp dir with no Tauri context.

use super::persisted_block_json;
use crate::session::BufBlock;
use std::path::Path;

/// Append one finalized block as a JSON line (durable-sessions FR-1/2).
/// Best-effort: a write failure is ignored so it never breaks the turn (§7).
pub(crate) fn append_at(path: &Path, block: &BufBlock) {
    use std::io::Write as _;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut line = serde_json::to_string(&persisted_block_json(block)).unwrap_or_default();
    line.push('\n');
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}
