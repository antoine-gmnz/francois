//! session/adapter/pi/models.rs — pi-models-metrics: everything that turns a
//! raw Pi RPC reply into the contract's `RuntimeModelDescriptor`/
//! `RuntimeMetrics` shapes, the 60 s catalogue cache (FR-2), and the
//! short-lived no-session probe FR-2 names ("a short-lived no-session RPC
//! probe under the same launch policy, then closes it").
//!
//! **Provisional, docs-derived wire shapes** — no real Pi RPC capture exists
//! yet (see `wire.rs`'s own doc comment and
//! `specs/research/pi-integration-audit.md`'s "Open evidence" section). Every
//! response is read through exactly ONE mapping function per command
//! (`parse_models_list`, `parse_model_from_state`, `parse_metrics_response`),
//! so a future certification pass reconciles the real shape in one place:
//!   - `get_available_models` answers `{ models: [<descriptor>, ...] }`,
//!     where each `<descriptor>` is assumed to already be shaped like the
//!     contract's own `RuntimeModelDescriptor` (nested `ref: {providerId,
//!     modelId}`) — the simplest possible provisional mapping, and the first
//!     thing to replace with real field renaming once a capture exists.
//!   - `set_model`'s read-back (a fresh `get_state`) answers `{ model:
//!     <descriptor>, effort?: string }`.
//!   - `get_session_stats` answers raw counters (`inputTokens` etc.) plus a
//!     `pricingKnown: bool` this module uses to decide `costBasis` — Pi's own
//!     reply is not assumed to speak our `contextBasis`/`costBasis`
//!     vocabulary directly (FR-7/FR-8).
//!
//! The probe this module spawns for `get_available_models` deliberately does
//! NOT reuse `PiConnection`/`ProtocolEngine` (`dispatcher.rs`/`protocol.rs`):
//! those model a SESSION-scoped, potentially long-lived connection whose
//! state machine requires a chosen model up front (`pi_args` always sets
//! `--provider`/`--model`) — exactly what discovery does not have yet. This
//! probe omits `--provider`/`--model` instead (also flagged provisional) and
//! runs one fire-and-forget command/response round trip of its own, closed
//! immediately after. `set_model`/`get_session_stats` ARE session-scoped, so
//! they dispatch through the session's own live `PiConnection`
//! (`dispatcher.rs`'s `set_model`/`get_session_stats_raw`).

use crate::ipc::{AppError, ErrorCode};
use crate::session::adapter::RuntimeModelRef;
use crate::session::events::{RuntimeMetrics, RuntimeModelDescriptor};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

// ---------------------------------------------------------------- mapping

/// One row of `get_available_models`' assumed `{ models: [...] }` shape, or a
/// `set_model` read-back's `data.model`. `None` on anything that does not
/// deserialize as `RuntimeModelDescriptor`, or whose identity is blank —
/// never a partially-filled descriptor.
fn parse_descriptor(v: &Value) -> Option<RuntimeModelDescriptor> {
    let d: RuntimeModelDescriptor = serde_json::from_value(v.clone()).ok()?;
    (!d.model_ref.provider_id.trim().is_empty() && !d.model_ref.model_id.trim().is_empty())
        .then_some(d)
}

/// FR-1: the AVAILABLE snapshot — empty when the account has none, never
/// padded with a fallback. `Err(())` ⇒ a malformed required model id, which
/// fails the WHOLE probe (wire.rs's own doc: "A malformed required model id
/// fails the whole probe (RUNTIME_PROTOCOL_ERROR)") rather than silently
/// dropping the one bad row.
pub(crate) fn parse_models_list(data: Option<&Value>) -> Result<Vec<RuntimeModelDescriptor>, ()> {
    let Some(rows) = data.and_then(|d| d.get("models")).and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(parse_descriptor(row).ok_or(())?);
    }
    Ok(out)
}

