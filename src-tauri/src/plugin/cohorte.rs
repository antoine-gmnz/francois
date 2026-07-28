//! The shipped `plugins/cohorte-dashboard` plugin, run through the REAL isolate
//! against a stubbed dashboard.
//!
//! This is the end-to-end proof that the sandbox and the plugin agree: the actual
//! file on disk is evaluated under the actual limits, its host calls are answered
//! with the shapes `dashboard/server/fleet.js` really returns, and the resulting
//! `PanelSpec` is validated by the same `panelspec` the command path uses.
//! Nothing here mocks our own code — only the node server on the other side of
//! the socket, which is a separate process by design.

use super::isolate::{Handler, Host, Invocation};
use super::*;

use serde_json::json;
use std::sync::{Arc, Mutex as StdMutex};

fn plugin_source() -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("plugins")
        .join("cohorte-dashboard")
        .join("plugin.js");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()))
}

fn caps_network() -> PluginCapabilities {
    PluginCapabilities {
        network: Some(PluginNetwork {
            hosts: vec!["127.0.0.1".into()],
        }),
        ..Default::default()
    }
}

/// `/api/fleet` exactly as the running server returns it — an OBJECT with a
/// `projects` key, not a bare array. The first version of this fixture invented
/// the bare-array shape and the tests passed against a fiction; the real server
/// was what caught it.
fn fleet_body() -> String {
    json!({ "projects": [
        {
            "path": "D:\\francois", "exists": true, "name": "Francois",
            "hasProfile": true, "surfaces": 2, "specs": 21,
            "versions": { "installMode": "global", "installedVersion": "1.0.0",
                          "latest": "1.0.0", "freshness": 0 },
            "summary": { "ok": 12, "warn": 1, "bad": 0, "skip": 2 }
        },
        {
            "path": "D:\\api", "exists": true, "name": "api",
            "hasProfile": true, "surfaces": 1, "specs": 4,
            "versions": { "installMode": "local", "installedVersion": "0.9.0",
                          "latest": "1.0.0", "freshness": 3 },
            "summary": { "ok": 8, "warn": 0, "bad": 2, "skip": 0 }
        }
    ] })
    .to_string()
}

/// The legacy bare-array shape the plugin also accepts, so the compatibility
/// branch is exercised rather than merely asserted in a comment.
fn fleet_body_legacy_array() -> String {
    let wrapped: Value = serde_json::from_str(&fleet_body()).unwrap();
    wrapped["projects"].to_string()
}

/// Answers `fetch` from a path→body table and keeps a real key-value store, so
/// `storage` round-trips across invocations the way the file does.
struct DashboardHost {
    bodies: std::collections::HashMap<String, String>,
    store: StdMutex<Map<String, Value>>,
    urls: StdMutex<Vec<String>>,
    /// When set, every fetch fails — the "dashboard not running" case.
    down: bool,
}

impl DashboardHost {
    fn up() -> Arc<Self> {
        let mut bodies = std::collections::HashMap::new();
        bodies.insert("/api/fleet".to_string(), fleet_body());
        bodies.insert(
            "/api/versions".to_string(),
            json!({ "installedVersion": "1.0.0", "latest": "1.0.0", "freshness": 0 }).to_string(),
        );
        bodies.insert(
            "/api/state".to_string(),
            json!({
                "profile": { "name": "Francois", "one_liner": "a desktop terminal",
                             "surfaces": [{ "key": "frontend" }, { "key": "core" }] },
                "specs": [1, 2, 3],
                "summary": { "ok": 12, "warn": 1, "bad": 0, "skip": 2 }
            })
            .to_string(),
        );
        Arc::new(DashboardHost {
            bodies,
            store: StdMutex::new(Map::new()),
            urls: StdMutex::new(Vec::new()),
            down: false,
        })
    }

    fn down() -> Arc<Self> {
        let mut host = DashboardHost::up();
        Arc::get_mut(&mut host).unwrap().down = true;
        host
    }
}

impl Host for DashboardHost {
    fn call(&self, method: &str, args: &[Value]) -> Result<Value, String> {
        match method {
            "fetch" => {
                let url = args
                    .first()
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                self.urls.lock().unwrap().push(url.clone());
                if self.down {
                    return Err("request timed out or the connection failed".into());
                }
                // Everything after the authority, minus the query string.
                let path = url.split("/api/").nth(1).unwrap_or("");
                let key = format!("/api/{}", path.split('?').next().unwrap_or(""));
                match self.bodies.get(&key) {
                    Some(body) => Ok(json!({
                        "status": 200, "ok": true, "headers": {}, "text": body
                    })),
                    None => Ok(json!({
                        "status": 404, "ok": false, "headers": {}, "text": "{}"
                    })),
                }
            }
            "storage.get" => Ok(self
                .store
                .lock()
                .unwrap()
                .get(args.first().and_then(|v| v.as_str()).unwrap_or_default())
                .cloned()
                .unwrap_or(Value::Null)),
            "storage.set" => {
                self.store.lock().unwrap().insert(
                    args.first()
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    args.get(1).cloned().unwrap_or(Value::Null),
                );
                Ok(Value::Null)
            }
            "storage.remove" => {
                self.store
                    .lock()
                    .unwrap()
                    .remove(args.first().and_then(|v| v.as_str()).unwrap_or_default());
                Ok(Value::Null)
            }
            other => Err(format!("unexpected host call: {other}")),
        }
    }
}

