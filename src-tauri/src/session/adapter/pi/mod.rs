//! session/adapter/pi/ — everything Pi-specific that is NOT the (still-stub)
//! RPC transport: `PiAdapter` in the parent module stays deliberately
//! unavailable until a future feature wires the real connection.
//!
//! `discovery` is pi-runtime-distribution's whole surface (specs/
//! pi-runtime-distribution.md): is a compatible external Pi installation on
//! this machine, independent of whether any session ever tries to connect to
//! one. A child module rather than folded into the parent — same "one concern
//! per child" shape the rest of this domain follows — because it owns its own
//! certification manifest/fixtures and has no reason to see `PiAdapter`'s
//! (future) connection state.

mod discovery;
/// FR-1/FR-2/FR-8: the bounded spawn + native/WSL resolution `discovery`
/// builds a verdict from. Split out purely for CLAUDE.md's ~1000-line file
/// cap — `discovery` is the only caller and the only thing that needs it.
mod probe;

// `pub`, not `pub(crate)`: `runtime_installation` is a Tauri command main.rs's
// `generate_handler!` table names as `session::runtime_installation`, and
// main.rs is an external crate relative to this lib (core-architecture-wave3
// FR-2) — the same reason every other command re-export chain here ends in
// `pub use` rather than `pub(crate) use`.
pub use discovery::{
    __cmd__runtime_installation, __tauri_command_name_runtime_installation, runtime_installation,
    InstallState, Provenance, RuntimeInstallStatus,
};
