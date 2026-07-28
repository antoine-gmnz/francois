//! FR-53..FR-60 — a plugin asking to put words in the user's mouth.
//!
//! `francois.session.prompt` **never sends anything**. It mints a request, emits
//! a card into the target session's transcript, and resolves with an id. The only
//! thing that can turn that into a message is a human pressing approve.
//!
//! Three deliberate refusals, each of which would be convenient and each of which
//! would undo the design:
//!
//! * **The plugin is never told the outcome** (FR-56). No callback, no promise
//!   that settles on the decision, no way to query state. That removes any reason
//!   to keep an isolate alive or to poll — and any way to A/B a user's trust.
//! * **There is no "always allow this plugin"** (FR-53). Not per session, not
//!   per plugin, not in settings. Every injection is confirmed.
//! * **An approved prompt buys no trust** (FR-59). It goes down the same
//!   `session_send` path a typed message does, so its tool calls still park in
//!   `permission-guardrails` under the session's own permission mode.

use super::*;

use tauri::{AppHandle, Manager};

/// FR-54's refusals, worded once. Each is returned to the plugin verbatim.
pub(crate) const MSG_UNKNOWN_SESSION: &str = "unknown session";
pub(crate) const MSG_ALREADY_PENDING: &str = "an injection is already pending for this session";
pub(crate) const MSG_RATE_LIMIT: &str = "injection rate limit exceeded";
pub(crate) const MSG_EMPTY: &str = "the prompt is empty";
pub(crate) const MSG_TOO_LONG: &str = "the prompt is too long";

/// FR-54: clean and bound the text a plugin wants a human to read.
///
/// Newlines and tabs survive because a prompt is prose and the card renders it
/// preformatted; every other control character is stripped, so a plugin cannot
/// use ANSI escapes or a carriage return to make the card display something
/// other than what would be sent. **What the card shows is what gets sent** is
/// the whole basis on which the user can consent.
pub(crate) fn clean_prompt(raw: &str) -> Result<String, &'static str> {
    let cleaned = clean_text(raw, INJECTION_MAX_PROMPT_CHARS + 1, true);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return Err(MSG_EMPTY);
    }
    if trimmed.chars().count() > INJECTION_MAX_PROMPT_CHARS {
        return Err(MSG_TOO_LONG);
    }
    Ok(trimmed.to_string())
}

/// FR-54: at most 5 requests per plugin per ROLLING minute. Returns the pruned
/// window so the caller can store it back.
pub(crate) fn rate_limit_ok(window: &mut std::collections::VecDeque<u64>, now: u64) -> bool {
    while window
        .front()
        .is_some_and(|t| now.saturating_sub(*t) >= 60_000)
    {
        window.pop_front();
    }
    if window.len() >= INJECTION_MAX_PER_MINUTE {
        return false;
    }
    window.push_back(now);
    true
}

/// FR-53: mint a request and emit the card. Returns `{ requestId }` for the
/// plugin — an acknowledgement that it ASKED, and nothing more (FR-56).
pub(crate) fn request(
    app: &AppHandle,
    plugin_id: &str,
    plugin_name: &str,
    session_id: &str,
    text: &str,
) -> Result<Value, String> {
    let prompt = clean_prompt(text).map_err(String::from)?;

    // FR-54 / §7 #25: the session must exist. Checked BEFORE the rate window is
    // touched, so probing for session ids cannot burn the plugin's own budget in
    // a way that reveals which ids are real.
    if !crate::session::plugin_session_exists(app, session_id) {
        return Err(MSG_UNKNOWN_SESSION.into());
    }

    let now = now_ms();
    let request_id = uuid();
    let block_id = uuid();
    let expires_at = now + INJECTION_TTL_MS;

    let request = serde_json::json!({
        "requestId": request_id,
        "pluginId": plugin_id,
        "pluginName": plugin_name,
        "sessionId": session_id,
        "prompt": prompt,
        "requestedAt": now,
        "expiresAt": expires_at,
    });

    {
        let state = app
            .try_state::<PluginState>()
            .ok_or_else(|| "plugins are unavailable".to_string())?;
        let mut inner = state.inner.lock().unwrap();

        // FR-54 / §7 #26: one pending request per (plugin, session).
        if inner
            .injections
            .values()
            .any(|p| p.plugin_id == plugin_id && p.session_id == session_id)
        {
            return Err(MSG_ALREADY_PENDING.into());
        }
        // §7 #27: the rate limit is per PLUGIN, not per session — otherwise a
        // plugin could multiply its budget by the number of open sessions.
        let window = inner
            .injection_window
            .entry(plugin_id.to_string())
            .or_default();
        if !rate_limit_ok(window, now) {
            return Err(MSG_RATE_LIMIT.into());
        }
        inner.injections.insert(
            block_id.clone(),
            PendingInjection {
                plugin_id: plugin_id.to_string(),
                plugin_name: plugin_name.to_string(),
                session_id: session_id.to_string(),
                request: request.clone(),
                prompt,
                expires_at,
            },
        );
    }

    // FR-60: the card lands in the TARGET session's transcript. No toast, no
    // modal, no focus steal — if the user is looking elsewhere, the sidebar's
    // existing activity treatment is the only signal.
    crate::session::buffer_plugin_injection(app, session_id, &block_id, &request, "pending");
    crate::session::emit_injection_asked(app, session_id, &block_id, &request);

    Ok(serde_json::json!({ "requestId": request_id }))
}

