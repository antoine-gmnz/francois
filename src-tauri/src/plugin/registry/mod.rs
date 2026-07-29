//! FR-16 / FR-61..FR-80 — `plugins.json`, consent state, enablement, settings.
//!
//! Everything here is a pure function of `(entries, inputs)` except the four
//! path/IO helpers at the bottom, so the whole decision surface is testable
//! without a Tauri `AppHandle` (the crate does not enable tauri's `test`
//! feature, so handler-level tests are not available — the same split
//! `project/registry.rs` uses).
//!
//! The load path never executes plugin code (FR-69). It reads the registry,
//! re-reads each on-disk manifest, and compares the two capability sets. That
//! comparison is the entire consent model: what the user agreed to lives in the
//! registry, what the code now wants lives on disk, and any gap freezes the
//! plugin until a human closes it.

use super::*;

use std::collections::HashSet;

/// FR-16: the message a registry entry carries when its tree vanished (§7 #39).
pub(crate) const MISSING_DIR_MSG: &str = "install directory missing";

mod settings;
mod store;

pub(crate) use settings::*;
pub(crate) use store::*;

// ---------- FR-13/FR-16: capability comparison ----------

/// FR-13: hosts compare after lowercasing and stripping a trailing dot. Storage
/// stays VERBATIM (FR-11 shows the consent card the manifest's own spelling) —
/// only the comparison normalizes.
fn norm_host(h: &str) -> String {
    h.trim_end_matches('.').to_ascii_lowercase()
}

/// What `new` asks for beyond `granted`: the flags, then the hosts.
///
/// Hosts are reported VERBATIM from `new` (not normalized) because the consent
/// card highlights them with a `+` and must show the manifest's own spelling.
pub(crate) fn capability_diff(
    granted: &PluginCapabilities,
    new: &PluginCapabilities,
) -> (Vec<String>, Vec<String>) {
    let mut flags = Vec::new();
    if new.read_state() && !granted.read_state() {
        flags.push("readState".to_string());
    }
    if new.drive_sessions() && !granted.drive_sessions() {
        flags.push("driveSessions".to_string());
    }
    if new.has_network() && !granted.has_network() {
        flags.push("network".to_string());
    }
    // FR-81: LAST, matching PLUGIN_CAPABILITY_KEYS and §8 · H36 — the consent
    // card sorts `webTab` after `network` because it is the strongest grant on
    // it. Without this line an update that adds `webTab` would not read as
    // widening at all, and FR-14's consent gate would never fire for the one
    // capability that puts a page's own code next to the app.
    if new.web_tab() && !granted.web_tab() {
        flags.push("webTab".to_string());
    }
    let have: HashSet<String> = granted.hosts().iter().map(|h| norm_host(h)).collect();
    let mut seen = HashSet::new();
    let hosts = new
        .hosts()
        .iter()
        .filter(|h| !have.contains(&norm_host(h)) && seen.insert(norm_host(h)))
        .cloned()
        .collect();
    (flags, hosts)
}

/// FR-13: an update is widening when it wants ANY flag or ANY host the granted
/// set does not already carry. Narrowing and reordering are not widening.
pub(crate) fn is_widening(granted: &PluginCapabilities, new: &PluginCapabilities) -> bool {
    let (flags, hosts) = capability_diff(granted, new);
    !flags.is_empty() || !hosts.is_empty()
}

/// FR-16: `consentPending` is exactly "the on-disk manifest wants more than was
/// granted". A missing on-disk manifest is NOT pending — the entry is inert for a
/// different reason (§7 #39) and offering "review permissions" there would be a
/// dead end.
pub(crate) fn consent_pending(entry: &PluginEntry) -> bool {
    match &entry.disk_manifest {
        Some(disk) => is_widening(&entry.granted_capabilities, &disk.capabilities),
        None => false,
    }
}

// ---------- FR-76: enablement ----------

/// FR-76. `scope` is the sidebar's project filter: `Some(id)` for one project,
/// `None` for *All projects*.
///
/// Under *All projects* a `projects`-scoped plugin is active when its set is
/// non-empty — the union reading, so a plugin enabled somewhere is visible in the
/// view that shows everywhere. An EMPTY set behaves as `off` in both scopes (FR-77).
pub(crate) fn is_active(entry: &PluginEntry, scope: Option<&str>) -> bool {
    if entry.consent_pending {
        return false; // FR-16: inert until re-consent, whatever the enablement says
    }
    match &entry.enablement {
        PluginEnablement::Off => false,
        PluginEnablement::All => true,
        PluginEnablement::Projects { project_ids } => match scope {
            Some(id) => project_ids.iter().any(|p| p == id),
            None => !project_ids.is_empty(),
        },
    }
}

