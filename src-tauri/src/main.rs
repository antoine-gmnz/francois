#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Francois core. Feature domains live in their own module directories; this file
// is only Tauri bootstrap (state, setup, the command table, the run loop).
//  * shell-terminal — session-keyed registry of real PTYs (shell/).
//  * session-engine — Claude Code session lifecycle + event stream (session/).

mod account;
mod diagnostics;
mod diff;
mod editor;
mod extensions;
mod fs_util;
mod ipc;
mod permissions;
mod process_util;
mod project;
mod session;
mod shell;
mod update;
mod usage;
mod window;
mod wsl;

// session::session_remove disposes a session's shells without depending on the
// shell module directly — re-exported at the crate root so `crate::dispose_session_shells`
// keeps resolving exactly as before this domain moved out of main.rs.
pub(crate) use shell::dispose_session_shells;

use tauri::RunEvent;
// `get_webview_window` is a `Manager` method; only the windows-only chrome tint
// below calls it, so the import is gated too (an unconditional one warns as
// unused on macOS/Linux).
#[cfg(windows)]
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(shell::Registry::default())
        .manage(session::Engine::default())
        // projects §6: the registry is loaded once at startup (see setup below)
        // and is memory-authoritative thereafter — Francois is its only writer.
        .manage(project::ProjectRegistry::default())
        .manage(session::RemoteRegistry::default())
        // cloud-sessions §6: `ref → { killer, phase, … }` for the at-most-one
        // adoption per cloud session (§7 #9). Process-lifetime only — nothing
        // about a cloud session is ever persisted.
        .manage(session::CloudAdoptRegistry::default())
        // usage-bar §6: the app-scoped usage cache lives in its OWN mutex, never
        // inside session::Engine — a leaf lock the probe path can take freely.
        .manage(usage::UsageState::default())
        // multi-account §6: the account registry + the single in-flight login.
        // Another LEAF lock — nothing under account/ ever takes Engine.sessions.
        .manage(account::AccountState::default())
        // self-update §6/FR-19: the last UpdateCheck, in memory only. Another
        // LEAF lock — `update::app_apply_update` reads the engine's running
        // count BEFORE it ever touches this.
        .manage(update::UpdateState::default())
        // extensions §6: the toggles, the per-root detection cache and the live
        // log-tail streams. Another LEAF lock — nothing under extensions/ ever
        // takes Engine.sessions, and no other domain takes this one.
        .manage(extensions::ExtensionState::default())
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
            // multi-account FR-1: same discipline — the account registry loads
            // BEFORE sessions, so load_persisted can fall an accountId that no
            // longer resolves back to `default` (FR-10).
            account::load_accounts(app.handle());
            session::load_persisted(app.handle());
            session::warm_model_cache(app.handle().clone());
            // usage-bar FR-11/FR-12: probe once now, then every 5 minutes.
            usage::start_timers(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            shell::commands::shell_ensure,
            shell::commands::shell_create,
            shell::commands::shell_restart,
            shell::commands::shell_rename,
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
            session::session_rename,
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
            project::project_repo_brief,
            session::conversation_get_transcript,
            session::agents_list,
            session::agents_dispatch,
            session::agents_kill,
            session::agents_activity,
            session::agents_transcript,
            session::workflows_list,
            // workflow-details §5: the run's agents, one agent's transcript, and
            // the script the harness wrote.
            session::workflows_detail,
            session::workflows_agent,
            session::workflows_script,
            session::mcp_registry,
            session::mcp_list,
            session::mcp_detail,
            session::mcp_reconnect,
            session::mcp_detach,
            session::mcp_attach,
            session::mcp_approvals,
            session::mcp_decide,
            session::skills_list,
            session::skills_install,
            session::skills_run,
            session::permissions_decide,
            session::remote_start,
            session::remote_stop,
            session::remote_get,
            // cloud-sessions: adopt a Claude Code on the web session.
            session::cloud_list,
            session::cloud_resolve,
            session::cloud_adopt,
            session::session_worktree_probe,
            session::session_worktree_status,
            session::session_worktree_remove,
            editor::session_editor_list,
            editor::session_open_in_editor,
            permissions::permissions_list,
            permissions::permissions_set_enabled,
            permissions::permissions_remove,
            permissions::permissions_set_tier,
            window::app_set_window_theme,
            usage::app_get_usage,
            usage::app_refresh_usage,
            update::app_check_update,
            update::app_apply_update,
            account::account_list,
            account::account_add,
            account::account_login_write,
            account::account_login_resize,
            account::account_login_cancel,
            account::account_rename,
            account::account_set_default,
            account::account_remove,
            extensions::extensions_list,
            extensions::extensions_set_enabled,
            extensions::extensions_detect,
            extensions::extensions_panel,
            extensions::extensions_open_stream,
            extensions::extensions_close_stream,
            extensions::extensions_probe,
            extensions::extensions_launch,
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
                // cloud-sessions FR-11: an adoption PTY is an interactive
                // `claude` mid-teleport — leaking one leaves a half-adopted
                // session with nobody draining its master.
                session::kill_all_cloud_adoptions(app);
                usage::kill_probe(app); // usage-bar §7 #9 — no orphan `claude`
                                        // multi-account FR-16: an in-flight login is a real `claude` on
                                        // a PTY plus a half-written config dir — both go on exit.
                account::cancel_all_logins(app);
                // extensions FR-43: a `log-tail` process source is a real child
                // (`docker logs -f`) — it goes with the window, like every other
                // process this app owns.
                extensions::kill_all_streams(app);
            }
        });
}