/// FR-57: the human's decision. `approve` sends through the SAME path as
/// `session_send`, queue-if-busy included (§7 #32).
pub(crate) fn resolve(
    app: &AppHandle,
    session_id: &str,
    block_id: &str,
    approve: bool,
) -> Result<(bool, Option<u32>), (&'static str, String)> {
    let pending = {
        let state = app.try_state::<PluginState>().ok_or((
            E_INJECTION_NOT_PENDING,
            "plugins are unavailable".to_string(),
        ))?;
        let mut inner = state.inner.lock().unwrap();
        match inner.injections.get(block_id) {
            // §7 #33: a decision for a block that is not pending. The card
            // re-syncs from the transcript rather than guessing.
            None => {
                return Err((
                    E_INJECTION_NOT_PENDING,
                    "this request is no longer pending".to_string(),
                ))
            }
            Some(p) if p.session_id != session_id => {
                return Err((
                    E_INJECTION_NOT_PENDING,
                    "this request belongs to another session".to_string(),
                ))
            }
            Some(_) => inner.injections.remove(block_id).unwrap(),
        }
    };

    let state_label = if approve { "approved" } else { "denied" };
    crate::session::buffer_plugin_injection(
        app,
        session_id,
        block_id,
        &pending.request,
        state_label,
    );
    crate::session::emit_injection_resolved(app, session_id, block_id, state_label);

    if !approve {
        // FR-56: the plugin is told nothing. Not even that it was denied.
        return Ok((false, None));
    }
    crate::session::send_from_plugin(
        app,
        session_id,
        pending.prompt,
        &pending.plugin_id,
        &pending.plugin_name,
    )
    .map_err(|(code, msg)| (code, msg))
}