/// FR-5/FR-6: `set_model`'s (and the connect handshake's) read-back — `None`
/// when the reply carries no parseable current model, which the caller
/// (`PiConnection::switch_model`) turns into `RUNTIME_PROTOCOL_ERROR` rather
/// than guessing which model won.
///
/// Lead clarification (contract/common.ts `ModelRuntimePayload`):
/// `RuntimeModelDescriptor` carries only `reasoning: boolean` — the AVAILABLE
/// thinking levels the runtime reports for the current model ride on
/// `SessionMeta.model.efforts` (`ModelInfo.efforts`), never on the
/// descriptor. This is the one place that reads Pi's assumed `efforts:
/// string[]` off the read-back and hands it back as its own tuple member —
/// `effort` (singular) is the currently-applied level, `efforts` (plural) is
/// the full reported set, empty when the reply names none.
pub(crate) fn parse_model_from_state(
    data: Option<&Value>,
) -> Option<(RuntimeModelDescriptor, Option<String>, Vec<String>)> {
    let data = data?;
    let descriptor = parse_descriptor(data.get("model")?)?;
    let effort = data.get("effort").and_then(Value::as_str).map(String::from);
    let efforts = data
        .get("efforts")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Some((descriptor, effort, efforts))
}

/// FR-6: `None` (clear) accepts whatever default Pi reports back — clearing
/// hands the model its OWN default, which is a real value, not "no effort at
/// all". A non-blank request must be echoed back EXACTLY, or Pi silently
/// declined/clamped it (INVALID_INPUT at the caller, never applied).
pub(crate) fn effort_matches(requested: Option<&str>, applied: Option<&str>) -> bool {
    match requested {
        None => true,
        Some(r) => Some(r) == applied,
    }
}

/// FR-7: the raw wire counters `get_session_stats` is assumed to answer.
/// Deliberately NOT `RuntimeMetrics` itself — `contextBasis`/`costBasis` are
/// OUR provenance vocabulary, derived below, not something Pi is assumed to
/// speak natively.
#[derive(Deserialize, Default)]
struct RawStats {
    #[serde(rename = "inputTokens")]
    input_tokens: Option<u64>,
    #[serde(rename = "outputTokens")]
    output_tokens: Option<u64>,
    #[serde(rename = "cacheReadTokens")]
    cache_read_tokens: Option<u64>,
    #[serde(rename = "cacheWriteTokens")]
    cache_write_tokens: Option<u64>,
    #[serde(rename = "contextTokens")]
    context_tokens: Option<u64>,
    #[serde(rename = "contextWindow")]
    context_window: Option<u64>,
    #[serde(rename = "costUsd")]
    cost_usd: Option<f64>,
    /// FR-8: "Zero pricing is not free" — only a reply that EXPLICITLY marks
    /// pricing as known may report a cost (estimated), zero included; missing/
    /// absent/false pricing information always yields unknown cost.
    #[serde(rename = "pricingKnown", default)]
    pricing_known: bool,
}

/// FR-7/FR-8: total — never fails. Missing/malformed data reads as every
/// counter unknown, matching "unknown is null, never zero" (never a load
/// failure for the caller). `measured_at` is the CALLER's clock (the moment
/// this read was accepted), never anything Pi itself reports.
pub(crate) fn parse_metrics_response(data: Option<&Value>, measured_at: u64) -> RuntimeMetrics {
    let raw: RawStats = data
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    // FR-7: after compaction Pi may report no trustworthy context figure —
    // preserved as null/'unknown' rather than guessed from the totals.
    let context_basis = if raw.context_tokens.is_some() {
        "reported"
    } else {
        "unknown"
    };
    let (cost_usd, cost_basis) = if raw.pricing_known {
        (raw.cost_usd, "estimated")
    } else {
        (None, "unknown")
    };
    RuntimeMetrics {
        input_tokens: raw.input_tokens,
        output_tokens: raw.output_tokens,
        cache_read_tokens: raw.cache_read_tokens,
        cache_write_tokens: raw.cache_write_tokens,
        context_tokens: raw.context_tokens,
        context_window: raw.context_window,
        context_basis: context_basis.to_string(),
        cost_usd,
        cost_basis: cost_basis.to_string(),
        measured_at,
        stale: false,
    }
}

// ---------------------------------------------------------------- 60 s cache (FR-2)

struct CacheEntry {
    models: Vec<RuntimeModelDescriptor>,
    checked_at: u64,
}

const CATALOG_TTL_MS: u64 = 60_000;

