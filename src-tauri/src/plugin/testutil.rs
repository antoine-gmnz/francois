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
        web_tab: None,
    }
}

/// `caps(...)` with FR-81's fourth flag set or cleared, for the widening tests.
pub(crate) fn with_web_tab(caps: PluginCapabilities, on: bool) -> PluginCapabilities {
    PluginCapabilities {
        web_tab: on.then_some(true),
        ..caps
    }
}

/// FR-81: the smallest manifest that contributes a framed tab — `webTab`
/// granted and the tab's host inside the network allowlist.
pub(crate) fn manifest_with_tab(id: &str, url: &str, host: &str) -> PluginManifest {
    let mut m = manifest_fixture(id);
    m.contributes.tab = Some(PluginTabContribution {
        title: "COHORTE".into(),
        url: url.into(),
        glyph: None,
    });
    m.capabilities = PluginCapabilities {
        network: Some(PluginNetwork {
            hosts: vec![host.to_string()],
        }),
        web_tab: Some(true),
        ..Default::default()
    };
    m
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

// ---------- shared isolate fixtures (FR-17..FR-24) ----------
//
// `run` is exercised from two modules now (isolate/mod.rs for the engine
// contract, isolate/limits.rs for the budgets), so the fake host and the two
// one-line drivers live here rather than in whichever of them happened to need
// them first.

pub(crate) mod iso {
    use super::*;
    use crate::plugin::isolate::{run, Handler, Host, Invocation};
    use serde_json::json;
    use std::sync::{Arc, Mutex as StdMutex};

    /// A host that records what it was asked and answers from a fixed table.
    pub(crate) struct FakeHost {
        pub answers: std::collections::HashMap<String, Value>,
        pub calls: StdMutex<Vec<(String, Vec<Value>)>>,
        /// Milliseconds each call blocks for, to exercise the FR-20 pause.
        pub delay_ms: u64,
    }

    impl FakeHost {
        pub(crate) fn new(answers: &[(&str, Value)]) -> Arc<Self> {
            Arc::new(FakeHost {
                answers: answers
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.clone()))
                    .collect(),
                calls: StdMutex::new(Vec::new()),
                delay_ms: 0,
            })
        }

        /// The same table, but every call blocks — the only way to tell a slow
        /// host from a runaway loop (FR-20).
        pub(crate) fn slow(answers: &[(&str, Value)], delay_ms: u64) -> Arc<Self> {
            Arc::new(FakeHost {
                answers: answers
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.clone()))
                    .collect(),
                calls: StdMutex::new(Vec::new()),
                delay_ms,
            })
        }
    }

    impl Host for FakeHost {
        fn call(&self, method: &str, args: &[Value]) -> Result<Value, String> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), args.to_vec()));
            if self.delay_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(self.delay_ms));
            }
            match self.answers.get(method) {
                Some(v) => Ok(v.clone()),
                None => Err(format!("no such host method: {method}")),
            }
        }
    }

    /// Run `source`'s `panel()` under `caps` and return its raw value.
    pub(crate) fn run_isolate(
        source: &str,
        caps: PluginCapabilities,
        host: Arc<dyn Host>,
    ) -> Result<Value, String> {
        run(
            &Invocation {
                plugin_id: "acme-ci".into(),
                plugin_version: "1.0.0".into(),
                entry_source: source.into(),
                handler: Handler::Panel,
                context: json!({ "surface": "panel", "projectId": null, "sessionId": null, "now": 1 }),
                settings: Map::new(),
                capabilities: caps,
            },
            host,
        )
        .map(|o| o.value)
    }

    /// The common case: no capabilities, no host answers.
    pub(crate) fn run_panel(source: &str) -> Result<Value, String> {
        run_isolate(source, PluginCapabilities::default(), FakeHost::new(&[]))
    }
}
