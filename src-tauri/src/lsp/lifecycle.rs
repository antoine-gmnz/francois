// lsp/lifecycle.rs — code-editor-lsp FR-5/FR-6/FR-7: one server's life across
// however many processes it takes.
//
// A `Server` outlives its `Connection`s. It owns the state the webview sees
// (`stopped → starting → ready`, `crashed`), the open documents with their
// latest full text (replayed as `didOpen` into every new process), the restart
// history, and the idle clock. Transitions, and when `lsp.status` fires:
//
//  * `start`   stopped|crashed -> starting   (emit)
//  * initialize answered        -> ready      (emit, after `initialized` + replay)
//  * process exits unexpectedly -> starting   (emit; respawned) — or, past
//                                  LSP_MAX_RESTARTS in the window, -> crashed (emit)
//  * `stop` / idle / revoke     -> stopped    (emit)
//
// Every timing reads `Ctx.clock`, so the policy is testable without sleeping.

use super::client::{client_capabilities, Connection, Handler, RpcError};
use super::servers::{spec, Resolution};
use super::uri::{doc_key, is_under, UriMap};
use super::{
    Ctx, LspEvent, LspLanguage, LspServerStatus, LspState, LSP_MAX_RESTARTS, LSP_RESTART_WINDOW_MS,
};
use crate::editor::EditorRoot;
use crate::ipc::{AppError, ErrorCode};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

/// FR-7: more than `LSP_MAX_RESTARTS` exits inside `LSP_RESTART_WINDOW_MS` -> crashed.
#[derive(Default, Debug)]
pub(crate) struct RestartPolicy {
    exits: VecDeque<u64>,
}

impl RestartPolicy {
    /// Record an exit at `now`; `true` = restart, `false` = give up (crashed).
    pub(crate) fn record_exit(&mut self, now: u64) -> bool {
        self.exits.push_back(now);
        while self
            .exits
            .front()
            .is_some_and(|t| now.saturating_sub(*t) >= LSP_RESTART_WINDOW_MS)
        {
            self.exits.pop_front();
        }
        self.exits.len() <= LSP_MAX_RESTARTS
    }

    pub(crate) fn reset(&mut self) {
        self.exits.clear();
    }
}

/// FR-7 idle stop: no open document for `idle_ms` while running.
pub(crate) fn idle_due(idle_since: Option<u64>, now: u64, idle_ms: u64) -> bool {
    idle_since.is_some_and(|t| now.saturating_sub(t) >= idle_ms)
}

struct Doc {
    /// As the webview named it — replayed verbatim.
    uri: String,
    language_id: Value,
    version: Value,
    text: String,
    /// The process generation that has seen `didOpen` for it (0 = none).
    sent_gen: u64,
}

struct Inner {
    res: Resolution,
    state: LspState,
    version: Option<String>,
    error: Option<String>,
    roots: Vec<EditorRoot>,
    conn: Option<Arc<Connection>>,
    generation: u64,
    docs: BTreeMap<String, Doc>,
    policy: RestartPolicy,
    idle_since: Option<u64>,
    progress_titles: HashMap<String, String>,
}

pub(crate) struct Server {
    me: Weak<Server>,
    ctx: Ctx,
    language: LspLanguage,
    root_uri: String,
    inner: Mutex<Inner>,
}

/// Routes one connection's callbacks to its server, tagged with the process
/// generation so a late callback from a replaced process is ignored.
struct ConnHandler {
    server: Weak<Server>,
    generation: u64,
}

impl Handler for ConnHandler {
    fn notification(&self, method: &str, params: Value) {
        if let Some(s) = self.server.upgrade() {
            s.on_notification(self.generation, method, params);
        }
    }
    fn exited(&self) {
        if let Some(s) = self.server.upgrade() {
            s.on_exit(self.generation);
        }
    }
}