static CATALOG_CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
fn catalog_cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    CATALOG_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// FR-2: "Cache by account/config fingerprint/environment" — the account id,
/// the SAME executable-config fingerprint FR-4 (pi-provider-auth) already
/// computes for trust drift (`account::compute_fingerprint`, so a
/// `models.json` edit misses the cache the same way it flips trust), and the
/// account's `inheritEnvironmentCredentials` choice (the "environment" axis:
/// a session launched with a different credential-inheritance policy is a
/// different probe environment).
fn cache_key(account_id: &str, config_dir: &str, inherit_environment_credentials: bool) -> String {
    format!(
        "{account_id}|{}|{inherit_environment_credentials}",
        crate::account::compute_fingerprint(config_dir)
    )
}

/// FR-2: served-from-cache after the 60 s TTL lapsed ⇒ stale.
fn catalog_is_stale(checked_at: u64, now: u64) -> bool {
    now.saturating_sub(checked_at) > CATALOG_TTL_MS
}

// ---------------------------------------------------------------- no-session probe

/// FR-2/FR-10: the baseline, locked-down argv for the no-session probe — the
/// same `--no-extensions --no-approve` lockdown `process::pi_args` applies to
/// a real session connection ("same launch policy"). Provisional: omits
/// `--provider`/`--model` (unlike `process::pi_args`), because a discovery
/// probe has no chosen model yet — the very thing it exists to enumerate.
const PROBE_ARGV: [&str; 4] = ["--mode", "rpc", "--no-extensions", "--no-approve"];
const PROBE_DEADLINE: Duration = Duration::from_secs(15);

/// FR-2: spawn the certified Pi child with no session/model context, ask for
/// `get_available_models`, and close it — never reused, never left running.
fn probe_available_models(
    runtime: &str,
    distro: Option<&str>,
    config_dir: &str,
    inherit_environment_credentials: bool,
) -> Result<Vec<RuntimeModelDescriptor>, AppError> {
    let status = super::discovery::probe_installation(runtime, distro, false)?;
    if status.state != super::discovery::InstallState::Ready {
        return Err(status.error.unwrap_or_else(|| {
            AppError::new(ErrorCode::RuntimeUnavailable, "Pi is not available")
        }));
    }
    let exe = status.executable_path.ok_or_else(|| {
        AppError::new(
            ErrorCode::RuntimeUnavailable,
            "Pi reported ready with no resolved executable path",
        )
    })?;

    let mut ambient: Vec<(String, String)> = std::env::vars().collect();
    if let Some(path) = crate::process_util::login_shell_path_env() {
        ambient.retain(|(k, _)| k != "PATH");
        ambient.push(("PATH".to_string(), path));
    }
    let env = crate::account::pi_account_env(&ambient, config_dir, inherit_environment_credentials);

    let mut child = crate::process_util::spawn(&exe)
        .args(PROBE_ARGV)
        .current_dir(std::env::temp_dir())
        .exact_env(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .configure(crate::process_util::own_process_group)
        .start()
        .map_err(|e| {
            AppError::new(
                ErrorCode::RuntimeUnavailable,
                format!("could not start pi: {e}"),
            )
        })?;

    let result = round_trip(
        &mut child,
        super::wire::PiCommandBody::GetAvailableModels,
        PROBE_DEADLINE,
    );
    crate::process_util::kill_tree(&mut child);
    let resp = result?;
    parse_models_list(resp.data.as_ref()).map_err(|()| {
        AppError::new(
            ErrorCode::RuntimeProtocolError,
            "Pi returned a malformed provider/model identity",
        )
    })
}

/// One fire-and-forget command/response round trip against an already-spawned
/// child — write the LF-framed command, read frames off stdout until the
/// matching response id arrives or `deadline` elapses. Deliberately ignores
/// (does not fail on) any EVENT lines or responses to a different id, since a
/// probe child speaks no other command.
fn round_trip(
    child: &mut std::process::Child,
    body: super::wire::PiCommandBody,
    deadline: Duration,
) -> Result<super::wire::PiResponse, AppError> {
    use std::io::{Read, Write};

    let cmd = super::wire::PiCommand {
        id: crate::ids::uuid(),
        body,
    };
    let wire_name = cmd.kind().wire_name();
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::new(ErrorCode::RuntimeProtocolError, "pi child has no stdin"))?;
    stdin
        .write_all(cmd.to_line().as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| {
            AppError::new(
                ErrorCode::RuntimeUnavailable,
                format!("could not write to pi: {e}"),
            )
        })?;
    drop(stdin);

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::new(ErrorCode::RuntimeProtocolError, "pi child has no stdout"))?;
    if let Some(mut stderr) = child.stderr.take() {
        // FR-2/FR-8: drained and discarded, never logged verbatim — same
        // "no raw RPC logging" rule the session-scoped connection follows.
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(stderr.read(&mut buf), Ok(n) if n > 0) {}
        });
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let expected_id = cmd.id.clone();
    std::thread::spawn(move || {
        let mut framer = super::wire::FrameReader::new();
        let mut buf = [0u8; 8192];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(Err(
                        "the Pi probe child closed its output before answering".to_string()
                    ));
                    return;
                }
                Ok(n) => match framer.feed(&buf[..n]) {
                    Ok(lines) => {
                        for line in lines {
                            if let Ok(super::wire::Frame::Response(resp)) =
                                super::wire::parse_line(&line)
                            {
                                if resp.id == expected_id {
                                    let _ = tx.send(Ok(resp));
                                    return;
                                }
                            }
                        }
                    }
                    Err(_) => {
                        let _ = tx.send(Err("malformed wire frame".to_string()));
                        return;
                    }
                },
                Err(e) => {
                    let _ = tx.send(Err(format!("read error: {e}")));
                    return;
                }
            }
        }
    });
    match rx.recv_timeout(deadline) {
        Ok(Ok(resp)) if resp.success => Ok(resp),
        Ok(Ok(resp)) => Err(AppError::new(
            ErrorCode::RuntimeUnavailable,
            resp.error
                .unwrap_or_else(|| format!("{wire_name} was rejected")),
        )),
        Ok(Err(reason)) => Err(AppError::new(ErrorCode::RuntimeProtocolError, reason)),
        Err(_) => Err(AppError::new(
            ErrorCode::RuntimeTimeout,
            format!("{wire_name} did not respond in time"),
        )),
    }
}

