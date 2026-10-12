// lsp/host_tests.rs — end-to-end over a real child process (testutil's fake
// server): trust gate, initialize -> ready, request/response with URIs, server
// -> client requests, diagnostics + progress events, cancel and timeout, crash
// -> restart -> didOpen replay, crashed past the limit, idle stop, revoke.

use super::testutil::fake_resolution;
use super::uri::dir_to_uri;
use super::{Ctx, LspEvent, LspHost, LspLanguage, LspState};
use crate::editor::testutil::TempDir;
use crate::editor::EditorRoot;
use crate::ipc::ErrorCode;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const TS: LspLanguage = LspLanguage::Typescript;

struct Rig {
    host: LspHost,
    events: Arc<Mutex<Vec<LspEvent>>>,
    tmp: TempDir,
    root: EditorRoot,
}

impl Rig {
    fn new(idle_ms: u64, request_timeout_ms: u64) -> Rig {
        let tmp = TempDir::new();
        let events: Arc<Mutex<Vec<LspEvent>>> = Arc::default();
        let sink = events.clone();
        let mut ctx = Ctx::new(Arc::new(move |e| sink.lock().unwrap().push(e)));
        ctx.idle_stop_ms = idle_ms;
        ctx.request_timeout_ms = request_timeout_ms;
        ctx.init_timeout_ms = 15_000;
        let host = LspHost::with(
            tmp.path().join("lsp-trust.json"),
            Box::new(|_, l| (l == LspLanguage::Typescript).then(fake_resolution)),
            ctx,
        );
        Rig {
            host,
            events,
            tmp,
            root: EditorRoot::Project {
                project_id: "p1".into(),
            },
        }
    }

    fn dir(&self) -> String {
        self.tmp.path().to_string_lossy().into_owned()
    }

    fn uri(&self, file: &str) -> String {
        format!("{}/{file}", dir_to_uri(&self.dir()))
    }

    fn mark(&self) -> usize {
        self.events.lock().unwrap().len()
    }