impl Server {
    pub(crate) fn new(
        ctx: Ctx,
        root: EditorRoot,
        root_uri: String,
        language: LspLanguage,
        res: Resolution,
    ) -> Arc<Server> {
        let server = Arc::new_cyclic(|me| Server {
            me: me.clone(),
            ctx,
            language,
            root_uri,
            inner: Mutex::new(Inner {
                version: res.version.clone(),
                res,
                state: LspState::Stopped,
                error: None,
                roots: vec![root],
                conn: None,
                generation: 0,
                docs: BTreeMap::new(),
                policy: RestartPolicy::default(),
                idle_since: None,
                progress_titles: HashMap::new(),
            }),
        });
        spawn_idle_watch(Arc::downgrade(&server), server.ctx.idle_stop_ms);
        server
    }

    pub(crate) fn add_root(&self, root: &EditorRoot) {
        let mut g = self.inner.lock().unwrap();
        if !g.roots.contains(root) {
            g.roots.push(root.clone());
        }
    }

    pub(crate) fn roots(&self) -> Vec<EditorRoot> {
        self.inner.lock().unwrap().roots.clone()
    }

    pub(crate) fn state(&self) -> LspState {
        self.inner.lock().unwrap().state
    }

    pub(crate) fn status_for(&self, root: &EditorRoot) -> LspServerStatus {
        let g = self.inner.lock().unwrap();
        self.status_locked(&g, root)
    }

    fn status_locked(&self, g: &Inner, root: &EditorRoot) -> LspServerStatus {
        LspServerStatus {
            root: root.clone(),
            language: self.language,
            state: g.state,
            server: g.res.server.clone(),
            version: g.version.clone(),
            program: Some(g.res.program.clone()),
            install_hint: None,
            error: g.error.clone(),
            root_uri: self.root_uri.clone(),
        }
    }

    fn status_events(&self, g: &Inner) -> Vec<LspEvent> {
        g.roots
            .iter()
            .map(|r| LspEvent::Status {
                status: self.status_locked(g, r),
            })
            .collect()
    }

    fn emit_all(&self, events: Vec<LspEvent>) {
        for e in events {
            (self.ctx.emit)(e);
        }
    }

    /// `lsp_start`: idempotent for starting/ready; a crashed server is reset.
    /// `res` refreshes the resolution (FR-2 re-probe). Err = spawn failure.
    pub(crate) fn start(&self, res: Option<Resolution>) -> Result<(), String> {
        let mut g = self.inner.lock().unwrap();
        if matches!(g.state, LspState::Starting | LspState::Ready) {
            return Ok(());
        }
        if g.state == LspState::Crashed {
            g.policy.reset();
        }
        if let Some(r) = res {
            g.version = r.version.clone();
            g.res = r;
        }
        g.error = None;
        let spawned = self.spawn_locked(&mut g);
        if let Err(e) = &spawned {
            g.state = LspState::Stopped;
            g.error = Some(e.clone());
        }
        let events = self.status_events(&g);
        drop(g);
        self.emit_all(events);
        spawned
    }

    fn spawn_locked(&self, g: &mut Inner) -> Result<(), String> {
        g.generation += 1;
        let generation = g.generation;
        let handler = Arc::new(ConnHandler {
            server: self.me.clone(),
            generation,
        });
        let conn = Connection::spawn(&g.res.launch, g.res.uri_map.clone(), handler)
            .map_err(|e| format!("could not start {}: {e}", g.res.server))?;
        g.conn = Some(conn.clone());
        g.state = LspState::Starting;
        g.progress_titles.clear();
        for d in g.docs.values_mut() {
            d.sent_gen = 0;
        }
        if g.docs.is_empty() {
            g.idle_since = Some((self.ctx.clock)());
        }
        let params = self.initialize_params(&g.res);
        let me = self.me.clone();
        let timeout = Duration::from_millis(self.ctx.init_timeout_ms);
        std::thread::spawn(move || {
            let reply = conn.request("initialize", params, None, timeout);
            if let Some(s) = me.upgrade() {
                s.on_initialized(generation, &conn, reply);
            }
        });
        Ok(())
    }

