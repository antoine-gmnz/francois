//! the session_* / conversation_* Tauri command surface, split by concern:
//! `lifecycle` (create/remove/switchModel/interrupt), `turn` (send/compact/clear),
//! `decisions` (answerQuestion/permissions_decide), `queries` (read-only/misc).
//!
//! Re-exported at `pub(crate)` so every existing path keeps resolving unchanged
//! — `session::commands::<name>` (used by a qualified `use` in persistence.rs's
//! tests) and, via session/mod.rs's own `pub(crate) use commands::*;`, the bare
//! `session::<name>` paths main.rs's `generate_handler!` list depends on.

mod decisions;
mod lifecycle;
mod queries;
mod turn;

pub(crate) use decisions::*;
pub(crate) use lifecycle::*;
pub(crate) use queries::*;
pub(crate) use turn::*;
