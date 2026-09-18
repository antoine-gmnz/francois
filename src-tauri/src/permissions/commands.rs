//! the francois:permissions:<verb> Tauri command surface (§5.1).

use super::*;
use crate::ipc::{AppError, ErrorCode};

use crate::ipc::IpcResult;
use crate::session::Engine;
use std::path::PathBuf;
use tauri::State;

// ---------- Tauri commands (§5.1) ----------

/// Both tier paths for a session. `SESSION_NOT_FOUND` when the session is gone;
/// the global path is `None` when it cannot be resolved (§7 #4) — listing then
/// shows local only, and a global write reports SETTINGS_WRITE_FAILED.
pub fn tiers_for(engine: &Engine, session_id: &str) -> Option<(PathBuf, Option<PathBuf>)> {
    let cwd = engine.cwd_of(session_id)?;
    let runtime = engine
        .runtime_of(session_id)
        .unwrap_or_else(|| "native".into());
    Some((
        local_settings_path(&cwd),
        global_settings_path(&cwd, &runtime),
    ))
}

pub const NO_GLOBAL: &str = "could not locate the global Claude settings directory";

/// The only two tier names the contract's `PermissionTier` union allows.
pub fn is_valid_tier(tier: &str) -> bool {
    tier == "local" || tier == "global"
}

/// FR-6: parse a `PermissionDecision` into `(allow, remember)`. `None` ⇒
/// `INVALID_INPUT`. Split out of `permissions_decide` (which needs a
/// `State<Engine>` and an `AppHandle`, so it cannot be unit-tested) purely so the
/// decision matrix is pinned by a test.
pub fn decide_outcome(decision: &str) -> Option<(bool, bool)> {
    match decision {
        "allowOnce" => Some((true, false)),
        "denyOnce" => Some((false, false)),
        "allowAlways" => Some((true, true)),
        "denyAlways" => Some((false, true)),
        _ => None,
    }
}

/// Resolve a tier name to its settings path for a WRITE.
pub fn tier_path(engine: &Engine, session_id: &str, tier: &str) -> Result<PathBuf, AppError> {
    let Some((local, global)) = tiers_for(engine, session_id) else {
        return Err(AppError::new(ErrorCode::SessionNotFound, "no such session"));
    };
    if tier == "global" {
        return global.ok_or(AppError::new(ErrorCode::SettingsWriteFailed, NO_GLOBAL));
    }
    Ok(local)
}

