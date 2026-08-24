//! response-mode FR-6: the response mode enum and its directive text.
//!
//! The instruction text is CORE-OWNED and lives only here — one `&'static str`
//! per non-default mode plus the clearing string (FR-11). It never crosses the
//! IPC boundary: the frontend receives the enum and its own presentation table
//! (`contract/response-mode.ts`, FR-13), never prompt text. `Default` is the
//! ABSENCE of an instruction, not an instruction saying "be normal".
//!
//! How each runtime family carries it:
//!   - `claude-code` — `--append-system-prompt <text>`, every turn (FR-7).
//!   - `francois`    — a `role: "system"` message rebuilt per request (FR-8).
//!   - `codex`/`grok` — prefixed to the prompt bytes, but only when it can be
//!     needed (`prefix_for`, FR-10/FR-11), because those threads carry history.

use super::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Mirrors `ResponseMode` in contract/common.ts. A closed set — every `match`
/// on it in the core is exhaustive with no wildcard arm, so widening the enum
/// cannot silently fall through anywhere.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default, Hash)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ResponseMode {
    #[default]
    Default,
    Concise,
    Explanatory,
    Learning,
}

const CONCISE: &str = "Answer as briefly as the question allows. Lead with the result. No preamble, no restating the request, and no summary of what you just did unless asked.";

const EXPLANATORY: &str = "As you work, explain the reasoning behind non-obvious choices — why this approach over the alternatives, and what trade-off it makes. Keep each explanation attached to the decision it justifies rather than collected at the end.";

const LEARNING: &str = "Work collaboratively rather than delivering finished work. Where a small, self-contained piece would teach the user something, leave it for them: mark the spot with `TODO(human)` and say what it needs to do and why. Explain the surrounding code as you go.";

/// FR-11: `codex`/`grok` only. Returning to `Default` mid-thread is not silence —
/// the earlier instruction is still in the thread's history, so it must be
/// explicitly withdrawn. `claude-code`/`francois` never need this: they rebuild
/// the directive per turn/request, so `Default` simply builds nothing.
const CLEARING: &str = "Disregard the response-style instruction given earlier in this conversation. Write in your default style from now on.";

impl ResponseMode {
    /// FR-3: the core's own re-validation of the wire value. The frontend's
    /// narrowing is never trusted — an older frontend, the CLI or an extension
    /// can hand this command anything, and an unknown value must surface as
    /// `INVALID_INPUT` rather than fall back silently to `Default`.
    pub(crate) fn parse(raw: &str) -> Option<ResponseMode> {
        match raw {
            "default" => Some(ResponseMode::Default),
            "concise" => Some(ResponseMode::Concise),
            "explanatory" => Some(ResponseMode::Explanatory),
            "learning" => Some(ResponseMode::Learning),
            _ => None,
        }
    }

    /// FR-1/§7: the persisted-record reading — an absent, malformed or unknown
    /// value loads as `Default`. Not an error, and never a load failure.
    pub(crate) fn parse_or_default(raw: Option<&str>) -> ResponseMode {
        raw.and_then(ResponseMode::parse).unwrap_or_default()
    }

    /// The contract string, for persistence and for the `SessionMeta` payload.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ResponseMode::Default => "default",
            ResponseMode::Concise => "concise",
            ResponseMode::Explanatory => "explanatory",
            ResponseMode::Learning => "learning",
        }
    }

    /// FR-6: the instruction text, or `None` for `Default` — which adds no
    /// instruction at all rather than one describing the absence of a style.
    pub(crate) fn directive(self) -> Option<&'static str> {
        match self {
            ResponseMode::Default => None,
            ResponseMode::Concise => Some(CONCISE),
            ResponseMode::Explanatory => Some(EXPLANATORY),
            ResponseMode::Learning => Some(LEARNING),
        }
    }
}

