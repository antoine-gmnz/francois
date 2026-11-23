//! Keep the Mac awake while a session is doing work.
//!
//! An unattended run used to die with the machine: idle sleep cuts the API
//! response mid-stream (`API Error: Your computer went to sleep mid-response`).
//! While work is in flight we hold a `caffeinate -i` assertion, which stops idle
//! sleep only: the display still sleeps, and closing the lid still sleeps the Mac.
//!
//! What counts as work is deliberately narrow. A session parked on the user is
//! waiting, not working, and a settled session whose only background task is a
//! dev server would otherwise hold the machine up forever, so only a streaming
//! turn or a running background AGENT qualifies.
//!
//! `-w <our pid>` makes `caffeinate` exit with the app, so a crash cannot leave
//! the assertion behind.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use super::{status, Engine};
use tauri::AppHandle;

/// Does this session's current state justify keeping the machine awake?
pub(crate) fn session_needs_awake(state: &str, live_turn: bool, background_agents: usize) -> bool {
    matches!(state, status::STARTING | status::RUNNING) || (live_turn && background_agents > 0)
}

fn engine_needs_awake(engine: &Engine) -> bool {
    engine.sessions.lock().unwrap().values().any(|s| {
        let agents = s
            .agents
            .values()
            .filter(|a| a.background && a.status == "running")
            .count();
        session_needs_awake(&s.status, s.current.is_some(), agents)
    })
}

/// Start the watcher. Called once from `.setup()`; a no-op off macOS.
pub fn start_keep_awake(app: AppHandle) {
    #[cfg(target_os = "macos")]
    std::thread::spawn(move || {
        use tauri::Manager;
        let mut holder: Option<std::process::Child> = None;
        loop {
            let wanted = app
                .try_state::<Engine>()
                .is_some_and(|engine| engine_needs_awake(&engine));
            sync_holder(&mut holder, wanted);
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
    });
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
fn sync_holder(holder: &mut Option<std::process::Child>, wanted: bool) {
    // Reap a holder that died on its own, so the next tick can replace it.
    if holder
        .as_mut()
        .is_some_and(|child| !matches!(child.try_wait(), Ok(None)))
    {
        *holder = None;
    }
    if wanted && holder.is_none() {
        *holder = crate::process_util::spawn("/usr/bin/caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .start()
            .ok();
    } else if !wanted {
        if let Some(mut child) = holder.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_streaming_turn_keeps_the_machine_awake() {
        assert!(session_needs_awake(status::STARTING, true, 0));
        assert!(session_needs_awake(status::RUNNING, true, 0));
    }

    #[test]
    fn a_settled_session_stays_awake_only_for_a_running_agent() {
        assert!(session_needs_awake(status::IDLE, true, 1));
        // A dev server is a background task but not an agent: no overnight hold.
        assert!(!session_needs_awake(status::IDLE, true, 0));
        assert!(!session_needs_awake(status::IDLE, false, 0));
    }

    #[test]
    fn a_session_parked_on_the_user_does_not_hold_the_machine() {
        assert!(!session_needs_awake(status::AWAITING_APPROVAL, true, 0));
        assert!(!session_needs_awake(status::AWAITING_INPUT, true, 0));
        // Unless an agent is still working behind the card.
        assert!(session_needs_awake(status::AWAITING_APPROVAL, true, 1));
    }
}
