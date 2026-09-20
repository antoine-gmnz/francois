//! pr-142 §9 — the `profiles ↔ project` inversion.
//!
//! A project default naming a deleted profile has to stop naming it (FR-7),
//! and `profiles_remove` used to say so by calling `project::clear_default_profile`
//! directly. That closed a module cycle: this domain already reads
//! `profiles::known_ids` to reconcile those same defaults at boot, so neither
//! side could be reasoned about — or compiled — without the other.
//!
//! The inversion is the ordinary one, and the third instance of it in this
//! crate (`session::SessionTeardown`, `account::AccountRemovalObserver`):
//! `profiles` declares what has to happen and knows nothing about who does it;
//! this domain — which owns the affected state and already depends on
//! `profiles` — implements it; the crate root wires the two together at
//! startup.

use tauri::AppHandle;

/// The `profiles` → `project` notification, landing on the sweep that has
/// always done the work. `clear_default_profile` is unchanged — only who
/// reaches it is.
pub struct ProjectProfileObserver;

impl crate::profiles::ProfileRemovalObserver for ProjectProfileObserver {
    fn profile_removed(&self, app: &AppHandle, profile_id: &str) {
        super::clear_default_profile(app, profile_id);
    }
}