/// FR-10/FR-11: what a `codex`/`grok` turn must prefix to its prompt bytes.
///
/// `sent` is the session's `response_mode_sent` — the mode the CURRENT thread
/// has already been told about, `None` when it has been told nothing.
/// `fresh_thread` is "this turn starts a new thread" (no resume anchor), which
/// is also how a resume retry arrives here.
///
/// Pure, so the whole ladder is testable without a child process:
///   - a fresh thread carries the directive (nothing to disregard on it, so
///     `Default` still carries nothing);
///   - an unchanged mode carries nothing — the instruction is still in history;
///   - a change to `Default` after a non-default instruction carries the
///     clearing string, exactly once (FR-11);
///   - a change to anything else carries that mode's directive.
pub(crate) fn prefix_for(
    mode: ResponseMode,
    sent: Option<ResponseMode>,
    fresh_thread: bool,
) -> Option<&'static str> {
    if fresh_thread {
        return mode.directive();
    }
    if sent == Some(mode) {
        return None;
    }
    match mode.directive() {
        Some(text) => Some(text),
        // Back to Default: withdraw the earlier instruction, but only if one
        // was ever given on THIS thread.
        None => match sent {
            Some(ResponseMode::Default) | None => None,
            Some(_) => Some(CLEARING),
        },
    }
}

/// FR-9: the prompt bytes handed to `codex`/`grok`. Applied to a LOCAL copy —
/// never to `ctx.text`, which is the same string `turn.rs` buffers the
/// transcript's user block from, so writing to it would put the directive in
/// the transcript.
pub(crate) fn prefixed_prompt(prefix: Option<&str>, text: &str) -> String {
    match prefix {
        Some(p) => format!("{p}\n\n{text}"),
        None => text.to_string(),
    }
}

/// FR-10, engine half: what THIS `codex`/`grok` turn must prefix, decided
/// against the session's own `response_mode_sent`. Split from `mark_sent`
/// because the spawn sits between the two — nothing is recorded until the
/// prompt has actually reached the child.
pub(crate) fn pending_prefix(
    app: &AppHandle,
    session_id: &str,
    mode: ResponseMode,
    fresh_thread: bool,
) -> Option<&'static str> {
    let sent = app
        .state::<Engine>()
        .with_session(session_id, |s| s.response_mode_sent)
        .flatten();
    prefix_for(mode, sent, fresh_thread)
}

