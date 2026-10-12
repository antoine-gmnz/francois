// lsp/client.rs — code-editor-lsp FR-1/FR-3: one live language-server process.
//
// Spawned through `process_util` (login-shell PATH, no console window, its
// whole process tree owned by an `OwnedChild` whose stderr is drained
// continuously). A reader thread decodes every frame from stdout: replies are
// routed to the waiting request by id, server -> client requests are answered
// here (the contract footer's table) and never reach the webview, and
// notifications go to the `Handler` with their URIs already rewritten to the
// webview's view. When stdout ends, every pending request fails and the
// handler hears `exited`.

use super::framing;
use super::servers::Launch;
use super::uri::UriMap;
use crate::process_util::OwnedChild;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::BufReader;
use std::process::{ChildStdin, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// JSON-RPC / LSP error codes the core produces itself.
pub(crate) const CODE_REQUEST_FAILED: i64 = -32803;
pub(crate) const CODE_CANCELLED: i64 = -32800;
const CODE_METHOD_NOT_FOUND: i64 = -32601;
/// FR-7: the stderr tail kept for `error`.
const STDERR_TAIL_BYTES: usize = 4 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    fn new(code: i64, message: &str) -> Self {
        RpcError {
            code,
            message: message.to_string(),
        }
    }
}

type Reply = Result<Value, RpcError>;

/// The server's side of one connection: notifications in, the end of it.
pub(crate) trait Handler: Send + Sync {
    fn notification(&self, method: &str, params: Value);
    fn exited(&self);
}

pub(crate) struct Connection {
    child: OwnedChild,
    /// Frames for the writer thread, which owns stdin. Sending never blocks,
    /// so a command thread (even the main one) is never held by a server
    /// that stopped reading, and frames keep the order they were queued in.
    out: mpsc::Sender<Vec<u8>>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, mpsc::Sender<Reply>>>,
    /// The webview's `requestId` -> the JSON-RPC id it was sent under.
    tags: Mutex<HashMap<String, i64>>,
    uri_map: UriMap,
}