    /// The first event at or after `from` matching `pred`.
    fn wait(&self, from: usize, what: &str, pred: impl Fn(&LspEvent) -> bool) -> LspEvent {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(e) = self.events.lock().unwrap()[from..].iter().find(|e| pred(e)) {
                return e.clone();
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_state(&self, from: usize, state: LspState) -> super::LspServerStatus {
        match self.wait(from, &format!("{state:?}"), |e| {
            matches!(e, LspEvent::Status { status } if status.state == state && status.root == self.root)
        }) {
            LspEvent::Status { status } => status,
            _ => unreachable!(),
        }
    }

    fn wait_diag(&self, from: usize, message: &str) -> LspEvent {
        self.wait(from, message, |e| {
            matches!(e, LspEvent::Diagnostics { diagnostics, .. }
                if diagnostics.first().and_then(|d| d["message"].as_str()) == Some(message))
        })
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), crate::ipc::AppError> {
        self.host
            .notify_impl(&self.root, &self.dir(), TS, method, params)
    }

    fn request(
        &self,
        method: &str,
        params: Value,
        tag: Option<&str>,
    ) -> Result<Value, crate::ipc::AppError> {
        self.host
            .request_impl(&self.root, &self.dir(), TS, method, params, tag)
    }

    fn start_ready(&self) {
        let m = self.mark();
        let st = self.host.start_impl(&self.root, &self.dir(), TS).unwrap();
        assert!(matches!(st.state, LspState::Starting | LspState::Ready));
        self.wait_state(m, LspState::Ready);
    }
}

#[test]
fn trust_gate_initialize_requests_events_cancel_timeout_crash_restart_replay() {
    let rig = Rig::new(10 * 60_000, 1_500);
    let (root, dir) = (rig.root.clone(), rig.dir());

    // ---- status + the trust gate ----
    let st = rig.host.statuses_impl(&root, &dir);
    let states: Vec<LspState> = st.iter().map(|s| s.state).collect();
    assert_eq!(
        states,
        vec![
            LspState::Untrusted,
            LspState::Missing,
            LspState::Missing,
            LspState::Missing
        ]
    );
    assert_eq!(
        (st[0].server.as_str(), st[0].program.as_deref()),
        ("fake-lsp", None)
    );
    assert_eq!(
        st[1].install_hint.as_deref(),
        Some("rustup component add rust-analyzer")
    );
    assert_eq!(st[0].root_uri, dir_to_uri(&dir));
    let e = rig.host.start_impl(&root, &dir, TS).unwrap_err();
    assert_eq!(e.code, ErrorCode::LspUntrusted);
    let e = rig
        .host
        .start_impl(&root, &dir, LspLanguage::Go)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::LspNotInstalled);
    assert_eq!(
        e.detail,
        Some(json!({ "installHint": "go install golang.org/x/tools/gopls@latest" }))
    );
    assert_eq!(
        rig.notify("textDocument/didSave", json!({}))
            .unwrap_err()
            .code,
        ErrorCode::LspNotRunning
    );

    let st = rig.host.trust_impl(&root, &dir, true).unwrap();
    assert_eq!(st[0].state, LspState::Stopped);
    assert!(st[0].program.is_some());

    // ---- initialize -> ready; server -> client request answered ----
    let m = rig.mark();
    rig.start_ready();
    let ready = rig.wait_state(m, LspState::Ready);
    assert_eq!(ready.version.as_deref(), Some("1.2.3"));
    let progress = rig.wait(m, "progress begin", |e| {
        matches!(e, LspEvent::Progress { done: false, .. })
    });
    assert!(
        matches!(&progress, LspEvent::Progress { token, title: Some(t), .. }
        if token == "7" && t == "[null,null]")
    );
    let end = rig.wait(m, "progress end", |e| {
        matches!(e, LspEvent::Progress { done: true, .. })
    });
    assert!(
        matches!(&end, LspEvent::Progress { title: Some(t), message: Some(msg), .. }
        if t == "[null,null]" && msg == "done")
    );

    // ---- didOpen -> diagnostics (outside-root ones dropped) ----
    let a = rig.uri("a.ts");
    let m = rig.mark();
    rig.notify(
        "textDocument/didOpen",
        json!({ "textDocument": { "uri": a, "languageId": "typescript", "version": 1, "text": "hello" } }),
    )
    .unwrap();
    let d = rig.wait_diag(m, "hello");
    assert!(matches!(&d, LspEvent::Diagnostics { uri, version: Some(1), .. } if *uri == a));
    assert!(!rig
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, LspEvent::Diagnostics { uri, .. } if uri.contains("elsewhere"))));

    // ---- request -> response ----
    let hover = rig
        .request(
            "textDocument/hover",
            json!({ "textDocument": { "uri": a }, "position": { "line": 0, "character": 0 } }),
            None,
        )
        .unwrap();
    assert_eq!(
        hover["contents"]["value"],
        format!("{a}|{}|{}", dir_to_uri(&dir), std::process::id())
    );
    let e = rig
        .request("workspace/executeCommand", json!({}), None)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::LspMethodNotAllowed);

    // ---- cancel and timeout ----
    let def = json!({ "textDocument": { "uri": a }, "position": { "line": 0, "character": 0 } });
    std::thread::scope(|s| {
        let pending = s.spawn(|| rig.request("textDocument/definition", def.clone(), Some("t1")));
        std::thread::sleep(Duration::from_millis(300));
        rig.host.cancel_impl(&dir, TS, "t1");
        let e = pending.join().unwrap().unwrap_err();
        assert_eq!(e.code, ErrorCode::LspRequestFailed);
        assert_eq!(e.detail.unwrap()["code"], -32800);
    });
    rig.host.cancel_impl(&dir, TS, "t1"); // already answered: a no-op
    let e = rig
        .request("textDocument/definition", def, None)
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::LspRequestFailed);
    assert_eq!(e.detail.unwrap()["code"], -32803);

    // ---- didChange keeps the latest text; crash -> restart -> replay ----
    let m = rig.mark();
    rig.notify(
        "textDocument/didChange",
        json!({ "textDocument": { "uri": a, "version": 2 }, "contentChanges": [{ "text": "world" }] }),
    )
    .unwrap();
    rig.wait_diag(m, "world");
    let m = rig.mark();
    rig.notify(
        "textDocument/didSave",
        json!({ "textDocument": { "uri": a } }),
    )
    .unwrap();
    let restarting = rig.wait_state(m, LspState::Starting);
    assert!(restarting.error.unwrap_or_default().contains("boom"));
    rig.wait_state(m, LspState::Ready);
    let replayed = rig.wait_diag(m, "world");
    assert!(matches!(
        replayed,
        LspEvent::Diagnostics {
            version: Some(2),
            ..
        }
    ));

    // A webview re-sending didOpen after the restart must not double-open.
    let m = rig.mark();
    rig.notify(
        "textDocument/didOpen",
        json!({ "textDocument": { "uri": a, "languageId": "typescript", "version": 3, "text": "again" } }),
    )
    .unwrap();
    rig.wait_diag(m, "again");

    // ---- two more restarts are allowed, the fourth exit in the window crashes ----
    for _ in 0..2 {
        let m = rig.mark();
        rig.notify(
            "textDocument/didSave",
            json!({ "textDocument": { "uri": a } }),
        )
        .unwrap();
        rig.wait_state(m, LspState::Ready);
    }
    let m = rig.mark();
    rig.notify(
        "textDocument/didSave",
        json!({ "textDocument": { "uri": a } }),
    )
    .unwrap();
    let crashed = rig.wait_state(m, LspState::Crashed);
    assert!(crashed.error.unwrap_or_default().contains("boom"));
    assert_eq!(
        rig.notify("textDocument/didSave", json!({}))
            .unwrap_err()
            .code,
        ErrorCode::LspNotRunning
    );

    // ---- lsp_start on crashed resets and retries; a second root shares it ----
    rig.start_ready();
    let session = EditorRoot::Session {
        session_id: "s1".into(),
    };
    assert_eq!(
        rig.host.status_impl(&session, &dir, TS).state,
        LspState::Ready
    );
    let m = rig.mark();
    rig.host.stop_impl(&root, &dir, TS);
    rig.wait_state(m, LspState::Stopped);
    rig.wait(m, "stopped for the session root", |e| {
        matches!(e, LspEvent::Status { status } if status.root == session && status.state == LspState::Stopped)
    });
    rig.host.stop_impl(&root, &dir, TS); // stopping a stopped server is ok
    rig.host.stop_all_impl();
}