fn settings_with_port(port: u32) -> Map<String, Value> {
    let mut s = Map::new();
    s.insert("port".into(), json!(port));
    s.insert("showHealth".into(), json!(true));
    s
}

/// The context shape the command path really builds — a render context for a
/// surface, a `PluginCommandContext` (with `args`) for a command. Getting this
/// wrong is how a command test passes while the real thing does nothing.
fn context_for(handler: &Handler, args: Value) -> Value {
    match handler {
        Handler::Command(id) => json!({
            "surface": "command", "commandId": id, "args": args,
            "projectId": null, "sessionId": null, "now": 1
        }),
        Handler::Panel => json!({
            "surface": "panel", "projectId": null, "sessionId": null, "now": 1
        }),
        Handler::StatusBar => json!({
            "surface": "statusBar", "projectId": null, "sessionId": null, "now": 1
        }),
    }
}

fn run_with(
    handler: Handler,
    host: Arc<dyn Host>,
    settings: Map<String, Value>,
    args: Value,
) -> Result<Value, String> {
    let context = context_for(&handler, args);
    isolate::run(
        &Invocation {
            plugin_id: "cohorte-dashboard".into(),
            plugin_version: "1.0.0".into(),
            entry_source: plugin_source(),
            handler,
            context,
            settings,
            capabilities: caps_network(),
        },
        host,
    )
    .map(|o| o.value)
}

fn run_handler(handler: Handler, host: Arc<dyn Host>) -> Result<Value, String> {
    run_with(handler, host, settings_with_port(4317), json!({}))
}

/// Invoke a command with the args a PanelSpec `action` would have carried.
fn run_command(id: &str, host: Arc<dyn Host>, args: Value) -> Result<Value, String> {
    run_with(
        Handler::Command(id.to_string()),
        host,
        settings_with_port(4317),
        args,
    )
}

/// Every `text`/`badge`/`action` string in the tree, so assertions can be about
/// what the user SEES rather than about tree shape.
fn strings(node: &PanelNode, out: &mut Vec<String>) {
    match node {
        PanelNode::Text { value, .. } | PanelNode::Badge { value, .. } => out.push(value.clone()),
        PanelNode::Action { label, .. } => out.push(label.clone()),
        PanelNode::Row { children, .. } | PanelNode::Stack { children, .. } => {
            children.iter().for_each(|c| strings(c, out))
        }
        PanelNode::List { items, .. } => items.iter().for_each(|c| strings(c, out)),
        _ => {}
    }
}

fn seen(spec: &PanelSpec) -> Vec<String> {
    let mut out = Vec::new();
    spec.nodes.iter().for_each(|n| strings(n, &mut out));
    out
}

fn collect_actions(node: &PanelNode, out: &mut Vec<(String, Option<Map<String, Value>>)>) {
    match node {
        PanelNode::Action {
            command_id, args, ..
        } => out.push((command_id.clone(), args.clone())),
        PanelNode::Row { children, .. } | PanelNode::Stack { children, .. } => {
            children.iter().for_each(|c| collect_actions(c, out))
        }
        PanelNode::List { items, .. } => items.iter().for_each(|c| collect_actions(c, out)),
        _ => {}
    }
}

#[test]
fn the_manifest_on_disk_is_valid_and_asks_only_for_loopback() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("plugins")
        .join("cohorte-dashboard")
        .join(MANIFEST_FILENAME);
    let bytes = std::fs::read(&path).expect("the manifest must exist");
    let manifest: PluginManifest = serde_json::from_slice(&bytes).expect("valid JSON");
    install::validate_manifest(&manifest).expect("the shipped manifest must pass FR-1");

    assert_eq!(manifest.id, "cohorte-dashboard");
    // The whole security story: ONE capability, one host, no readState and no
    // driveSessions. A reviewer should be able to check that at a glance.
    assert!(!manifest.capabilities.read_state());
    assert!(!manifest.capabilities.drive_sessions());
    assert_eq!(manifest.capabilities.hosts(), ["127.0.0.1"]);
    // FR-70: within the clamp band, so the declared interval is the real one.
    assert_eq!(install::refresh_interval(&manifest), Some(30_000));
}

