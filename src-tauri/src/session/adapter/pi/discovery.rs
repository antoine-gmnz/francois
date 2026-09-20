//! pi-runtime-distribution: is a compatible external Pi installation on this
//! machine? Answers `francois:runtime:installation` (spec §5) — entirely
//! independent of the (still-stub) `PiAdapter` RPC transport in the parent
//! module. Nothing here ever runs Pi's RPC protocol; it only resolves the
//! binary and reads its `--version` banner (`probe`, a sibling module: how a
//! candidate is reached; this file: what a resolved version MEANS).
//!
//! **Certification is a checked-in fact, not a live computation.** `MANIFEST`
//! (`fixtures/manifest.json`) is the FR-4/FR-5 allowlist: exactly the package
//! identity `specs/research/pi-integration-audit.md` audited
//! (`@earendil-works/pi-coding-agent` 0.85.1, Node >=22.19.0, MIT). That audit
//! explicitly ran no real install/capture ("no real Pi runtime … was
//! executed"), so `artifactDigest` is `null` and `tested` is empty in the
//! fixture — which is why a version match here can only ever report
//! `Provenance::Unverified`, never `Certified`: certifying a digest, and
//! proving the FR-5 RPC surface against a live protocol capture, is
//! certification work for a follow-up feature once real fixtures exist, not
//! something this probe can honestly claim on a version string alone. FR-5's
//! scope note (spec round-1 fix) makes this explicit; the live RPC-protocol
//! probe itself is tracked as `deferred:pi-runtime-distribution` in
//! `specs/refactor-backlog.md`.

use super::probe::{
    parse_version_line, probe_native, probe_node_at_native, probe_node_wsl, probe_wsl, ProbeEnv,
    ResolutionOutcome,
};
use crate::ipc::{ok, AppError, ErrorCode, IpcResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// §5: "Cache keyed by environment … for 60 seconds; refresh bypasses it."
const CACHE_TTL: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------- manifest

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[allow(dead_code)] // read by the fixture-pinning test only
    schema_version: u32,
    package_name: String,
    package_version: String,
    #[allow(dead_code)] // FR-4: compared once a real capture populates it
    artifact_digest: Option<String>,
    #[allow(dead_code)]
    source_revision: String,
    node_range: String,
    #[allow(dead_code)]
    tested: Vec<TestedEnvironment>,
    #[allow(dead_code)] // read by the fixture-pinning test only
    required_commands: Vec<String>,
    #[allow(dead_code)] // read by the fixture-pinning test only
    required_events: Vec<String>,
    #[allow(dead_code)]
    fixture_revision: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct TestedEnvironment {
    os: String,
    environment: String,
}

fn manifest() -> &'static Manifest {
    static MANIFEST: OnceLock<Manifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/manifest.json"))
            .expect("fixtures/manifest.json is valid JSON matching Manifest")
    })
}

/// FR-3: display/copy only, built from the certified package/version — never
/// `@latest` (§5).
fn install_command() -> String {
    format!(
        "npm install --global {}@{}",
        manifest().package_name,
        manifest().package_version
    )
}

// ---------------------------------------------------------------- wire shapes

/// Mirrors `RuntimeInstallStatus.state` (contract/pi-runtime-distribution.ts).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InstallState {
    Missing,
    Incompatible,
    Ready,
    ProbeFailed,
}

/// Mirrors `RuntimeInstallStatus.provenance`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provenance {
    #[allow(dead_code)] // reachable once a real artifact digest is captured (see module doc)
    Certified,
    Unverified,
    Unknown,
}

/// Mirrors `RuntimeInstallStatus` exactly.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RuntimeInstallStatus {
    pub state: InstallState,
    #[serde(rename = "executablePath", skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
    #[serde(rename = "detectedVersion", skip_serializing_if = "Option::is_none")]
    pub detected_version: Option<String>,
    #[serde(rename = "nodeVersion", skip_serializing_if = "Option::is_none")]
    pub node_version: Option<String>,
    #[serde(rename = "supportedVersions")]
    pub supported_versions: Vec<String>,
    pub provenance: Provenance,
    #[serde(rename = "checkedAt")]
    pub checked_at: u64,
    #[serde(rename = "installCommand")]
    pub install_command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
}

// ---------------------------------------------------------------- validation

