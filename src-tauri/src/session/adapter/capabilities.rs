//! process-native-capabilities FR-1/FR-4/FR-6: the backend guard over the
//! seventeen-key capability map. Distinguishes the runtime's implemented
//! ceiling (what its adapter can ever do) from the current live snapshot
//! (what the connected process negotiated), and names WHY a control is off:
//! unsupported, a supported transport that is disconnected, or an invalid
//! snapshot. The frontend selector (`src/lib/runtimeCapability.ts`) mirrors
//! this exactly; both are tested against `capability-matrix.json`.
use super::{resolve_capability, validate_capabilities, AgentRuntime, RuntimeCapabilities};
use crate::ipc::ErrorCode;

pub(crate) const CAPABILITY_UNSUPPORTED: &str = "runtime capability is unavailable";
pub(crate) const CAPABILITY_DISCONNECTED: &str =
    "runtime is disconnected; start or continue a turn to reconnect";
pub(crate) const CAPABILITY_INVALID: &str = "runtime reported an invalid capability snapshot";

/// Keys an implemented adapter supports only while its negotiated live
/// transport exists: absent a snapshot they stay off (FR-1/FR-2).
pub(crate) fn live_only(runtime: AgentRuntime, key: &str) -> bool {
    runtime == AgentRuntime::Codex && key == "permissions"
}

/// FR-1: the explicit supported-control matrix — legacy baseline plus the
/// live-only keys. Pi supports nothing.
pub(crate) fn capability_ceiling(runtime: AgentRuntime, key: &str) -> bool {
    runtime != AgentRuntime::Pi
        && (resolve_capability(runtime, None, key) || live_only(runtime, key))
}

/// FR-4/FR-6: the one backend guard. `generation` is the live runtime child's
/// id; a snapshot without one is stale and can only narrow, never widen.
pub(crate) fn check_capability(
    runtime: AgentRuntime,
    caps: Option<&RuntimeCapabilities>,
    generation: Option<&str>,
    key: &str,
) -> Result<(), (ErrorCode, &'static str)> {
    let unsupported = (ErrorCode::RuntimeUnsupported, CAPABILITY_UNSUPPORTED);
    if !capability_ceiling(runtime, key) {
        return Err(unsupported);
    }
    if caps.is_some_and(|caps| validate_capabilities(caps).is_err()) {
        return Err((ErrorCode::RuntimeUnsupported, CAPABILITY_INVALID));
    }
    if live_only(runtime, key) && (generation.is_none() || caps.is_none()) {
        return Err((ErrorCode::RuntimeUnavailable, CAPABILITY_DISCONNECTED));
    }
    match caps {
        Some(caps) if !caps.get(key).is_some_and(|state| state.available) => Err(unsupported),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{native_capabilities, CapabilityState, RUNTIME_CAPABILITIES};
    use super::*;
    use std::collections::BTreeMap;

    fn snapshot(available: bool) -> RuntimeCapabilities {
        RUNTIME_CAPABILITIES
            .iter()
            .map(|key| {
                (
                    (*key).to_string(),
                    CapabilityState {
                        available,
                        reason: (!available).then(|| "Disabled".into()),
                    },
                )
            })
            .collect()
    }

    /// The same five scenarios the frontend matrix test builds.
    fn scenario(name: &str) -> (Option<RuntimeCapabilities>, Option<&'static str>) {
        match name {
            "none" => (None, None),
            "live-all" => (Some(snapshot(true)), Some("g1")),
            "live-none" => (Some(snapshot(false)), Some("g1")),
            "invalid" => {
                let mut caps = snapshot(true);
                caps.remove("costMetrics");
                (Some(caps), Some("g1"))
            }
            "stale-all" => (Some(snapshot(true)), None),
            other => panic!("unknown scenario {other}"),
        }
    }

    #[test]
    fn every_key_matches_the_shared_matrix_for_every_runtime_and_snapshot() {
        let matrix: serde_json::Value =
            serde_json::from_str(include_str!("capability-matrix.json")).unwrap();
        let cases = matrix["cases"].as_object().unwrap();
        assert_eq!(cases.len(), 5, "claude-code, codex, francois, grok, pi");
        for (runtime_name, scenarios) in cases {
            let runtime: AgentRuntime =
                serde_json::from_value(serde_json::Value::String(runtime_name.clone())).unwrap();
            let scenarios: BTreeMap<String, Vec<String>> =
                serde_json::from_value(scenarios.clone()).unwrap();
            assert_eq!(scenarios.len(), 5, "{runtime_name}");
            for (name, expected) in scenarios {
                let (caps, generation) = scenario(&name);
                for key in RUNTIME_CAPABILITIES {
                    let got = check_capability(runtime, caps.as_ref(), generation, key).is_ok();
                    assert_eq!(
                        got,
                        expected.iter().any(|k| k == key),
                        "{runtime_name} / {name} / {key}"
                    );
                }
            }
        }
    }

    #[test]
    fn denial_names_unsupported_disconnected_and_invalid_without_native_detail() {
        let codex = AgentRuntime::Codex;
        assert_eq!(
            check_capability(codex, None, None, "mcp"),
            Err((ErrorCode::RuntimeUnsupported, CAPABILITY_UNSUPPORTED))
        );
        assert_eq!(
            check_capability(codex, None, Some("g1"), "permissions"),
            Err((ErrorCode::RuntimeUnavailable, CAPABILITY_DISCONNECTED))
        );
        let (invalid, generation) = scenario("invalid");
        assert_eq!(
            check_capability(codex, invalid.as_ref(), generation, "permissions"),
            Err((ErrorCode::RuntimeUnsupported, CAPABILITY_INVALID))
        );
        for reason in [
            CAPABILITY_UNSUPPORTED,
            CAPABILITY_DISCONNECTED,
            CAPABILITY_INVALID,
        ] {
            assert!(crate::ipc::safe_display(
                reason,
                crate::ipc::MAX_CAPABILITY_REASON_BYTES
            ));
            assert!(!reason.contains('/') && !reason.contains('\\'));
        }
    }

    #[test]
    fn the_codex_native_snapshot_advertises_exactly_its_ceiling() {
        let caps = native_capabilities(AgentRuntime::Codex);
        assert!(validate_capabilities(&caps).is_ok());
        for key in RUNTIME_CAPABILITIES {
            assert_eq!(
                caps[key].available,
                capability_ceiling(AgentRuntime::Codex, key),
                "{key}"
            );
        }
    }
}