#[test]
fn the_panel_renders_the_fleet_with_freshness_and_health() {
    let raw = run_handler(Handler::Panel, DashboardHost::up()).unwrap();
    let spec = panelspec::validate_panel(&raw).expect("the core must accept the spec");
    let text = seen(&spec);

    assert!(text.contains(&"Francois".to_string()), "{text:?}");
    assert!(text.contains(&"api".to_string()), "{text:?}");
    // freshness 0 => current, 3 => "3 behind"
    assert!(text.contains(&"current".to_string()), "{text:?}");
    assert!(text.contains(&"3 behind".to_string()), "{text:?}");
    // doctor health as ok/warn/bad
    assert!(text.contains(&"12/1/0".to_string()), "{text:?}");
    assert!(text.contains(&"8/0/2".to_string()), "{text:?}");
    assert!(text.contains(&"21 specs".to_string()), "{text:?}");
}

#[test]
fn both_fleet_response_shapes_render_identically() {
    // The running server answers `{ projects: [...] }`. An earlier build answered
    // a bare array, and the plugin accepts either — which is only worth doing if
    // it is actually true, so both shapes go through the real isolate here.
    let wrapped = run_handler(Handler::Panel, DashboardHost::up()).unwrap();

    let legacy = {
        let mut host = DashboardHost::up();
        Arc::get_mut(&mut host)
            .unwrap()
            .bodies
            .insert("/api/fleet".to_string(), fleet_body_legacy_array());
        run_handler(Handler::Panel, host as Arc<dyn Host>).unwrap()
    };

    let a = seen(&panelspec::validate_panel(&wrapped).unwrap());
    let b = seen(&panelspec::validate_panel(&legacy).unwrap());
    assert_eq!(a, b, "the two shapes must render the same fleet");
    assert!(a.contains(&"Francois".to_string()), "{a:?}");
}

#[test]
fn both_fleet_response_shapes_render_the_same_projects() {
    // The server answers `{ projects: [...] }`. An earlier version of this
    // fixture invented a bare array, and every assertion below still passed
    // because an empty list renders as an empty list — which is why this test
    // compares the two shapes against each other AND asserts the result is
    // non-empty, rather than trusting a count.
    let wrapped = DashboardHost::up();
    let mut legacy = DashboardHost::up();
    Arc::get_mut(&mut legacy)
        .unwrap()
        .bodies
        .insert("/api/fleet".to_string(), fleet_body_legacy_array());

    let from_wrapped =
        seen(&panelspec::validate_panel(&run_handler(Handler::Panel, wrapped).unwrap()).unwrap());
    let from_legacy =
        seen(&panelspec::validate_panel(&run_handler(Handler::Panel, legacy).unwrap()).unwrap());
    assert_eq!(from_wrapped, from_legacy);
    assert!(
        from_wrapped.contains(&"Francois".to_string()),
        "neither shape may render an EMPTY list: {from_wrapped:?}"
    );
}

#[test]
fn the_fleet_list_is_the_panes_keyboard_target_and_each_row_can_be_opened() {
    // FR-40: a selectable list makes ↑/↓/⏎ work, and ⏎ fires the FIRST action
    // inside the selected item — which has to be `open-project`.
    let raw = run_handler(Handler::Panel, DashboardHost::up()).unwrap();
    let spec = panelspec::validate_panel(&raw).unwrap();

    let list = spec
        .nodes
        .iter()
        .find_map(|n| match n {
            PanelNode::List {
                items, selectable, ..
            } if *selectable == Some(true) => Some(items),
            _ => None,
        })
        .expect("the fleet list must be selectable");
    assert_eq!(list.len(), 2);

    let mut actions = Vec::new();
    for item in list {
        collect_actions(item, &mut actions);
    }
    assert_eq!(actions.len(), 2, "one action per project row");
    for (command_id, args) in &actions {
        assert_eq!(command_id, "open-project");
        // FR-39: args round-trip verbatim, so the path survives validation
        // intact — including the backslashes a Windows path carries.
        let path = args.as_ref().unwrap()["path"].as_str().unwrap();
        assert!(path.contains('\\'), "{path}");
    }
}

#[test]
fn every_declared_command_is_actually_implemented() {
    // FR-38/FR-44: an action naming an undeclared command renders inert, and a
    // declared command with no handler fails at invoke time. Both directions
    // have to agree, and neither is checked by the manifest alone.
    assert!(run_command("refresh", DashboardHost::up(), json!({})).is_ok());
    assert!(run_command(
        "open-project",
        DashboardHost::up(),
        json!({ "path": "D:\\francois" })
    )
    .is_ok());
    // ...and a command the manifest never declared is not implemented either.
    assert!(run_command("no-such-command", DashboardHost::up(), json!({})).is_err());
}

