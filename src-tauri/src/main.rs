#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Francois core. Feature domains live in their own module directories; this file
// is only Tauri bootstrap (state, setup, the command table, the run loop).
//  * shell-terminal — session-keyed registry of real PTYs (shell/).
//  * session-engine — Claude Code session lifecycle + event stream (session/).

mod diagnostics;
mod diff;
mod fs_util;
mod ipc;
mod permissions;
mod process_util;
mod project;
mod session;
mod shell;
mod usage;
mod window;
mod wsl;

// session::session_remove disposes a session's shell without depending on the
// shell module directly — re-exported at the crate root so `crate::dispose_session_shell`
// keeps resolving exactly as before this domain moved out of main.rs.
pub(crate) use shell::dispose_session_shell;

use tauri::{Manager, RunEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(shell::Registry::default())
        .manage(session::Engine::default())
        // projects §6: the registry is loaded once at startup (see setup below)
        // and is memory-authoritative thereafter — Francois is its only writer.
        .manage(project::ProjectRegistry::default())
        .manage(session::RemoteRegistry::default())
        // usage-bar §6: the app-scoped usage cache lives in its OWN mutex, never
        // inside session::Engine — a leaf lock the probe path can take freely.
        .manage(usage::UsageState::default())
        .setup(|app| {
            diagnostics::install_panic_log(app.handle());
            // Tint with the dark caption up front; the webview re-tints with the
            // persisted theme (app_set_window_theme) once it mounts. See §theme.
            #[cfg(windows)]
            if let Some(w) = app.get_webview_window("main") {
                window::tint_window_chrome(&w, "dark");
            }
            // projects FR-1/FR-3: load the registry BEFORE sessions, so
            // load_persisted can drop a projectId that no longer resolves (FR-18).
            project::load_projects(app.handle());
            session::load_persisted(app.handle());
            session::warm_model_cache(app.handle().clone());
            // usage-bar FR-11/FR-12: probe once now, then every 5 minutes.
            usage::start_timers(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            shell::commands::shell_ensure,
            shell::commands::shell_write,
            shell::commands::shell_resize,
            shell::commands::shell_dispose,
            session::session_list,
            session::session_create,
            session::session_remove,
            session::session_send,
            session::session_interrupt,
            session::session_answer_question,
            session::session_switch_model,
            session::session_compact,
            session::session_clear,
            session::session_list_commands,
            session::session_models,
            session::session_pick_directory,
            session::session_attach_file,
            session::session_attach_clipboard_image,
            session::session_pick_attachments,
            session::session_release_attachment,
            session::session_commit_attachments,
            session::session_clear_attachments,
            project::project_list,
            project::project_create,
            project::project_update,
            project::project_remove,
            project::project_get_standards,
            project::project_set_standards,
            session::conversation_get_transcript,
            session::agents_list,
            session::agents_dispatch,
            session::agents_kill,
            session::agents_activity,
            session::agents_transcript,
            session::mcp_registry,
            session::mcp_list,
            session::mcp_detail,
            session::mcp_reconnect,
            session::mcp_detach,
            session::mcp_attach,
            session::skills_list,
            session::skills_install,
            session::skills_run,
            session::permissions_decide,
            session::remote_start,
            session::remote_stop,
            session::remote_get,
            session::session_worktree_probe,
            session::session_worktree_status,
            session::session_worktree_remove,
            permissions::permissions_list,
            permissions::permissions_set_enabled,
            permissions::permissions_remove,
            permissions::permissions_set_tier,
            window::app_set_window_theme,
            usage::app_get_usage,
            usage::app_refresh_usage,
            diff::diff_get_summary,
            diff::diff_get_file_diff,
            diff::diff_stage_all,
            diff::diff_commit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building francois")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                shell::kill_all_shells(app);
                session::kill_all(app);
                // remote-control: the hosts are real interactive `claude`
                // processes — leaking them leaves remote sessions live on the
                // user's claude.ai account after Francois is gone.
                session::kill_all_remote(app);
                usage::kill_probe(app); // usage-bar §7 #9 — no orphan `claude`
            }
        });
}
