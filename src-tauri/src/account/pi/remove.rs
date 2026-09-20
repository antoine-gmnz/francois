//! pi-provider-auth FR-6/FR-8: what makes REMOVING a Pi account different
//! from removing every other kind — the in-use gate, and the targeted undo a
//! refused removal needs. `commands.rs`'s `account_remove` is this child's
//! only caller; it lives here rather than there because that file sits at
//! CLAUDE.md's ~1000-line cap and this is a Pi concern, not a registry one.

use super::*;
use crate::ipc::{err, err_detail, AppError, ErrorCode, IpcResult};

use tauri::AppHandle;

/// FR-4/FR-8, the in-lock half of the gate: an open setup PTY IS this account
/// executing right now, so removing the row out from under it is the same
/// class of hazard as a connected session — and `account_trust_pi` already
/// refuses on exactly this condition (`trust_pi_gate`). Without it, a removal
/// mid-setup leaves the frontend's setup terminal with no `login.done`/
/// `login.failed` to close on: the reader thread's `claim_pi_setup` finds the
/// handle already dropped by `cancel_login_for_account` and settles nothing.
///
/// Pure over `AccountInner` (no cross-domain lock), so unlike the blocked-
/// sessions half this is safe to run while the account lock is held.
pub(crate) fn pi_remove_gate(inner: &AccountInner, id: &str) -> Result<(), AppError> {
    if setup_pty_open_for(inner, id) {
        return Err(AppError::new(
            ErrorCode::AccountInUse,
            "close this account's open setup before removing it",
        ));
    }
    Ok(())
}

/// FR-6/FR-8: the post-write recheck, closing the window between
/// `account_remove`'s pre-write check and its write — a session that started
/// using this Pi account in between must not have its row disappear under it.
/// `Some(_)` IS the command's answer (the removal was refused and undone);
/// `None` means the removal stands.
///
/// Runs with the account lock RELEASED, because `sessions_pinned_to` locks
/// `Engine.sessions` and the crate-wide order is `Engine.sessions` →
/// `AccountState` (see `sessions_currently_use`'s LOCK ORDER doc).
pub(crate) fn refuse_removal_if_in_use<T: serde::Serialize>(
    app: &AppHandle,
    state: &AccountState,
    id: &str,
    previous: &RegistrySnapshot,
) -> Option<IpcResult<T>> {
    let blocked = super::sessions_pinned_to(app, id);
    if blocked.is_empty() {
        return None;
    }
    let accounts = {
        let Ok(mut inner) = state.0.lock() else {
            return Some(err(ErrorCode::Internal, "account state is unavailable"));
        };
        undo_remove(&mut inner, previous, id);
        if let Err(e) = persist(app, &inner) {
            // The refusal is no longer the worst fact to report: memory says
            // the account is back, accounts.json says it is gone, and the next
            // launch would read the removal as final. That is what the caller
            // has to see — with the blocked sessions still attached, so the UI
            // can still name them.
            return Some(err_detail(
                ErrorCode::Internal,
                format!(
                    "this account still has sessions using it, and the refused removal could not be written back: {}",
                    e.message
                ),
                serde_json::json!({ "blockedSessions": blocked }),
            ));
        }
        build_list(&inner)
    };
    emit(app, AccountEvent::List { accounts });
    Some(err_detail(
        ErrorCode::AccountInUse,
        "this account still has sessions using it — stop them before removing it",
        serde_json::json!({ "blockedSessions": blocked }),
    ))
}

