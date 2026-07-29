//! FR-1/FR-2/FR-61 — what a tree must declare to be installable.
//!
//! Pure validation over a parsed manifest, plus the one read that turns a staged
//! directory into a validated one. Every failure here is
//! `PLUGIN_MANIFEST_INVALID`, and every one of them happens BEFORE a consent
//! card is drawn — the user is never asked to approve something that could not
//! have been installed anyway.

use super::*;

use std::path::Path;

/// FR-1: everything the manifest must satisfy before a consent card is even
/// drawn. Every failure is `PLUGIN_MANIFEST_INVALID`.
pub(crate) fn validate_manifest(m: &PluginManifest) -> Result<(), String> {
    if m.manifest_version != 1 {
        return Err(format!(
            "unsupported manifestVersion {} — this Francois understands 1",
            m.manifest_version
        ));
    }
    if !valid_plugin_id(&m.id) {
        return Err("id must be lower-case letters, digits and dashes (2–64 chars)".into());
    }
    if m.name.trim().is_empty() || m.name.chars().count() > 48 {
        return Err("name must be 1–48 characters".into());
    }
    if m.version.trim().is_empty() || m.version.chars().count() > 64 {
        return Err("version must be 1–64 characters".into());
    }
    if m.description.chars().count() > 200 {
        return Err("description must be at most 200 characters".into());
    }
    if m.author.as_ref().is_some_and(|a| a.chars().count() > 64) {
        return Err("author must be at most 64 characters".into());
    }
    validate_entry_path(&m.entry)?;
    validate_contributes(&m.contributes, &m.capabilities)?;
    validate_configuration(m.configuration())?;
    validate_capabilities(&m.capabilities)?;
    Ok(())
}

fn validate_contributes(c: &PluginContributes, caps: &PluginCapabilities) -> Result<(), String> {
    if let Some(panel) = &c.panel {
        if panel.title.trim().is_empty() {
            return Err("contributes.panel.title must not be empty".into());
        }
    }
    if let Some(tab) = &c.tab {
        webtab::validate_contribution(tab, caps)?;
    }
    let mut seen = std::collections::HashSet::new();
    for cmd in c.commands() {
        if cmd.id.trim().is_empty() || cmd.id.chars().count() > 64 {
            return Err("a command id must be 1–64 characters".into());
        }
        if !cmd
            .id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(format!(
                "command id \"{}\" must be kebab-case",
                clean_text(&cmd.id, 64, false)
            ));
        }
        if !seen.insert(cmd.id.clone()) {
            return Err(format!(
                "duplicate command id \"{}\"",
                clean_text(&cmd.id, 64, false)
            ));
        }
        if cmd.title.trim().is_empty() || cmd.title.chars().count() > 64 {
            return Err("a command title must be 1–64 characters".into());
        }
        // FR-50: the glyph is rendered as-is in the palette and in actions — one
        // grapheme, so it cannot blow out the row.
        if cmd.glyph.as_ref().is_some_and(|g| g.chars().count() > 2) {
            return Err("a command glyph must be a single character".into());
        }
    }
    Ok(())
}

fn validate_configuration(config: &[PluginSettingDescriptor]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for d in config {
        if !valid_setting_key(&d.key) {
            return Err(format!(
                "setting key \"{}\" must start with a letter and use letters, digits, _ or -",
                clean_text(&d.key, 64, false)
            ));
        }
        if !seen.insert(d.key.clone()) {
            return Err(format!(
                "duplicate setting key \"{}\"",
                clean_text(&d.key, 64, false)
            ));
        }
        if d.label.trim().is_empty() || d.label.chars().count() > 48 {
            return Err("a setting label must be 1–48 characters".into());
        }
        if d.description
            .as_ref()
            .is_some_and(|s| s.chars().count() > 200)
        {
            return Err("a setting description must be at most 200 characters".into());
        }
        if d.placeholder
            .as_ref()
            .is_some_and(|s| s.chars().count() > 48)
        {
            return Err("a setting placeholder must be at most 48 characters".into());
        }
        match d.kind {
            PluginSettingType::Select => {
                let options = d.options.as_deref().unwrap_or(&[]);
                if options.is_empty() {
                    return Err(format!(
                        "setting \"{}\" is a select and needs a non-empty options list",
                        clean_text(&d.key, 64, false)
                    ));
                }
            }
            PluginSettingType::Secret => {
                // FR-61: a default would be a credential committed to a repo.
                if d.default.is_some() {
                    return Err(format!(
                        "setting \"{}\" is a secret and cannot declare a default",
                        clean_text(&d.key, 64, false)
                    ));
                }
            }
            PluginSettingType::Number => {
                if let (Some(min), Some(max)) = (d.min, d.max) {
                    if min > max {
                        return Err(format!(
                            "setting \"{}\" has min greater than max",
                            clean_text(&d.key, 64, false)
                        ));
                    }
                }
            }
            _ => {}
        }
        if d.kind != PluginSettingType::Number && (d.min.is_some() || d.max.is_some()) {
            return Err(format!(
                "setting \"{}\" declares min/max but is not a number",
                clean_text(&d.key, 64, false)
            ));
        }
        if d.kind != PluginSettingType::Select && d.options.is_some() {
            return Err(format!(
                "setting \"{}\" declares options but is not a select",
                clean_text(&d.key, 64, false)
            ));
        }
    }
    Ok(())
}