impl Connection {
    pub(crate) fn spawn(
        launch: &Launch,
        uri_map: UriMap,
        handler: Arc<dyn Handler>,
    ) -> std::io::Result<Arc<Connection>> {
        let mut b = crate::process_util::spawn(&launch.program)
            .args(&launch.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if let Some(cwd) = &launch.cwd {
            b = b.current_dir(cwd);
        }
        for (k, v) in &launch.env {
            b = b.env(k, v);
        }
        let child = b.start_owned()?;
        let (Some(stdin), Some(stdout)) = (child.take_stdin(), child.take_stdout()) else {
            let _ = child.terminate();
            return Err(std::io::Error::other("the server's stdio was not piped"));
        };
        let (out, frames) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut stdin: ChildStdin = stdin;
            for body in frames {
                if framing::write_message(&mut stdin, &body).is_err() {
                    break;
                }
            }
        });
        let conn = Arc::new(Connection {
            child,
            out,
            next_id: AtomicI64::new(1),
            pending: Mutex::default(),
            tags: Mutex::default(),
            uri_map,
        });
        let reader = conn.clone();
        std::thread::spawn(move || {
            let mut r = BufReader::new(stdout);
            while let Ok(Some(body)) = framing::read_message(&mut r) {
                reader.dispatch(&body, &*handler);
            }
            // Dropping the senders fails every waiting request at once.
            reader.pending.lock().unwrap().clear();
            handler.exited();
        });
        Ok(conn)
    }

    fn dispatch(&self, body: &[u8], handler: &dyn Handler) {
        let Ok(mut msg) = serde_json::from_slice::<Value>(body) else {
            return;
        };
        let method = msg
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string);
        let id = msg.get("id").cloned().filter(|i| !i.is_null());
        match (method, id) {
            (Some(m), Some(id)) => {
                let reply = answer_server_request(&m, msg.get("params"));
                let _ = self.send(&response(id, reply));
            }
            (Some(m), None) => {
                let mut params = msg.get_mut("params").map(Value::take).unwrap_or_default();
                self.uri_map.to_webview(&mut params);
                handler.notification(&m, params);
            }
            (None, Some(id)) => {
                let Some(id) = id.as_i64() else { return };
                let Some(tx) = self.pending.lock().unwrap().remove(&id) else {
                    return; // cancelled or timed out already
                };
                let reply = match msg.get("error") {
                    Some(e) => Err(RpcError {
                        code: e
                            .get("code")
                            .and_then(Value::as_i64)
                            .unwrap_or(CODE_REQUEST_FAILED),
                        message: e
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("request failed")
                            .to_string(),
                    }),
                    None => {
                        let mut result = msg.get_mut("result").map(Value::take).unwrap_or_default();
                        self.uri_map.to_webview(&mut result);
                        Ok(result)
                    }
                };
                let _ = tx.send(reply);
            }
            (None, None) => {}
        }
    }

    fn send(&self, msg: &Value) -> std::io::Result<()> {
        let body = serde_json::to_vec(msg)?;
        self.out
            .send(body)
            .map_err(|_| std::io::Error::other("the server's stdin is closed"))
    }

    /// A notification; `params` in the webview's view (rewritten here).
    pub(crate) fn notify(&self, method: &str, mut params: Value) -> std::io::Result<()> {
        self.uri_map.to_server(&mut params);
        self.send(&envelope(None, method, params))
    }

    /// A request, blocking until its reply, `timeout`, a cancel, or the
    /// server's exit. `params` and the result are in the webview's view.
    pub(crate) fn request(
        &self,
        method: &str,
        mut params: Value,
        tag: Option<&str>,
        timeout: Duration,
    ) -> Reply {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Some(t) = tag {
            self.tags.lock().unwrap().insert(t.to_string(), id);
        }
        self.uri_map.to_server(&mut params);
        let reply = match self.send(&envelope(Some(id), method, params)) {
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(RpcError::new(
                    CODE_REQUEST_FAILED,
                    "the language server is not reading",
                ))
            }
            Ok(()) => match rx.recv_timeout(timeout) {
                Ok(r) => r,
                Err(RecvTimeoutError::Timeout) => {
                    if self.pending.lock().unwrap().remove(&id).is_some() {
                        let _ = self.send_cancel(id);
                    }
                    Err(RpcError::new(
                        CODE_REQUEST_FAILED,
                        "the language server did not answer in time",
                    ))
                }
                Err(RecvTimeoutError::Disconnected) => Err(RpcError::new(
                    CODE_REQUEST_FAILED,
                    "the language server exited",
                )),
            },
        };
        if let Some(t) = tag {
            let mut tags = self.tags.lock().unwrap();
            if tags.get(t) == Some(&id) {
                tags.remove(t);
            }
        }
        reply
    }

    /// FR-3: `$/cancelRequest` for a tagged request still in flight; it
    /// resolves with -32800 right away. A no-op once it has been answered.
    pub(crate) fn cancel(&self, tag: &str) {
        let Some(id) = self.tags.lock().unwrap().remove(tag) else {
            return;
        };
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(Err(RpcError::new(CODE_CANCELLED, "cancelled")));
            let _ = self.send_cancel(id);
        }
    }

    fn send_cancel(&self, id: i64) -> std::io::Result<()> {
        self.send(&envelope(None, "$/cancelRequest", json!({ "id": id })))
    }

    /// FR-7 graceful stop: `shutdown` (bounded by `grace`), `exit`, then the
    /// tree is killed if it is still alive 2 s later.
    pub(crate) fn shutdown(&self, grace: Duration) {
        let _ = self.request("shutdown", Value::Null, None, grace);
        let _ = self.notify("exit", Value::Null);
        let _ = self.child.close();
    }

    pub(crate) fn kill(&self) {
        let _ = self.child.terminate();
    }

    /// The last lines the server wrote to stderr before dying, capped at 4 KiB.
    pub(crate) fn stderr_tail(&self) -> Option<String> {
        let tail = self.child.exit_diagnostic(Duration::from_millis(500))?;
        if tail.len() <= STDERR_TAIL_BYTES {
            return Some(tail);
        }
        let mut cut = tail.len() - STDERR_TAIL_BYTES;
        while !tail.is_char_boundary(cut) {
            cut += 1;
        }
        Some(tail[cut..].to_string())
    }
}

/// A request (`id` set) or notification. `params: null` is omitted — JSON-RPC
/// only allows structured params, and `shutdown`/`exit` take none.
fn envelope(id: Option<i64>, method: &str, params: Value) -> Value {
    let mut m = json!({ "jsonrpc": "2.0", "method": method });
    if let Some(id) = id {
        m["id"] = json!(id);
    }
    if !params.is_null() {
        m["params"] = params;
    }
    m
}

fn response(id: Value, reply: Reply) -> Value {
    match reply {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(e) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": e.code, "message": e.message }
        }),
    }
}

