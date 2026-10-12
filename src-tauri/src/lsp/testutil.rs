// lsp/testutil.rs — a tiny fake language server for the integration tests.
//
// It lives inside the lib's own test binary: the tests spawn that binary
// again (`current_exe()`) filtered down to `fake_lsp_server_main`, with
// `FRANCOIS_FAKE_LSP=1` in its environment. Run normally (no variable), the
// "test" returns at once. libtest's own banner on stdout ("running 1 test") is
// noise the framing reader skips by design.
//
// Behaviour:
//  * initialize           -> serverInfo { version "1.2.3" }
//  * initialized          -> asks `workspace/configuration` (2 items) and reports
//                            the answer as a `$/progress` begin whose title is it
//  * textDocument/hover   -> contents.value = "<uri>|<initialize rootUri>|<pid>"
//  * textDocument/definition -> never answered (timeout / cancel tests)
//  * didOpen / didChange  -> publishDiagnostics for a file OUTSIDE the root, then
//                            one diagnostic whose message is the document text
//  * didSave              -> writes "boom: crashed on purpose" to stderr, exits 3
//  * shutdown / exit      -> null / exit 0

use super::framing::{read_message, write_message};
use super::servers::{Launch, Resolution};
use super::uri::UriMap;
use serde_json::{json, Value};
use std::io::Write as _;

pub(crate) const FAKE_ENV: &str = "FRANCOIS_FAKE_LSP";

/// A resolution that launches the fake server.
pub(crate) fn fake_resolution() -> Resolution {
    let exe = std::env::current_exe()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    Resolution {
        server: "fake-lsp".into(),
        program: exe.clone(),
        launch: Launch {
            program: exe,
            args: vec![
                "lsp::testutil::fake_lsp_server_main".into(),
                "--exact".into(),
                "--quiet".into(),
                "--test-threads=1".into(),
            ],
            cwd: None,
            env: vec![(FAKE_ENV.into(), "1".into())],
        },
        uri_map: UriMap::Native,
        init_options: None,
        version: None,
    }
}

fn send(v: &Value) {
    let mut out = std::io::stdout().lock();
    write_message(&mut out, &serde_json::to_vec(v).unwrap()).unwrap();
}

fn publish(uri: &str, version: &Value, message: &str) {
    send(&json!({
        "jsonrpc": "2.0",
        "method": "textDocument/publishDiagnostics",
        "params": {
            "uri": uri,
            "version": version,
            "diagnostics": [{
                "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } },
                "message": message
            }]
        }
    }));
}

#[test]
fn fake_lsp_server_main() {
    if std::env::var(FAKE_ENV).ok().as_deref() != Some("1") {
        return;
    }
    let mut stdin = std::io::BufReader::new(std::io::stdin());
    let mut root_uri = String::new();
    let mut pid = Value::Null;
    while let Ok(Some(body)) = read_message(&mut stdin) {
        let msg: Value = serde_json::from_slice(&body).unwrap();
        let id = msg.get("id").cloned();
        let method = msg["method"].as_str().unwrap_or_default();
        let p = &msg["params"];
        match method {
            "initialize" => {
                root_uri = p["rootUri"].as_str().unwrap_or_default().to_string();
                pid = p["processId"].clone();
                send(&json!({ "jsonrpc": "2.0", "id": id, "result": {
                    "capabilities": { "hoverProvider": true },
                    "serverInfo": { "name": "fake", "version": "1.2.3" }
                }}));
            }
            "initialized" => send(&json!({
                "jsonrpc": "2.0", "id": "cfg-1", "method": "workspace/configuration",
                "params": { "items": [{ "section": "a" }, { "section": "b" }] }
            })),
            "textDocument/hover" => {
                let uri = p["textDocument"]["uri"].as_str().unwrap_or_default();
                send(&json!({ "jsonrpc": "2.0", "id": id, "result": {
                    "contents": { "kind": "plaintext", "value": format!("{uri}|{root_uri}|{pid}") }
                }}));
            }
            "textDocument/definition" => {}
            "textDocument/didOpen" | "textDocument/didChange" => {
                let td = &p["textDocument"];
                let uri = td["uri"].as_str().unwrap_or_default();
                let text = if method == "textDocument/didOpen" {
                    td["text"].as_str().unwrap_or_default().to_string()
                } else {
                    p["contentChanges"][0]["text"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string()
                };
                publish(
                    "file:///definitely/elsewhere/x.ts",
                    &td["version"],
                    "outside",
                );
                publish(uri, &td["version"], &text);
            }
            "textDocument/didSave" => {
                let _ = writeln!(std::io::stderr(), "boom: crashed on purpose");
                std::process::exit(3);
            }
            "shutdown" => send(&json!({ "jsonrpc": "2.0", "id": id, "result": null })),
            "exit" => std::process::exit(0),
            "" if id.as_ref().and_then(Value::as_str) == Some("cfg-1") => {
                let title = msg["result"].to_string();
                send(
                    &json!({ "jsonrpc": "2.0", "method": "$/progress", "params": {
                        "token": 7, "value": { "kind": "begin", "title": title, "percentage": 0 }
                    }}),
                );
                send(
                    &json!({ "jsonrpc": "2.0", "method": "$/progress", "params": {
                        "token": 7, "value": { "kind": "end", "message": "done" }
                    }}),
                );
            }
            _ => {}
        }
    }
    std::process::exit(0);
}