    fn initialize_params(&self, res: &Resolution) -> Value {
        // A WSL server cannot see a Windows pid — and vscode-languageserver
        // exits when the processId it was given is not alive.
        let pid = match res.uri_map {
            UriMap::Native => json!(std::process::id()),
            UriMap::Wsl { .. } => Value::Null,
        };
        let name = self
            .root_uri
            .rsplit('/')
            .find(|s| !s.is_empty())
            .unwrap_or("root")
            .to_string();
        let mut p = json!({
            "processId": pid,
            "clientInfo": { "name": "Francois", "version": env!("CARGO_PKG_VERSION") },
            "rootUri": self.root_uri,
            "workspaceFolders": [{ "uri": self.root_uri, "name": name }],
            "capabilities": client_capabilities(),
        });
        if let Some(o) = &res.init_options {
            p["initializationOptions"] = o.clone();
        }
        p
    }

    fn on_initialized(&self, generation: u64, conn: &Connection, reply: Result<Value, RpcError>) {
        let mut g = self.inner.lock().unwrap();
        if g.generation != generation {
            return;
        }
        let result = match reply {
            Ok(r) => r,
            Err(e) => {
                g.error = Some(format!("initialize failed: {}", e.message));
                drop(g);
                conn.kill(); // the reader's exit drives the restart/crash path
                return;
            }
        };
        if g.version.is_none() {
            g.version = result
                .pointer("/serverInfo/version")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        let _ = conn.notify("initialized", json!({}));
        for d in g.docs.values_mut() {
            let _ = conn.notify("textDocument/didOpen", did_open(d));
            d.sent_gen = generation;
        }
        g.state = LspState::Ready;
        g.error = None;
        let events = self.status_events(&g);
        drop(g);
        self.emit_all(events);
    }

    fn on_exit(&self, generation: u64) {
        let conn = {
            let mut g = self.inner.lock().unwrap();
            if g.generation != generation {
                return;
            }
            g.conn.take()
        };
        let tail = conn.as_ref().and_then(|c| c.stderr_tail());
        if let Some(c) = &conn {
            c.kill();
        }
        let mut g = self.inner.lock().unwrap();
        if g.generation != generation {
            return; // stopped (or restarted) meanwhile
        }
        g.error = tail
            .or(g.error.take())
            .or_else(|| Some(format!("{} exited unexpectedly", g.res.server)));
        if g.policy.record_exit((self.ctx.clock)()) {
            if let Err(e) = self.spawn_locked(&mut g) {
                g.state = LspState::Crashed;
                g.error = Some(e);
            }
        } else {
            g.state = LspState::Crashed;
            g.generation += 1;
        }
        let events = self.status_events(&g);
        drop(g);
        self.emit_all(events);
    }

    /// `lsp_stop`, idle stop, revoke, app quit. Blocks for the graceful
    /// shutdown (≤ ~4 s); a stopped server is a no-op.
    pub(crate) fn stop(&self) {
        let mut g = self.inner.lock().unwrap();
        if !matches!(g.state, LspState::Starting | LspState::Ready) {
            return;
        }
        g.generation += 1;
        let conn = g.conn.take();
        g.state = LspState::Stopped;
        g.idle_since = None;
        let events = self.status_events(&g);
        drop(g);
        self.emit_all(events);
        if let Some(c) = conn {
            c.shutdown(Duration::from_secs(2));
        }
    }

    fn running_conn(&self) -> Option<Arc<Connection>> {
        let g = self.inner.lock().unwrap();
        (g.state == LspState::Ready)
            .then(|| g.conn.clone())
            .flatten()
    }

    /// FR-3 request: waits for `ready` while starting (within the timeout).
    pub(crate) fn request(
        &self,
        method: &str,
        params: Value,
        tag: Option<&str>,
    ) -> Result<Value, AppError> {
        let timeout = Duration::from_millis(self.ctx.request_timeout_ms);
        let deadline = std::time::Instant::now() + timeout;
        let conn = loop {
            if let Some(c) = self.running_conn() {
                break c;
            }
            if self.state() != LspState::Starting || std::time::Instant::now() >= deadline {
                return Err(not_running());
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        conn.request(method, params, tag, left.max(Duration::from_millis(1)))
            .map_err(|e| {
                AppError::with_detail(
                    ErrorCode::LspRequestFailed,
                    e.message.clone(),
                    json!({ "code": e.code, "message": e.message }),
                )
            })
    }

    pub(crate) fn cancel(&self, tag: &str) {
        let conn = self.inner.lock().unwrap().conn.clone();
        if let Some(c) = conn {
            c.cancel(tag);
        }
    }

    /// FR-7 document tracking + forwarding, in call order (the lock is held
    /// across the write). While `starting`, nothing is sent — the replay after
    /// `initialize` carries the latest text of every open document.
    pub(crate) fn notify(&self, method: &str, params: Value) -> Result<(), AppError> {
        let mut g = self.inner.lock().unwrap();
        if !matches!(g.state, LspState::Starting | LspState::Ready) {
            return Err(not_running());
        }
        let generation = g.generation;
        let conn = (g.state == LspState::Ready)
            .then(|| g.conn.clone())
            .flatten();
        let uri = params
            .pointer("/textDocument/uri")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let key = doc_key(&uri);
        let send = |m: &str, p: Value| {
            if let Some(c) = &conn {
                let _ = c.notify(m, p);
            }
        };
        match method {
            "textDocument/didOpen" => {
                let td = &params["textDocument"];
                let text = td["text"].as_str().unwrap_or_default().to_string();
                g.idle_since = None;
                if let Some(d) = g.docs.get_mut(&key).filter(|d| d.sent_gen == generation) {
                    // Already open in this process (the core replayed it): a
                    // second didOpen is a protocol error — sync the text instead.
                    d.version = td["version"].clone();
                    if d.text != text {
                        d.text = text.clone();
                        send(
                            "textDocument/didChange",
                            json!({
                                "textDocument": { "uri": uri, "version": d.version },
                                "contentChanges": [{ "text": text }]
                            }),
                        );
                    }
                    return Ok(());
                }
                let mut d = Doc {
                    uri: uri.clone(),
                    language_id: td["languageId"].clone(),
                    version: td["version"].clone(),
                    text,
                    sent_gen: 0,
                };
                if conn.is_some() {
                    send(method, params);
                    d.sent_gen = generation;
                }
                g.docs.insert(key, d);
            }
            "textDocument/didChange" => {
                if let Some(d) = g.docs.get_mut(&key) {
                    d.version = params["textDocument"]["version"].clone();
                    let last = params["contentChanges"]
                        .as_array()
                        .and_then(|c| c.last())
                        .filter(|c| c.get("range").is_none())
                        .and_then(|c| c["text"].as_str());
                    if let Some(t) = last {
                        d.text = t.to_string();
                    }
                    if d.sent_gen == generation {
                        send(method, params);
                    }
                } else {
                    send(method, params);
                }
            }
            "textDocument/didClose" => {
                let was_sent = g.docs.remove(&key).is_none_or(|d| d.sent_gen == generation);
                if was_sent {
                    send(method, params);
                }
                if g.docs.is_empty() {
                    g.idle_since = Some((self.ctx.clock)());
                }
            }
            _ => send(method, params), // didSave
        }
        Ok(())
    }

    fn on_notification(&self, generation: u64, method: &str, params: Value) {
        let events = {
            let mut g = self.inner.lock().unwrap();
            if g.generation != generation {
                return;
            }
            let roots = g.roots.clone();
            match method {
                "textDocument/publishDiagnostics" => {
                    let uri = params["uri"].as_str().unwrap_or_default().to_string();
                    if !is_under(&uri, &self.root_uri) {
                        return; // §7: outside the root
                    }
                    let version = params["version"].as_i64();
                    let diagnostics = params["diagnostics"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let ev: Vec<LspEvent> = roots
                        .iter()
                        .map(|r| LspEvent::Diagnostics {
                            root: r.clone(),
                            language: self.language,
                            uri: uri.clone(),
                            version,
                            diagnostics: diagnostics.clone(),
                        })
                        .collect();
                    ev
                }
                "$/progress" => {
                    let token = match &params["token"] {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    let value = &params["value"];
                    let kind = value["kind"].as_str().unwrap_or_default();
                    if !matches!(kind, "begin" | "report" | "end") {
                        return;
                    }
                    if let Some(t) = value["title"].as_str() {
                        g.progress_titles.insert(token.clone(), t.to_string());
                    }
                    let title = if kind == "end" {
                        g.progress_titles.remove(&token)
                    } else {
                        g.progress_titles.get(&token).cloned()
                    };
                    let text = |k: &str| value[k].as_str().map(str::to_string);
                    let ev: Vec<LspEvent> = roots
                        .iter()
                        .map(|r| LspEvent::Progress {
                            root: r.clone(),
                            language: self.language,
                            token: token.clone(),
                            title: title.clone(),
                            message: text("message"),
                            percentage: value["percentage"].as_f64(),
                            done: kind == "end",
                        })
                        .collect();
                    ev
                }
                "window/logMessage" | "window/showMessage" => {
                    eprintln!(
                        "[lsp {}] {}",
                        spec(self.language).display,
                        params["message"].as_str().unwrap_or_default()
                    );
                    return;
                }
                _ => return,
            }
        };
        self.emit_all(events);
    }

    /// FR-7: stop when no document has been open for `idle_stop_ms`.
    fn idle_tick(&self) {
        let due = {
            let g = self.inner.lock().unwrap();
            matches!(g.state, LspState::Starting | LspState::Ready)
                && g.docs.is_empty()
                && idle_due(g.idle_since, (self.ctx.clock)(), self.ctx.idle_stop_ms)
        };
        if due {
            self.stop();
        }
    }
}

fn did_open(d: &Doc) -> Value {
    json!({
        "textDocument": {
            "uri": d.uri,
            "languageId": d.language_id,
            "version": d.version,
            "text": d.text,
        }
    })
}

fn not_running() -> AppError {
    AppError::new(
        ErrorCode::LspNotRunning,
        "the language server is not running",
    )
}

/// One thread per server; it ends when the server is dropped.
fn spawn_idle_watch(server: Weak<Server>, idle_ms: u64) {
    let poll = Duration::from_millis((idle_ms / 4).clamp(5, 30_000));
    std::thread::spawn(move || loop {
        std::thread::sleep(poll);
        match server.upgrade() {
            Some(s) => s.idle_tick(),
            None => break,
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_policy_allows_three_restarts_per_window_then_crashes() {
        let mut p = RestartPolicy::default();
        let t0 = 1_000_000;
        assert!(p.record_exit(t0));
        assert!(p.record_exit(t0 + 1_000));
        assert!(p.record_exit(t0 + 2_000));
        assert!(
            !p.record_exit(t0 + 3_000),
            "the 4th exit in the window crashes"
        );
    }

    #[test]
    fn restart_policy_forgets_exits_older_than_the_window() {
        let mut p = RestartPolicy::default();
        let t0 = 0;
        assert!(p.record_exit(t0));
        assert!(p.record_exit(t0 + 10));
        assert!(p.record_exit(t0 + 20));
        // The first three are now outside the window.
        assert!(p.record_exit(t0 + 20 + LSP_RESTART_WINDOW_MS));
        assert!(p.record_exit(t0 + 21 + LSP_RESTART_WINDOW_MS));
        p.reset();
        assert!(p.record_exit(5));
    }

    #[test]
    fn idle_is_due_only_after_the_full_quiet_period() {
        assert!(!idle_due(None, 10_000, 100));
        assert!(!idle_due(Some(1_000), 1_099, 100));
        assert!(idle_due(Some(1_000), 1_100, 100));
    }
}
