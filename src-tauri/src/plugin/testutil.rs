//! Shared fixtures for the plugin module's unit tests.
//!
//! Every fixture here is deliberately MINIMAL-but-valid: a test that wants to
//! exercise a rejection mutates one field of a fixture, so the fixture itself
//! must never be the reason something fails.

use super::*;

use std::path::PathBuf;

/// A throwaway directory that really exists on disk. install.rs, registry.rs and
/// secrets.rs all touch the filesystem for real — a temp dir is the only honest
/// way to test an atomic rename or a `0600` mode.
pub(crate) fn tmp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "francois-plug-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The smallest manifest that passes `install::validate_manifest`: one panel, one
/// command, no capabilities, no configuration.
pub(crate) fn manifest_fixture(id: &str) -> PluginManifest {
    PluginManifest {
        manifest_version: 1,
        id: id.into(),
        name: "Acme CI".into(),
        version: "1.2.0".into(),
        description: "CI runs at a glance".into(),
        author: Some("Acme".into()),
        entry: "plugin.js".into(),
        contributes: PluginContributes {
            commands: Some(vec![PluginCommandContribution {
                id: "open-run".into(),
                title: "Open run".into(),
                glyph: None,
                palette: None,
            }]),
            panel: Some(PluginPanelContribution { title: "CI".into() }),
            status_bar: None,
            tab: None,
        },
        configuration: None,
        capabilities: PluginCapabilities::default(),
        refresh_interval_ms: None,
    }
}

/// `manifest_fixture` with the capability set replaced — the shape most
/// consent/gating tests need.
pub(crate) fn manifest_with_caps(id: &str, caps: PluginCapabilities) -> PluginManifest {
    PluginManifest {
        capabilities: caps,
        ..manifest_fixture(id)
    }
}

/// The three capability flags as a set, for the FR-13 widening tests.
pub(crate) fn caps(read_state: bool, drive: bool, hosts: &[&str]) -> PluginCapabilities {
    PluginCapabilities {
        read_state: read_state.then_some(true),
        drive_sessions: drive.then_some(true),
        network: (!hosts.is_empty()).then(|| PluginNetwork {
            hosts: hosts.iter().map(|h| (*h).to_string()).collect(),
        }),
    }
}

/// A registry entry pinned to `install_path`, granted exactly what its manifest
/// declares (the post-consent steady state — FR-9).
pub(crate) fn entry_fixture(id: &str, install_path: &str) -> PluginEntry {
    let manifest = manifest_fixture(id);
    PluginEntry {
        granted_capabilities: manifest.capabilities.clone(),
        disk_manifest: Some(manifest.clone()),
        manifest,
        source: PluginSource {
            kind: PluginSourceKind::Github,
            spec: format!("acme/{id}"),
        },
        resolved_ref: "8f2c1a9".repeat(4) + "8f2c1a9d",
        install_path: install_path.into(),
        installed_at: 1_000,
        updated_at: 1_000,
        enablement: PluginEnablement::Off,
        settings: Map::new(),
        consent_pending: false,
        last_error: None,
    }
}

/// Write a plugin tree (manifest + entry file) into `dir` and return the manifest.
pub(crate) fn write_plugin_tree(dir: &std::path::Path, id: &str, source: &str) -> PluginManifest {
    let manifest = manifest_fixture(id);
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(
        dir.join(MANIFEST_FILENAME),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(dir.join(&manifest.entry), source).unwrap();
    manifest
}
