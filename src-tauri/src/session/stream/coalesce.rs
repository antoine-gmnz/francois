//! `CoalescingEnv` — an accumulation window over `assistant.delta` EMISSIONS.
//!
//! `handle_text_delta` (blocks.rs) emits one `SessionEvent::AssistantDelta` per
//! NDJSON `text_delta` line. Every one of those is its own IPC crossing plus a
//! JSON parse on the webview's main thread, so a handful of sessions streaming
//! at once starves the renderer enough to lag typing — the same failure the
//! shell PTY path already fixed with an 8 ms window (`shell/commands.rs`,
//! `SHELL_EMIT_COALESCE`).
//!
//! This is that window for the session stream: a `SessionEnv` wrapper the
//! reader puts in front of the real env, so every existing call site keeps
//! calling `env.emit_session(...)` unchanged. It holds at most ONE buffered run
//! — same session, same block, inside the window — and emits it as a single
//! event whose payload is indistinguishable from one bigger delta: the text
//! concatenated, the `offset` of the FIRST chunk. Offsets are the UTF-16 prefix
//! counts the caller computed (transcript-perf FR-24) and are never recomputed
//! here.
//!
//! Only the emission is coalesced. `handle_text_delta` still pushes every chunk
//! into the transcript buffer as it arrives (transcript-perf FR-22/FR-23), so a
//! view hydrating mid-block still gets the opening it would otherwise miss.
//!
//! Ordering is the whole correctness argument: ANY other emission — a delta for
//! a different block, a `tool.start`, an `assistant.done`, an agent event —
//! flushes the buffered run BEFORE it goes out, so nothing can overtake text
//! the reader has already produced. The frontend's per-frame flush states the
//! same rule from the other side (transcript-perf FR-5/FR-6).
//!
//! It supersedes transcript-perf's "coalescing deltas in the core" non-goal,
//! whose stated cost was rewriting `fixtures/turn.expected.json` — which this
//! does, with the window injected so the fixture stays a function of the
//! capture's line order and never of wall-clock timing.

use crate::session::*;

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// How long a run of deltas accumulates before the next one flushes it — long
/// enough to fold a fast stream into a handful of events per second, short
/// enough that the answer still reads as typing. Same figure and same reasoning
/// as the shell's `SHELL_EMIT_COALESCE`.
pub(crate) const ASSISTANT_DELTA_COALESCE: Duration = Duration::from_millis(8);

/// One run of deltas: consecutive chunks of the same block that will go out as
/// a single `assistant.delta`.
struct PendingDelta {
    session_id: String,
    block_id: String,
    /// Every chunk in the run, concatenated.
    text: String,
    /// The FIRST chunk's offset — never recomputed, so the merged event looks
    /// exactly like the one bigger delta the model could have sent instead.
    offset: usize,
    /// When the run started, which is what the window is measured against.
    since: Instant,
}

impl PendingDelta {
    fn into_event(self) -> SessionEvent {
        SessionEvent::AssistantDelta {
            session_id: self.session_id,
            block_id: self.block_id,
            text: self.text,
            offset: self.offset,
        }
    }
}

/// A `SessionEnv` that batches `assistant.delta` and passes everything else
/// through untouched. `window` is a parameter rather than the const so a test
/// can pin it open (`Duration::MAX`) or shut (`Duration::ZERO`) and assert the
/// merge without sleeping.
pub(crate) struct CoalescingEnv<'a> {
    inner: &'a dyn SessionEnv,
    window: Duration,
    /// The single buffered run. `Mutex` because `SessionEnv` is `Sync`; in
    /// practice one reader thread owns the wrapper for the whole turn, so this
    /// arbitrates nothing — it is what makes `&self` emission legal.
    pending: Mutex<Option<PendingDelta>>,
}

impl<'a> CoalescingEnv<'a> {
    pub(crate) fn new(inner: &'a dyn SessionEnv, window: Duration) -> Self {
        Self {
            inner,
            window,
            pending: Mutex::new(None),
        }
    }

    /// Emit the buffered run, if any. Idempotent — the run is TAKEN, so the
    /// reader's explicit call and the drop below can never emit it twice.
    pub(crate) fn flush(&self) {
        // Taken from under the lock and emitted outside it: an emission is an
        // IPC crossing, and it has no business happening in a critical section.
        let pending = self.lock_pending().take();
        if let Some(run) = pending {
            self.inner.emit_session(run.into_event());
        }
    }

    /// Lock the buffer without caring about poisoning: it guards one value that
    /// is only ever swapped wholesale, so a panic elsewhere cannot leave it
    /// half-written — and unwrapping here would turn one panic into a turn
    /// whose streamed tail is never emitted. Same rule as `shell/commands.rs`.
    fn lock_pending(&self) -> MutexGuard<'_, Option<PendingDelta>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A delta arrived: extend the buffered run when it continues it, otherwise
    /// end that run — emitting it first, so order is preserved — and start a
    /// new one from this chunk.
    fn buffer_delta(&self, session_id: String, block_id: String, text: String, offset: usize) {
        let ended = {
            let mut pending = self.lock_pending();
            match pending.as_mut() {
                Some(run)
                    if run.session_id == session_id
                        && run.block_id == block_id
                        && run.since.elapsed() < self.window =>
                {
                    run.text.push_str(&text);
                    None
                }
                // A different block (or session), or the window is spent: the
                // buffered run is complete and goes out ahead of this chunk.
                _ => pending.replace(PendingDelta {
                    session_id,
                    block_id,
                    text,
                    offset,
                    since: Instant::now(),
                }),
            }
        };
        if let Some(run) = ended {
            self.inner.emit_session(run.into_event());
        }
    }
}

