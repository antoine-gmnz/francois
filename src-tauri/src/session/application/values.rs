use super::*;
#[derive(Clone)]
pub struct TurnContext {
    pub(crate) scope: RuntimeScope,
    pub(crate) execution: ExecutionConfig,
    pub(crate) session_id: String,
    pub(crate) block_id: String,
    pub(crate) text: String,
    pub(crate) mode: TurnMode,
    pub(crate) cwd: String,
    pub(crate) model_id: String,
    pub(crate) effort: Option<String>,
    pub(crate) permission_mode: String,
    pub(crate) runtime: String,
    pub(crate) worktree_distro: Option<String>,
    pub(crate) account_id: String,
    /// Carried per FR-1's field list, even though `ClaudeCodeAdapter` does not
    /// read it directly today: the allowGit auto-approve fast path is decided
    /// deeper, in the control-channel handler, which still reads it live off
    /// `Session` (unchanged) rather than off this snapshot.
    #[allow(dead_code)]
    pub(crate) allow_git: bool,
    /// The saved native resume anchor. A rejected resume fails the turn
    /// explicitly; nothing retries it fresh (process-session-continuity FR-5).
    pub(crate) resume: Option<String>,
    /// session-profiles FR-13: the REPLACE-mode prompt, snapshotted at session
    /// creation and carried on EVERY turn — never re-read from the profile.
    pub(crate) system_prompt: Option<String>,
    /// session-profiles FR-12: raw extra argv tokens, appended last to the
    /// runtime's own argv. Empty when the session carries none.
    pub(crate) extra_args: Vec<String>,
    /// response-mode FR-5: the mode this turn was SPAWNED with, snapshotted with
    /// the rest. No adapter re-reads the session mid-turn, which is what makes
    /// FR-4's next-turn semantics uniform across runtimes.
    pub(crate) response_mode: crate::session::ResponseMode,
}

#[derive(Clone, Copy, PartialEq)]
pub enum TurnMode {
    Normal,
    #[allow(dead_code)]
    Compact,
}

/// FR-2: pending-state introspection. `refresh_parked_status` derives
/// `awaiting_approval`/`awaiting_input` from this without knowing which
/// adapter it is talking to.
#[derive(Clone, Copy, Default)]
pub struct PendingCounts {
    pub(crate) questions: usize,
    pub(crate) permissions: usize,
}

/// FR-2: what `permissions_decide` hands to `TurnControl::decide_permission`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PermissionDecision {
    Allow,
    Deny,
    Cancel,
}

/// The result of a `TurnControl::answer_question`/`decide_permission` call.
///
/// Richer than the bare `bool` the spec's FR-2 sketches, because the caller
/// (`session_answer_question`/`permissions_decide`) must tell "never pending"
/// (no event at all) apart from "pending, but the channel died between park
/// and decision" (a `cancelled` resolution is still owed, matching the
/// pre-refactor behavior). Both call sites match all three variants: the two
/// failure variants return the SAME `*_NOT_PENDING` error, and only
/// `ChannelClosed` resolves the card `cancelled` on its way out.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ControlAck {
    Unsupported,
    InvalidAnswer,
    /// The id was never pending (unknown, or already resolved by a race).
    NotPending,
    /// The id was pending and the decision reached the control channel.
    Applied,
    /// The id was pending, but the channel is gone (the child died between
    /// park and decision) — the caller resolves it `cancelled`.
    ChannelClosed,
    /// The write was accepted locally; native confirmation will resolve it.
    #[allow(dead_code)] // Native server acknowledgment is implemented in09.
    AwaitingConfirmation,
}

/// FR-2: replaces direct field access on the concrete turn handle, which
/// moves into `claude_code.rs` and is `pub(crate)` to it only. No command may
/// name a `Child`, a `ChildStdin`, or a pending map (FR-8) — everything reaches
/// the live turn through this trait.
pub(crate) trait TurnControl: Send + Sync {
    fn interrupt(&self);
    fn kill(&self);
    /// `id` is the caller's own tracking key for the ask — `blockId` at every
    /// call site today. The CLI's own `request_id` is an adapter-internal
    /// implementation detail the engine never sees.
    fn answer_question(&self, id: &str, answers: &Value) -> ControlAck;
    fn decide_permission(&self, id: &str, decision: PermissionDecision) -> ControlAck;
    /// permission-guardrails FR-7: the rule pattern a STILL-PENDING permission
    /// ask was parked with. A peek — it claims nothing, so `permissions_decide`
    /// can write an `*Always` rule before claiming (the spec'd order) without
    /// consuming the ask. `None` once the ask is resolved, or if it never was
    /// pending: that is the authorization gate on the rule write, and it must
    /// never be answered from the transcript buffer, whose resolved permission
    /// cards keep their `ask` (pattern included) for the life of the session.
    fn pending_permission_pattern(&self, id: &str) -> Option<String>;
    fn pending_counts(&self) -> PendingCounts;
    /// App-exit teardown only (`kill_all`): synchronously claim every pending
    /// ask so it can be resolved `cancelled` before the process is killed.
    /// Returns `(question block ids, permission block ids)`.
    fn drain_pending(&self) -> (Vec<String>, Vec<String>);
}