/// FR-77/FR-78: drop ids that no longer resolve to a registry project. Returns
/// true when anything changed, so the caller only persists on a real edit.
pub(crate) fn prune_project_ids(entries: &mut [PluginEntry], known: &HashSet<String>) -> bool {
    let mut changed = false;
    for entry in entries.iter_mut() {
        if let PluginEnablement::Projects { project_ids } = &mut entry.enablement {
            let before = project_ids.len();
            project_ids.retain(|id| known.contains(id));
            changed |= project_ids.len() != before;
        }
    }
    changed
}

// ---------- the webview projection ----------

/// FR-64/FR-16. The manifest sent up is the ON-DISK one when it is readable, so
/// the modal can show what a pending update wants; the granted set alongside it
/// is what is actually in force.
pub(crate) fn to_view(entry: &PluginEntry) -> InstalledPlugin {
    let mut manifest = entry
        .disk_manifest
        .clone()
        .unwrap_or_else(|| entry.manifest.clone());
    // FR-70: the poll interval crosses to the webview ALREADY clamped, so the
    // band is a core guarantee rather than something the timer that happens to
    // read it remembers to apply.
    manifest.refresh_interval_ms = crate::plugin::install::refresh_interval(&manifest);
    InstalledPlugin {
        manifest,
        source: entry.source.clone(),
        resolved_ref: entry.resolved_ref.clone(),
        install_path: entry.install_path.clone(),
        installed_at: entry.installed_at,
        updated_at: entry.updated_at,
        enablement: entry.enablement.clone(),
        granted_capabilities: entry.granted_capabilities.clone(),
        consent_pending: entry.consent_pending,
        settings: settings_view(entry),
        last_error: entry.last_error.clone(),
    }
}