#[test]
fn a_dashboard_that_is_not_running_renders_an_instruction_not_an_error() {
    // The server is a separate process the user starts by hand, so this is the
    // EXPECTED state — it must read as a calm instruction, not a failure.
    let raw = run_handler(Handler::Panel, DashboardHost::down()).unwrap();
    let spec = panelspec::validate_panel(&raw).unwrap();
    let text = seen(&spec);
    assert!(
        text.iter().any(|t| t.contains("dashboard not running")),
        "{text:?}"
    );
    assert!(
        text.iter().any(|t| t.contains("cohorte dashboard")),
        "the panel must say how to start it: {text:?}"
    );
    assert!(text.iter().any(|t| t == "retry"), "{text:?}");
}

#[test]
fn the_status_item_escalates_failing_over_stale_over_idle() {
    let raw = run_handler(Handler::StatusBar, DashboardHost::up()).unwrap();
    let item = panelspec::validate_status(&raw).unwrap();
    // The fixture has one project with bad > 0, which outranks staleness.
    assert_eq!(item.text, "1 failing");
    assert_eq!(item.tone, Some(PanelTone::Error));
    assert_eq!(item.badge.as_deref(), Some("coh"));
    // §8·B: within the caps, so nothing is silently truncated in the bar.
    assert!(item.text.chars().count() <= STATUS_MAX_TEXT);
    assert!(item.badge.as_ref().unwrap().chars().count() <= STATUS_MAX_BADGE);

    // ...and it goes quiet when the dashboard is not running (FR-43).
    let raw = run_handler(Handler::StatusBar, DashboardHost::down()).unwrap();
    assert_eq!(raw, Value::Null, "no status item, and no error");
}

#[test]
fn open_project_stores_a_detail_the_next_panel_render_picks_up() {
    let host = DashboardHost::up();
    run_command(
        "open-project",
        host.clone() as Arc<dyn Host>,
        json!({ "path": "D:\\francois" }),
    )
    .unwrap();

    let stored = host.store.lock().unwrap().get("detail").cloned().unwrap();
    assert_eq!(stored["name"], "Francois");

    // The NEXT render is a FRESH isolate (FR-17) — nothing but storage carries
    // over, which is exactly what this proves.
    let raw = run_handler(Handler::Panel, host.clone() as Arc<dyn Host>).unwrap();
    let text = seen(&panelspec::validate_panel(&raw).unwrap());
    assert!(
        text.iter().any(|t| t.contains("surfaces: frontend, core")),
        "{text:?}"
    );
    assert!(text.iter().any(|t| t.contains("12 ok")), "{text:?}");

    // ...and `refresh` clears it again.
    run_command("refresh", host.clone() as Arc<dyn Host>, json!({})).unwrap();
    assert!(host.store.lock().unwrap().get("detail").is_none());
}

#[test]
fn the_plugin_only_ever_reaches_the_configured_loopback_port() {
    // The whole security story of this plugin is its one-host allowlist. If it
    // ever built a URL out of fleet data, it would show up here.
    let host = DashboardHost::up();
    run_handler(Handler::Panel, host.clone() as Arc<dyn Host>).unwrap();
    let urls = host.urls.lock().unwrap();
    assert!(!urls.is_empty());
    for url in urls.iter() {
        assert!(
            url.starts_with("http://127.0.0.1:4317/api/"),
            "unexpected url: {url}"
        );
        // It must never touch the code-executing endpoint.
        assert!(!url.contains("/api/action"), "{url}");
    }
}

#[test]
fn a_custom_port_setting_reaches_the_url() {
    let host = DashboardHost::up();
    let _ = run_with(
        Handler::Panel,
        host.clone() as Arc<dyn Host>,
        settings_with_port(9999),
        json!({}),
    );
    let urls = host.urls.lock().unwrap();
    assert!(!urls.is_empty());
    assert!(
        urls.iter().all(|u| u.contains(":9999")),
        "the port setting must reach the URL: {urls:?}"
    );
}

#[test]
fn one_render_stays_well_inside_the_isolates_io_budget() {
    // Two fetches per panel render (fleet + versions) plus one storage read —
    // comfortably inside FR-20's 4 fetches and 8 I/O calls, with room for the
    // detail lookup a command adds.
    let host = DashboardHost::up();
    assert!(run_handler(Handler::Panel, host.clone() as Arc<dyn Host>).is_ok());
    let fetches = host.urls.lock().unwrap().len() as u32;
    assert!(
        fetches <= FETCH_MAX_PER_INVOCATION,
        "{fetches} fetches in one render"
    );
}