impl Drop for CoalescingEnv<'_> {
    /// Safety net for the unwind path only — the reader flushes explicitly the
    /// moment its loop ends, because everything it does afterwards emits with
    /// the bare `&AppHandle` and bypasses this wrapper entirely. Without this,
    /// a panic inside the parse loop would swallow the buffered tail instead of
    /// emitting it the way the uncoalesced path did (cf. `ReaderDone` in
    /// `shell/commands.rs`, which exists for the same reason).
    fn drop(&mut self) {
        self.flush();
    }
}

impl SessionEnv for CoalescingEnv<'_> {
    // The non-emitting half passes straight through and leaves the buffered run
    // alone: none of it is ordered against the delta stream. `engine()` in
    // particular MUST NOT flush — it is what `handle_text_delta` uses to push
    // every chunk into the transcript buffer per line (transcript-perf
    // FR-22/FR-23), which stays uncoalesced by design.
    fn engine(&self) -> &Engine {
        self.inner.engine()
    }

    fn emit_session(&self, ev: SessionEvent) {
        match ev {
            SessionEvent::AssistantDelta {
                session_id,
                block_id,
                text,
                offset,
            } => self.buffer_delta(session_id, block_id, text, offset),
            // Everything else settles the buffered run FIRST. This is the rule
            // that stops a `tool.start` or an `assistant.done` from overtaking
            // text the reader already streamed.
            other => {
                self.flush();
                self.inner.emit_session(other);
            }
        }
    }

    fn emit_agent(&self, ev: AgentEvent) {
        // agent.block rides its own channel, but the reader produces it from
        // the same line it produces deltas from — flushing first keeps the two
        // streams telling the same story about what happened when.
        self.flush();
        self.inner.emit_agent(ev);
    }

    fn emit_workflow_detail(&self, ev: WorkflowDetailEvent) {
        self.flush();
        self.inner.emit_workflow_detail(ev);
    }

    fn persist(&self) {
        self.inner.persist();
    }

    fn append_transcript(&self, session_id: &str, block: &BufBlock) {
        self.inner.append_transcript(session_id, block);
    }

    fn append_step_detail(&self, session_id: &str, detail: &StepDetail) {
        self.inner.append_step_detail(session_id, detail);
    }

    fn note_file_diff(&self, session_id: &str, cwd: &str) {
        self.inner.note_file_diff(session_id, cwd);
    }

    fn discover_commands(&self, cwd: &str) -> Vec<SkillInfo> {
        self.inner.discover_commands(cwd)
    }
}

#[cfg(test)]
mod tests {
    //! The window is always injected (`Duration::MAX` = pinned open,
    //! `Duration::ZERO` = every delta stands alone), never waited out: a test
    //! that sleeps to prove a batching window is a test that goes red on a
    //! loaded CI box.

    use super::*;
    use crate::session::testenv::TestEnv;

    fn delta(block_id: &str, text: &str, offset: usize) -> SessionEvent {
        SessionEvent::AssistantDelta {
            session_id: "s1".into(),
            block_id: block_id.into(),
            text: text.into(),
            offset,
        }
    }

    /// (blockId, text, offset) for every `assistant.delta` the inner env saw,
    /// in arrival order — everything else as its serialized `type`.
    fn seen(env: &TestEnv) -> Vec<String> {
        env.session_events
            .lock()
            .unwrap()
            .iter()
            .map(|ev| match ev {
                SessionEvent::AssistantDelta {
                    block_id,
                    text,
                    offset,
                    ..
                } => format!("delta {block_id} {offset} {text}"),
                other => serde_json::to_value(other)
                    .unwrap()
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("?")
                    .to_string(),
            })
            .collect()
    }

    #[test]
    fn consecutive_deltas_for_one_block_merge_into_a_single_emission() {
        let inner = TestEnv::default();
        let env = CoalescingEnv::new(&inner, Duration::MAX);
        env.emit_session(delta("b1", "Hello", 0));
        env.emit_session(delta("b1", ", ", 5));
        env.emit_session(delta("b1", "world", 7));
        assert!(
            seen(&inner).is_empty(),
            "nothing goes out inside the window"
        );
        env.flush();
        // Indistinguishable from one bigger delta: text concatenated, offset
        // the FIRST chunk's.
        assert_eq!(seen(&inner), vec!["delta b1 0 Hello, world"]);
    }

