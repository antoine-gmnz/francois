//! FR-79 — where the registry lives and how it survives a bad write.
//!
//! Paths, parsing, the atomic save, and the load-time hydration that re-reads
//! each on-disk manifest. Two rules the rest of the domain leans on: a write
//! that fails ROLLS BACK the in-memory registry so the two can never disagree,
//! and an entry that fails re-validation at load is kept but made inert rather
//! than dropped (§7 #49) — silently losing a plugin is the worse failure.

use super::*;

use std::path::{Path, PathBuf};
use tauri::Manager;

// ---------- FR-79: persistence ----------

pub(crate) fn plugins_json_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("plugins.json"))
}

pub(crate) fn plugins_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("plugins"))
}

/// FR-27/§6: the KV store sits BESIDE the code directory, not inside it, so an
/// update swap (which replaces the directory wholesale) cannot clobber it.
pub(crate) fn storage_path(app: &tauri::AppHandle, plugin_id: &str) -> Option<PathBuf> {
    plugins_dir(app).map(|d| d.join(format!("{plugin_id}.storage.json")))
}

pub(crate) fn staging_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    plugins_dir(app).map(|d| d.join(".staging"))
}

/// FR-79: `Err(())` means UNPARSEABLE and the caller renames the file to
/// `plugins.json.bak`. A missing file is not unparseable — it is an empty
/// registry, and a first run must not produce a spurious backup notice.
pub(crate) fn parse_registry(bytes: &[u8]) -> Result<Vec<PluginEntry>, ()> {
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(Vec::new());
    }
    let Ok(doc) = serde_json::from_slice::<Value>(bytes) else {
        return Err(());
    };
    let Some(list) = doc.get("plugins").and_then(|v| v.as_array()) else {
        return Err(());
    };
    // One undeserializable ENTRY is skipped rather than resetting the registry —
    // losing every plugin because one row is malformed is the worse failure.
    Ok(list
        .iter()
        .filter_map(|e| serde_json::from_value::<PluginEntry>(e.clone()).ok())
        .collect())
}

pub(crate) fn save_to(path: &Path, entries: &[PluginEntry]) -> Result<(), String> {
    let doc = serde_json::json!({ "version": 1, "plugins": entries });
    crate::permissions::write_json_atomic(path, &doc)
}

/// FR-69: re-read the on-disk manifest so `consentPending` reflects the CODE, not
/// the registry's memory of it. Never executes anything — this is a file read.
pub(crate) fn read_disk_manifest(install_path: &str) -> Option<PluginManifest> {
    let bytes = std::fs::read(Path::new(install_path).join(MANIFEST_FILENAME)).ok()?;
    serde_json::from_slice::<PluginManifest>(&bytes).ok()
}

pub(crate) const TAMPERED_MSG: &str = "this registry entry is not trustworthy — reinstall it";
/// FR-82a: the on-disk manifest names a tab url that is not the one consented to.
pub(crate) const TAB_CHANGED_MSG: &str = "this plugin's tab address changed on disk — reinstall it";

/// §7 #49 defense in depth: `plugins.json` is attacker-influenceable, and
/// everything downstream trusts FR-2's charset and FR-1's layout.
/// `{manifest.id}.storage.json` is built from the id, `plugins_uninstall` does
/// `remove_dir_all(install_path)`, and `invoke` reads and EVALUATES
/// `install_path/manifest.entry`. So a hand-edited row must not be able to name
/// an id of `../../x` or an install path outside the plugins directory.
///
/// `expected_dir` is `<app data>/plugins`; `None` when it cannot be resolved, in
/// which case only the manifest is re-checked.
pub(crate) fn entry_is_trustworthy(entry: &PluginEntry, expected_dir: Option<&Path>) -> bool {
    if crate::plugin::install::validate_manifest(&entry.manifest).is_err() {
        return false;
    }
    match expected_dir {
        None => true,
        Some(dir) => Path::new(&entry.install_path) == dir.join(&entry.manifest.id),
    }
}

