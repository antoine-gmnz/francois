//! FR-15/FR-28/FR-61..FR-64 — a plugin's settings, in their three shapes.
//!
//! The same key exists as three different values depending on who is looking:
//! RAW in `plugins.json` (a secret sealed in an `enc:v1:` envelope), PLAINTEXT
//! inside the isolate (`resolve_settings` — the only place a secret is opened),
//! and REDACTED on the way to the webview (`settings_view`). Keeping the three
//! projections in one file is what makes it obvious that they are three.

use super::*;

// ---------- FR-61..FR-64: settings ----------

/// The value a descriptor takes when nothing is stored and no `default` is
/// declared. Every declared key is always present in the resolved map, because
/// `PluginSettingsView` is a total `Record` and a plugin reading `undefined` for
/// a declared setting would be a contract violation.
fn empty_for(kind: PluginSettingType) -> Value {
    match kind {
        PluginSettingType::Number => Value::from(0),
        PluginSettingType::Boolean => Value::Bool(false),
        // string / select / secret — "" reads as unset, and a `select` whose
        // options never include "" is how the form shows "nothing chosen yet".
        _ => Value::String(String::new()),
    }
}

fn declared_default(d: &PluginSettingDescriptor) -> Value {
    // FR-61: a `secret` may not declare a default, so an unset secret is always "".
    match (&d.default, d.kind) {
        (Some(v), k) if k != PluginSettingType::Secret => v.clone(),
        _ => empty_for(d.kind),
    }
}

/// FR-28: the plugin's own view — declared defaults overlaid with stored values,
/// **secrets in plaintext**. This is the only place a stored secret is opened,
/// and the result never crosses back to the webview.
///
/// A secret that cannot be opened (missing or rotated `secret.key`) reads as
/// UNSET rather than failing the invocation (§7 #42): a plugin that handles "no
/// token configured" already handles this, and failing would take the whole panel
/// down for a recoverable condition.
pub(crate) fn resolve_settings(
    entry: &PluginEntry,
    key: Option<&[u8; 32]>,
) -> (Map<String, Value>, bool) {
    let mut out = Map::new();
    let mut unreadable = false;
    for d in entry.manifest.configuration() {
        let stored = entry.settings.get(&d.key);
        let value = match (d.kind, stored) {
            (_, None) => declared_default(d),
            (PluginSettingType::Secret, Some(Value::String(raw))) => {
                match (secrets::is_envelope(raw), key) {
                    (false, _) => Value::String(raw.clone()), // never sealed (empty)
                    (true, Some(k)) => match secrets::open(k, raw) {
                        Ok(plain) => Value::String(plain),
                        Err(_) => {
                            unreadable = true;
                            Value::String(String::new())
                        }
                    },
                    (true, None) => {
                        unreadable = true;
                        Value::String(String::new())
                    }
                }
            }
            (_, Some(v)) => v.clone(),
        };
        out.insert(d.key.clone(), value);
    }
    (out, unreadable)
}

/// FR-64: the WEBVIEW's view. A set secret reads as the sentinel, an unset one as
/// `''`. The ciphertext never leaves the core either — the modal has no use for
/// it and shipping it would put the secret one `atob` away from a devtools user.
pub(crate) fn settings_view(entry: &PluginEntry) -> Map<String, Value> {
    let mut out = Map::new();
    for d in entry.manifest.configuration() {
        let stored = entry.settings.get(&d.key);
        let value = match (d.kind, stored) {
            (PluginSettingType::Secret, Some(Value::String(raw))) if !raw.is_empty() => {
                Value::String(SECRET_SENTINEL.to_string())
            }
            (PluginSettingType::Secret, _) => Value::String(String::new()),
            (_, Some(v)) => v.clone(),
            (_, None) => declared_default(d),
        };
        out.insert(d.key.clone(), value);
    }
    out
}