// ---------------------------------------------------------------- francois:runtime:models

/// FR-2: `(models, checkedAt, stale)` — served from cache unless `refresh` or
/// nothing is cached yet. FR-9: a failed live probe keeps the previous
/// display metadata (marked stale) rather than surfacing an error, as long as
/// SOMETHING was cached before; the very first probe for an account still
/// propagates its error.
pub(crate) fn runtime_models(
    app: &AppHandle,
    account_id: &str,
    refresh: bool,
) -> Result<(Vec<RuntimeModelDescriptor>, u64, bool), AppError> {
    let (config_dir, runtime, distro, inherit) =
        crate::account::pi_execution_preflight_for(app, account_id, "listing available models")?;
    let key = cache_key(account_id, &config_dir, inherit);
    let now = crate::ids::now_ms();
    if !refresh {
        if let Some(entry) = catalog_cache().lock().unwrap().get(&key) {
            return Ok((
                entry.models.clone(),
                entry.checked_at,
                catalog_is_stale(entry.checked_at, now),
            ));
        }
    }
    match probe_available_models(&runtime, distro.as_deref(), &config_dir, inherit) {
        Ok(models) => {
            catalog_cache().lock().unwrap().insert(
                key,
                CacheEntry {
                    models: models.clone(),
                    checked_at: now,
                },
            );
            Ok((models, now, false))
        }
        Err(e) => match catalog_cache().lock().unwrap().get(&key) {
            Some(entry) => Ok((entry.models.clone(), entry.checked_at, true)),
            None => Err(e),
        },
    }
}