/// FR-1/§5: `distro` is required iff `runtime == "wsl"`, and `wsl` itself is
/// only ever accepted on Windows (create-time session validation's own rule,
/// `session::valid_runtime`/`lifecycle.rs`'s `validate_create_input` — mirrored
/// here rather than shared, since that helper is turn-shaped and this probe
/// takes no `cwd`).
fn validate(runtime: &str, distro: Option<&str>) -> Result<(), AppError> {
    if !crate::session::valid_runtime(runtime) {
        return Err(AppError::new(ErrorCode::InvalidInput, "unknown runtime"));
    }
    if runtime == "wsl" {
        if !cfg!(windows) {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "the WSL runtime is only available on Windows",
            ));
        }
        if distro.map(str::trim).unwrap_or("").is_empty() {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "distro is required for the wsl runtime",
            ));
        }
    } else if distro.is_some() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "distro is only valid for the wsl runtime",
        ));
    }
    Ok(())
}

/// FR-4/FR-5: the exact-match allowlist gate — no semver-wide inference. See
/// the module doc for why a match can only ever report `Unverified` today.
fn evaluate_version(version: &str) -> (InstallState, Provenance, Option<AppError>) {
    if version == manifest().package_version {
        (InstallState::Ready, Provenance::Unverified, None)
    } else {
        let message = format!(
            "Pi {version} is not a certified release. Install {} to use Pi with Francois.",
            manifest().package_version
        );
        (
            InstallState::Incompatible,
            Provenance::Unknown,
            Some(AppError::new(ErrorCode::RuntimeIncompatible, message)),
        )
    }
}

/// FR-3: the manifest's `nodeRange` is a simple `>=X.Y.Z` floor (Pi's own
/// certified minimum), not a general semver range — parsed once, not with a
/// semver crate dependency this repo doesn't otherwise carry. `None` only if
/// the manifest were ever hand-edited to something this parser doesn't
/// recognize, in which case Node compatibility simply isn't checked (fails
/// open — see `check_node_incompatibility`) rather than panicking.
fn minimum_node_version() -> Option<(u64, u64, u64)> {
    parse_semver(manifest().node_range.strip_prefix(">=")?.trim())
}

fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let mut parts = s.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// FR-3: gates an otherwise-`Ready` verdict on the manifest's Node floor — a
/// certified Pi paired with a too-old Node must not silently report `ready`
/// and only fail once the RPC session actually starts. Only ever downgrades a
/// `Ready` verdict (see `build_status`'s call site): a Pi version mismatch is
/// already `Incompatible` on its own, independent of Node. Returns `None`
/// (nothing to downgrade) when there is nothing usable to check — Node wasn't
/// probed, or its banner didn't parse as a version — which stays `Ready`
/// rather than a false negative.
fn check_node_incompatibility(
    node_version: Option<&str>,
) -> Option<(InstallState, Provenance, AppError)> {
    let node_version = node_version?;
    let minimum = minimum_node_version()?;
    let found = parse_semver(node_version)?;
    if found >= minimum {
        return None;
    }
    let message = format!(
        "Pi requires Node {}; detected Node {node_version}. Upgrade Node to use Pi with Francois.",
        manifest().node_range
    );
    Some((
        InstallState::Incompatible,
        Provenance::Unknown,
        AppError::new(ErrorCode::RuntimeIncompatible, message),
    ))
}

// ---------------------------------------------------------------- assembly