/// francois:permissions:list (FR-17).
#[tauri::command(async)]
pub fn permissions_list(
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Vec<PermissionRule>> {
    list_of(&engine, &session_id).into()
}

fn list_of(engine: &Engine, session_id: &str) -> Result<Vec<PermissionRule>, AppError> {
    let Some((local, global)) = tiers_for(engine, session_id) else {
        return Err(AppError::new(ErrorCode::SessionNotFound, "no such session"));
    };
    Ok(list_rules(&local, global.as_deref()))
}

/// Look a rule up in the FRESH list (FR-18) — an id the user is acting on may
/// have been deleted externally since the editor rendered it (§7 #13).
pub fn locate(
    engine: &Engine,
    session_id: &str,
    rule_id: &str,
) -> Result<(PermissionRule, PathBuf, PathBuf, Option<PathBuf>), AppError> {
    let Some((local, global)) = tiers_for(engine, session_id) else {
        return Err(AppError::new(ErrorCode::SessionNotFound, "no such session"));
    };
    let Some((tier, _, _)) = parse_rule_id(rule_id) else {
        return Err(AppError::new(
            ErrorCode::RuleNotFound,
            "that rule no longer exists",
        ));
    };
    let rule = list_rules(&local, global.as_deref())
        .into_iter()
        .find(|r| r.id == rule_id)
        .ok_or(AppError::new(
            ErrorCode::RuleNotFound,
            "that rule no longer exists",
        ))?;
    let settings = if tier == "global" {
        global
            .clone()
            .ok_or(AppError::new(ErrorCode::SettingsWriteFailed, NO_GLOBAL))?
    } else {
        local.clone()
    };
    Ok((rule, settings, local, global))
}

/// francois:permissions:setEnabled (FR-15/FR-18): move the pattern between
/// `permissions.<effect>` and the sidecar's parking lot.
#[tauri::command(async)]
pub fn permissions_set_enabled(
    engine: State<'_, Engine>,
    session_id: String,
    rule_id: String,
    enabled: bool,
) -> IpcResult<Vec<PermissionRule>> {
    set_enabled(&engine, &session_id, &rule_id, enabled).into()
}

fn set_enabled(
    engine: &Engine,
    session_id: &str,
    rule_id: &str,
    enabled: bool,
) -> Result<Vec<PermissionRule>, AppError> {
    let (rule, settings, local, global) = locate(engine, session_id, rule_id)?;
    if rule.enabled != enabled {
        if enabled {
            write_rule(&settings, &rule.tier, &rule.effect, &rule.pattern)?;
        } else {
            park_rule(&settings, &rule.effect, &rule.pattern)?;
        }
    }
    Ok(list_rules(&local, global.as_deref()))
}

/// francois:permissions:remove (FR-18): clear the pattern from BOTH the settings
/// file and the sidecar, so a delete is a real delete.
#[tauri::command(async)]
pub fn permissions_remove(
    engine: State<'_, Engine>,
    session_id: String,
    rule_id: String,
) -> IpcResult<Vec<PermissionRule>> {
    remove_rule(&engine, &session_id, &rule_id).into()
}

fn remove_rule(
    engine: &Engine,
    session_id: &str,
    rule_id: &str,
) -> Result<Vec<PermissionRule>, AppError> {
    let (rule, settings, local, global) = locate(engine, session_id, rule_id)?;
    drop_rule(&settings, &rule.effect, &rule.pattern)?;
    Ok(list_rules(&local, global.as_deref()))
}

/// francois:permissions:setTier (FR-18): move a rule between tiers, preserving
/// whether it is enabled. Same-tier is a no-op that still returns the list.
#[tauri::command(async)]
pub fn permissions_set_tier(
    engine: State<'_, Engine>,
    session_id: String,
    rule_id: String,
    tier: String,
) -> IpcResult<Vec<PermissionRule>> {
    set_tier(&engine, &session_id, &rule_id, &tier).into()
}

fn set_tier(
    engine: &Engine,
    session_id: &str,
    rule_id: &str,
    tier: &str,
) -> Result<Vec<PermissionRule>, AppError> {
    // Validate BEFORE locate(): §5.1 lists no INVALID_INPUT for this channel, and
    // there is no reason to read both tiers' files to reject a bad argument.
    if !is_valid_tier(tier) {
        return Err(AppError::new(
            ErrorCode::RuleNotFound,
            "that rule no longer exists",
        ));
    }
    let (rule, from, local, global) = locate(engine, session_id, rule_id)?;
    if rule.tier == tier {
        return Ok(list_rules(&local, global.as_deref()));
    }
    let to = if tier == "global" {
        global
            .clone()
            .ok_or(AppError::new(ErrorCode::SettingsWriteFailed, NO_GLOBAL))?
    } else {
        local.clone()
    };
    move_rule(&from, &to, tier, &rule.effect, &rule.pattern, rule.enabled)?;
    Ok(list_rules(&local, global.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- FR-6: the decision matrix ----

    #[test]
    fn decide_outcome_maps_the_four_decisions_and_rejects_anything_else() {
        assert_eq!(decide_outcome("allowOnce"), Some((true, false)));
        assert_eq!(decide_outcome("denyOnce"), Some((false, false)));
        assert_eq!(decide_outcome("allowAlways"), Some((true, true)));
        assert_eq!(decide_outcome("denyAlways"), Some((false, true)));
        for bad in ["", "allow", "AllowOnce", "allowalways", "nonsense"] {
            assert_eq!(decide_outcome(bad), None, "{bad} must be INVALID_INPUT");
        }
    }

    #[test]
    fn only_the_contract_s_two_tier_names_are_valid() {
        assert!(is_valid_tier("local"));
        assert!(is_valid_tier("global"));
        for bad in ["", "Global", "LOCAL", "project", "user"] {
            assert!(!is_valid_tier(bad), "{bad} must be rejected");
        }
    }
}
