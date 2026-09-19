//! pi-provider-auth FR-7/FR-9: the account's provider/model refresh probe —
//! the wire shape it answers with and the launch-policy check it runs. Split
//! out of `pi/mod.rs` purely for CLAUDE.md's ~1000-line file cap;
//! `pi_commands.rs`'s `account_pi_refresh` is this child's only caller.

use crate::ipc::AppError;

/// Mirrors `PiProviderAuthObservation` (contract/multi-account.ts).
///
/// `#[allow(dead_code)]`: never CONSTRUCTED in this build —
/// `probe_provider_auth`'s documented MVP limit returns an empty `Vec` of
/// these rather than inventing a per-provider state it cannot honestly back
/// (see that function's doc). It exists now because the wire response shape
/// (`AccountPiRefreshResponse`) is frozen in the contract; a real per-provider
/// probe fills it in without a wire change.
#[allow(dead_code)]
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct PiProviderAuthObservation {
    #[serde(rename = "providerId")]
    pub(crate) provider_id: String,
    pub(crate) state: PiAuthState,
    #[serde(rename = "checkedAt")]
    pub(crate) checked_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
}

/// Mirrors `PiProviderAuthObservation.state`.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PiAuthState {
    #[allow(dead_code)] // reachable once a real per-provider probe lands (see probe_provider_auth)
    Unknown,
    #[allow(dead_code)]
    Configured,
    #[allow(dead_code)]
    Verified,
    #[allow(dead_code)]
    Failed,
}

/// The session engine's Pi installation preflight
/// (`session::installation_preflight`), injected as managed state by main.rs.
/// A function pointer rather than a direct call because session/ already
/// depends on account/ — naming `crate::session` here would close a cycle.
pub struct PiInstallProbe(pub fn(&str, Option<&str>) -> Result<(), AppError>);

/// FR-7/FR-9: run the account's provider/model probe. "Same launch policy as
/// sessions" is satisfied by reusing the injected `PiInstallProbe` — the
/// SAME native/WSL binary resolution and version-compatibility gate a real
/// session's create-time preflight runs — rather than re-implementing
/// discovery here. It always refreshes (FR-9's "no shared cache") since
/// Refresh is an explicit user action every time.
///
/// **Known MVP limit** (see the feature handoff): this proves the certified
/// Pi binary is present and compatible for the account's runtime/distro, and
/// surfaces the corresponding `RUNTIME_*` failure when it is not. It does NOT
/// yet ask Pi for its live per-provider state (`get_available_models` over
/// the private RPC transport `session::adapter::pi` — pi-rpc-sessions — is
/// deliberately not production-wired for a session yet, so a one-shot admin
/// probe has nothing more to read); a Ready installation returns an empty
/// observation list rather than inventing a `configured`/`verified` state
/// this build cannot honestly back.
pub(crate) fn probe_provider_auth(
    install: &PiInstallProbe,
    runtime: &str,
    distro: Option<&str>,
) -> Result<Vec<PiProviderAuthObservation>, AppError> {
    (install.0)(runtime, distro).map(|()| Vec::new())
}