    #[test]
    fn a_delta_for_another_block_flushes_the_buffered_run_first() {
        let inner = TestEnv::default();
        let env = CoalescingEnv::new(&inner, Duration::MAX);
        env.emit_session(delta("b1", "one", 0));
        env.emit_session(delta("b1", " two", 3));
        env.emit_session(delta("b2", "next", 0));
        // b1's run went out the moment b2 opened — never after it.
        assert_eq!(seen(&inner), vec!["delta b1 0 one two"]);
        env.flush();
        assert_eq!(seen(&inner), vec!["delta b1 0 one two", "delta b2 0 next"]);
    }

    #[test]
    fn a_delta_for_another_session_flushes_the_buffered_run_first() {
        // Block ids are uuids, so a cross-session collision cannot happen — the
        // session is compared anyway, because a merged run carries ONE sessionId
        // and guessing wrong would post one session's text into another's.
        let inner = TestEnv::default();
        let env = CoalescingEnv::new(&inner, Duration::MAX);
        env.emit_session(delta("b1", "mine", 0));
        env.emit_session(SessionEvent::AssistantDelta {
            session_id: "s2".into(),
            block_id: "b1".into(),
            text: "theirs".into(),
            offset: 0,
        });
        assert_eq!(seen(&inner), vec!["delta b1 0 mine"]);
        env.flush();
        let events = inner.session_events.lock().unwrap();
        let sessions: Vec<&str> = events
            .iter()
            .map(|ev| match ev {
                SessionEvent::AssistantDelta { session_id, .. } => session_id.as_str(),
                _ => "?",
            })
            .collect();
        assert_eq!(sessions, vec!["s1", "s2"]);
    }

    #[test]
    fn any_other_event_flushes_the_buffered_run_before_itself() {
        let inner = TestEnv::default();
        let env = CoalescingEnv::new(&inner, Duration::MAX);
        env.emit_session(delta("b1", "reading", 0));
        env.emit_session(SessionEvent::ToolStart {
            session_id: "s1".into(),
            block_id: "b2".into(),
            tool: "Read".into(),
            summary: "README.md".into(),
            model: None,
        });
        env.emit_session(SessionEvent::AssistantDone {
            session_id: "s1".into(),
            block_id: "b1".into(),
            text: "reading".into(),
        });
        assert_eq!(
            seen(&inner),
            vec!["delta b1 0 reading", "tool.start", "assistant.done"],
            "a tool.start or an assistant.done must never overtake buffered text"
        );
    }

    #[test]
    fn emit_agent_flushes_the_buffered_run_first() {
        let inner = TestEnv::default();
        let env = CoalescingEnv::new(&inner, Duration::MAX);
        env.emit_session(delta("b1", "dispatching", 0));
        env.emit_agent(AgentEvent::Block {
            session_id: "s1".into(),
            agent_id: "a1".into(),
            block: serde_json::json!({ "kind": "assistant" }),
        });
        // Asserted BEFORE any explicit flush: the delta has to be out by the
        // time the agent event is, not merely by the end of the turn.
        assert_eq!(seen(&inner), vec!["delta b1 0 dispatching"]);
        assert_eq!(inner.agent_events.lock().unwrap().len(), 1);
    }

    #[test]
    fn flush_emits_the_buffered_run_and_is_idempotent() {
        let inner = TestEnv::default();
        let env = CoalescingEnv::new(&inner, Duration::MAX);
        env.emit_session(delta("b1", "tail", 0));
        env.flush();
        env.flush();
        drop(env); // the unwind safety net must not re-emit either
        assert_eq!(seen(&inner), vec!["delta b1 0 tail"]);
    }

    #[test]
    fn a_delta_past_the_window_starts_a_new_emission() {
        // ZERO window: every run is already spent when the next chunk lands, so
        // each delta flushes the previous one — the uncoalesced cadence, proven
        // without a sleep.
        let inner = TestEnv::default();
        let env = CoalescingEnv::new(&inner, Duration::ZERO);
        env.emit_session(delta("b1", "one", 0));
        env.emit_session(delta("b1", " two", 3));
        assert_eq!(seen(&inner), vec!["delta b1 0 one"]);
        env.emit_session(delta("b1", " three", 7));
        env.flush();
        assert_eq!(
            seen(&inner),
            vec!["delta b1 0 one", "delta b1 3  two", "delta b1 7  three"],
            "each chunk keeps its own offset when nothing merges"
        );
    }

    #[test]
    fn the_non_emitting_half_delegates_without_disturbing_the_run() {
        let inner = TestEnv::default();
        let env = CoalescingEnv::new(&inner, Duration::MAX);
        env.emit_session(delta("b1", "buffered", 0));
        env.persist();
        env.note_file_diff("s1", "/work");
        assert_eq!(env.discover_commands("/work").len(), 2);
        assert_eq!(*inner.persist_calls.lock().unwrap(), 1);
        assert_eq!(inner.diff_notes.lock().unwrap().len(), 1);
        assert!(
            seen(&inner).is_empty(),
            "nothing that is not an emission may settle the run"
        );
        env.flush();
        assert_eq!(seen(&inner), vec!["delta b1 0 buffered"]);
    }
}