/// The contract footer: server -> client requests the core answers itself.
pub(crate) fn answer_server_request(method: &str, params: Option<&Value>) -> Reply {
    match method {
        "workspace/configuration" => {
            let n = params
                .and_then(|p| p.get("items"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            Ok(Value::Array(vec![Value::Null; n]))
        }
        "client/registerCapability"
        | "client/unregisterCapability"
        | "window/workDoneProgress/create"
        | "window/showMessageRequest" => Ok(Value::Null),
        "workspace/applyEdit" => Ok(json!({ "applied": false })),
        _ => Err(RpcError::new(
            CODE_METHOD_NOT_FOUND,
            "method not supported by Francois",
        )),
    }
}

/// FR-1: the capabilities matching the providers the frontend registers.
pub(crate) fn client_capabilities() -> Value {
    let markup = json!(["markdown", "plaintext"]);
    json!({
        "general": { "positionEncodings": ["utf-16"] },
        "window": { "workDoneProgress": true, "showMessage": {} },
        "workspace": {
            "workspaceFolders": true,
            "configuration": true,
            "applyEdit": false,
            "workspaceEdit": { "documentChanges": true },
            "symbol": { "symbolKind": { "valueSet": (1..=26).collect::<Vec<u32>>() } }
        },
        "textDocument": {
            "synchronization": { "didSave": true, "willSave": false, "willSaveWaitUntil": false },
            "completion": {
                "contextSupport": true,
                "completionItem": {
                    "snippetSupport": true,
                    "commitCharactersSupport": true,
                    "documentationFormat": markup,
                    "deprecatedSupport": true,
                    "labelDetailsSupport": true,
                    "resolveSupport": { "properties": ["documentation", "detail", "additionalTextEdits"] }
                },
                "completionItemKind": { "valueSet": (1..=25).collect::<Vec<u32>>() }
            },
            "hover": { "contentFormat": markup },
            "signatureHelp": {
                "contextSupport": true,
                "signatureInformation": {
                    "documentationFormat": markup,
                    "parameterInformation": { "labelOffsetSupport": true },
                    "activeParameterSupport": true
                }
            },
            "definition": { "linkSupport": true },
            "typeDefinition": { "linkSupport": true },
            "implementation": { "linkSupport": true },
            "references": {},
            "documentHighlight": {},
            "documentSymbol": {
                "hierarchicalDocumentSymbolSupport": true,
                "symbolKind": { "valueSet": (1..=26).collect::<Vec<u32>>() }
            },
            "codeAction": {
                "codeActionLiteralSupport": {
                    "codeActionKind": { "valueSet": [
                        "", "quickfix", "refactor", "refactor.extract", "refactor.inline",
                        "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"
                    ] }
                },
                "isPreferredSupport": true,
                "dataSupport": true,
                "resolveSupport": { "properties": ["edit"] }
            },
            "rename": { "prepareSupport": true },
            "formatting": {},
            "rangeFormatting": {},
            "publishDiagnostics": {
                "relatedInformation": true,
                "versionSupport": true,
                "codeDescriptionSupport": true,
                "tagSupport": { "valueSet": [1, 2] }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_requests_are_answered_per_the_contract_footer() {
        let items = json!({ "items": [{ "section": "a" }, { "section": "b" }, {}] });
        assert_eq!(
            answer_server_request("workspace/configuration", Some(&items)),
            Ok(json!([null, null, null]))
        );
        for m in [
            "client/registerCapability",
            "client/unregisterCapability",
            "window/workDoneProgress/create",
            "window/showMessageRequest",
        ] {
            assert_eq!(answer_server_request(m, None), Ok(Value::Null), "{m}");
        }
        assert_eq!(
            answer_server_request("workspace/applyEdit", Some(&json!({ "edit": {} }))),
            Ok(json!({ "applied": false }))
        );
        assert_eq!(
            answer_server_request("workspace/somethingElse", None)
                .unwrap_err()
                .code,
            CODE_METHOD_NOT_FOUND
        );
    }

    #[test]
    fn envelopes_omit_null_params_and_responses_carry_errors() {
        assert_eq!(
            envelope(Some(3), "shutdown", Value::Null),
            json!({ "jsonrpc": "2.0", "id": 3, "method": "shutdown" })
        );
        assert_eq!(
            envelope(None, "initialized", json!({})),
            json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} })
        );
        assert_eq!(
            response(json!("x"), Err(RpcError::new(-1, "no"))),
            json!({ "jsonrpc": "2.0", "id": "x", "error": { "code": -1, "message": "no" } })
        );
        assert_eq!(
            response(json!(7), Ok(Value::Null)),
            json!({ "jsonrpc": "2.0", "id": 7, "result": null })
        );
    }

    #[test]
    fn capabilities_announce_the_fr1_feature_set() {
        let c = client_capabilities();
        let td = &c["textDocument"];
        assert_eq!(td["completion"]["completionItem"]["snippetSupport"], true);
        assert!(td["completion"]["completionItem"]["resolveSupport"].is_object());
        assert_eq!(
            td["documentSymbol"]["hierarchicalDocumentSymbolSupport"],
            true
        );
        assert_eq!(td["rename"]["prepareSupport"], true);
        assert!(td["codeAction"]["codeActionLiteralSupport"].is_object());
        assert_eq!(td["publishDiagnostics"]["relatedInformation"], true);
        assert_eq!(c["window"]["workDoneProgress"], true);
    }
}