fn build_status(
    resolution: ResolutionOutcome,
    node_output: Option<String>,
    now_ms: u64,
) -> RuntimeInstallStatus {
    let supported_versions = vec![manifest().package_version.clone()];
    let install_command = install_command();
    let base = |state, provenance, executable_path, detected_version, error| RuntimeInstallStatus {
        state,
        executable_path,
        detected_version,
        node_version: node_output.as_ref().and_then(|o| parse_version_line(o)),
        supported_versions: supported_versions.clone(),
        provenance,
        checked_at: now_ms,
        install_command: install_command.clone(),
        error,
    };
    match resolution {
        ResolutionOutcome::Missing => base(
            InstallState::Missing,
            Provenance::Unknown,
            None,
            None,
            Some(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "Pi is not installed. Install it, then Retry.",
            )),
        ),
        ResolutionOutcome::Unavailable(message) => base(
            InstallState::Missing,
            Provenance::Unknown,
            None,
            None,
            Some(AppError::new(ErrorCode::RuntimeUnavailable, message)),
        ),
        ResolutionOutcome::SpawnFailed => base(
            InstallState::ProbeFailed,
            Provenance::Unknown,
            None,
            None,
            Some(AppError::new(
                ErrorCode::RuntimeProtocolError,
                "Pi was found but could not be started.",
            )),
        ),
        ResolutionOutcome::TimedOut => base(
            InstallState::ProbeFailed,
            Provenance::Unknown,
            None,
            None,
            Some(AppError::new(
                ErrorCode::RuntimeTimeout,
                "Pi did not respond to --version within 5 seconds.",
            )),
        ),
        ResolutionOutcome::Found {
            path,
            version_output,
        } => match parse_version_line(&version_output) {
            None => base(
                InstallState::ProbeFailed,
                Provenance::Unknown,
                Some(path),
                None,
                Some(AppError::new(
                    ErrorCode::RuntimeProtocolError,
                    "Pi printed an unexpected response to --version.",
                )),
            ),
            Some(version) => {
                let (state, provenance, error) = evaluate_version(&version);
                if state == InstallState::Ready {
                    let node_version = node_output.as_ref().and_then(|o| parse_version_line(o));
                    if let Some((state, provenance, error)) =
                        check_node_incompatibility(node_version.as_deref())
                    {
                        return base(state, provenance, Some(path), Some(version), Some(error));
                    }
                }
                base(state, provenance, Some(path), Some(version), error)
            }
        },
    }
}

// ---------------------------------------------------------------- cache

struct CacheEntry {
    status: RuntimeInstallStatus,
    at: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// pi-provider-auth FR-9: the account a probe runs FOR. Its `config_dir` is
/// part of the CACHE KEY, not just the spawn: "no shared cache can mix
/// providers/models across accounts", and a 60s entry keyed on the
/// environment alone would hand one account's verdict to another — or leak an
/// account-scoped result into the ambient `runtime_installation` cache.
pub(crate) struct ProbeScope<'a> {
    pub(crate) config_dir: &'a str,
    pub(crate) env: &'a [(String, String)],
}

fn cache_key(runtime: &str, distro: Option<&str>, scope: Option<&ProbeScope<'_>>) -> String {
    format!(
        "{runtime}:{}:{}",
        distro.unwrap_or(""),
        scope.map(|s| s.config_dir).unwrap_or("")
    )
}

/// §5: "Cache keyed by environment and resolved binary metadata for 60
/// seconds; refresh bypasses it." — the full status (which carries the
/// resolved path/version) is the cached value, so a changed binary under an
/// unchanged environment is only ever stale for at most 60s or one explicit
/// Retry (`refresh: true`), never silently forever (spec FR-6).
pub(crate) fn probe_installation(
    runtime: &str,
    distro: Option<&str>,
    refresh: bool,
) -> Result<RuntimeInstallStatus, AppError> {
    probe_installation_scoped(runtime, distro, refresh, None)
}

/// The same probe, run in ONE account's environment (PR #142 §5). Everything
/// about it is identical except the two things that make it account-scoped:
/// the child's environment (so `PI_CODING_AGENT_DIR` — and, for `wsl`, the
/// `WSLENV` entry that carries it into the distro — are the account's), and
/// the cache key (FR-9).
pub(crate) fn probe_installation_scoped(
    runtime: &str,
    distro: Option<&str>,
    refresh: bool,
    scope: Option<&ProbeScope<'_>>,
) -> Result<RuntimeInstallStatus, AppError> {
    validate(runtime, distro)?;
    let key = cache_key(runtime, distro, scope);
    let env: ProbeEnv<'_> = scope.map(|s| s.env);
    if !refresh {
        // `unwrap_or_else(|e| e.into_inner())` rather than `.unwrap()`: a panic
        // in one probe (this lock is held only for the get/insert, never across
        // a spawn) must not poison the cache for every later
        // `runtime_installation` call — same degrade-gracefully stance as
        // `account/cli_tools.rs::in_flight()`.
        if let Some(entry) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            if entry.at.elapsed() < CACHE_TTL {
                return Ok(entry.status.clone());
            }
        }
    }
    let now = crate::ids::now_ms();
    let (resolution, node_output) = if runtime == "wsl" {
        let distro = distro.expect("validated above: wsl always carries a distro");
        (probe_wsl(distro, env), probe_node_wsl(distro, env))
    } else {
        (probe_native(env), probe_node_at_native(env))
    };
    let status = build_status(resolution, node_output, now);
    cache().lock().unwrap_or_else(|e| e.into_inner()).insert(
        key,
        CacheEntry {
            status: status.clone(),
            at: Instant::now(),
        },
    );
    Ok(status)
}