/// FR-55: expire everything that has run out of time, plus (when `plugin_id` is
/// given) every request belonging to one plugin — the disable/uninstall path
/// (FR-74 / §7 #34). Returns the `(sessionId, blockId)` pairs to resolve.
pub(crate) fn expire(
    inner: &mut PluginInner,
    now: u64,
    plugin_id: Option<&str>,
    session_id: Option<&str>,
) -> Vec<(String, String)> {
    let doomed: Vec<String> = inner
        .injections
        .iter()
        .filter(|(_, p)| {
            now >= p.expires_at
                || plugin_id.is_some_and(|id| p.plugin_id == id)
                || session_id.is_some_and(|id| p.session_id == id)
        })
        .map(|(block_id, _)| block_id.clone())
        .collect();
    doomed
        .into_iter()
        .filter_map(|block_id| {
            inner
                .injections
                .remove(&block_id)
                .map(|p| (p.session_id, block_id))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    // ---------- FR-54: the prompt ----------

    #[test]
    fn a_prompt_keeps_its_shape_and_loses_its_control_characters() {
        // What the card SHOWS must be what gets sent — that is the entire basis
        // for consenting to it.
        assert_eq!(clean_prompt("  fix the build  ").unwrap(), "fix the build");
        assert_eq!(
            clean_prompt("line one\nline two\tindented").unwrap(),
            "line one\nline two\tindented",
            "newlines and tabs are prose"
        );
        assert_eq!(
            clean_prompt("say \u{1b}[2Jsomething").unwrap(),
            "say [2Jsomething",
            "an ANSI escape cannot repaint the card"
        );
        assert_eq!(
            clean_prompt("visible\rhidden").unwrap(),
            "visiblehidden",
            "a carriage return cannot overwrite what was shown"
        );
    }

    #[test]
    fn an_empty_or_over_long_prompt_is_refused_with_its_own_message() {
        // §7 #28.
        for empty in ["", "   ", "\n\t\n", "\u{0}\u{1}"] {
            assert_eq!(clean_prompt(empty), Err(MSG_EMPTY), "{empty:?}");
        }
        assert!(clean_prompt(&"x".repeat(INJECTION_MAX_PROMPT_CHARS)).is_ok());
        assert_eq!(
            clean_prompt(&"x".repeat(INJECTION_MAX_PROMPT_CHARS + 1)),
            Err(MSG_TOO_LONG)
        );
    }

    // ---------- FR-54: the rate limit ----------

    #[test]
    fn five_requests_a_minute_are_allowed_and_the_sixth_is_not() {
        // §7 #27.
        let mut window = VecDeque::new();
        let t0 = 1_000_000;
        for i in 0..INJECTION_MAX_PER_MINUTE {
            assert!(rate_limit_ok(&mut window, t0 + i as u64), "request {i}");
        }
        assert!(
            !rate_limit_ok(&mut window, t0 + 10),
            "the sixth inside the minute"
        );
        assert_eq!(
            window.len(),
            INJECTION_MAX_PER_MINUTE,
            "a refusal costs no budget"
        );
    }

    #[test]
    fn the_window_rolls_rather_than_resetting_on_a_boundary() {
        // A fixed bucket would let a plugin send 10 across a boundary instant.
        let mut window = VecDeque::new();
        let t0 = 1_000_000;
        for i in 0..INJECTION_MAX_PER_MINUTE {
            assert!(rate_limit_ok(&mut window, t0 + i as u64));
        }
        assert!(
            !rate_limit_ok(&mut window, t0 + 59_000),
            "still inside the minute"
        );
        // the oldest ages out exactly 60 s after it was made, one slot at a time
        assert!(rate_limit_ok(&mut window, t0 + 60_000));
        assert!(
            !rate_limit_ok(&mut window, t0 + 60_000),
            "only one slot freed"
        );
        assert!(rate_limit_ok(&mut window, t0 + 60_001));
    }

    // ---------- FR-55/FR-74: expiry ----------

    fn pending(plugin: &str, session: &str, expires_at: u64) -> PendingInjection {
        PendingInjection {
            plugin_id: plugin.into(),
            plugin_name: plugin.into(),
            session_id: session.into(),
            request: Value::Null,
            prompt: "do the thing".into(),
            expires_at,
        }
    }

    fn inner_with(entries: &[(&str, PendingInjection)]) -> PluginInner {
        let mut inner = PluginInner::default();
        for (block_id, p) in entries {
            inner.injections.insert((*block_id).to_string(), p.clone());
        }
        inner
    }

    #[test]
    fn a_request_expires_when_its_ten_minutes_are_up() {
        // §7 #29.
        let mut inner = inner_with(&[
            ("b1", pending("acme-ci", "s1", 10_000)),
            ("b2", pending("acme-ci", "s2", 30_000)),
        ]);
        let expired = expire(&mut inner, 20_000, None, None);
        assert_eq!(expired, vec![("s1".to_string(), "b1".to_string())]);
        assert_eq!(inner.injections.len(), 1, "the unexpired one survives");
        assert!(inner.injections.contains_key("b2"));
    }

    #[test]
    fn disabling_or_uninstalling_a_plugin_expires_every_request_it_has_open() {
        // FR-55/FR-74 / §7 #34.
        let mut inner = inner_with(&[
            ("b1", pending("acme-ci", "s1", u64::MAX)),
            ("b2", pending("acme-ci", "s2", u64::MAX)),
            ("b3", pending("other", "s1", u64::MAX)),
        ]);
        let mut expired = expire(&mut inner, 0, Some("acme-ci"), None);
        expired.sort();
        assert_eq!(
            expired,
            vec![
                ("s1".to_string(), "b1".to_string()),
                ("s2".to_string(), "b2".to_string())
            ]
        );
        assert_eq!(
            inner.injections.len(),
            1,
            "another plugin's request is untouched"
        );
        assert!(inner.injections.contains_key("b3"));
    }

    #[test]
    fn removing_a_session_expires_the_requests_aimed_at_it() {
        // §7 #31: the card goes with the transcript.
        let mut inner = inner_with(&[
            ("b1", pending("acme-ci", "s1", u64::MAX)),
            ("b2", pending("acme-ci", "s2", u64::MAX)),
        ]);
        let expired = expire(&mut inner, 0, None, Some("s1"));
        assert_eq!(expired, vec![("s1".to_string(), "b1".to_string())]);
        assert!(inner.injections.contains_key("b2"));
    }

    #[test]
    fn expiring_an_empty_registry_is_a_no_op() {
        let mut inner = PluginInner::default();
        assert!(expire(&mut inner, u64::MAX, Some("acme-ci"), Some("s1")).is_empty());
    }
}
