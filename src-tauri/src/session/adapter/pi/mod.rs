//! session/adapter/pi/ — everything Pi-specific.
//!
//! `discovery` is pi-runtime-distribution's whole surface (specs/
//! pi-runtime-distribution.md): is a compatible external Pi installation on
//! this machine, independent of whether any session ever tries to connect to
//! one. A child module rather than folded into the parent — same "one concern
//! per child" shape the rest of this domain follows — because it owns its own
//! certification manifest/fixtures and has no reason to see the connection
//! state `dispatcher` owns.
//!
//! pi-rpc-sessions adds the private RPC session lifecycle (specs/
//! pi-rpc-sessions.md): `wire` (the LF-framed command/response/event
//! protocol), `process` (spawning the certified executable under the
//! baseline launch policy), and `dispatcher` (the per-session correlation +
//! state machine, and the live `RuntimeSessionControl` `PiAdapter::
//! connect_session` returns). None of the three are exported past this
//! module — spec §5: "Private wire types belong only in
//! session/adapter/pi/wire.rs", and the same holds for their siblings.
//! Production access remains disabled until the dependent tasks that let a
//! session actually select the Pi runtime land (spec §6) — `PiAdapter::
//! preflight`/`begin_turn` (the per-turn `TurnControl` seam every other
//! runtime uses) stay deliberately unavailable in the parent module; Pi's
//! real seam is the session-scoped `connect_session` this module implements.

/// pi-turn-controls: steer/follow-up submit (reuses `submit`), `clear_queue`/
/// `abort`/`compact` wire calls, and the shared Stop sequence (FR-6/FR-7)
/// built from them. A sibling of `dispatcher` — same "one concern per child"
/// split, connection plumbing vs. the turn-control verbs riding it —
/// dispatching through `PiConnection::dispatch` (widened `pub(super)` for
/// exactly this).
mod controls;
mod discovery;
mod dispatcher;
/// pi-models-metrics: model catalogue discovery/switching and session usage
/// metrics — the mapping functions, the 60 s catalogue cache and the
/// short-lived no-session probe. A sibling of `dispatcher`/`protocol` rather
/// than folded into either — same "one concern per child" split; see this
/// module's own doc for why its no-session probe does NOT reuse
/// `PiConnection`/`ProtocolEngine`.
mod models;
/// pi-transcript-events FR-1..FR-9: the pure Pi-transcript-event → generic
/// tool-call/text/notice reducer. A sibling of `protocol` rather than a part
/// of it — same "one concern per child" split, this time content vs.
/// connection/run state. Wired into `dispatcher`'s live reader thread — see
/// its own module doc.
mod normalize;
/// pi-session-durability §5/§6: the core-private `PiResumeRecord` nested in
/// `sessions.json`, and the "owned native session directory" path helpers
/// FR-3's validation is built on. A sibling of `recovery` (data vs. the
/// validate/rebuild logic that reads and writes it) — same "one concern per
/// child" split every other pair in this domain follows.
mod persistence;
/// FR-1/FR-2/FR-8: the bounded spawn + native/WSL resolution `discovery`
/// builds a verdict from. Split out purely for CLAUDE.md's ~1000-line file
/// cap — `discovery` is the only caller and the only thing that needs it.
mod probe;
mod process;
/// pi-migration-rollout FR-3/FR-5: `PiProfileSettings` → (argv tokens,
/// core-owned launch-prompt snapshot) — split into a resolve-once (fs-
/// reading) half and a pure argv-building half. Wired into `process.rs`'s
/// `spawn` and `recovery.rs`'s reconnect/new-from — see its own module doc
/// for the read-once split and the provisional Pi flag spellings it owns.
mod profile_args;
/// FR-2/FR-3/FR-4/FR-6: the pure correlation/state-machine core `dispatcher`
/// wraps in a live connection. Split out purely for CLAUDE.md's ~1000-line
/// file cap — see its module doc.
mod protocol;
/// pi-migration-rollout FR-8: the single-source production-readiness
/// decision for Pi session creation — see its own module doc for why it
/// must stay closed in this build and what would open it.
mod readiness;
/// pi-session-durability §4/§5: FR-3's pre-resume validation, FR-4/FR-5's
/// projection rebuild (native entry ancestry + stable-block-id
/// reconciliation), FR-8's version-transition backup, and the
/// `session_reconnect`/`session_new_from` orchestration those commands call
/// into (`session/commands/lifecycle.rs` stays a thin Tauri wrapper).
mod recovery;
/// pi-skills-capabilities FR-5/FR-6/FR-7: `RuntimeResourcePolicy`, the ONE
/// policy → launch-argv mapping (`process.rs`'s `pi_args` is the ONE call
/// site), the FR-7 preflight, and the `get_commands` wire mapping. A sibling
/// of `process`/`models` rather than folded into either — same "one concern
/// per child" split; see its own module doc for the provisional wire shape
/// it owns.
mod resources;
mod wire;

/// pi-turn-controls FR-6/FR-7: what `session_interrupt`'s Pi branch
/// (`session/commands/lifecycle.rs`) calls for the whole Stop sequence.
pub(crate) use controls::run_stop_sequence;
pub(crate) use dispatcher::connect;
/// pi-models-metrics §5: `francois:runtime:models` / the Pi branches of
/// `session_create`/`session_switch_model` reach these through
/// `adapter::pi::models::*` — see that module's own doc.
pub(crate) use models::{evict_catalog, resolve_and_validate_pair, runtime_models};
pub(crate) use persistence::PiResumeRecord;
/// pi-migration-rollout FR-3: `session_create`'s Pi branch resolves the
/// launch-prompt snapshot exactly once, here — the SAME `PiLaunchPrompt`
/// type rides `Session.pi_launch_prompt`/`RuntimeConnectContext.
/// pi_launch_prompt` from then on. See `profile_args`'s module doc.
pub(crate) use profile_args::{resolve_launch_prompt, PiLaunchPrompt};
/// pi-migration-rollout FR-8: `session_create`'s Pi branch calls this before
/// anything else Pi-specific.
pub(crate) use readiness::check as production_readiness_check;
pub(crate) use recovery::{new_from_session, reconnect_session};
/// pi-skills-capabilities §5: the policy type + its `session::skills`/
/// `session::slash` Pi-routing helpers reach these through
/// `adapter::pi::*` — see `resources`'s own doc.
pub(crate) use resources::{skill_name_from_invocation, RuntimeResourcePolicy};
/// Test-only: `RuntimeResourcePolicy`'s two member enums are only ever
/// CONSTRUCTED directly outside this module in test code (production code
/// only ever copies an existing policy via `..p`, or passes one through
/// opaquely) — gated so the plain lib build carries no unused re-export.
#[cfg(test)]
pub(crate) use resources::{ExtensionsPolicy, ProjectResources};

// `pub`, not `pub(crate)`: `runtime_installation` is a Tauri command main.rs's
// `generate_handler!` table names as `session::runtime_installation`, and
// main.rs is an external crate relative to this lib (core-architecture-wave3
// FR-2) — the same reason every other command re-export chain here ends in
// `pub use` rather than `pub(crate) use`.
pub use discovery::{
    __cmd__runtime_installation, __tauri_command_name_runtime_installation, installation_preflight,
    runtime_installation, InstallState, Provenance, RuntimeInstallStatus,
};
