// Francois core library. core-architecture-wave3 FR-2: the module tree that
// used to live directly in `main.rs` moved here unchanged — `main.rs` is now a
// thin bin crate over this lib, keeping only `fn main()`, the `.manage()`
// registrations, the `.setup()` hook, and the Tauri command table (which needs
// every command function, and `tauri::generate_handler!`'s two hidden
// companions per command, reachable through `francois::<path>`).
//
// Feature domains live in their own module directories — see each domain's
// `mod.rs` for its own module map (session-engine FR-1's doc comment is the
// template: named re-exports, never a glob, grouped by child module).
//  * shell-terminal — session-keyed registry of real PTYs (shell/).
//  * session-engine — Claude Code session lifecycle + event stream (session/).
//
// The leaves below each domain belong to no domain and depend on nothing, which
// is what lets every domain reach them without an edge anyone chose:
//  * ids — the wall clock and uuid minting (FR-9).
//  * ipc — the Result envelope, `ErrorCode`, `ModelInfo` (FR-4/FR-5/FR-9).
//  * process_util — the spawn facade every child process goes through (FR-7).
//  * fs_util, wsl, window, diagnostics — filesystem, WSL paths, window chrome,
//    the panic log.

pub mod account;
pub mod diagnostics;
pub mod diff;
pub mod dnd;
pub mod editor;
pub mod extensions;
pub(crate) mod fs_util;
pub(crate) mod ids;
pub(crate) mod ipc;
pub mod permissions;
pub(crate) mod process_util;
pub mod profiles;
pub mod project;
pub mod session;
pub mod shell;
pub mod update;
pub mod usage;
pub mod window;
pub(crate) mod wsl;
