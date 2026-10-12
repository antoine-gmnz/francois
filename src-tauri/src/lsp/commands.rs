// lsp/commands.rs — code-editor-lsp §5: `lsp_status`, `lsp_trust`,
// `lsp_start`, `lsp_stop`, `lsp_request`, `lsp_cancel`, `lsp_notify`, plus the
// app-quit hook. The `*_impl` methods on `LspHost` take an already-resolved
// root directory, so they are testable without a Tauri `AppHandle`; the
// commands only resolve the EditorRoot (editor's own resolver) and delegate.

use super::lifecycle::Server;
use super::servers::{spec, Resolution};
use super::uri::dir_to_uri;
use super::{
    dir_key, Ctx, LspEvent, LspHost, LspLanguage, LspServerStatus, LspState, ServerKey,
    LSP_ALLOWED_NOTIFICATIONS, LSP_ALLOWED_REQUESTS,
};
use crate::editor::EditorRoot;
use crate::ipc::{AppError, ErrorCode, IpcResult};
use crate::session::Engine;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

type CoreResult<T> = Result<T, AppError>;

/// FR-3.
pub(crate) fn check_request_method(method: &str) -> CoreResult<()> {
    allowed(&LSP_ALLOWED_REQUESTS, method)
}

pub(crate) fn check_notify_method(method: &str) -> CoreResult<()> {
    allowed(&LSP_ALLOWED_NOTIFICATIONS, method)
}

fn allowed(list: &[&str], method: &str) -> CoreResult<()> {
    if list.contains(&method) {
        Ok(())
    } else {
        Err(AppError::with_detail(
            ErrorCode::LspMethodNotAllowed,
            format!("{method} is not an allowed language-server method"),
            json!({ "method": method }),
        ))
    }
}

impl LspHost {
    /// Tests build a host with an injected trust file, resolver and context.
    #[cfg(test)]
    pub(crate) fn with(
        trust_file: std::path::PathBuf,
        resolver: super::Resolver,
        ctx: Ctx,
    ) -> Self {
        let host = LspHost {
            servers: Default::default(),
            probes: Default::default(),
            trust: std::sync::Mutex::new(super::trust::TrustStore::new(Some(trust_file))),
            resolver,
            ctx: std::sync::OnceLock::new(),
        };
        let _ = host.ctx.set(ctx);
        host
    }

    fn ctx(&self) -> &Ctx {
        self.ctx
            .get()
            .expect("the lsp context is set before any command runs")
    }

    fn ensure_ctx(&self, app: &AppHandle) {
        self.ctx.get_or_init(|| {
            let app = app.clone();
            Ctx::new(Arc::new(move |ev: LspEvent| {
                let _ = app.emit("francois://lsp/event", &ev);
            }))
        });
    }

    /// FR-2: re-probed at most every 30 s per (directory, language).
    fn resolution(&self, dir: &str, lang: LspLanguage) -> Option<Resolution> {
        let key = dir_key(dir);
        let now = (self.ctx().clock)();
        if let Some(hit) = self.probes.lock().unwrap().get(&key, lang, now) {
            return hit;
        }
        let r = (self.resolver)(dir, lang);
        self.probes.lock().unwrap().put(&key, lang, now, r.clone());
        r
    }

    fn server(&self, dir: &str, lang: LspLanguage) -> Option<Arc<Server>> {
        let key = ServerKey {
            dir_key: dir_key(dir),
            language: lang,
        };
        self.servers.lock().unwrap().get(&key).cloned()
    }

    fn is_trusted(&self, dir: &str) -> bool {
        self.trust.lock().unwrap().is_trusted(dir)
    }

    pub(crate) fn status_impl(
        &self,
        root: &EditorRoot,
        dir: &str,
        lang: LspLanguage,
    ) -> LspServerStatus {
        let res = self.resolution(dir, lang);
        if let Some(s) = self.server(dir, lang) {
            s.add_root(root);
            if res.is_some() || s.state() != LspState::Stopped {
                return s.status_for(root);
            }
        }
        let s = spec(lang);
        let base = LspServerStatus {
            root: root.clone(),
            language: lang,
            state: LspState::Missing,
            server: s.display.to_string(),
            version: None,
            program: None,
            install_hint: None,
            error: None,
            root_uri: dir_to_uri(dir),
        };
        // `missing` wins over `untrusted`: the FR-15 prompt is only offered for
        // a language whose server is installed.
        match res {
            None => LspServerStatus {
                install_hint: Some(s.install_hint.to_string()),
                ..base
            },
            Some(r) if !self.is_trusted(dir) => LspServerStatus {
                state: LspState::Untrusted,
                server: r.server,
                ..base
            },
            Some(r) => LspServerStatus {
                state: LspState::Stopped,
                server: r.server,
                version: r.version,
                program: Some(r.program),
                ..base
            },
        }
    }