/// FR-10: record what the thread has now been told, AFTER the prompt reached
/// the child. Called on every `codex`/`grok` turn, prefix or not: a turn that
/// sent nothing still confirms the thread already carries this mode.
pub(crate) fn mark_sent(app: &AppHandle, session_id: &str, mode: ResponseMode) {
    app.state::<Engine>()
        .with_session_mut(session_id, |s| s.response_mode_sent = Some(mode));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_every_contract_member_and_nothing_else() {
        assert_eq!(ResponseMode::parse("default"), Some(ResponseMode::Default));
        assert_eq!(ResponseMode::parse("concise"), Some(ResponseMode::Concise));
        assert_eq!(
            ResponseMode::parse("explanatory"),
            Some(ResponseMode::Explanatory)
        );
        assert_eq!(
            ResponseMode::parse("learning"),
            Some(ResponseMode::Learning)
        );
        // FR-3: never a silent fallback to Default.
        assert_eq!(ResponseMode::parse("Concise"), None);
        assert_eq!(ResponseMode::parse("terse"), None);
        assert_eq!(ResponseMode::parse(""), None);
    }

    #[test]
    fn an_unknown_or_absent_persisted_value_loads_as_default() {
        // §7: a persisted session or project default carrying an unknown string
        // loads as 'default' — not an error, not a load failure.
        assert_eq!(ResponseMode::parse_or_default(None), ResponseMode::Default);
        assert_eq!(
            ResponseMode::parse_or_default(Some("nonsense")),
            ResponseMode::Default
        );
        assert_eq!(
            ResponseMode::parse_or_default(Some("learning")),
            ResponseMode::Learning
        );
    }

    #[test]
    fn serde_round_trips_the_contract_strings() {
        for (mode, wire) in [
            (ResponseMode::Default, "default"),
            (ResponseMode::Concise, "concise"),
            (ResponseMode::Explanatory, "explanatory"),
            (ResponseMode::Learning, "learning"),
        ] {
            let v = serde_json::to_value(mode).unwrap();
            assert_eq!(v, serde_json::json!(wire));
            assert_eq!(mode.as_str(), wire);
            let back: ResponseMode = serde_json::from_value(v).unwrap();
            assert_eq!(back, mode);
        }
    }

    // FR-6 / spec §5: the directive text is PINNED here so it cannot drift.
    #[test]
    fn the_directive_text_is_exactly_what_the_spec_pins() {
        assert_eq!(ResponseMode::Default.directive(), None);
        assert_eq!(
            ResponseMode::Concise.directive(),
            Some(
                "Answer as briefly as the question allows. Lead with the result. No preamble, no \
                 restating the request, and no summary of what you just did unless asked."
            )
        );
        assert_eq!(
            ResponseMode::Explanatory.directive(),
            Some(
                "As you work, explain the reasoning behind non-obvious choices — why this \
                 approach over the alternatives, and what trade-off it makes. Keep each \
                 explanation attached to the decision it justifies rather than collected at the \
                 end."
            )
        );
        assert_eq!(
            ResponseMode::Learning.directive(),
            Some(
                "Work collaboratively rather than delivering finished work. Where a small, \
                 self-contained piece would teach the user something, leave it for them: mark the \
                 spot with `TODO(human)` and say what it needs to do and why. Explain the \
                 surrounding code as you go."
            )
        );
        assert_eq!(
            CLEARING,
            "Disregard the response-style instruction given earlier in this conversation. Write \
             in your default style from now on."
        );
    }

    // ---------- prefix_for (FR-10/FR-11) ----------

    #[test]
    fn a_fresh_thread_carries_the_directive_and_default_carries_nothing() {
        assert_eq!(
            prefix_for(ResponseMode::Concise, None, true),
            ResponseMode::Concise.directive()
        );
        // Nothing to disregard on a thread with no history.
        assert_eq!(prefix_for(ResponseMode::Default, None, true), None);
        assert_eq!(
            prefix_for(ResponseMode::Default, Some(ResponseMode::Concise), true),
            None
        );
    }

    #[test]
    fn an_unchanged_mode_is_never_re_sent_on_a_resumed_thread() {
        assert_eq!(
            prefix_for(ResponseMode::Concise, Some(ResponseMode::Concise), false),
            None
        );
        assert_eq!(
            prefix_for(ResponseMode::Default, Some(ResponseMode::Default), false),
            None
        );
    }

    #[test]
    fn a_changed_mode_carries_its_directive_on_a_resumed_thread() {
        assert_eq!(
            prefix_for(ResponseMode::Learning, Some(ResponseMode::Concise), false),
            ResponseMode::Learning.directive()
        );
        // Told nothing yet, mid-thread (a session that predates the feature).
        assert_eq!(
            prefix_for(ResponseMode::Concise, None, false),
            ResponseMode::Concise.directive()
        );
    }

    #[test]
    fn returning_to_default_mid_thread_carries_exactly_one_clearing_directive() {
        // FR-11: the earlier instruction is still in the thread's history.
        assert_eq!(
            prefix_for(ResponseMode::Default, Some(ResponseMode::Concise), false),
            Some(CLEARING)
        );
        // Once it lands, `response_mode_sent` is Some(Default) — then silence.
        assert_eq!(
            prefix_for(ResponseMode::Default, Some(ResponseMode::Default), false),
            None
        );
        // Never told anything on this thread ⇒ nothing to withdraw.
        assert_eq!(prefix_for(ResponseMode::Default, None, false), None);
    }

    #[test]
    fn the_prefix_is_prepended_to_a_copy_of_the_prompt_and_absent_leaves_it_alone() {
        assert_eq!(prefixed_prompt(None, "list the files"), "list the files");
        assert_eq!(
            prefixed_prompt(Some("be brief"), "list the files"),
            "be brief\n\nlist the files"
        );
    }
}
