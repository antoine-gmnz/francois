//! FR-1..FR-15 — sources, staging, unpack limits, and the update swap.
//!
//! This module runs BEFORE any plugin code exists as far as the isolate is
//! concerned: it turns a string the user typed into a verified tree on disk. Two
//! things it must never do — write outside `<app data>/plugins/` (FR-8), and let
//! an archive decide where its own bytes land (FR-6).
//!
//! Three children, one concern each:
//!   source.rs   — FR-3/FR-4: what the user typed, resolved and fetched
//!   unpack.rs   — FR-6/FR-7/FR-15: bytes onto disk, under limits, and the swap
//!   manifest.rs — FR-1/FR-2/FR-61: what the tree must declare to be installable
//!
//! The unpack path is the sharp edge; `unpack.rs` carries that reasoning.

mod manifest;
mod source;
mod unpack;

use super::*;

#[allow(unused_imports)]
pub(crate) use manifest::*;
#[allow(unused_imports)]
pub(crate) use source::*;
#[allow(unused_imports)]
pub(crate) use unpack::*;

/// §7 #2/#3/#4/#5/#7 — the messages the install field shows verbatim.
pub(crate) const NO_MANIFEST_MSG: &str = "no francois-plugin.json at the repo root";
pub(crate) const NO_GIT_MSG: &str = "git is required to install from github";
pub(crate) const RANGE_MSG: &str = "use an exact version or a dist-tag";
pub(crate) const INTEGRITY_MSG: &str = "package integrity check failed";
pub(crate) const BAD_SPEC_MSG: &str = "not a github repo or npm package";