// ---------------------------------------------------------------- command

/// francois:runtime:installation (spec §5). `async` — a native probe spawns
/// one bounded child (two for WSL: Pi, then Node), and must not hold a Tauri
/// worker thread for the whole 5s deadline. Missing/incompatible/probe-failure
/// are all successful `Result`s (§5) — only `INVALID_INPUT` (bad runtime/
/// distro combination) rejects the envelope itself.
///
/// **Not a pi-provider-auth FR-4 bypass, though it runs `pi --version` with no
/// trust check** (reviewed, PR #142 §5 — recorded here so the next reader does
/// not re-raise it). FR-4 gates executing a USER-NOMINATED `configDir`, whose
/// provider configuration can name credential helpers Francois would be
/// running on the user's behalf. This probe nominates nothing: it resolves
/// whatever `pi` the ambient PATH already offers and reads its version banner,
/// which is the same thing typing `pi --version` in a terminal does. The
/// account-scoped probe — the one that DOES carry a `configDir` — is
/// `account::pi::refresh`, and it is gated by `pi_execution_preflight`.
#[tauri::command(async)]
pub fn runtime_installation(
    runtime: String,
    distro: Option<String>,
    refresh: Option<bool>,
) -> IpcResult<RuntimeInstallStatus> {
    match probe_installation(&runtime, distro.as_deref(), refresh.unwrap_or(false)) {
        Ok(status) => ok(status),
        Err(e) => e.into(),
    }
}

