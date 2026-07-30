// Shared process-spawn helpers. `no_window` was duplicated verbatim in wsl.rs,
// diff/git.rs, and session/mod.rs — this is the single copy those first two now
// import (session/mod.rs keeps its own for now; see the refactor follow-up note).

use std::process::Command;

#[cfg(windows)]
pub(crate) fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash
}
#[cfg(not(windows))]
pub(crate) fn no_window(_cmd: &mut Command) {}