/// FR-82, on the third path — the one neither install nor update covers.
///
/// `to_view` ships the ON-DISK manifest to the webview so the modal can show
/// what a pending update wants (FR-16). That manifest was read, not validated:
/// install validated the tree that was consented to, and this file may have been
/// edited since (§7 #49 treats the plugin directory as attacker-influenceable).
/// So a hand-edited `contributes.tab.url` of `http://127.0.0.1:4317` would reach
/// the renderer having passed no check at all.
///
/// So the disk tab must clear two bars, and only then is it honoured:
///
/// 1. **FR-82a — it must be byte-for-byte the url the user consented to.** The
///    recorded string is `entry.manifest.contributes.tab.url`: `manifest` is the
///    last CONSENTED manifest (§5.2), it is persisted in `plugins.json`, and the
///    only two places that write it — `plugins_install` and `plugins_update` —
///    are both downstream of the consent gate, so a changed tab url can only be
///    recorded through a consented update (FR-13/FR-14). A host-level check
///    cannot carry FR-81's claim: the consent card names a HOST, and what
///    executes is a PAGE.
/// 2. **FR-82 — it must still validate against the GRANTED capabilities**, not
///    the disk manifest's own, which the same edit could have widened.
///
/// Only the tab is dropped, deliberately: the panel, commands and status item
/// are unaffected, and FR-16 still holds the whole plugin inert if the
/// capabilities themselves moved. A rewritten `plugin.js` gets no equivalent pin
/// because it stays inside the isolate — the tab is the one place where on-disk
/// content becomes an executing origin in the webview.
///
/// Returns true when a tab was dropped, so the caller can say so in `lastError`.
fn strip_untrusted_tab(entry: &mut PluginEntry) -> bool {
    let granted = entry.granted_capabilities.clone();
    let consented = entry
        .manifest
        .contributes
        .tab
        .as_ref()
        .map(|t| t.url.clone());
    let Some(disk) = entry.disk_manifest.as_mut() else {
        return false;
    };
    let refuse = match &disk.contributes.tab {
        None => false,
        // `Some(tab)` against a consented `None` is a tab appearing out of
        // nowhere, which is as much a change as a rewritten one.
        Some(tab) => {
            consented.as_deref() != Some(tab.url.as_str())
                || crate::plugin::webtab::validate_contribution(tab, &granted).is_err()
        }
    };
    if refuse {
        disk.contributes.tab = None;
    }
    refuse
}

/// FR-69: bring a freshly-parsed entry up to date with the filesystem. Split out
/// so tests can drive it against a real temp tree without a Tauri handle.
pub(crate) fn hydrate(entry: &mut PluginEntry, expected_dir: Option<&Path>) {
    // A row that fails re-validation is kept but made INERT with a lastError,
    // rather than dropped: silently losing a plugin is how a user ends up
    // reinstalling one that was tampered with. `consent_pending` also holds it
    // out of every surface (FR-16/FR-23).
    if !entry_is_trustworthy(entry, expected_dir) {
        entry.disk_manifest = None;
        entry.consent_pending = true;
        entry.last_error = Some(PluginRuntimeError {
            at: now_ms(),
            surface: PluginSurface::Panel,
            message: TAMPERED_MSG.to_string(),
        });
        return;
    }
    entry.disk_manifest = read_disk_manifest(&entry.install_path);
    let tab_dropped = strip_untrusted_tab(entry);
    entry.consent_pending = consent_pending(entry);
    // `surface` has no `tab` member (a tab never renders, FR-81), so these two
    // load-time conditions report as `panel` — the pane is where a plugin's
    // errors surface, and MISSING_DIR_MSG already uses it for the same reason.
    let message = match (&entry.disk_manifest, tab_dropped) {
        (None, _) => Some(MISSING_DIR_MSG),
        (Some(_), true) => Some(TAB_CHANGED_MSG),
        (Some(_), false) => None,
    };
    entry.last_error = message.map(|message| PluginRuntimeError {
        at: now_ms(),
        surface: PluginSurface::Panel,
        message: message.to_string(),
    });
}

