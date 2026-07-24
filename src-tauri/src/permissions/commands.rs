//! the francois:permissions:<verb> Tauri command surface (§5.1).

use super::*;

use crate::ipc::{err, ok, IpcResult};
use crate::session::Engine;
use std::path::PathBuf;
use tauri::State;

// ---------- Tauri commands (§5.1) ----------

/// Both tier paths for a session. `SESSION_NOT_FOUND` when the session is gone;
/// the global path is `None` when it cannot be resolved (§7 #4) — listing then
/// shows local only, and a global write reports SETTINGS_WRITE_FAILED.
pub(crate) fn tiers_for(engine: &Engine, session_id: &str) -> Option<(PathBuf, Option<PathBuf>)> {
    let cwd = engine.cwd_of(session_id)?;
    let runtime = engine
        .runtime_of(session_id)
        .unwrap_or_else(|| "native".into());
    Some((
        local_settings_path(&cwd),
        global_settings_path(&cwd, &runtime),
    ))
}

pub(crate) const NO_GLOBAL: &str = "could not locate the global Claude settings directory";

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
pub fn tier_path(
    engine: &Engine,
    session_id: &str,
    tier: &str,
) -> Result<PathBuf, (&'static str, String)> {
    let Some((local, global)) = tiers_for(engine, session_id) else {
        return Err(("SESSION_NOT_FOUND", "no such session".into()));
    };
    if tier == "global" {
        return global.ok_or(("SETTINGS_WRITE_FAILED", NO_GLOBAL.into()));
    }
    Ok(local)
}

/// francois:permissions:list (FR-17).
#[tauri::command(async)]
pub fn permissions_list(
    engine: State<'_, Engine>,
    session_id: String,
) -> IpcResult<Vec<PermissionRule>> {
    match tiers_for(&engine, &session_id) {
        None => err("SESSION_NOT_FOUND", "no such session"),
        Some((local, global)) => ok(list_rules(&local, global.as_deref())),
    }
}

/// Look a rule up in the FRESH list (FR-18) — an id the user is acting on may
/// have been deleted externally since the editor rendered it (§7 #13).
pub(crate) fn locate(
    engine: &Engine,
    session_id: &str,
    rule_id: &str,
) -> Result<(PermissionRule, PathBuf, PathBuf, Option<PathBuf>), (&'static str, String)> {
    let Some((local, global)) = tiers_for(engine, session_id) else {
        return Err(("SESSION_NOT_FOUND", "no such session".into()));
    };
    let Some((tier, _, _)) = parse_rule_id(rule_id) else {
        return Err(("RULE_NOT_FOUND", "that rule no longer exists".into()));
    };
    let rule = list_rules(&local, global.as_deref())
        .into_iter()
        .find(|r| r.id == rule_id)
        .ok_or(("RULE_NOT_FOUND", "that rule no longer exists".into()))?;
    let settings = if tier == "global" {
        global
            .clone()
            .ok_or(("SETTINGS_WRITE_FAILED", NO_GLOBAL.into()))?
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
    let (rule, settings, local, global) = match locate(&engine, &session_id, &rule_id) {
        Ok(v) => v,
        Err((code, msg)) => return err(code, msg),
    };
    if rule.enabled != enabled {
        let outcome = if enabled {
            write_rule(&settings, &rule.tier, &rule.effect, &rule.pattern).map(|_| ())
        } else {
            park_rule(&settings, &rule.effect, &rule.pattern)
        };
        if let Err(msg) = outcome {
            return err("SETTINGS_WRITE_FAILED", msg);
        }
    }
    ok(list_rules(&local, global.as_deref()))
}

/// francois:permissions:remove (FR-18): clear the pattern from BOTH the settings
/// file and the sidecar, so a delete is a real delete.
#[tauri::command(async)]
pub fn permissions_remove(
    engine: State<'_, Engine>,
    session_id: String,
    rule_id: String,
) -> IpcResult<Vec<PermissionRule>> {
    let (rule, settings, local, global) = match locate(&engine, &session_id, &rule_id) {
        Ok(v) => v,
        Err((code, msg)) => return err(code, msg),
    };
    if let Err(msg) = drop_rule(&settings, &rule.effect, &rule.pattern) {
        return err("SETTINGS_WRITE_FAILED", msg);
    }
    ok(list_rules(&local, global.as_deref()))
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
    // Validate BEFORE locate(): §5.1 lists no INVALID_INPUT for this channel, and
    // there is no reason to read both tiers' files to reject a bad argument.
    if !is_valid_tier(&tier) {
        return err("RULE_NOT_FOUND", "that rule no longer exists");
    }
    let (rule, from, local, global) = match locate(&engine, &session_id, &rule_id) {
        Ok(v) => v,
        Err((code, msg)) => return err(code, msg),
    };
    if rule.tier == tier {
        return ok(list_rules(&local, global.as_deref()));
    }
    let to = if tier == "global" {
        match global.clone() {
            Some(p) => p,
            None => return err("SETTINGS_WRITE_FAILED", NO_GLOBAL),
        }
    } else {
        local.clone()
    };
    let moved = move_rule(&from, &to, &tier, &rule.effect, &rule.pattern, rule.enabled);
    if let Err(msg) = moved {
        return err("SETTINGS_WRITE_FAILED", msg);
    }
    ok(list_rules(&local, global.as_deref()))
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