    pub(crate) fn statuses_impl(&self, root: &EditorRoot, dir: &str) -> Vec<LspServerStatus> {
        LspLanguage::ALL
            .iter()
            .map(|l| self.status_impl(root, dir, *l))
            .collect()
    }

    /// FR-4. Revoking stops (and forgets) every server of that directory.
    pub(crate) fn trust_impl(
        &self,
        root: &EditorRoot,
        dir: &str,
        trusted: bool,
    ) -> CoreResult<Vec<LspServerStatus>> {
        let write = self.trust.lock().unwrap().set(dir, trusted);
        let mut extra_roots: Vec<EditorRoot> = Vec::new();
        if !trusted {
            let key = dir_key(dir);
            let removed: Vec<Arc<Server>> = {
                let mut map = self.servers.lock().unwrap();
                let keys: Vec<ServerKey> =
                    map.keys().filter(|k| k.dir_key == key).cloned().collect();
                keys.iter().filter_map(|k| map.remove(k)).collect()
            };
            for s in removed {
                extra_roots.extend(s.roots().into_iter().filter(|r| r != root));
                s.stop();
            }
        }
        let statuses = self.statuses_impl(root, dir);
        for s in &statuses {
            (self.ctx().emit)(LspEvent::Status { status: s.clone() });
        }
        extra_roots.dedup();
        for r in extra_roots {
            for s in self.statuses_impl(&r, dir) {
                (self.ctx().emit)(LspEvent::Status { status: s });
            }
        }
        write.map_err(|e| {
            AppError::new(
                ErrorCode::Internal,
                format!("could not save language-server trust: {e}"),
            )
        })?;
        Ok(statuses)
    }

    pub(crate) fn start_impl(
        &self,
        root: &EditorRoot,
        dir: &str,
        lang: LspLanguage,
    ) -> CoreResult<LspServerStatus> {
        let Some(res) = self.resolution(dir, lang) else {
            let hint = spec(lang).install_hint;
            return Err(AppError::with_detail(
                ErrorCode::LspNotInstalled,
                format!("{} is not installed", spec(lang).display),
                json!({ "installHint": hint }),
            ));
        };
        if !self.is_trusted(dir) {
            return Err(AppError::new(
                ErrorCode::LspUntrusted,
                "language servers are not allowed for this root",
            ));
        }
        let server = {
            let key = ServerKey {
                dir_key: dir_key(dir),
                language: lang,
            };
            let mut map = self.servers.lock().unwrap();
            map.entry(key)
                .or_insert_with(|| {
                    Server::new(
                        self.ctx().clone(),
                        root.clone(),
                        dir_to_uri(dir),
                        lang,
                        res.clone(),
                    )
                })
                .clone()
        };
        server.add_root(root);
        server
            .start(Some(res))
            .map_err(|e| AppError::new(ErrorCode::Internal, e))?;
        Ok(server.status_for(root))
    }

    pub(crate) fn stop_impl(&self, root: &EditorRoot, dir: &str, lang: LspLanguage) {
        if let Some(s) = self.server(dir, lang) {
            s.add_root(root);
            s.stop();
        }
    }

    fn running(&self, root: &EditorRoot, dir: &str, lang: LspLanguage) -> CoreResult<Arc<Server>> {
        let s = self.server(dir, lang).ok_or_else(|| {
            AppError::new(
                ErrorCode::LspNotRunning,
                "the language server is not running",
            )
        })?;
        s.add_root(root);
        Ok(s)
    }

    pub(crate) fn request_impl(
        &self,
        root: &EditorRoot,
        dir: &str,
        lang: LspLanguage,
        method: &str,
        params: Value,
        request_id: Option<&str>,
    ) -> CoreResult<Value> {
        check_request_method(method)?;
        self.running(root, dir, lang)?
            .request(method, params, request_id)
    }

    pub(crate) fn cancel_impl(&self, dir: &str, lang: LspLanguage, request_id: &str) {
        if let Some(s) = self.server(dir, lang) {
            s.cancel(request_id);
        }
    }

    pub(crate) fn notify_impl(
        &self,
        root: &EditorRoot,
        dir: &str,
        lang: LspLanguage,
        method: &str,
        params: Value,
    ) -> CoreResult<()> {
        check_notify_method(method)?;
        self.running(root, dir, lang)?.notify(method, params)
    }

    /// FR-7: app quit stops every server, in parallel.
    pub(crate) fn stop_all_impl(&self) {
        let all: Vec<Arc<Server>> = self
            .servers
            .lock()
            .unwrap()
            .drain()
            .map(|(_, s)| s)
            .collect();
        let handles: Vec<_> = all
            .into_iter()
            .map(|s| std::thread::spawn(move || s.stop()))
            .collect();
        for h in handles {
            let _ = h.join();
        }
    }
}

// ---------- commands ----------

fn root_dir(app: &AppHandle, root: &EditorRoot) -> CoreResult<String> {
    let host = app.state::<LspHost>();
    host.ensure_ctx(app);
    crate::editor::resolve_root_dir(app, &app.state::<Engine>(), root)
}

