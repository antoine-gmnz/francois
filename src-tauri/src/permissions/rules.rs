//! FR-15/FR-16/FR-17: rule identity, the disabled sidecar, listing and writes.

use super::*;

use crate::ipc::AppError;
use serde_json::{Map, Value};
use std::path::Path;

// ---------- FR-16: rule identity ----------

pub fn rule_id(tier: &str, effect: &str, pattern: &str) -> String {
    format!("{tier}|{effect}|{pattern}")
}

/// Split a rule id back into its parts. `splitn(3)` because a pattern may itself
/// contain `|` (`Bash(a || b)`) while a tier and an effect never can.
pub fn parse_rule_id(id: &str) -> Option<(String, String, String)> {
    let mut it = id.splitn(3, '|');
    let tier = it.next()?;
    let effect = it.next()?;
    let pattern = it.next()?;
    if pattern.is_empty() || !EFFECT_ORDER.contains(&effect) {
        return None;
    }
    Some((tier.into(), effect.into(), pattern.into()))
}

// ---------- FR-15: the disabled sidecar ----------

/// `(effect, pattern)` pairs parked in the sidecar. A missing or unparseable
/// sidecar reads as empty — it is a Francois convenience, never a source of truth
/// worth failing an operation over.
pub fn read_disabled(settings: &Path) -> Vec<(String, String)> {
    let Ok(doc) = read_json_object(&sidecar_path(settings)) else {
        return Vec::new();
    };
    doc.get("disabled")
        .and_then(|d| d.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let effect = e.get("effect")?.as_str()?;
                    let pattern = e.get("pattern")?.as_str()?;
                    EFFECT_ORDER
                        .contains(&effect)
                        .then(|| (effect.to_string(), pattern.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Rewrite the sidecar's `disabled` array, preserving any other key it carries.
pub fn write_disabled(settings: &Path, entries: &[(String, String)]) -> Result<(), AppError> {
    let path = sidecar_path(settings);
    let mut doc = read_json_object(&path).unwrap_or_else(|_| Value::Object(Map::new()));
    let arr: Vec<Value> = entries
        .iter()
        .map(|(effect, pattern)| serde_json::json!({ "effect": effect, "pattern": pattern }))
        .collect();
    let Some(obj) = doc.as_object_mut() else {
        return Err(settings_err(format!(
            "{} is not a JSON object",
            path.display()
        )));
    };
    obj.insert("disabled".into(), Value::Array(arr));
    write_json_atomic(&path, &doc)
}

pub fn set_disabled(
    settings: &Path,
    effect: &str,
    pattern: &str,
    on: bool,
) -> Result<(), AppError> {
    let mut entries = read_disabled(settings);
    let present = entries.iter().any(|(e, p)| e == effect && p == pattern);
    if on == present {
        return Ok(());
    }
    if on {
        entries.push((effect.to_string(), pattern.to_string()));
    } else {
        entries.retain(|(e, p)| !(e == effect && p == pattern));
    }
    write_disabled(settings, &entries)
}

// ---------- FR-17: listing ----------

pub fn rules_of_tier(tier: &str, settings: &Path) -> Vec<PermissionRule> {
    // A tier whose settings file is unreadable/unparseable contributes NOTHING
    // rather than failing the whole listing — the editor must still open so the
    // user can see (and fix) the other tier. Writes are where we hard-fail.
    let doc = read_json_object(settings).unwrap_or_else(|_| Value::Object(Map::new()));
    let disabled = read_disabled(settings);
    let mut out = Vec::new();
    for effect in EFFECT_ORDER {
        let live = patterns_of(&doc, effect);
        for pattern in &live {
            out.push(make_rule(tier, effect, pattern, true));
        }
        // A pattern that is live in settings.json AND parked in the sidecar must
        // list ONCE, as enabled. That state is reachable through the documented
        // three-writer scenario (§3 flow 7: the user disables a rule, then the
        // CLI or a hand edit re-adds it) and rule ids are derived from
        // tier|effect|pattern (FR-16), so listing it twice would produce two rows
        // with the SAME id — and `locate()` takes the first, so a toggle or a
        // delete could act on the wrong row. Settings.json wins: it is what Claude
        // actually enforces.
        for (_, pattern) in disabled
            .iter()
            .filter(|(e, p)| e == effect && !live.contains(p))
        {
            out.push(make_rule(tier, effect, pattern, false));
        }
    }
    out
}

pub fn make_rule(tier: &str, effect: &str, pattern: &str, enabled: bool) -> PermissionRule {
    PermissionRule {
        id: rule_id(tier, effect, pattern),
        pattern: pattern.to_string(),
        effect: effect.to_string(),
        tier: tier.to_string(),
        enabled,
        label: label_for_pattern(pattern),
    }
}

/// FR-17: both tiers, ordered deny → ask → allow, local before global, file order
/// within a tier (enabled entries first, then the sidecar's disabled ones).
pub fn list_rules(local: &Path, global: Option<&Path>) -> Vec<PermissionRule> {
    let l = rules_of_tier("local", local);
    let g = global
        .map(|p| rules_of_tier("global", p))
        .unwrap_or_default();
    let mut out = Vec::new();
    for effect in EFFECT_ORDER {
        out.extend(l.iter().filter(|r| r.effect == effect).cloned());
        out.extend(g.iter().filter(|r| r.effect == effect).cloned());
    }
    out
}

// ---------- FR-7/FR-14: the write a decision performs ----------

/// Write one rule into a tier's settings file, surgically. Returns the resulting
/// `PermissionRule` (already-present is a success — §7 #1). Any failure leaves
/// the file untouched, which is what lets `permissions_decide` fail before it
/// claims anything (FR-7).
pub fn write_rule(
    settings: &Path,
    tier: &str,
    effect: &str,
    pattern: &str,
) -> Result<PermissionRule, AppError> {
    let mut doc = read_json_object(settings)?;
    if merge_pattern(&mut doc, effect, pattern) {
        write_json_atomic(settings, &doc)?;
    }
    // A rule that was parked as disabled and is now being re-created must not
    // stay parked, or it would read as disabled in the editor while being live
    // in settings.json. The error PROPAGATES: swallowing it left the pattern in
    // both files at once — the duplicate-id state rules_of_tier now guards
    // against — while reporting success to the card and the editor.
    set_disabled(settings, effect, pattern, false)?;
    Ok(make_rule(tier, effect, pattern, true))
}

/// Park a pattern in the sidecar (FR-15) after taking it out of settings.json.
/// Ordering is deliberate and the REVERSE of the obvious one: the sidecar write
/// happens FIRST, so a failure between the two steps leaves the rule visible in
/// settings.json rather than deleted from both files. `permissions_set_tier`
/// reasons the same way ("present in both, visible and fixable" beats "vanished").
pub fn park_rule(settings: &Path, effect: &str, pattern: &str) -> Result<(), AppError> {
    set_disabled(settings, effect, pattern, true)?;
    let mut doc = read_json_object(settings)?;
    if remove_pattern(&mut doc, effect, pattern) {
        write_json_atomic(settings, &doc)?;
    }
    Ok(())
}

/// FR-18: move one rule between tiers, preserving whether it is enabled. Add to
/// the destination FIRST, then drop from the source — a failure half-way leaves
/// the rule present in BOTH tiers (visible, fixable) rather than gone from both.
/// Lifted out of the command so it is testable without a `State<Engine>`.
pub fn move_rule(
    from: &Path,
    to: &Path,
    to_tier: &str,
    effect: &str,
    pattern: &str,
    enabled: bool,
) -> Result<(), AppError> {
    if enabled {
        write_rule(to, to_tier, effect, pattern)?;
    } else {
        set_disabled(to, effect, pattern, true)?;
    }
    drop_rule(from, effect, pattern)
}

pub fn drop_rule(settings: &Path, effect: &str, pattern: &str) -> Result<(), AppError> {
    let mut doc = read_json_object(settings)?;
    if remove_pattern(&mut doc, effect, pattern) {
        write_json_atomic(settings, &doc)?;
    }
    set_disabled(settings, effect, pattern, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::testutil::*;
    use serde_json::json;

    #[test]
    fn write_rule_merges_into_an_existing_file_without_clobbering_it() {
        let dir = tmpdir("write");
        let settings = dir.join(".claude").join("settings.local.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(
            &settings,
            r#"{"env":{"FOO":"bar"},"permissions":{"allow":["Bash(ls:*)"]}}"#,
        )
        .unwrap();

        let rule = write_rule(&settings, "local", "allow", "Bash(npm test:*)").unwrap();
        assert_eq!(rule.pattern, "Bash(npm test:*)");
        assert_eq!(rule.id, "local|allow|Bash(npm test:*)");
        assert_eq!(rule.label, "npm test (any arguments)");
        assert!(rule.enabled);

        let doc = read_json_object(&settings).unwrap();
        assert_eq!(doc["env"]["FOO"], "bar");
        assert_eq!(
            doc["permissions"]["allow"],
            json!(["Bash(ls:*)", "Bash(npm test:*)"])
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_rule_refuses_to_touch_an_unparseable_settings_file() {
        // §7 #2 / FR-7: the decision must fail BEFORE anything is claimed.
        let dir = tmpdir("garbage");
        let settings = dir.join("settings.local.json");
        std::fs::write(&settings, "{ this is not json").unwrap();
        assert!(write_rule(&settings, "local", "allow", "Bash(ls:*)").is_err());
        assert_eq!(
            std::fs::read_to_string(&settings).unwrap(),
            "{ this is not json"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_rule_creates_the_claude_dir_on_first_write() {
        let dir = tmpdir("mkdir");
        let settings = local_settings_path(dir.to_str().unwrap());
        assert!(!settings.parent().unwrap().exists());
        write_rule(&settings, "local", "deny", "Bash(rm:*)").unwrap();
        assert_eq!(
            read_json_object(&settings).unwrap()["permissions"]["deny"],
            json!(["Bash(rm:*)"])
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-15/FR-17: sidecar + listing ----

    #[test]
    fn listing_orders_deny_then_ask_then_allow_and_local_before_global() {
        let dir = tmpdir("list");
        let local = dir.join("local").join("settings.local.json");
        let global = dir.join("global").join("settings.json");
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        std::fs::create_dir_all(global.parent().unwrap()).unwrap();
        std::fs::write(
            &local,
            r#"{"permissions":{"allow":["Bash(ls:*)"],"deny":["Bash(rm:*)"],"ask":["Bash(git push:*)"]}}"#,
        )
        .unwrap();
        std::fs::write(&global, r#"{"permissions":{"allow":["WebSearch"]}}"#).unwrap();

        let rules = list_rules(&local, Some(&global));
        let seen: Vec<(String, String, String)> = rules
            .iter()
            .map(|r| (r.effect.clone(), r.tier.clone(), r.pattern.clone()))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("deny".into(), "local".into(), "Bash(rm:*)".into()),
                ("ask".into(), "local".into(), "Bash(git push:*)".into()),
                ("allow".into(), "local".into(), "Bash(ls:*)".into()),
                ("allow".into(), "global".into(), "WebSearch".into()),
            ]
        );
        assert!(rules.iter().all(|r| r.enabled));
        // §7 #14: the same pattern in both tiers is two distinct ids.
        assert_ne!(
            rule_id("local", "allow", "X"),
            rule_id("global", "allow", "X")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn disabling_moves_a_pattern_into_the_sidecar_and_back() {
        let dir = tmpdir("sidecar");
        let settings = dir.join("settings.local.json");
        std::fs::write(&settings, r#"{"permissions":{"allow":["Bash(ls:*)"]}}"#).unwrap();

        // off: out of settings.json, into the sidecar
        let mut doc = read_json_object(&settings).unwrap();
        assert!(remove_pattern(&mut doc, "allow", "Bash(ls:*)"));
        write_json_atomic(&settings, &doc).unwrap();
        set_disabled(&settings, "allow", "Bash(ls:*)", true).unwrap();

        let rules = list_rules(&settings, None);
        assert_eq!(rules.len(), 1);
        assert!(!rules[0].enabled);
        assert_eq!(rules[0].pattern, "Bash(ls:*)");
        assert_eq!(
            read_json_object(&settings).unwrap()["permissions"]["allow"],
            json!([])
        );

        // on: back into settings.json, out of the sidecar
        write_rule(&settings, "local", "allow", "Bash(ls:*)").unwrap();
        let rules = list_rules(&settings, None);
        assert_eq!(rules.len(), 1, "never listed twice");
        assert!(rules[0].enabled);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn drop_rule_clears_both_the_settings_entry_and_the_sidecar() {
        let dir = tmpdir("drop");
        let settings = dir.join("settings.local.json");
        std::fs::write(&settings, "{}").unwrap();
        set_disabled(&settings, "deny", "Bash(rm:*)", true).unwrap();
        assert_eq!(list_rules(&settings, None).len(), 1);
        drop_rule(&settings, "deny", "Bash(rm:*)").unwrap();
        assert!(list_rules(&settings, None).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_tier_contributes_nothing_instead_of_failing_the_listing() {
        let dir = tmpdir("tolerant");
        let local = dir.join("settings.local.json");
        let global = dir.join("global.json");
        std::fs::write(&local, "{ garbage").unwrap();
        std::fs::write(&global, r#"{"permissions":{"allow":["WebSearch"]}}"#).unwrap();
        let rules = list_rules(&local, Some(&global));
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].tier, "global");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-16/FR-17: no duplicate ids ----

    #[test]
    fn a_pattern_live_in_settings_and_parked_in_the_sidecar_lists_once_as_enabled() {
        // Reachable via §3 flow 7: the user disables a rule, then the CLI or a
        // hand edit re-adds it. Ids are derived (FR-16), so listing it twice would
        // give two rows the SAME id — and locate() takes the first, so a toggle or
        // a delete could act on the wrong row.
        let dir = tmpdir("dupid");
        let settings = dir.join("settings.local.json");
        std::fs::write(&settings, r#"{"permissions":{"allow":["Bash(ls:*)"]}}"#).unwrap();
        write_disabled(&settings, &[("allow".into(), "Bash(ls:*)".into())]).unwrap();

        let rules = list_rules(&settings, None);
        assert_eq!(rules.len(), 1, "listed twice: {rules:?}");
        assert!(
            rules[0].enabled,
            "settings.json wins — it is what Claude enforces"
        );
        let ids: std::collections::HashSet<&str> = rules.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids.len(), rules.len());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_sidecar_write_failure_is_reported_and_leaves_settings_json_intact() {
        // A swallowed sidecar error would leave a pattern live in settings.json
        // AND parked in the sidecar (the duplicate-id state) while reporting
        // success. Forcing a real write failure: make the sidecar PATH a
        // directory, so the temp-file rename can never land.
        let dir = tmpdir("sidefail");
        let settings = dir.join("settings.local.json");
        std::fs::write(&settings, r#"{"permissions":{"allow":["Bash(ls:*)"]}}"#).unwrap();
        std::fs::create_dir_all(sidecar_path(&settings)).unwrap();

        let outcome = park_rule(&settings, "allow", "Bash(ls:*)");
        assert!(
            outcome.is_err(),
            "the failure must surface, not be swallowed"
        );
        // FR-15 ordering: the sidecar write is attempted FIRST, so a failure
        // leaves the rule visible in settings.json rather than gone from both.
        assert_eq!(
            read_json_object(&settings).unwrap()["permissions"]["allow"],
            json!(["Bash(ls:*)"])
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-15: park ordering ----

    #[test]
    fn park_rule_records_the_sidecar_entry_before_dropping_the_live_one() {
        // Ordering is the REVERSE of the obvious one on purpose: a failure between
        // the two steps must leave the rule visible in settings.json, never
        // deleted from both files.
        let dir = tmpdir("park");
        let settings = dir.join("settings.local.json");
        std::fs::write(&settings, r#"{"permissions":{"allow":["Bash(ls:*)"]}}"#).unwrap();
        park_rule(&settings, "allow", "Bash(ls:*)").unwrap();
        let rules = list_rules(&settings, None);
        assert_eq!(rules.len(), 1);
        assert!(!rules[0].enabled);
        assert_eq!(
            read_json_object(&settings).unwrap()["permissions"]["allow"],
            json!([])
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-18: setTier's move ----

    #[test]
    fn move_rule_transfers_between_tiers_preserving_enabled() {
        let dir = tmpdir("move");
        let local = dir.join("l").join("settings.local.json");
        let global = dir.join("g").join("settings.json");
        write_rule(&local, "local", "allow", "Bash(ls:*)").unwrap();

        // enabled: lands live in the destination, gone from the source
        move_rule(&local, &global, "global", "allow", "Bash(ls:*)", true).unwrap();
        let after = list_rules(&local, Some(&global));
        assert_eq!(after.len(), 1, "present in exactly one tier: {after:?}");
        assert_eq!(after[0].tier, "global");
        assert!(after[0].enabled);
        assert_eq!(after[0].id, "global|allow|Bash(ls:*)");

        // disabled: stays parked on the way back
        park_rule(&global, "allow", "Bash(ls:*)").unwrap();
        move_rule(&global, &local, "local", "allow", "Bash(ls:*)", false).unwrap();
        let back = list_rules(&local, Some(&global));
        assert_eq!(back.len(), 1, "present in exactly one tier: {back:?}");
        assert_eq!(back[0].tier, "local");
        assert!(!back[0].enabled, "enabled state must survive the move");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- FR-16: rule ids ----

    #[test]
    fn rule_ids_round_trip_even_when_the_pattern_contains_a_pipe() {
        let id = rule_id("local", "allow", "Bash(a || b)");
        assert_eq!(
            parse_rule_id(&id),
            Some((
                "local".to_string(),
                "allow".to_string(),
                "Bash(a || b)".to_string()
            ))
        );
        assert_eq!(parse_rule_id("local|nonsense|X"), None);
        assert_eq!(parse_rule_id("local|allow"), None);
    }
}
