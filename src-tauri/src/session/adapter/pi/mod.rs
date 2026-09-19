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

mod discovery;
mod dispatcher;
/// pi-transcript-events FR-1..FR-9: the pure Pi-transcript-event → generic
/// tool-call/text/notice reducer. A sibling of `protocol` rather than a part
/// of it — same "one concern per child" split, this time content vs.
/// connection/run state. Wired into `dispatcher`'s live reader thread — see
/// its own module doc.
mod normalize;
/// FR-1/FR-2/FR-8: the bounded spawn + native/WSL resolution `discovery`
/// builds a verdict from. Split out purely for CLAUDE.md's ~1000-line file
/// cap — `discovery` is the only caller and the only thing that needs it.
mod probe;
mod process;
/// FR-2/FR-3/FR-4/FR-6: the pure correlation/state-machine core `dispatcher`
/// wraps in a live connection. Split out purely for CLAUDE.md's ~1000-line
/// file cap — see its module doc.
mod protocol;
mod wire;

pub(crate) use dispatcher::connect;

// `pub`, not `pub(crate)`: `runtime_installation` is a Tauri command main.rs's
// `generate_handler!` table names as `session::runtime_installation`, and
// main.rs is an external crate relative to this lib (core-architecture-wave3
// FR-2) — the same reason every other command re-export chain here ends in
// `pub use` rather than `pub(crate) use`.
pub use discovery::{
    __cmd__runtime_installation, __tauri_command_name_runtime_installation, runtime_installation,
    InstallState, Provenance, RuntimeInstallStatus,
};