/// FR-63: validate a patch against the descriptors and produce the RAW values to
/// store. Atomic — one bad key rejects the whole call and nothing is written.
///
/// FR-64's sentinel rule lives here: writing `'••••••'` back to a secret is a
/// NO-OP that preserves the stored value, so a form round-trip that never touched
/// the field cannot erase a token. Clearing is spelled `''`.
pub(crate) fn validate_settings_patch(
    entry: &PluginEntry,
    patch: &Map<String, Value>,
    key: Option<&[u8; 32]>,
) -> Result<Map<String, Value>, String> {
    let mut next = entry.settings.clone();
    for (k, raw) in patch {
        let d = entry
            .manifest
            .configuration()
            .iter()
            .find(|d| &d.key == k)
            .ok_or_else(|| format!("unknown setting \"{}\"", clean_text(k, 64, false)))?;
        match d.kind {
            PluginSettingType::Boolean => {
                let b = raw.as_bool().ok_or_else(|| type_err(k, "a boolean"))?;
                next.insert(k.clone(), Value::Bool(b));
            }
            PluginSettingType::Number => {
                let n = raw
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .ok_or_else(|| type_err(k, "a number"))?;
                if let Some(min) = d.min {
                    if n < min {
                        return Err(format!(
                            "\"{}\" must be at least {min}",
                            clean_text(k, 64, false)
                        ));
                    }
                }
                if let Some(max) = d.max {
                    if n > max {
                        return Err(format!(
                            "\"{}\" must be at most {max}",
                            clean_text(k, 64, false)
                        ));
                    }
                }
                next.insert(k.clone(), raw.clone());
            }
            PluginSettingType::Select => {
                let s = raw.as_str().ok_or_else(|| type_err(k, "a string"))?;
                let options = d.options.as_deref().unwrap_or(&[]);
                if !options.iter().any(|o| o.value == s) {
                    return Err(format!(
                        "\"{}\" is not one of the declared options",
                        clean_text(k, 64, false)
                    ));
                }
                next.insert(k.clone(), Value::String(s.to_string()));
            }
            PluginSettingType::String => {
                let s = raw.as_str().ok_or_else(|| type_err(k, "a string"))?;
                if s.chars().count() > SETTING_MAX_STRING {
                    return Err(too_long(k));
                }
                next.insert(k.clone(), Value::String(s.to_string()));
            }
            PluginSettingType::Secret => {
                let s = raw.as_str().ok_or_else(|| type_err(k, "a string"))?;
                if s == SECRET_SENTINEL {
                    continue; // FR-64: the round-trip no-op
                }
                if s.chars().count() > SETTING_MAX_STRING {
                    return Err(too_long(k));
                }
                if s.is_empty() {
                    next.insert(k.clone(), Value::String(String::new()));
                    continue;
                }
                let k32 = key.ok_or_else(|| {
                    "secrets cannot be stored — the key file is unavailable".to_string()
                })?;
                next.insert(k.clone(), Value::String(secrets::seal(k32, s)?));
            }
        }
    }
    Ok(next)
}

fn type_err(key: &str, want: &str) -> String {
    format!("\"{}\" must be {want}", clean_text(key, 64, false))
}

fn too_long(key: &str) -> String {
    format!(
        "\"{}\" must be at most {SETTING_MAX_STRING} characters",
        clean_text(key, 64, false)
    )
}