/// pi-provider-auth FR-7: the same preflight, shaped as `account::PiInstallProbe`
/// — main.rs injects it so account/ never names `crate::session` (session/
/// already depends on account/). Always `refresh`: Refresh is an explicit user
/// action (FR-9's "no shared cache").
///
/// PR #142 §5: it takes the account's `config_dir` and its prebuilt
/// environment, so "the same launch policy as sessions" now covers the child's
/// ENVIRONMENT too, not just which binary gets resolved. `account::pi::refresh`
/// builds the env (it owns that rule); this side only spends it.
pub fn installation_preflight(
    runtime: &str,
    distro: Option<&str>,
    config_dir: &str,
    env: &[(String, String)],
) -> Result<(), AppError> {
    let scope = ProbeScope { config_dir, env };
    match probe_installation_scoped(runtime, distro, true, Some(&scope))?.error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- manifest fixture pinning ----

    #[test]
    fn the_fixture_names_the_audited_package_and_its_full_rpc_surface() {
        let m = manifest();
        assert_eq!(m.schema_version, 1);
        assert_eq!(m.package_name, "@earendil-works/pi-coding-agent");
        assert_eq!(m.package_version, "0.85.1");
        assert!(m.artifact_digest.is_none(), "no real capture exists yet");
        for cmd in [
            "get_state",
            "get_available_models",
            "get_commands",
            "get_entries",
            "get_session_stats",
            "prompt",
            "steer",
            "follow_up",
            "clear_queue",
            "abort",
            "compact",
            "set_model",
            "get_available_thinking_levels",
        ] {
            assert!(
                m.required_commands.contains(&cmd.to_string()),
                "missing required command: {cmd}"
            );
        }
        assert!(m.required_events.contains(&"agent_settled".to_string()));
    }

    #[test]
    fn install_command_names_the_pinned_version_never_latest() {
        assert_eq!(
            install_command(),
            "npm install --global @earendil-works/pi-coding-agent@0.85.1"
        );
    }

    // ---- validate (FR-1) ----

    #[test]
    fn native_rejects_a_distro() {
        let e = validate("native", Some("Ubuntu")).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn an_unknown_runtime_is_rejected() {
        assert_eq!(
            validate("vmware", None).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    #[test]
    fn native_with_no_distro_is_valid() {
        assert!(validate("native", None).is_ok());
    }

    #[cfg(not(windows))]
    #[test]
    fn wsl_is_rejected_off_windows_even_with_a_distro() {
        assert_eq!(
            validate("wsl", Some("Ubuntu")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    #[cfg(windows)]
    #[test]
    fn wsl_requires_a_nonblank_distro_on_windows() {
        assert_eq!(
            validate("wsl", None).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert_eq!(
            validate("wsl", Some("  ")).unwrap_err().code,
            ErrorCode::InvalidInput
        );
        assert!(validate("wsl", Some("Ubuntu")).is_ok());
    }

    // ---- evaluate_version (FR-4/FR-5 exact allowlist) ----

    #[test]
    fn the_certified_version_is_ready_and_unverified_pending_a_real_capture() {
        let (state, provenance, error) = evaluate_version("0.85.1");
        assert_eq!(state, InstallState::Ready);
        assert_eq!(provenance, Provenance::Unverified);
        assert!(error.is_none());
    }

    #[test]
    fn any_other_version_is_incompatible_with_no_semver_leniency() {
        for other in ["0.85.0", "0.86.0", "1.0.0", "0.85.10"] {
            let (state, provenance, error) = evaluate_version(other);
            assert_eq!(state, InstallState::Incompatible, "{other}");
            assert_eq!(provenance, Provenance::Unknown, "{other}");
            let error = error.expect("incompatible carries an error");
            assert_eq!(error.code, ErrorCode::RuntimeIncompatible);
            assert!(error.message.contains(other));
            assert!(error.message.contains("0.85.1"));
        }
    }

    // ---- check_node_incompatibility (quality finding round 2: FR-3 nodeRange) ----

    #[test]
    fn the_manifests_node_floor_parses_as_22_19_0() {
        assert_eq!(minimum_node_version(), Some((22, 19, 0)));
    }

    #[test]
    fn node_at_or_above_the_floor_is_not_downgraded() {
        assert!(check_node_incompatibility(Some("22.19.0")).is_none());
        assert!(check_node_incompatibility(Some("22.19.1")).is_none());
        assert!(check_node_incompatibility(Some("23.0.0")).is_none());
    }

    #[test]
    fn node_below_the_floor_is_incompatible_with_a_node_specific_message() {
        let (state, provenance, error) =
            check_node_incompatibility(Some("18.20.4")).expect("below the floor");
        assert_eq!(state, InstallState::Incompatible);
        assert_eq!(provenance, Provenance::Unknown);
        assert_eq!(error.code, ErrorCode::RuntimeIncompatible);
        assert!(error.message.contains("18.20.4"));
        assert!(error.message.contains(">=22.19.0"));
    }

    #[test]
    fn nothing_to_check_fails_open_rather_than_downgrading() {
        assert!(check_node_incompatibility(None).is_none());
        assert!(check_node_incompatibility(Some("not-a-version")).is_none());
    }

    #[test]
    fn a_certified_pi_on_too_old_node_reports_incompatible_not_ready() {
        let status = build_status(
            ResolutionOutcome::Found {
                path: "/usr/local/bin/pi".into(),
                version_output: "0.85.1".into(),
            },
            Some("v18.20.4".into()),
            0,
        );
        assert_eq!(status.state, InstallState::Incompatible);
        assert_eq!(status.provenance, Provenance::Unknown);
        assert_eq!(status.detected_version.as_deref(), Some("0.85.1"));
        assert_eq!(status.node_version.as_deref(), Some("18.20.4"));
        let error = status.error.expect("too-old node carries an error");
        assert_eq!(error.code, ErrorCode::RuntimeIncompatible);
        assert!(error.message.contains("18.20.4"));
    }

    #[test]
    fn an_uncertified_pi_version_stays_incompatible_for_its_own_reason_even_with_old_node() {
        // A Pi version mismatch must not be masked or reworded by the Node
        // check — `evaluate_version`'s own message wins.
        let status = build_status(
            ResolutionOutcome::Found {
                path: "/usr/local/bin/pi".into(),
                version_output: "0.80.0".into(),
            },
            Some("v18.20.4".into()),
            0,
        );
        assert_eq!(status.state, InstallState::Incompatible);
        let error = status.error.unwrap();
        assert!(error.message.contains("0.80.0"));
        assert!(!error.message.contains("Node"));
    }

    // ---- build_status / RuntimeInstallStatus shape ----

    #[test]
    fn missing_reports_runtime_unavailable_with_no_path_or_version() {
        let status = build_status(ResolutionOutcome::Missing, None, 111);
        assert_eq!(status.state, InstallState::Missing);
        assert_eq!(status.provenance, Provenance::Unknown);
        assert!(status.executable_path.is_none());
        assert!(status.detected_version.is_none());
        assert!(status.node_version.is_none());
        assert_eq!(status.checked_at, 111);
        assert_eq!(status.supported_versions, vec!["0.85.1".to_string()]);
        assert_eq!(status.error.unwrap().code, ErrorCode::RuntimeUnavailable);
    }

    #[test]
    fn wsl_unavailable_carries_its_own_message_but_still_reports_missing() {
        let status = build_status(
            ResolutionOutcome::Unavailable("WSL is not available.".into()),
            None,
            0,
        );
        assert_eq!(status.state, InstallState::Missing);
        let error = status.error.unwrap();
        assert_eq!(error.code, ErrorCode::RuntimeUnavailable);
        assert_eq!(error.message, "WSL is not available.");
    }

    #[test]
    fn spawn_failure_is_probe_failed_protocol_error() {
        let status = build_status(ResolutionOutcome::SpawnFailed, None, 0);
        assert_eq!(status.state, InstallState::ProbeFailed);
        assert_eq!(status.error.unwrap().code, ErrorCode::RuntimeProtocolError);
    }

    #[test]
    fn a_timeout_is_probe_failed_runtime_timeout() {
        let status = build_status(ResolutionOutcome::TimedOut, None, 0);
        assert_eq!(status.state, InstallState::ProbeFailed);
        assert_eq!(status.error.unwrap().code, ErrorCode::RuntimeTimeout);
    }

    #[test]
    fn a_found_but_malformed_banner_is_probe_failed_protocol_error_with_path() {
        let status = build_status(
            ResolutionOutcome::Found {
                path: "/usr/local/bin/pi".into(),
                version_output: "segmentation fault".into(),
            },
            None,
            0,
        );
        assert_eq!(status.state, InstallState::ProbeFailed);
        assert_eq!(status.executable_path.as_deref(), Some("/usr/local/bin/pi"));
        assert!(status.detected_version.is_none());
        assert_eq!(status.error.unwrap().code, ErrorCode::RuntimeProtocolError);
    }

    #[test]
    fn a_found_certified_version_is_ready_and_carries_the_probed_node_version() {
        let status = build_status(
            ResolutionOutcome::Found {
                path: "/usr/local/bin/pi".into(),
                version_output: "0.85.1".into(),
            },
            Some("v22.19.0".into()),
            42,
        );
        assert_eq!(status.state, InstallState::Ready);
        assert_eq!(status.provenance, Provenance::Unverified);
        assert_eq!(status.detected_version.as_deref(), Some("0.85.1"));
        assert_eq!(status.node_version.as_deref(), Some("22.19.0"));
        assert!(status.error.is_none());
        assert_eq!(
            status.install_command,
            "npm install --global @earendil-works/pi-coding-agent@0.85.1"
        );
    }

    #[test]
    fn missing_node_leaves_node_version_absent_rather_than_failing_the_probe() {
        let status = build_status(
            ResolutionOutcome::Found {
                path: "/usr/local/bin/pi".into(),
                version_output: "0.85.1".into(),
            },
            None,
            0,
        );
        assert_eq!(status.state, InstallState::Ready);
        assert!(status.node_version.is_none());
    }

    // ---- wire shape ----

    #[test]
    fn status_serializes_camelcase_and_omits_absent_optionals() {
        let status = build_status(ResolutionOutcome::Missing, None, 999);
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["state"], "missing");
        assert_eq!(json["checkedAt"], 999);
        assert_eq!(json["installCommand"], install_command());
        assert!(json.get("executablePath").is_none());
        assert!(json.get("detectedVersion").is_none());
        assert!(json.get("nodeVersion").is_none());
        assert_eq!(json["error"]["code"], "RUNTIME_UNAVAILABLE");
    }

    #[test]
    fn every_state_and_provenance_spelling_matches_the_contract_union() {
        assert_eq!(
            serde_json::to_value(InstallState::Missing).unwrap(),
            "missing"
        );
        assert_eq!(
            serde_json::to_value(InstallState::Incompatible).unwrap(),
            "incompatible"
        );
        assert_eq!(serde_json::to_value(InstallState::Ready).unwrap(), "ready");
        assert_eq!(
            serde_json::to_value(InstallState::ProbeFailed).unwrap(),
            "probe-failed"
        );
        assert_eq!(
            serde_json::to_value(Provenance::Certified).unwrap(),
            "certified"
        );
        assert_eq!(
            serde_json::to_value(Provenance::Unverified).unwrap(),
            "unverified"
        );
        assert_eq!(
            serde_json::to_value(Provenance::Unknown).unwrap(),
            "unknown"
        );
    }

    // ---- cache / refresh (§5) ----
    //
    // One test, not four: `cache()` is a process-global singleton keyed by
    // environment, `cargo test` runs tests in parallel threads by default, and
    // every scenario below shares the SAME "native:" key — split across
    // separate `#[test]` fns they would race each other's inserts/removals.

    fn fixture_status(checked_at: u64) -> RuntimeInstallStatus {
        RuntimeInstallStatus {
            state: InstallState::Ready,
            executable_path: Some("/opt/pi".into()),
            detected_version: Some("0.85.1".into()),
            node_version: None,
            supported_versions: vec!["0.85.1".into()],
            provenance: Provenance::Unverified,
            checked_at,
            install_command: install_command(),
            error: None,
        }
    }

    /// pi-provider-auth FR-9: two accounts, two cache entries — and neither of
    /// them is the ambient `runtime_installation` one. Before this, a 60s
    /// entry keyed on `"native:"` alone was shared by every account and by the
    /// unscoped probe, so the FIRST account's verdict answered for all of them.
    #[test]
    fn the_probe_cache_key_separates_accounts_from_each_other_and_from_the_ambient_probe() {
        let env: Vec<(String, String)> = Vec::new();
        let a = ProbeScope {
            config_dir: "/pi/a",
            env: &env,
        };
        let b = ProbeScope {
            config_dir: "/pi/b",
            env: &env,
        };
        assert_ne!(
            cache_key("native", None, Some(&a)),
            cache_key("native", None, Some(&b))
        );
        assert_ne!(
            cache_key("native", None, Some(&a)),
            cache_key("native", None, None)
        );
        // The environment itself is still keyed too (runtime + distro).
        assert_ne!(
            cache_key("wsl", Some("Ubuntu"), Some(&a)),
            cache_key("wsl", Some("Debian"), Some(&a))
        );
    }

    #[test]
    fn cache_serves_fresh_entries_reprobes_past_ttl_and_refresh_and_never_caches_invalid_input() {
        let key = cache_key("native", None, None);

        // A fresh entry is served as-is, with no reprobe.
        let stale_status = fixture_status(1);
        cache().lock().unwrap().insert(
            key.clone(),
            CacheEntry {
                status: stale_status.clone(),
                at: Instant::now(),
            },
        );
        let got = probe_installation("native", None, false).unwrap();
        assert_eq!(got, stale_status, "a fresh entry must be served from cache");

        // An entry past the 60s TTL is not served — a real (deterministic,
        // since no `pi` is installed on a CI runner) reprobe replaces it.
        cache().lock().unwrap().insert(
            key.clone(),
            CacheEntry {
                status: fixture_status(1),
                at: Instant::now() - Duration::from_secs(61),
            },
        );
        let got = probe_installation("native", None, false).unwrap();
        assert_ne!(got.checked_at, 1, "an expired entry must not be served");

        // `refresh: true` bypasses an otherwise-still-fresh entry.
        cache().lock().unwrap().insert(
            key.clone(),
            CacheEntry {
                status: fixture_status(1),
                at: Instant::now(),
            },
        );
        let got = probe_installation("native", None, true).unwrap();
        assert_ne!(got.checked_at, 1, "refresh must reprobe a fresh entry too");

        cache().lock().unwrap().remove(&key);

        // INVALID_INPUT never reaches (or seeds) the cache.
        assert!(probe_installation("native", Some("Ubuntu"), false).is_err());
        assert!(!cache()
            .lock()
            .unwrap()
            .contains_key(&cache_key("native", Some("Ubuntu"), None)));
    }
}