fn validate_capabilities(c: &PluginCapabilities) -> Result<(), String> {
    let Some(network) = &c.network else {
        return Ok(());
    };
    if network.hosts.is_empty() {
        return Err("capabilities.network declares no hosts".into());
    }
    if network.hosts.len() > 64 {
        return Err("capabilities.network declares too many hosts".into());
    }
    for host in &network.hosts {
        // The consent card shows these verbatim (FR-11), so they must be
        // renderable and must not contain a scheme, a path or a port the user
        // would read as part of the host.
        let body = host.strip_prefix("*.").unwrap_or(host);
        if body.is_empty()
            || host.len() > 253
            || !body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b':' | b'[' | b']'))
        {
            return Err(format!(
                "\"{}\" is not a valid host",
                clean_text(host, 64, false)
            ));
        }
    }
    Ok(())
}

/// FR-70: clamped, or `None` when the manifest declares no polling.
pub(crate) fn refresh_interval(m: &PluginManifest) -> Option<u64> {
    m.refresh_interval_ms
        .map(|ms| ms.clamp(REFRESH_INTERVAL_MIN_MS, REFRESH_INTERVAL_MAX_MS))
}

/// Read and validate the manifest at the root of a staged tree (FR-1/FR-7).
pub(crate) fn read_staged_manifest(dir: &Path) -> Result<PluginManifest, (&'static str, String)> {
    let bytes = std::fs::read(dir.join(MANIFEST_FILENAME))
        .map_err(|_| (E_MANIFEST_INVALID, NO_MANIFEST_MSG.to_string()))?;
    let manifest: PluginManifest = serde_json::from_slice(&bytes).map_err(|e| {
        (
            E_MANIFEST_INVALID,
            format!(
                "francois-plugin.json is not valid: {}",
                clean_text(&e.to_string(), 160, false)
            ),
        )
    })?;
    validate_manifest(&manifest).map_err(|m| (E_MANIFEST_INVALID, m))?;
    // FR-7: the entry must actually be there — a manifest pointing at a file the
    // tree does not contain fails now, not at first render.
    let entry_path = validate_entry_path(&manifest.entry).map_err(|m| (E_MANIFEST_INVALID, m))?;
    if !dir.join(&entry_path).is_file() {
        return Err((
            E_MANIFEST_INVALID,
            format!(
                "entry \"{}\" is not in the package",
                clean_text(&manifest.entry, 120, false)
            ),
        ));
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::*;
    #[allow(unused_imports)]
    use serde_json::json;

    #[test]
    fn the_fixture_manifest_is_valid_so_a_mutation_is_always_the_cause() {
        assert!(validate_manifest(&manifest_fixture("acme-ci")).is_ok());
    }

    #[test]
    fn manifest_identity_fields_are_bounded() {
        let bad = |f: fn(&mut PluginManifest)| {
            let mut m = manifest_fixture("acme-ci");
            f(&mut m);
            assert!(validate_manifest(&m).is_err());
        };
        bad(|m| m.manifest_version = 2);
        bad(|m| m.id = "Acme".into());
        bad(|m| m.id = "../evil".into());
        bad(|m| m.id = "a".into());
        bad(|m| m.name = "  ".into());
        bad(|m| m.name = "x".repeat(49));
        bad(|m| m.version = String::new());
        bad(|m| m.description = "x".repeat(201));
        bad(|m| m.author = Some("x".repeat(65)));
        bad(|m| m.entry = "../escape.js".into());
    }

    #[test]
    fn contributed_commands_must_be_unique_kebab_case_and_titled() {
        let with = |cmds: Vec<PluginCommandContribution>| {
            let mut m = manifest_fixture("acme-ci");
            m.contributes.commands = Some(cmds);
            validate_manifest(&m)
        };
        let cmd = |id: &str, title: &str| PluginCommandContribution {
            id: id.into(),
            title: title.into(),
            glyph: None,
            palette: None,
        };
        assert!(with(vec![cmd("open-run", "Open")]).is_ok());
        assert!(
            with(vec![cmd("open-run", "Open"), cmd("open-run", "Again")]).is_err(),
            "duplicate"
        );
        assert!(
            with(vec![cmd("Open_Run", "Open")]).is_err(),
            "not kebab-case"
        );
        assert!(with(vec![cmd("open-run", "")]).is_err(), "no title");
        assert!(with(vec![cmd("", "Open")]).is_err());
    }

    #[test]
    fn setting_descriptors_are_checked_against_their_own_type() {
        let with = |d: PluginSettingDescriptor| {
            let mut m = manifest_fixture("acme-ci");
            m.configuration = Some(vec![d]);
            validate_manifest(&m)
        };
        let base = |key: &str, kind: PluginSettingType| PluginSettingDescriptor {
            key: key.into(),
            kind,
            label: "L".into(),
            description: None,
            default: None,
            placeholder: None,
            options: None,
            min: None,
            max: None,
        };

        assert!(with(base("token", PluginSettingType::Secret)).is_ok());
        // FR-61: a secret default would be a credential committed to a repo
        assert!(with(PluginSettingDescriptor {
            default: Some(json!("ghp_x")),
            ..base("token", PluginSettingType::Secret)
        })
        .is_err());
        // a select needs options; a non-select must not declare them
        assert!(with(base("mode", PluginSettingType::Select)).is_err());
        assert!(with(PluginSettingDescriptor {
            options: Some(vec![]),
            ..base("mode", PluginSettingType::Select)
        })
        .is_err());
        assert!(with(PluginSettingDescriptor {
            options: Some(vec![PluginSettingOption {
                value: "a".into(),
                label: "A".into()
            }]),
            ..base("s", PluginSettingType::String)
        })
        .is_err());
        // min/max belong to numbers only, and must be ordered
        assert!(with(PluginSettingDescriptor {
            min: Some(1.0),
            ..base("s", PluginSettingType::String)
        })
        .is_err());
        assert!(with(PluginSettingDescriptor {
            min: Some(9.0),
            max: Some(1.0),
            ..base("n", PluginSettingType::Number)
        })
        .is_err());
        assert!(with(PluginSettingDescriptor {
            min: Some(1.0),
            max: Some(9.0),
            ..base("n", PluginSettingType::Number)
        })
        .is_ok());
        // keys follow the contract pattern and must be unique
        assert!(with(base("9lives", PluginSettingType::String)).is_err());
        let mut m = manifest_fixture("acme-ci");
        m.configuration = Some(vec![
            base("dup", PluginSettingType::String),
            base("dup", PluginSettingType::Number),
        ]);
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn a_network_capability_must_declare_usable_hosts() {
        let with = |hosts: &[&str]| {
            let mut m = manifest_fixture("acme-ci");
            m.capabilities = caps(false, false, hosts);
            validate_manifest(&m)
        };
        assert!(with(&["api.github.com", "*.acme.dev", "127.0.0.1"]).is_ok());
        for bad in [
            vec!["https://api.github.com"], // a scheme is not a host
            vec!["acme.dev/path"],
            vec![""],
            vec!["*."],
        ] {
            assert!(with(&bad).is_err(), "should refuse {bad:?}");
        }
        // an EMPTY network block is a declaration that grants nothing — refuse it
        // rather than showing the user a network consent line for no hosts.
        let mut m = manifest_fixture("acme-ci");
        m.capabilities.network = Some(PluginNetwork { hosts: vec![] });
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn the_refresh_interval_is_clamped_to_its_declared_band() {
        // FR-70.
        let mut m = manifest_fixture("acme-ci");
        assert_eq!(refresh_interval(&m), None, "absent ⇒ no polling");
        for (declared, expect) in [
            (0, REFRESH_INTERVAL_MIN_MS),
            (1_000, REFRESH_INTERVAL_MIN_MS),
            (30_000, 30_000),
            (u64::MAX, REFRESH_INTERVAL_MAX_MS),
        ] {
            m.refresh_interval_ms = Some(declared);
            assert_eq!(refresh_interval(&m), Some(expect));
        }
    }

    #[test]
    fn a_staged_tree_yields_its_manifest_or_a_specific_refusal() {
        let dir = tmp_dir("staged-manifest");

        let good = dir.join("good");
        write_plugin_tree(&good, "acme-ci", "export default {}");
        assert_eq!(read_staged_manifest(&good).unwrap().id, "acme-ci");

        // §7 #3: no manifest at all
        let bare = dir.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        assert_eq!(read_staged_manifest(&bare).unwrap_err().1, NO_MANIFEST_MSG);

        // unparseable
        let broken = dir.join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join(MANIFEST_FILENAME), b"{ not json").unwrap();
        assert_eq!(
            read_staged_manifest(&broken).unwrap_err().0,
            E_MANIFEST_INVALID
        );

        // FR-7: the entry file named by a valid manifest is not in the tree
        let missing = dir.join("missing-entry");
        write_plugin_tree(&missing, "acme-ci", "x");
        std::fs::remove_file(missing.join("plugin.js")).unwrap();
        let e = read_staged_manifest(&missing).unwrap_err();
        assert!(e.1.contains("not in the package"), "{}", e.1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
