// lsp/ — code-editor-lsp (specs/code-editor-lsp.md FR-1..FR-8): real Language
// Server Protocol servers run by the core, one per (root directory, language),
// bridged into the webview's Monaco editor over `lsp_*` commands and the
// `francois://lsp/event` stream.
//
// mod.rs owns the model (mirrors contract/code-editor-lsp.ts EXACTLY), the FR-7
// limits, the server key and the managed `LspHost`. Children:
//  * framing.rs   — `Content-Length` framing over Read/Write (FR-1)
//  * servers.rs   — the FR-2 table, resolution (native + WSL) and the probe cache
//  * client.rs    — one live server process: JSON-RPC ids, replies, timeouts,
//                   `$/cancelRequest`, and the answers to server -> client requests
//  * lifecycle.rs — one server's state machine across restarts: initialize,
//                   open-document tracking + replay, idle stop, restart policy
//  * trust.rs     — `~/.francois/lsp-trust.json` (FR-4)
//  * uri.rs       — `file://` rewriting between the webview's and WSL's view (FR-8)
//  * commands.rs  — the seven `#[tauri::command]`s and the FR-3 allowlist

mod client;
pub mod commands;
mod framing;
mod lifecycle;
mod servers;
mod trust;
mod uri;

#[cfg(test)]
mod host_tests;
#[cfg(test)]
pub(crate) mod testutil;

pub use commands::stop_all;

use crate::editor::EditorRoot;
use lifecycle::Server;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use servers::{ProbeCache, Resolution};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use trust::TrustStore;

// ---------- model (mirrors contract/code-editor-lsp.ts EXACTLY) ----------

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LspLanguage {
    Typescript,
    Rust,
    Python,
    Go,
}