pub(crate) fn snapshot(entries: &[PluginEntry]) -> Vec<InstalledPlugin> {
    entries.iter().map(to_view).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::*;
    #[allow(unused_imports)]
    use serde_json::json;

    // ---------- FR-13: widening ----------

    #[test]
    fn adding_a_flag_or_a_host_is_widening_and_removing_one_is_not() {
        let granted = caps(true, false, &["api.github.com"]);

        assert!(!is_widening(&granted, &granted), "identical");
        assert!(
            !is_widening(&granted, &caps(false, false, &[])),
            "FR-14: narrowing is applied silently"
        );
        assert!(
            !is_widening(&granted, &caps(true, false, &["API.GitHub.com."])),
            "FR-13: hosts compare case-insensitively, trailing dot stripped"
        );

        assert!(
            is_widening(&granted, &caps(true, true, &["api.github.com"])),
            "new flag"
        );
        assert!(
            is_widening(
                &granted,
                &caps(true, false, &["api.github.com", "telemetry.acme.dev"])
            ),
            "new host"
        );
        // network appearing where there was none at all
        assert!(is_widening(
            &caps(true, false, &[]),
            &caps(true, false, &["a.dev"])
        ));
    }

    #[test]
    fn the_diff_reports_added_flags_and_hosts_verbatim_for_the_consent_card() {
        // FR-11/FR-13: the card highlights these with a `+`, so they must carry
        // the manifest's own spelling, not a normalized one.
        let (flags, hosts) = capability_diff(
            &caps(false, false, &["api.github.com"]),
            &caps(
                true,
                true,
                &[
                    "API.GitHub.com",
                    "Telemetry.Acme.dev",
                    "telemetry.acme.dev.",
                ],
            ),
        );
        assert_eq!(flags, ["readState", "driveSessions"]);
        assert_eq!(
            hosts,
            ["Telemetry.Acme.dev"],
            "deduped, verbatim, already-granted excluded"
        );

        let (flags, hosts) =
            capability_diff(&caps(true, true, &["a.dev"]), &caps(true, true, &["a.dev"]));
        assert!(flags.is_empty() && hosts.is_empty());
    }

    #[test]
    fn adding_web_tab_in_an_update_is_widening_like_any_other_flag() {
        // FR-13/FR-81: `webTab` is the strongest grant on the card — a framed
        // page RUNS. An update that adds it must be reported and must require
        // `consented: true`, exactly as `driveSessions` does. It is reported
        // LAST (§8 · H36's sort order), after `network`.
        let granted = with_web_tab(caps(false, false, &["dash.acme.dev"]), false);
        let wants = with_web_tab(caps(false, false, &["dash.acme.dev"]), true);

        let (flags, hosts) = capability_diff(&granted, &wants);
        assert_eq!(flags, ["webTab"]);
        assert!(
            hosts.is_empty(),
            "webTab narrows the allowlist, never widens"
        );
        assert!(is_widening(&granted, &wants));

        // …and it sorts after network when both are new.
        let (flags, _) = capability_diff(
            &caps(false, false, &[]),
            &with_web_tab(caps(true, true, &["dash.acme.dev"]), true),
        );
        assert_eq!(flags, ["readState", "driveSessions", "network", "webTab"]);

        // Dropping it is narrowing, applied silently (FR-14).
        assert!(!is_widening(&wants, &granted));
        assert!(!is_widening(&wants, &wants));

        // FR-16: the same rule reached through the on-disk manifest — a plugin
        // that hand-edits `webTab: true` into its own manifest is inert until
        // the human re-consents, and cannot frame anything in the meantime.
        let mut e = entry_fixture("acme-ci", "/tmp/x");
        e.granted_capabilities = granted;
        e.disk_manifest = Some(manifest_with_caps("acme-ci", wants));
        assert!(consent_pending(&e));
    }

    // ---------- FR-16: consentPending ----------

    #[test]
    fn consent_is_pending_exactly_when_the_disk_manifest_wants_more() {
        // §7 #49: a hand-edited manifest freezes the plugin on next load.
        let mut e = entry_fixture("acme-ci", "/tmp/x");
        e.granted_capabilities = caps(true, false, &[]);
        e.disk_manifest = Some(manifest_with_caps("acme-ci", caps(true, false, &[])));
        assert!(!consent_pending(&e));

        e.disk_manifest = Some(manifest_with_caps("acme-ci", caps(true, true, &[])));
        assert!(consent_pending(&e));

        e.disk_manifest = Some(manifest_with_caps("acme-ci", PluginCapabilities::default()));
        assert!(!consent_pending(&e), "narrowing is not pending");

        // §7 #39: a missing tree is inert for a DIFFERENT reason — offering
        // "review permissions" there would be a dead end.
        e.disk_manifest = None;
        assert!(!consent_pending(&e));
    }

    // ---------- FR-76/FR-77: enablement ----------

    #[test]
    fn enablement_resolves_against_the_sidebar_scope() {
        let mut e = entry_fixture("acme-ci", "/tmp/x");

        e.enablement = PluginEnablement::Off;
        assert!(!is_active(&e, Some("p1")) && !is_active(&e, None));

        e.enablement = PluginEnablement::All;
        assert!(is_active(&e, Some("p1")) && is_active(&e, None));

        e.enablement = PluginEnablement::Projects {
            project_ids: vec!["p1".into()],
        };
        assert!(is_active(&e, Some("p1")));
        assert!(!is_active(&e, Some("p2")));
        assert!(is_active(&e, None), "FR-76: the union under *All projects*");

        // FR-77: an emptied set behaves as `off` in BOTH scopes
        e.enablement = PluginEnablement::Projects {
            project_ids: Vec::new(),
        };
        assert!(!is_active(&e, Some("p1")) && !is_active(&e, None));
    }

    #[test]
    fn a_consent_pending_plugin_is_never_active_whatever_its_enablement() {
        // FR-16: renders no panel, publishes no status item, registers no command.
        let mut e = entry_fixture("acme-ci", "/tmp/x");
        e.enablement = PluginEnablement::All;
        e.consent_pending = true;
        assert!(!is_active(&e, Some("p1")) && !is_active(&e, None));
    }

    #[test]
    fn removing_a_project_drops_its_id_from_every_plugin() {
        // FR-78 / §7 #45.
        let mut entries = vec![
            entry_fixture("a", "/tmp/a"),
            entry_fixture("b", "/tmp/b"),
            entry_fixture("c", "/tmp/c"),
        ];
        entries[0].enablement = PluginEnablement::Projects {
            project_ids: vec!["p1".into(), "p2".into()],
        };
        entries[1].enablement = PluginEnablement::Projects {
            project_ids: vec!["p2".into()],
        };
        entries[2].enablement = PluginEnablement::All;

        let known: HashSet<String> = ["p1".to_string()].into_iter().collect();
        assert!(prune_project_ids(&mut entries, &known));
        assert_eq!(
            entries[0].enablement,
            PluginEnablement::Projects {
                project_ids: vec!["p1".into()]
            }
        );
        assert_eq!(
            entries[1].enablement,
            PluginEnablement::Projects {
                project_ids: Vec::new()
            },
            "emptied, which behaves as off"
        );
        assert_eq!(entries[2].enablement, PluginEnablement::All, "untouched");

        // a second prune changes nothing, so the caller does not re-persist
        assert!(!prune_project_ids(&mut entries, &known));
    }
}
