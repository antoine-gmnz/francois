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

/// pi-session-durability FR-6: atomically REPLACE the whole file with a
/// freshly rebuilt block list. Unlike `append_at` (one line, best-effort,
/// `O(1)` per event), a projection rebuild supersedes the file's entire prior
/// content — a crash mid-write must never leave a torn mix of old and new
/// lines, so this writes a sibling temp file (`fs_util`'s shared helper,
/// FR-6: "existing fs helpers", not a private temp-name scheme) and renames
/// it into place.
pub(crate) fn replace_at(path: &Path, blocks: &[BufBlock]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut bytes = Vec::new();
    for block in blocks {
        bytes.extend_from_slice(persisted_block_json(block).to_string().as_bytes());
        bytes.push(b'\n');
    }
    let tmp = crate::fs_util::unique_temp_path(path, "jsonl");
    let result = std::fs::write(&tmp, &bytes).and_then(|_| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}