impl LspLanguage {
    /// Contract order — `lsp_status` answers one entry per language in it.
    pub(crate) const ALL: [LspLanguage; 4] = [
        LspLanguage::Typescript,
        LspLanguage::Rust,
        LspLanguage::Python,
        LspLanguage::Go,
    ];
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LspState {
    Untrusted,
    Missing,
    Stopped,
    Starting,
    Ready,
    Crashed,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LspServerStatus {
    pub root: EditorRoot,
    pub language: LspLanguage,
    pub state: LspState,
    pub server: String,
    pub version: Option<String>,
    pub program: Option<String>,
    pub install_hint: Option<String>,
    pub error: Option<String>,
    pub root_uri: String,
}

/// `francois://lsp/event`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type")]
pub enum LspEvent {
    #[serde(rename = "lsp.status")]
    Status { status: LspServerStatus },
    #[serde(rename = "lsp.diagnostics")]
    Diagnostics {
        root: EditorRoot,
        language: LspLanguage,
        uri: String,
        version: Option<i64>,
        diagnostics: Vec<Value>,
    },
    #[serde(rename = "lsp.progress")]
    Progress {
        root: EditorRoot,
        language: LspLanguage,
        token: String,
        title: Option<String>,
        message: Option<String>,
        percentage: Option<f64>,
        done: bool,
    },
}

/// FR-7 limits — the contract's constants.
pub(crate) const LSP_MAX_RESTARTS: usize = 3;
pub(crate) const LSP_RESTART_WINDOW_MS: u64 = 5 * 60_000;
pub(crate) const LSP_IDLE_STOP_MS: u64 = 10 * 60_000;
pub(crate) const LSP_REQUEST_TIMEOUT_MS: u64 = 10_000;

/// FR-3: the only methods the webview may send.
pub(crate) const LSP_ALLOWED_REQUESTS: [&str; 17] = [
    "textDocument/completion",
    "completionItem/resolve",
    "textDocument/hover",
    "textDocument/signatureHelp",
    "textDocument/definition",
    "textDocument/typeDefinition",
    "textDocument/implementation",
    "textDocument/references",
    "textDocument/documentHighlight",
    "textDocument/documentSymbol",
    "textDocument/codeAction",
    "codeAction/resolve",
    "textDocument/rename",
    "textDocument/prepareRename",
    "textDocument/formatting",
    "textDocument/rangeFormatting",
    "workspace/symbol",
];

pub(crate) const LSP_ALLOWED_NOTIFICATIONS: [&str; 4] = [
    "textDocument/didOpen",
    "textDocument/didChange",
    "textDocument/didSave",
    "textDocument/didClose",
];

// ---------- the host ----------

/// §7: servers are keyed by the normalised DIRECTORY, not the EditorRoot — a
/// project and a session sitting in the same directory share one server.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct ServerKey {
    pub dir_key: String,
    pub language: LspLanguage,
}

/// The comparison form of a root directory: `norm_path`, lower-cased for
/// Windows paths (drive or UNC), which compare case-insensitively.
pub(crate) fn dir_key(dir: &str) -> String {
    let n = crate::fs_util::norm_path(dir);
    let b = n.as_bytes();
    if n.starts_with("//") || (b.len() >= 2 && b[1] == b':') {
        n.to_lowercase()
    } else {
        n
    }
}

pub(crate) type Emitter = Arc<dyn Fn(LspEvent) + Send + Sync>;
pub(crate) type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;
pub(crate) type Resolver = Box<dyn Fn(&str, LspLanguage) -> Option<Resolution> + Send + Sync>;

/// What every server shares: where events go, what time it is, and the
/// timings (production values from the contract; tests shrink them).
#[derive(Clone)]
pub(crate) struct Ctx {
    pub emit: Emitter,
    pub clock: Clock,
    pub idle_stop_ms: u64,
    pub request_timeout_ms: u64,
    pub init_timeout_ms: u64,
}

impl Ctx {
    pub(crate) fn new(emit: Emitter) -> Self {
        Ctx {
            emit,
            clock: Arc::new(crate::ids::now_ms),
            idle_stop_ms: LSP_IDLE_STOP_MS,
            request_timeout_ms: LSP_REQUEST_TIMEOUT_MS,
            init_timeout_ms: 60_000,
        }
    }
}

/// Tauri-managed state. A LEAF lock domain: nothing here takes another
/// domain's lock (root resolution happens before any of these are taken).
pub struct LspHost {
    servers: Mutex<HashMap<ServerKey, Arc<Server>>>,
    probes: Mutex<ProbeCache>,
    trust: Mutex<TrustStore>,
    resolver: Resolver,
    ctx: OnceLock<Ctx>,
}

impl Default for LspHost {
    fn default() -> Self {
        LspHost {
            servers: Mutex::default(),
            probes: Mutex::default(),
            trust: Mutex::new(TrustStore::new(TrustStore::default_path())),
            resolver: Box::new(servers::resolve),
            ctx: OnceLock::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root() -> EditorRoot {
        EditorRoot::Project {
            project_id: "p1".into(),
        }
    }

    fn status() -> LspServerStatus {
        LspServerStatus {
            root: root(),
            language: LspLanguage::Typescript,
            state: LspState::Ready,
            server: "typescript-language-server".into(),
            version: Some("TypeScript 5.6.3".into()),
            program: Some("/r/node_modules/.bin/typescript-language-server".into()),
            install_hint: None,
            error: None,
            root_uri: "file:///r".into(),
        }
    }

    #[test]
    fn status_serialises_to_the_contract_shape_and_back() {
        let v = serde_json::to_value(status()).unwrap();
        assert_eq!(
            v,
            json!({
                "root": { "kind": "project", "projectId": "p1" },
                "language": "typescript",
                "state": "ready",
                "server": "typescript-language-server",
                "version": "TypeScript 5.6.3",
                "program": "/r/node_modules/.bin/typescript-language-server",
                "installHint": null,
                "error": null,
                "rootUri": "file:///r"
            })
        );
        assert_eq!(
            serde_json::from_value::<LspServerStatus>(v).unwrap(),
            status()
        );
    }

    #[test]
    fn enums_use_the_contract_spellings() {
        let langs: Vec<Value> = LspLanguage::ALL
            .iter()
            .map(|l| serde_json::to_value(l).unwrap())
            .collect();
        assert_eq!(
            langs,
            vec![
                json!("typescript"),
                json!("rust"),
                json!("python"),
                json!("go")
            ]
        );
        for (s, w) in [
            (LspState::Untrusted, "untrusted"),
            (LspState::Missing, "missing"),
            (LspState::Stopped, "stopped"),
            (LspState::Starting, "starting"),
            (LspState::Ready, "ready"),
            (LspState::Crashed, "crashed"),
        ] {
            assert_eq!(serde_json::to_value(s).unwrap(), json!(w));
            assert_eq!(serde_json::from_value::<LspState>(json!(w)).unwrap(), s);
        }
    }

    #[test]
    fn every_event_variant_round_trips_with_its_type_tag() {
        let events = vec![
            (
                LspEvent::Status { status: status() },
                json!({ "type": "lsp.status", "status": serde_json::to_value(status()).unwrap() }),
            ),
            (
                LspEvent::Diagnostics {
                    root: root(),
                    language: LspLanguage::Rust,
                    uri: "file:///r/a.rs".into(),
                    version: Some(4),
                    diagnostics: vec![json!({ "message": "x" })],
                },
                json!({
                    "type": "lsp.diagnostics",
                    "root": { "kind": "project", "projectId": "p1" },
                    "language": "rust",
                    "uri": "file:///r/a.rs",
                    "version": 4,
                    "diagnostics": [{ "message": "x" }]
                }),
            ),
            (
                LspEvent::Progress {
                    root: root(),
                    language: LspLanguage::Go,
                    token: "1".into(),
                    title: Some("Indexing".into()),
                    message: None,
                    percentage: Some(42.0),
                    done: false,
                },
                json!({
                    "type": "lsp.progress",
                    "root": { "kind": "project", "projectId": "p1" },
                    "language": "go",
                    "token": "1",
                    "title": "Indexing",
                    "message": null,
                    "percentage": 42.0,
                    "done": false
                }),
            ),
        ];
        for (ev, wire) in events {
            assert_eq!(serde_json::to_value(&ev).unwrap(), wire);
            assert_eq!(serde_json::from_value::<LspEvent>(wire).unwrap(), ev);
        }
    }

    #[test]
    fn request_payloads_deserialise_from_the_contract_shapes() {
        // The command arguments are flat (Tauri maps each top-level key to a
        // parameter); the two non-primitive ones are EditorRoot and LspLanguage.
        let req = json!({
            "root": { "kind": "session", "sessionId": "s1" },
            "language": "python",
        });
        let root: EditorRoot = serde_json::from_value(req["root"].clone()).unwrap();
        let lang: LspLanguage = serde_json::from_value(req["language"].clone()).unwrap();
        assert_eq!(
            (root, lang),
            (
                EditorRoot::Session {
                    session_id: "s1".into()
                },
                LspLanguage::Python
            )
        );
        assert!(serde_json::from_value::<LspLanguage>(json!("java")).is_err());
    }

    #[test]
    fn dir_keys_fold_windows_case_only() {
        assert_eq!(dir_key(r"D:\Repo\"), "d:/repo");
        assert_eq!(
            dir_key(r"\\wsl.localhost\Ubuntu\x"),
            "//wsl.localhost/ubuntu/x"
        );
        assert_eq!(dir_key("/Home/u/"), "/Home/u");
    }
}
