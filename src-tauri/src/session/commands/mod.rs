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
/// pi-migration-rollout FR-2/FR-3/FR-5: `session_create`'s whole
/// `piProfile`/`profileId` decision, pure and testable without an
/// `AppHandle` — a new file per `lifecycle.rs` already being over
/// CLAUDE.md's ~1000-line cap, rather than growing it further.
/// pi-skills-capabilities FR-5: `session_acknowledge_policy` — a LEAD
/// ADDITION (see contract/session-engine.ts's own comment on
/// `RuntimePolicyAcknowledgeInput`). A new file rather than growing
/// `lifecycle.rs` (already over CLAUDE.md's ~1000-line cap).
mod queries;
/// pi-models-metrics §5: `francois:runtime:models` / `francois:session:metrics`
/// — a new file per this feature's own ownership notes, rather than growing
/// `queries.rs`.
/// pi-turn-controls: `session_submit` / `session_clear_queue` — the explicit-
/// delivery send and the bulk queue clear. A new file per this feature's own
/// ownership notes, rather than growing `turn.rs`.
mod turn;

pub use decisions::*;
pub use lifecycle::*;
pub use queries::*;
pub use turn::*;