/// FR-79: persist, and on failure restore `snapshot` so memory and disk always
/// agree. The caller has already mutated `entries` in place.
pub(crate) fn persist_or_rollback(
    app: &tauri::AppHandle,
    entries: &mut Vec<PluginEntry>,
    snapshot: Vec<PluginEntry>,
) -> Result<(), (&'static str, String)> {
    let Some(path) = plugins_json_path(app) else {
        *entries = snapshot;
        return Err((
            E_STORE_WRITE_FAILED,
            "could not resolve the app data directory".to_string(),
        ));
    };
    if let Err(msg) = save_to(&path, entries) {
        *entries = snapshot;
        return Err((E_STORE_WRITE_FAILED, msg));
    }
    Ok(())
}

/// Load the registry at startup (FR-69/FR-79). Returns `true` when an unparseable
/// file was backed up, which the modal surfaces once (§7 #40).
pub(crate) fn load_registry(path: &Path, expected_dir: Option<&Path>) -> (Vec<PluginEntry>, bool) {
    let Ok(bytes) = std::fs::read(path) else {
        return (Vec::new(), false); // missing ⇒ empty, not a reset
    };
    match parse_registry(&bytes) {
        Ok(mut entries) => {
            for e in entries.iter_mut() {
                hydrate(e, expected_dir);
            }
            (entries, false)
        }
        Err(()) => {
            let _ = std::fs::rename(path, path.with_extension("json.bak"));
            (Vec::new(), true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::*;
    #[allow(unused_imports)]
    use serde_json::json;

    // ---------- FR-79: the registry file ----------

    #[test]
    fn the_registry_round_trips_and_never_persists_derived_state() {
        let dir = tmp_dir("registry-roundtrip");
        let path = dir.join("plugins.json");
        let mut e = entry_fixture("acme-ci", &dir.to_string_lossy());
        e.consent_pending = true;
        e.last_error = Some(PluginRuntimeError {
            at: 5,
            surface: PluginSurface::Panel,
            message: "boom".into(),
        });
        save_to(&path, std::slice::from_ref(&e)).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("consentPending"),
            "§6: recomputed at load:\n{raw}"
        );
        assert!(
            !raw.contains("lastError"),
            "§6: a fresh run starts clean:\n{raw}"
        );

        let (loaded, reset) = load_registry(&path, None);
        assert!(!reset);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].manifest.id, "acme-ci");
        assert!(
            loaded[0].last_error.is_some(),
            "no manifest on disk at that path"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_registry_is_empty_and_is_not_a_reset() {
        // A first run must not show `the plugin registry was reset`.
        let dir = tmp_dir("registry-missing");
        let (entries, reset) = load_registry(&dir.join("nope.json"), None);
        assert!(entries.is_empty() && !reset);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unparseable_registry_is_backed_up_and_replaced_with_an_empty_one() {
        // §7 #40 / FR-79.
        let dir = tmp_dir("registry-corrupt");
        let path = dir.join("plugins.json");
        std::fs::write(&path, b"{ not json").unwrap();

        let (entries, reset) = load_registry(&path, None);
        assert!(entries.is_empty());
        assert!(reset, "the modal surfaces this once");
        assert!(dir.join("plugins.json.bak").exists(), "the backup is kept");

        // shapes that are valid JSON but not OURS are also a reset
        assert!(parse_registry(b"[]").is_err());
        assert!(parse_registry(br#"{"version":1}"#).is_err());
        // ...but whitespace/empty is simply empty
        assert_eq!(parse_registry(b"").unwrap().len(), 0);
        assert_eq!(parse_registry(b"  \n ").unwrap().len(), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_undeserializable_entry_is_skipped_rather_than_resetting_the_registry() {
        let doc = json!({
            "version": 1,
            "plugins": [
                serde_json::to_value(entry_fixture("keep-me", "/tmp/a")).unwrap(),
                { "id": "not an entry" },
                "not even an object",
            ]
        });
        let loaded = parse_registry(doc.to_string().as_bytes()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].manifest.id, "keep-me");
    }

    #[test]
    fn hydrate_reads_the_manifest_from_disk_and_flags_a_missing_tree() {
        // FR-69: the load path reads files; it never runs plugin code.
        let dir = tmp_dir("hydrate");
        let install = dir.join("acme-ci");
        write_plugin_tree(&install, "acme-ci", "export default {}");

        let mut e = entry_fixture("acme-ci", &install.to_string_lossy());
        hydrate(&mut e, None);
        assert!(e.disk_manifest.is_some());
        assert!(!e.consent_pending);
        assert_eq!(e.last_error, None);

        // widen the manifest on disk behind the registry's back (§7 #49)
        let mut widened = manifest_fixture("acme-ci");
        widened.capabilities = caps(true, true, &["evil.dev"]);
        std::fs::write(
            install.join(MANIFEST_FILENAME),
            serde_json::to_vec(&widened).unwrap(),
        )
        .unwrap();
        hydrate(&mut e, None);
        assert!(e.consent_pending, "FR-16: frozen until re-consent");

        // §7 #39: the tree disappears entirely
        std::fs::remove_dir_all(&install).unwrap();
        hydrate(&mut e, None);
        assert!(e.disk_manifest.is_none());
        assert!(!e.consent_pending);
        assert_eq!(e.last_error.unwrap().message, MISSING_DIR_MSG);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_webview_projection_shows_the_disk_manifest_beside_the_granted_set() {
        // FR-16: the modal must be able to say what the update WANTS while the
        // granted set is what is actually in force.
        let mut e = entry_fixture("acme-ci", "/tmp/x");
        e.granted_capabilities = caps(true, false, &[]);
        e.disk_manifest = Some(manifest_with_caps(
            "acme-ci",
            caps(true, true, &["evil.dev"]),
        ));
        e.consent_pending = true;

        let view = to_view(&e);
        assert!(
            view.manifest.capabilities.drive_sessions(),
            "what disk wants"
        );
        assert!(
            !view.granted_capabilities.drive_sessions(),
            "what is in force"
        );
        assert!(view.consent_pending);

        // with no readable manifest the LAST CONSENTED one is shown
        e.disk_manifest = None;
        assert!(!to_view(&e).manifest.capabilities.drive_sessions());
    }

    #[test]
    fn the_view_carries_the_refresh_interval_already_clamped() {
        // FR-70: the band is a CORE guarantee. Shipping the raw value would put
        // it entirely on whichever timer happens to read it.
        let mut e = entry_fixture("acme-ci", "/tmp/plugins/acme-ci");
        e.disk_manifest.as_mut().unwrap().refresh_interval_ms = Some(1);
        assert_eq!(
            to_view(&e).manifest.refresh_interval_ms,
            Some(REFRESH_INTERVAL_MIN_MS)
        );
        e.disk_manifest.as_mut().unwrap().refresh_interval_ms = Some(u64::MAX);
        assert_eq!(
            to_view(&e).manifest.refresh_interval_ms,
            Some(REFRESH_INTERVAL_MAX_MS)
        );
        e.disk_manifest.as_mut().unwrap().refresh_interval_ms = None;
        assert_eq!(to_view(&e).manifest.refresh_interval_ms, None);
    }

    // ---------- §7 #49: the registry file is attacker-influenceable ----------

    #[test]
    fn a_registry_row_is_re_validated_on_load() {
        // `plugins.json` is a file on disk that nothing signs. Everything
        // downstream trusts FR-2's charset: `{id}.storage.json` is built from
        // the id, uninstall does `remove_dir_all(installPath)`, and `invoke`
        // READS AND EVALUATES `installPath/entry`.
        let dir = tmp_dir("registry-tamper");
        let plugins = dir.join("plugins");
        let ok_path = plugins.join("acme-ci");

        let good = entry_fixture("acme-ci", &ok_path.to_string_lossy());
        assert!(entry_is_trustworthy(&good, Some(&plugins)));

        // an id that escapes its own directory
        let mut bad_id = good.clone();
        bad_id.manifest.id = "../evil".into();
        assert!(!entry_is_trustworthy(&bad_id, Some(&plugins)));

        // an install path pointing anywhere it likes
        let mut elsewhere = good.clone();
        elsewhere.install_path = "/etc".into();
        assert!(!entry_is_trustworthy(&elsewhere, Some(&plugins)));

        // an entry file outside the tree
        let mut escaping_entry = good.clone();
        escaping_entry.manifest.entry = "../../../etc/passwd.js".into();
        assert!(!entry_is_trustworthy(&escaping_entry, Some(&plugins)));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_hand_edited_tab_url_never_reaches_the_webview() {
        // FR-82 on the load path. `to_view` ships the ON-DISK manifest (FR-16),
        // which install validated and nothing has validated since — so this is
        // the one way a tab could be repointed after consent without passing a
        // single check. The frontend re-validates too (FR-85), but it only sees
        // what the core hands it, and the core must not hand it this.
        let dir = tmp_dir("tab-repoint");
        let plugins = dir.join("plugins");
        let install = plugins.join("acme-ci");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("plugin.js"), "export default {}").unwrap();

        let mut e = entry_fixture("acme-ci", &install.to_string_lossy());
        e.manifest = manifest_with_tab("acme-ci", "https://dash.acme.dev/ci", "dash.acme.dev");
        e.granted_capabilities = e.manifest.capabilities.clone();

        let write_disk = |m: &PluginManifest| {
            std::fs::write(
                install.join(MANIFEST_FILENAME),
                serde_json::to_vec(m).unwrap(),
            )
            .unwrap();
        };

        // the consented tab survives untouched
        write_disk(&e.manifest);
        hydrate(&mut e, Some(&plugins));
        let tab = e.disk_manifest.as_ref().unwrap().contributes.tab.as_ref();
        assert_eq!(tab.unwrap().url, "https://dash.acme.dev/ci");

        // …every repoint the core would have refused at install is dropped here
        for url in [
            "http://127.0.0.1:4317/",              // FR-82: loopback is not exempt
            "https://evil.example/x",              // off the granted allowlist
            "data:text/html,<script>x()</script>", // supplying the document itself
        ] {
            let mut tampered = e.manifest.clone();
            tampered.contributes.tab.as_mut().unwrap().url = url.into();
            write_disk(&tampered);
            hydrate(&mut e, Some(&plugins));
            assert!(
                e.disk_manifest.as_ref().unwrap().contributes.tab.is_none(),
                "{url} must not reach the webview"
            );
            // …and only the tab is dropped: the rest of the plugin still works.
            assert!(e
                .disk_manifest
                .as_ref()
                .unwrap()
                .contributes
                .panel
                .is_some());
        }

        // A tab checked against the DISK manifest's own capabilities would pass
        // here, because the same edit widened them. It is checked against the
        // GRANTED set instead, so it does not.
        let mut widened = e.manifest.clone();
        widened.contributes.tab.as_mut().unwrap().url = "https://evil.example/x".into();
        widened.capabilities = with_web_tab(caps(false, false, &["evil.example"]), true);
        write_disk(&widened);
        hydrate(&mut e, Some(&plugins));
        assert!(e.disk_manifest.as_ref().unwrap().contributes.tab.is_none());
        assert!(e.consent_pending, "FR-16 catches the capability edit too");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_tab_url_is_pinned_to_the_string_that_was_consented_to() {
        // FR-82a. A host check cannot carry FR-81's claim that the url is fixed
        // at the moment of consent: the card names a HOST and what executes is a
        // PAGE. Every url below is `https:` and on the granted allowlist — they
        // all pass FR-82 — and every one of them is still a page the user never
        // agreed to open.
        let dir = tmp_dir("tab-pin");
        let plugins = dir.join("plugins");
        let install = plugins.join("acme-ci");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("plugin.js"), "export default {}").unwrap();

        let mut e = entry_fixture("acme-ci", &install.to_string_lossy());
        e.manifest = manifest_with_tab("acme-ci", "https://dash.acme.dev/ci", "*.acme.dev");
        e.granted_capabilities = e.manifest.capabilities.clone();
        let write_disk = |m: &PluginManifest| {
            std::fs::write(
                install.join(MANIFEST_FILENAME),
                serde_json::to_vec(m).unwrap(),
            )
            .unwrap();
        };
        let tab_of = |e: &PluginEntry| {
            e.disk_manifest
                .as_ref()
                .unwrap()
                .contributes
                .tab
                .as_ref()
                .map(|t| t.url.clone())
        };

        // the consented string, byte for byte, survives
        write_disk(&e.manifest);
        hydrate(&mut e, Some(&plugins));
        assert_eq!(tab_of(&e).as_deref(), Some("https://dash.acme.dev/ci"));
        assert_eq!(e.last_error, None);

        for url in [
            "https://dash.acme.dev/admin",   // another path, same host
            "https://dash.acme.dev/ci?x=1",  // a query the consent never saw
            "https://other.acme.dev/ci",     // another host INSIDE the wildcard
            "https://dash.acme.dev/ci/",     // one trailing slash
            "https://dash.acme.dev:8443/ci", // another port on the same host
            "https://DASH.acme.dev/ci",      // not even case-normalized
        ] {
            let mut moved = e.manifest.clone();
            moved.contributes.tab.as_mut().unwrap().url = url.into();
            write_disk(&moved);
            hydrate(&mut e, Some(&plugins));
            assert_eq!(tab_of(&e), None, "{url} is not what was consented to");
            assert_eq!(
                e.last_error.as_ref().unwrap().message,
                TAB_CHANGED_MSG,
                "the user is told, rather than the tab quietly vanishing"
            );
            assert!(
                !e.consent_pending,
                "the capabilities did not move — only the tab is dropped, and the \
                 plugin's other surfaces keep working"
            );
        }

        // A tab appearing where the consented manifest declared none is a change
        // too — there is no url to have agreed to.
        let mut e2 = entry_fixture("acme-ci", &install.to_string_lossy());
        e2.granted_capabilities = with_web_tab(caps(false, false, &["dash.acme.dev"]), true);
        write_disk(&manifest_with_tab(
            "acme-ci",
            "https://dash.acme.dev/ci",
            "dash.acme.dev",
        ));
        hydrate(&mut e2, Some(&plugins));
        assert_eq!(tab_of(&e2), None);
        assert_eq!(e2.last_error.unwrap().message, TAB_CHANGED_MSG);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_untrustworthy_row_is_kept_but_inert() {
        // Dropping it silently is how a user ends up reinstalling a plugin that
        // was tampered with, having never been told. It stays visible, carries
        // the reason, and runs nothing (FR-16/FR-23).
        let dir = tmp_dir("registry-inert");
        let plugins = dir.join("plugins");
        let install = plugins.join("acme-ci");
        write_plugin_tree(&install, "acme-ci", "export default {}");

        let mut e = entry_fixture("acme-ci", &install.to_string_lossy());
        hydrate(&mut e, Some(&plugins));
        assert!(!e.consent_pending, "the honest row still loads");
        assert_eq!(e.last_error, None);

        // now repoint it out of the plugins directory
        e.install_path = dir.join("elsewhere").to_string_lossy().into_owned();
        hydrate(&mut e, Some(&plugins));
        assert!(e.consent_pending, "inert: is_active refuses it");
        assert_eq!(e.last_error.as_ref().unwrap().message, TAMPERED_MSG);
        assert!(!is_active(&e, None) && !is_active(&e, Some("p1")));

        std::fs::remove_dir_all(&dir).ok();
    }
}