/// Every command does its work off the async runtime: a probe, a graceful
/// stop and a request wait can each block for seconds.
async fn blocking<T: serde::Serialize + Send + 'static>(
    app: AppHandle,
    root: EditorRoot,
    job: impl FnOnce(&LspHost, &EditorRoot, &str) -> CoreResult<T> + Send + 'static,
) -> IpcResult<T> {
    let run = move || {
        let dir = root_dir(&app, &root)?;
        job(&app.state::<LspHost>(), &root, &dir)
    };
    match tauri::async_runtime::spawn_blocking(run).await {
        Ok(r) => r.into(),
        Err(e) => AppError::new(ErrorCode::Internal, format!("lsp task failed: {e}")).into(),
    }
}

/// francois:lsp:status — one entry per language, never spawns a server.
#[tauri::command]
pub async fn lsp_status(app: AppHandle, root: EditorRoot) -> IpcResult<Vec<LspServerStatus>> {
    blocking(app, root, |h, r, d| Ok(h.statuses_impl(r, d))).await
}

/// francois:lsp:trust (FR-4).
#[tauri::command]
pub async fn lsp_trust(
    app: AppHandle,
    root: EditorRoot,
    trusted: bool,
) -> IpcResult<Vec<LspServerStatus>> {
    blocking(app, root, move |h, r, d| h.trust_impl(r, d, trusted)).await
}

/// francois:lsp:start — resolves once spawned (`starting`).
#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    root: EditorRoot,
    language: LspLanguage,
) -> IpcResult<LspServerStatus> {
    blocking(app, root, move |h, r, d| h.start_impl(r, d, language)).await
}

/// francois:lsp:stop — graceful; stopping a stopped server is ok.
#[tauri::command]
pub async fn lsp_stop(
    app: AppHandle,
    root: EditorRoot,
    language: LspLanguage,
) -> IpcResult<Option<()>> {
    blocking(app, root, move |h, r, d| {
        h.stop_impl(r, d, language);
        Ok(None)
    })
    .await
}

/// francois:lsp:request (FR-3).
#[tauri::command]
pub async fn lsp_request(
    app: AppHandle,
    root: EditorRoot,
    language: LspLanguage,
    method: String,
    params: Value,
    request_id: Option<String>,
) -> IpcResult<Value> {
    blocking(app, root, move |h, r, d| {
        h.request_impl(r, d, language, &method, params, request_id.as_deref())
    })
    .await
}

/// francois:lsp:cancel — a no-op once answered.
#[tauri::command]
pub async fn lsp_cancel(
    app: AppHandle,
    root: EditorRoot,
    language: LspLanguage,
    request_id: String,
) -> IpcResult<Option<()>> {
    blocking(app, root, move |h, _, d| {
        h.cancel_impl(d, language, &request_id);
        Ok(None)
    })
    .await
}

/// francois:lsp:notify — in call order. Synchronous on purpose: sync commands
/// run one after another in invoke order, where two async ones could reach the
/// server out of order (a didChange overtaking its didOpen desynchronises the
/// document). Cheap: a lock, the document bookkeeping and a queued frame —
/// the write itself happens on the connection's writer thread.
#[tauri::command]
pub fn lsp_notify(
    app: AppHandle,
    engine: State<'_, Engine>,
    host: State<'_, LspHost>,
    root: EditorRoot,
    language: LspLanguage,
    method: String,
    params: Value,
) -> IpcResult<Option<()>> {
    host.ensure_ctx(&app);
    crate::editor::resolve_root_dir(&app, &engine, &root)
        .and_then(|d| host.notify_impl(&root, &d, language, &method, params))
        .map(|()| None)
        .into()
}

/// App quit (FR-7).
pub fn stop_all(app: &AppHandle) {
    if let Some(h) = app.try_state::<LspHost>() {
        h.stop_all_impl();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_allowlist_admits_exactly_the_contract_methods() {
        for m in LSP_ALLOWED_REQUESTS {
            assert!(check_request_method(m).is_ok(), "{m}");
            assert_eq!(
                check_notify_method(m).unwrap_err().code,
                ErrorCode::LspMethodNotAllowed
            );
        }
        for m in LSP_ALLOWED_NOTIFICATIONS {
            assert!(check_notify_method(m).is_ok(), "{m}");
            assert!(check_request_method(m).is_err());
        }
        for m in [
            "workspace/executeCommand",
            "shutdown",
            "exit",
            "initialize",
            "$/cancelRequest",
            "textDocument/Hover",
            "",
        ] {
            let e = check_request_method(m).unwrap_err();
            assert_eq!(e.code, ErrorCode::LspMethodNotAllowed);
            assert_eq!(e.detail, Some(json!({ "method": m })));
            assert!(check_notify_method(m).is_err());
        }
    }
}