#[test]
fn idle_stop_fires_only_without_open_documents() {
    let rig = Rig::new(150, 5_000);
    let dir = rig.dir();
    rig.host.trust_impl(&rig.root, &dir, true).unwrap();

    let m = rig.mark();
    rig.start_ready();
    rig.wait_state(m, LspState::Stopped);

    rig.start_ready();
    let a = rig.uri("a.ts");
    rig.notify(
        "textDocument/didOpen",
        json!({ "textDocument": { "uri": a, "languageId": "typescript", "version": 1, "text": "x" } }),
    )
    .unwrap();
    let m = rig.mark();
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        !rig.events.lock().unwrap()[m..]
            .iter()
            .any(|e| matches!(e, LspEvent::Status { status } if status.state == LspState::Stopped)),
        "an open document keeps the server alive"
    );
    rig.notify(
        "textDocument/didClose",
        json!({ "textDocument": { "uri": a } }),
    )
    .unwrap();
    rig.wait_state(m, LspState::Stopped);
    rig.host.stop_all_impl();
}

#[test]
fn revoking_trust_stops_the_roots_servers() {
    let rig = Rig::new(10 * 60_000, 5_000);
    let dir = rig.dir();
    rig.host.trust_impl(&rig.root, &dir, true).unwrap();
    rig.start_ready();
    let m = rig.mark();
    let st = rig.host.trust_impl(&rig.root, &dir, false).unwrap();
    assert_eq!(st[0].state, LspState::Untrusted);
    rig.wait_state(m, LspState::Stopped);
    rig.wait_state(m, LspState::Untrusted);
    assert_eq!(
        rig.request("textDocument/hover", json!({}), None)
            .unwrap_err()
            .code,
        ErrorCode::LspNotRunning
    );
}
