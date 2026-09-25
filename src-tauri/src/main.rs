#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Francois core — Tauri bootstrap only (state, setup, the command table, the
// run loop). core-architecture-wave3 FR-2: every feature domain now lives
// behind the `francois` library target (`lib.rs`); this file is an external
// crate relative to it.

use francois::{
    account, cohorte, diagnostics, diff, dnd, editor, extensions, github, permissions, profiles,
    project, session, shell, update, usage, window,
};

use tauri::RunEvent;
// `get_webview_window` is a `Manager` method — needed unconditionally now:
// the windows-only chrome tint below, the rework-topbar frameless-window setup
// (Windows/Linux), and the post-setup `show()` every platform needs (the
// window starts hidden — see the `visible: false` note below).
use tauri::Manager;

fn main() {
    // Before any child — PTY, `claude`, git — inherits the launch directory.
    update::leave_launch_dir();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(shell::Registry::default())
        .manage(session::Engine::default())
        // projects §6: the registry is loaded once at startup (see setup below)
        // and is memory-authoritative thereafter — Francois is its only writer.
        .manage(project::ProjectRegistry::default())
        // session-profiles §6: the profile registry, app-scoped and shared
        // across every account (FR-2) — same load-once-at-startup discipline
        // as projects/accounts.
        .manage(profiles::ProfileRegistry::default())
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
        // cohorte-integration §6: detection/probe caches + the per-root watchers.
        .manage(cohorte::CohorteState::default())
        .manage(std::sync::Arc::new(
            cohorte::python_service::PythonState::default(),
        ))
        .setup(|app| {
            diagnostics::install_panic_log(app.handle());
            // core-architecture-wave3 FR-9: the crate root is the one place that
            // legitimately knows about both domains, so it is where they are
            // wired together. FIRST in `.setup()` — every later step can create
            // sessions, and a session removed before this ran would orphan its
            // PTYs silently.
            session::register_teardown(vec![Box::new(shell::ShellTeardown)]);
            // Same wiring, the other direction: removing an account repoints the
            // sessions bound to it, and `account` no longer names `session` to
            // say so.
            account::register_removal_observers(vec![Box::new(session::SessionAccountObserver)]);
            // pr-142 §9: the same inversion once more — removing a profile
            // clears the project defaults naming it, and `profiles` no longer
            // names `project` to say so.
            profiles::register_removal_observers(vec![Box::new(project::ProjectProfileObserver)]);
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
            // session-profiles: no ordering dependency on session load — a
            // session's profile ref is snapshotted verbatim and never
            // re-resolved (FR-16) — loaded here alongside its registry peers.
            profiles::load_profiles(app.handle());
            // MUST come after all three registries above: it drops project
            // defaults naming a profile/account that no longer exists, validating
            // against what those loads produced. Running it earlier would see
            // empty registries and invalidate every id — which is also why it
            // refuses to act on a registry that came back empty
            // (session-profiles §A2 / multi-account §A1).
            project::reconcile_defaults(app.handle());
            // MUST come before load_persisted: a session's context window is
            // derived from the model catalog at load time, so a cold catalog
            // gave every session the 200K placeholder (and clamped its used
            // figure against it). The disk mirror makes the real windows
            // available synchronously, before the first session exists.
            session::load_model_cache(app.handle());
            session::load_persisted(app.handle());
            // FR-9: transcripts hydrate off the main thread, one session at a
            // time, each landing via its own `session.meta` — `.setup()`
            // itself performs no transcript read, so the window paints first.
            session::spawn_transcript_hydration(app.handle().clone());
            session::warm_model_cache(app.handle().clone());
            // extension-install FR-1/FR-13: load the manifest registry from
            // ~/.francois/extensions/ once at startup — the other FR-13
            // trigger is an explicit `extensions_detect`.
            extensions::load_registry(app.handle());
            // usage-bar FR-11/FR-12: probe once now, then every 5 minutes.
            usage::start_timers(app.handle().clone());
            // rework-topbar: Windows/Linux go frameless — this app bar draws
            // its own caption buttons (WindowControls.tsx); the OS chrome
            // would otherwise draw a second set. macOS keeps its native
            // traffic lights untouched. Tauri 2 keeps resize borders on an
            // undecorated Windows window as long as the shadow stays on, so
            // that gets re-asserted right after — `set_decorations` can drop
            // it on some Windows builds.
            #[cfg(not(target_os = "macos"))]
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_decorations(false);
                #[cfg(windows)]
                let _ = w.set_shadow(true);
            }
            // The window starts hidden (`"visible": false` in tauri.conf.json
            // / tauri.dev.conf.json) precisely so `set_decorations` above runs
            // BEFORE the first paint — undecorating a window already on
            // screen is a visible flash (the native caption disappearing out
            // from under the content). Shown here, once, after every setup
            // step above has had its say.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }
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
            session::session_unqueue,
            session::session_interrupt,
            session::session_answer_question,
            session::session_switch_model,
            session::session_switch_permission_mode,
            session::session_switch_effort,
            session::session_switch_response_mode,
            session::session_rename,
            session::session_update_settings,
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
            project::project_create_group,
            project::project_rename_group,
            project::project_remove_group,
            project::project_assign_group,
            project::project_get_standards,
            project::project_set_standards,
            project::project_repo_brief,
            profiles::profiles_list,
            profiles::profiles_create,
            profiles::profiles_update,
            profiles::profiles_remove,
            session::conversation_get_transcript,
            session::conversation_step_detail,
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
            github::github_repo_info,
            github::github_fetch,
            github::github_list_pulls,
            github::github_get_pull,
            github::github_update_pull_branch,
            github::github_merge_pull,
            github::github_list_commits,
            github::github_get_commit,
            github::github_list_branches,
            github::github_worktree_disk_usage,
            github::github_create_worktree,
            github::github_prune,
            github::github_open_url,
            github::github_list_checks,
            github::github_get_job,
            github::github_get_step_log,
            github::github_rerun_failed,
            cohorte::cohorte_detect,
            cohorte::cohorte_doctor,
            cohorte::cohorte_policy,
            cohorte::cohorte_init,
            cohorte::cohorte_watch,
            cohorte::cohorte_list_runs,
            cohorte::cohorte_get_run,
            cohorte::cohorte_run_log,
            cohorte::cohorte_approve,
            cohorte::cohorte_send_to_fix,
            cohorte::cohorte_deny,
            cohorte::cohorte_pause,
            cohorte::cohorte_resume,
            cohorte::cohorte_cancel,
            cohorte::python_service::cohorte_v3_detect,
            cohorte::python_service::cohorte_v3_doctor,
            cohorte::python_service::cohorte_v3_policy,
            cohorte::python_service::cohorte_v3_init,
            cohorte::python_service::cohorte_v3_watch,
            cohorte::python_service::cohorte_v3_list_runs,
            cohorte::python_service::cohorte_v3_get_run,
            cohorte::python_service::cohorte_v3_run_log,
            cohorte::python_service::cohorte_v3_features,
            cohorte::python_service::cohorte_v3_start,
            cohorte::python_service::cohorte_v3_approve,
            cohorte::python_service::cohorte_v3_answer,
            cohorte::python_service::cohorte_v3_send_to_fix,
            cohorte::python_service::cohorte_v3_deny,
            cohorte::python_service::cohorte_v3_pause,
            cohorte::python_service::cohorte_v3_resume,
            cohorte::python_service::cohorte_v3_cancel,
            cohorte::actions_cli::cohorte_action_intake,
            cohorte::actions_cli::cohorte_action_preview,
            permissions::permissions_list,
            permissions::permissions_set_enabled,
            permissions::permissions_remove,
            permissions::permissions_set_tier,
            window::app_set_window_theme,
            dnd::app_dnd_state,
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
            account::account_add_endpoint,
            account::account_add_codex,
            account::account_codex_login,
            account::account_add_grok,
            account::account_grok_login,
            account::account_update_endpoint,
            account::account_test_endpoint,
            account::account_cli_tools,
            account::account_install_cli,
            extensions::extensions_list,
            extensions::extensions_set_enabled,
            extensions::extensions_detect,
            extensions::extensions_consent,
            extensions::extensions_panel,
            extensions::extensions_open_stream,
            extensions::extensions_close_stream,
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
                session::kill_model_probes();
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
                // FR-10: compact every idle session's on-disk transcript to
                // its retention bound — best-effort, skips a session mid-turn.
                session::compact_all_transcripts(app);
                // FR-10 counterpart for the step-detail sidecar: without this
                // it grows unbounded for the whole life of every retained
                // session — same best-effort, skips a session mid-turn.
                session::compact_all_step_details(app);
            }
        });
}