/// FR-1/FR-4: resolve `pair` against the account's snapshot and confirm it is
/// `available` — `MODEL_UNAVAILABLE` otherwise. `require_fresh` is FR-4's
/// creation-time rule ("requires an exact pair from a FRESH available
/// snapshot" — a stale cache never authorizes a new session); a switch
/// (FR-5) tolerates the cached snapshot, matching FR-2's ordinary freshness
/// rule for display.
pub(crate) fn resolve_and_validate_pair(
    app: &AppHandle,
    account_id: &str,
    pair: &RuntimeModelRef,
    require_fresh: bool,
) -> Result<RuntimeModelDescriptor, AppError> {
    pair.validate()?;
    let (models, _checked_at, stale) = runtime_models(app, account_id, require_fresh)?;
    if require_fresh && stale {
        return Err(AppError::new(
            ErrorCode::ModelUnavailable,
            "a fresh model snapshot could not be confirmed for this account",
        ));
    }
    models
        .into_iter()
        .find(|m| {
            m.model_ref.provider_id == pair.provider_id && m.model_ref.model_id == pair.model_id
        })
        .filter(|m| m.availability == "available")
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::ModelUnavailable,
                "this provider/model pair is not available",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor_json(provider: &str, model: &str, available: bool) -> Value {
        serde_json::json!({
            "ref": { "providerId": provider, "modelId": model },
            "displayName": format!("{provider}/{model}"),
            "input": ["text"],
            "contextWindow": 200_000,
            "maxOutputTokens": 8_192,
            "reasoning": true,
            "authState": "verified",
            "availability": if available { "available" } else { "unavailable" },
        })
    }

    // ---------------------------------------------------------- parse_descriptor

    #[test]
    fn parse_descriptor_accepts_a_well_formed_row() {
        let d = parse_descriptor(&descriptor_json("anthropic", "claude-sonnet-5", true)).unwrap();
        assert_eq!(d.model_ref.provider_id, "anthropic");
        assert_eq!(d.model_ref.model_id, "claude-sonnet-5");
        assert_eq!(d.availability, "available");
    }

    #[test]
    fn parse_descriptor_rejects_blank_or_missing_identity() {
        assert!(parse_descriptor(&serde_json::json!({})).is_none());
        let mut blank = descriptor_json("", "claude-sonnet-5", true);
        blank["ref"]["providerId"] = serde_json::json!("");
        assert!(parse_descriptor(&blank).is_none());
    }

    // ---------------------------------------------------------- parse_models_list

    #[test]
    fn parse_models_list_is_empty_for_no_models_key_or_an_empty_array() {
        assert_eq!(parse_models_list(None), Ok(Vec::new()));
        assert_eq!(
            parse_models_list(Some(&serde_json::json!({}))),
            Ok(Vec::new())
        );
        assert_eq!(
            parse_models_list(Some(&serde_json::json!({ "models": [] }))),
            Ok(Vec::new())
        );
    }

    #[test]
    fn parse_models_list_keeps_two_providers_with_the_same_model_id_distinct() {
        // FR-1: identity is the (providerId, modelId) PAIR.
        let data = serde_json::json!({
            "models": [
                descriptor_json("anthropic", "shared-id", true),
                descriptor_json("ollama", "shared-id", true),
            ]
        });
        let models = parse_models_list(Some(&data)).unwrap();
        assert_eq!(models.len(), 2);
        assert_ne!(
            models[0].model_ref.provider_id,
            models[1].model_ref.provider_id
        );
        assert_eq!(models[0].model_ref.model_id, models[1].model_ref.model_id);
    }

    #[test]
    fn a_malformed_required_model_id_fails_the_whole_probe() {
        let mut bad_row = descriptor_json("anthropic", "claude-sonnet-5", true);
        bad_row["ref"]["modelId"] = serde_json::json!("");
        let data = serde_json::json!({
            "models": [descriptor_json("anthropic", "claude-opus-5", true), bad_row]
        });
        assert_eq!(parse_models_list(Some(&data)), Err(()));
    }

    // ---------------------------------------------------------- parse_model_from_state

    #[test]
    fn parse_model_from_state_reads_the_current_model_effort_and_available_levels() {
        let data = serde_json::json!({
            "model": descriptor_json("anthropic", "claude-sonnet-5", true),
            "effort": "high",
            "efforts": ["low", "medium", "high"],
        });
        let (descriptor, effort, efforts) = parse_model_from_state(Some(&data)).unwrap();
        assert_eq!(descriptor.model_ref.model_id, "claude-sonnet-5");
        assert_eq!(effort.as_deref(), Some("high"));
        assert_eq!(efforts, vec!["low", "medium", "high"]);

        let no_effort = serde_json::json!({ "model": descriptor_json("a", "m", true) });
        let (_, effort, efforts) = parse_model_from_state(Some(&no_effort)).unwrap();
        assert_eq!(effort, None);
        assert!(efforts.is_empty());
    }

    #[test]
    fn parse_model_from_state_is_none_without_a_parseable_model() {
        assert!(parse_model_from_state(None).is_none());
        assert!(parse_model_from_state(Some(&serde_json::json!({}))).is_none());
        assert!(parse_model_from_state(Some(&serde_json::json!({ "model": {} }))).is_none());
    }

    // ---------------------------------------------------------- effort_matches

    #[test]
    fn effort_matches_accepts_any_applied_value_when_clearing() {
        assert!(effort_matches(None, None));
        assert!(effort_matches(None, Some("medium")));
    }

    #[test]
    fn effort_matches_requires_an_exact_echo_of_a_requested_level() {
        assert!(effort_matches(Some("high"), Some("high")));
        assert!(!effort_matches(Some("high"), Some("medium")));
        assert!(!effort_matches(Some("high"), None));
    }

    // ---------------------------------------------------------- parse_metrics_response

    #[test]
    fn parse_metrics_response_reads_known_counters_and_reported_context() {
        let data = serde_json::json!({
            "inputTokens": 120, "outputTokens": 45,
            "cacheReadTokens": null, "cacheWriteTokens": null,
            "contextTokens": 3_400, "contextWindow": 200_000,
            "costUsd": 0.0123, "pricingKnown": true,
        });
        let m = parse_metrics_response(Some(&data), 1_000);
        assert_eq!(m.input_tokens, Some(120));
        assert_eq!(m.output_tokens, Some(45));
        assert_eq!(m.cache_read_tokens, None);
        assert_eq!(m.context_tokens, Some(3_400));
        assert_eq!(m.context_basis, "reported");
        assert_eq!(m.cost_usd, Some(0.0123));
        assert_eq!(m.cost_basis, "estimated");
        assert_eq!(m.measured_at, 1_000);
        assert!(!m.stale);
    }

    #[test]
    fn missing_or_malformed_data_is_every_counter_unknown_never_zero() {
        let m = parse_metrics_response(None, 1_000);
        assert_eq!(m.input_tokens, None);
        assert_eq!(m.context_tokens, None);
        assert_eq!(m.context_basis, "unknown");
        assert_eq!(m.cost_usd, None);
        assert_eq!(m.cost_basis, "unknown");
    }

    #[test]
    fn context_after_compaction_null_stays_unknown_not_zero() {
        let data = serde_json::json!({ "contextTokens": null, "contextWindow": 200_000 });
        let m = parse_metrics_response(Some(&data), 1_000);
        assert_eq!(m.context_tokens, None);
        assert_eq!(m.context_basis, "unknown");
    }

    #[test]
    fn zero_pricing_is_not_free_unless_pricing_is_explicitly_known() {
        // pricingKnown absent/false ⇒ unknown cost, whatever costUsd says.
        let untrusted = serde_json::json!({ "costUsd": 0.0 });
        let m = parse_metrics_response(Some(&untrusted), 1_000);
        assert_eq!(m.cost_usd, None);
        assert_eq!(m.cost_basis, "unknown");

        // A genuinely confirmed zero IS a legitimate estimate, not a guess.
        let confirmed_zero = serde_json::json!({ "costUsd": 0.0, "pricingKnown": true });
        let m = parse_metrics_response(Some(&confirmed_zero), 1_000);
        assert_eq!(m.cost_usd, Some(0.0));
        assert_eq!(m.cost_basis, "estimated");
    }

    // ---------------------------------------------------------- cache key / freshness

    #[test]
    fn cache_key_differs_by_account_fingerprint_and_environment_choice() {
        let a = cache_key("acc-1", "/pi/acc-1", false);
        let b = cache_key("acc-2", "/pi/acc-1", false);
        let c = cache_key("acc-1", "/pi/acc-1", true);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a, cache_key("acc-1", "/pi/acc-1", false));
    }

    #[test]
    fn catalog_staleness_is_gated_at_the_60s_ttl() {
        assert!(!catalog_is_stale(0, CATALOG_TTL_MS));
        assert!(catalog_is_stale(0, CATALOG_TTL_MS + 1));
    }
}