/// Undo EXACTLY what `apply_remove` did — the row at its own index, its
/// `auth_failed_at` stamp, and the default flag if it was the one carrying it
/// — onto whatever the registry is NOW.
///
/// Targeted rather than `restore`'s whole-snapshot re-apply, because the
/// account lock is RELEASED between the removal's write and this undo: an
/// `account_add`/`account_rename`/`account_set_default` that landed in that
/// window is a change nobody asked to revert, and re-applying the pre-removal
/// snapshot would silently drop it.
pub(crate) fn undo_remove(inner: &mut AccountInner, previous: &RegistrySnapshot, id: &str) {
    if inner.records.iter().any(|r| r.id == id) {
        return; // already back — nothing this call removed
    }
    let Some(index) = previous.0.iter().position(|r| r.id == id) else {
        return;
    };
    let at = index.min(inner.records.len());
    inner.records.insert(at, previous.0[index].clone());
    if let Some(stamp) = previous.2.get(id) {
        inner.auth_failed_at.insert(id.to_string(), *stamp);
    }
    // `apply_remove` only moves the flag when the removed row held it — and
    // putting it back must not steal it from a row made default meanwhile.
    if previous.1 == id && inner.default_account_id == DEFAULT_ACCOUNT_ID {
        inner.default_account_id = id.to_string();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::testutil::*;

    #[test]
    fn an_open_setup_pty_blocks_removal_the_same_way_it_blocks_a_trust_change() {
        let mut inner = inner_fixture(&[], "default");
        inner.records.push(pi_record_fixture("p1", "Pi", true));
        assert!(pi_remove_gate(&inner, "p1").is_ok());
        inner
            .pi_setups
            .insert("login-1".into(), pi_setup_handle_fixture("p1"));
        assert_eq!(
            pi_remove_gate(&inner, "p1").unwrap_err().code,
            ErrorCode::AccountInUse
        );
        assert!(pi_remove_gate(&inner, "other").is_ok());
    }

    #[test]
    fn undoing_a_removal_restores_the_row_its_place_its_stamp_and_its_default_flag() {
        let mut inner = inner_fixture(&["a1", "a2", "a3"], "a2");
        inner.auth_failed_at.insert("a2".into(), 7);
        let previous = snapshot(&inner);
        apply_remove(&mut inner, "a2").unwrap();
        assert_eq!(inner.default_account_id, "default");
        assert!(!inner.auth_failed_at.contains_key("a2"));

        undo_remove(&mut inner, &previous, "a2");
        let ids: Vec<&str> = inner.records.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["a1", "a2", "a3"], "back at its own index");
        assert_eq!(inner.default_account_id, "a2");
        assert_eq!(inner.auth_failed_at.get("a2"), Some(&7));
    }

    #[test]
    fn undoing_a_removal_keeps_a_row_added_while_the_lock_was_released() {
        // The whole point of a TARGETED undo: `restore`'s whole-snapshot
        // re-apply would drop `a9` on the floor.
        let mut inner = inner_fixture(&["a1", "a2"], "default");
        let previous = snapshot(&inner);
        apply_remove(&mut inner, "a2").unwrap();
        inner.records.push(record_fixture("a9", "added meanwhile"));
        undo_remove(&mut inner, &previous, "a2");
        let ids: Vec<&str> = inner.records.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["a1", "a2", "a9"]);
    }

    #[test]
    fn undoing_a_removal_never_steals_the_default_flag_back() {
        let mut inner = inner_fixture(&["a1", "a2"], "a2");
        let previous = snapshot(&inner);
        apply_remove(&mut inner, "a2").unwrap();
        // Someone made a1 the default in the window.
        inner.default_account_id = "a1".into();
        undo_remove(&mut inner, &previous, "a2");
        assert_eq!(inner.default_account_id, "a1");
    }

    #[test]
    fn undoing_a_removal_twice_inserts_the_row_once() {
        let mut inner = inner_fixture(&["a1", "a2"], "default");
        let previous = snapshot(&inner);
        apply_remove(&mut inner, "a2").unwrap();
        undo_remove(&mut inner, &previous, "a2");
        undo_remove(&mut inner, &previous, "a2");
        assert_eq!(inner.records.iter().filter(|r| r.id == "a2").count(), 1);
    }
}