/// FR-15: an update keeps stored settings, drops keys the new manifest no longer
/// declares, and lets a newly declared key fall to its `default`.
pub(crate) fn migrate_settings(
    stored: &Map<String, Value>,
    next: &PluginManifest,
) -> Map<String, Value> {
    let mut out = Map::new();
    for d in next.configuration() {
        if let Some(v) = stored.get(&d.key) {
            out.insert(d.key.clone(), v.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::*;
    #[allow(unused_imports)]
    use serde_json::json;

    fn descriptor(key: &str, kind: PluginSettingType) -> PluginSettingDescriptor {
        PluginSettingDescriptor {
            key: key.into(),
            kind,
            label: key.into(),
            description: None,
            default: None,
            placeholder: None,
            options: None,
            min: None,
            max: None,
        }
    }

    fn with_config(id: &str, config: Vec<PluginSettingDescriptor>) -> PluginEntry {
        let mut e = entry_fixture(id, "/tmp/x");
        e.manifest.configuration = Some(config);
        e.disk_manifest = Some(e.manifest.clone());
        e
    }

    // ---------- FR-28/FR-64: settings resolution ----------

    #[test]
    fn the_plugins_view_gets_defaults_overlaid_with_stored_values() {
        let mut e = with_config(
            "acme-ci",
            vec![
                PluginSettingDescriptor {
                    default: Some(json!("acme/x")),
                    ..descriptor("repo", PluginSettingType::String)
                },
                PluginSettingDescriptor {
                    default: Some(json!(30)),
                    ..descriptor("poll", PluginSettingType::Number)
                },
                descriptor("verbose", PluginSettingType::Boolean),
                descriptor("mode", PluginSettingType::Select),
            ],
        );
        let (resolved, unreadable) = resolve_settings(&e, None);
        assert_eq!(resolved["repo"], json!("acme/x"));
        assert_eq!(resolved["poll"], json!(30));
        assert_eq!(
            resolved["verbose"],
            json!(false),
            "undeclared default ⇒ typed empty"
        );
        assert_eq!(resolved["mode"], json!(""));
        assert!(!unreadable);

        e.settings.insert("repo".into(), json!("acme/other"));
        e.settings.insert("verbose".into(), json!(true));
        let (resolved, _) = resolve_settings(&e, None);
        assert_eq!(resolved["repo"], json!("acme/other"));
        assert_eq!(resolved["verbose"], json!(true));
        assert_eq!(
            resolved["poll"],
            json!(30),
            "untouched keys keep their default"
        );
    }

    #[test]
    fn every_declared_key_is_present_even_with_nothing_stored() {
        // PluginSettingsView is a TOTAL record — a plugin reading `undefined` for
        // a declared setting would be a contract violation.
        let e = with_config(
            "acme-ci",
            vec![
                descriptor("a", PluginSettingType::String),
                descriptor("b", PluginSettingType::Number),
                descriptor("c", PluginSettingType::Boolean),
                descriptor("d", PluginSettingType::Secret),
            ],
        );
        let (resolved, _) = resolve_settings(&e, None);
        for k in ["a", "b", "c", "d"] {
            assert!(resolved.contains_key(k), "missing {k}");
        }
        assert_eq!(settings_view(&e).len(), 4);
    }

    #[test]
    fn a_secret_reaches_the_isolate_in_plaintext_and_the_webview_as_the_sentinel() {
        // FR-28 vs FR-64 — the same stored value, two different projections.
        let key = [3u8; 32];
        let mut e = with_config(
            "acme-ci",
            vec![descriptor("token", PluginSettingType::Secret)],
        );
        e.settings.insert(
            "token".into(),
            json!(secrets::seal(&key, "ghp_real").unwrap()),
        );

        let (resolved, unreadable) = resolve_settings(&e, Some(&key));
        assert_eq!(
            resolved["token"],
            json!("ghp_real"),
            "FR-28: plaintext, isolate-only"
        );
        assert!(!unreadable);

        let view = settings_view(&e);
        assert_eq!(
            view["token"],
            json!(SECRET_SENTINEL),
            "FR-64: never the value"
        );
        assert!(
            !serde_json::to_string(&view).unwrap().contains("ghp_real"),
            "the ciphertext must not travel either"
        );
    }

    #[test]
    fn an_unopenable_secret_reads_as_unset_rather_than_failing_the_render() {
        // §7 #42: a missing or rotated secret.key must not take the panel down.
        let mut e = with_config(
            "acme-ci",
            vec![descriptor("token", PluginSettingType::Secret)],
        );
        e.settings.insert(
            "token".into(),
            json!(secrets::seal(&[3u8; 32], "ghp_real").unwrap()),
        );

        let (resolved, unreadable) = resolve_settings(&e, Some(&[9u8; 32]));
        assert_eq!(resolved["token"], json!(""));
        assert!(
            unreadable,
            "the modal shows `stored secrets could not be read`"
        );

        let (resolved, unreadable) = resolve_settings(&e, None);
        assert_eq!(resolved["token"], json!(""));
        assert!(unreadable);
    }

    #[test]
    fn an_unset_secret_is_empty_in_both_projections() {
        let mut e = with_config(
            "acme-ci",
            vec![descriptor("token", PluginSettingType::Secret)],
        );
        assert_eq!(settings_view(&e)["token"], json!(""));
        e.settings.insert("token".into(), json!(""));
        assert_eq!(settings_view(&e)["token"], json!(""));
        assert_eq!(resolve_settings(&e, Some(&[1u8; 32])).0["token"], json!(""));
    }

    // ---------- FR-63/FR-64: writing settings ----------

    #[test]
    fn a_patch_validates_every_value_against_its_descriptor() {
        let e = with_config(
            "acme-ci",
            vec![
                descriptor("s", PluginSettingType::String),
                PluginSettingDescriptor {
                    min: Some(5.0),
                    max: Some(60.0),
                    ..descriptor("n", PluginSettingType::Number)
                },
                descriptor("b", PluginSettingType::Boolean),
                PluginSettingDescriptor {
                    options: Some(vec![PluginSettingOption {
                        value: "a".into(),
                        label: "A".into(),
                    }]),
                    ..descriptor("sel", PluginSettingType::Select)
                },
            ],
        );

        let good = validate_settings_patch(
            &e,
            &json!({ "s": "x", "n": 30, "b": true, "sel": "a" })
                .as_object()
                .unwrap()
                .clone(),
            None,
        )
        .unwrap();
        assert_eq!(good["n"], json!(30));

        for bad in [
            json!({ "nope": "x" }), // unknown key
            json!({ "s": 42 }),     // wrong type
            json!({ "b": "true" }),
            json!({ "n": "30" }),
            json!({ "n": 4 }),     // below min
            json!({ "n": 61 }),    // above max
            json!({ "sel": "z" }), // not a declared option
            json!({ "s": "x".repeat(SETTING_MAX_STRING + 1) }),
        ] {
            assert!(
                validate_settings_patch(&e, bad.as_object().unwrap(), None).is_err(),
                "should reject {bad}"
            );
        }
        // the bounds themselves are inclusive
        assert!(validate_settings_patch(&e, json!({ "n": 5 }).as_object().unwrap(), None).is_ok());
        assert!(validate_settings_patch(&e, json!({ "n": 60 }).as_object().unwrap(), None).is_ok());
    }

    #[test]
    fn a_patch_is_atomic_so_one_bad_key_writes_nothing() {
        // FR-63: "the whole call is atomic".
        let mut e = with_config(
            "acme-ci",
            vec![
                descriptor("a", PluginSettingType::String),
                descriptor("b", PluginSettingType::Number),
            ],
        );
        e.settings.insert("a".into(), json!("original"));
        let err = validate_settings_patch(
            &e,
            json!({ "a": "changed", "b": "not a number" })
                .as_object()
                .unwrap(),
            None,
        );
        assert!(err.is_err());
        assert_eq!(e.settings["a"], json!("original"), "unchanged in memory");
    }

    #[test]
    fn writing_the_sentinel_back_preserves_the_stored_secret() {
        // FR-64 / §7 #43: the form round-trip must not be able to erase a token.
        let key = [3u8; 32];
        let mut e = with_config(
            "acme-ci",
            vec![descriptor("token", PluginSettingType::Secret)],
        );
        let sealed = secrets::seal(&key, "ghp_real").unwrap();
        e.settings.insert("token".into(), json!(sealed.clone()));

        let next = validate_settings_patch(
            &e,
            json!({ "token": SECRET_SENTINEL }).as_object().unwrap(),
            Some(&key),
        )
        .unwrap();
        assert_eq!(
            next["token"],
            json!(sealed),
            "byte-identical, not re-sealed"
        );

        // ...and clearing is spelled ''
        let cleared =
            validate_settings_patch(&e, json!({ "token": "" }).as_object().unwrap(), Some(&key))
                .unwrap();
        assert_eq!(cleared["token"], json!(""));
    }

    #[test]
    fn a_written_secret_is_sealed_and_never_stored_in_the_clear() {
        let key = [3u8; 32];
        let e = with_config(
            "acme-ci",
            vec![descriptor("token", PluginSettingType::Secret)],
        );
        let next = validate_settings_patch(
            &e,
            json!({ "token": "ghp_new" }).as_object().unwrap(),
            Some(&key),
        )
        .unwrap();
        let stored = next["token"].as_str().unwrap();
        assert!(secrets::is_envelope(stored), "FR-65: enc:v1: at rest");
        assert!(!stored.contains("ghp_new"));
        assert_eq!(secrets::open(&key, stored).unwrap(), "ghp_new");

        // with no key available, a secret write FAILS rather than storing plaintext
        assert!(validate_settings_patch(
            &e,
            json!({ "token": "ghp_new" }).as_object().unwrap(),
            None
        )
        .is_err());
    }

    // ---------- FR-15: settings across an update ----------

    #[test]
    fn an_update_keeps_known_settings_drops_removed_ones_and_defaults_new_ones() {
        let mut stored = Map::new();
        stored.insert("keep".into(), json!("v"));
        stored.insert("gone".into(), json!("old"));

        let mut next = manifest_fixture("acme-ci");
        next.configuration = Some(vec![
            descriptor("keep", PluginSettingType::String),
            PluginSettingDescriptor {
                default: Some(json!("fresh")),
                ..descriptor("added", PluginSettingType::String)
            },
        ]);

        let migrated = migrate_settings(&stored, &next);
        assert_eq!(migrated["keep"], json!("v"));
        assert!(
            !migrated.contains_key("gone"),
            "no longer declared ⇒ dropped"
        );
        assert!(
            !migrated.contains_key("added"),
            "not stored — it falls to its default"
        );

        let mut e = entry_fixture("acme-ci", "/tmp/x");
        e.manifest = next;
        e.settings = migrated;
        assert_eq!(settings_view(&e)["added"], json!("fresh"));
    }
}
