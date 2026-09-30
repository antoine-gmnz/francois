//! Shared Codex resources without shared account identity or conversation state.
use crate::ipc::{AppError, ErrorCode};
use std::path::Path;

const SHARED_KEYS: &[&str] = &[
    "model",
    "review_model",
    "model_reasoning_effort",
    "model_reasoning_summary",
    "model_verbosity",
    "personality",
    "approval_policy",
    "sandbox_mode",
    "sandbox_workspace_write",
    "web_search",
    "features",
    "tools",
    "mcp_servers",
    "skills",
    "plugins",
    "apps",
    "agents",
    "projects",
    "instructions",
    "developer_instructions",
    "compact_prompt",
    "service_tier",
];
const SHARED_PATHS: &[&str] = &[
    "skills",
    "agents",
    "hooks.json",
    "rules",
    "prompts",
    "AGENTS.md",
    "plugins/cache",
    "plugins/marketplaces",
];

pub(crate) fn inherit_codex_resources(config_dir: &str) -> Result<(), AppError> {
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };
    let shared = std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    inherit_from(&shared, Path::new(config_dir))
        .map_err(|_| AppError::new(ErrorCode::Internal, "Could not inherit shared Codex resources without overwriting this account's configuration"))
}
pub(crate) fn codex_server_inherited(config_file: &str, name: &str) -> bool {
    let Some(root) = Path::new(config_file).parent() else {
        return false;
    };
    std::fs::read(root.join(".francois-shared-resources.json"))
        .ok()
        .and_then(|bytes| {
            serde_json::from_slice::<std::collections::BTreeMap<String, String>>(&bytes).ok()
        })
        .is_some_and(|baseline| baseline.contains_key(&format!("mcp_servers/{name}")))
}
fn read_config(root: &Path) -> std::io::Result<toml::Value> {
    match std::fs::read_to_string(root.join("config.toml")) {
        Ok(text) => toml::from_str(&text).map_err(std::io::Error::other),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(toml::Value::Table(Default::default()))
        }
        Err(error) => Err(error),
    }
}
fn inherit_from(shared: &Path, account: &Path) -> std::io::Result<()> {
    if shared == account
        || shared
            .canonicalize()
            .ok()
            .zip(account.canonicalize().ok())
            .is_some_and(|(a, b)| a == b)
    {
        return Ok(());
    }
    let shared_config = read_config(shared)?;
    let mut config = read_config(account)?;
    let original = config.clone();
    let baseline_path = account.join(".francois-shared-resources.json");
    let mut baseline: std::collections::BTreeMap<String, String> =
        match std::fs::read(&baseline_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(std::io::Error::other)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
            Err(error) => return Err(error),
        };
    let original_baseline = baseline.clone();
    let table = config
        .as_table_mut()
        .ok_or_else(|| std::io::Error::other("Codex configuration must be a table"))?;
    for key in SHARED_KEYS {
        if *key == "mcp_servers" {
            let source = shared_config
                .get(*key)
                .and_then(toml::Value::as_table)
                .cloned()
                .unwrap_or_default();
            let target = table
                .entry(*key)
                .or_insert_with(|| toml::Value::Table(Default::default()));
            let Some(target) = target.as_table_mut() else {
                continue;
            };
            let removed = baseline
                .keys()
                .filter_map(|path| {
                    path.strip_prefix("mcp_servers/")
                        .filter(|name| !source.contains_key(*name))
                        .map(String::from)
                })
                .collect::<Vec<_>>();
            for name in removed {
                let path = format!("mcp_servers/{name}");
                if target
                    .get(&name)
                    .is_some_and(|current| baseline.get(&path) == Some(&fingerprint(current)))
                {
                    target.remove(&name);
                }
                baseline.remove(&path);
            }
            for (name, value) in source {
                let path = format!("mcp_servers/{name}");
                if target
                    .get(&name)
                    .is_none_or(|current| baseline.get(&path) == Some(&fingerprint(current)))
                {
                    baseline.insert(path, fingerprint(&value));
                    target.insert(name, value);
                } else {
                    baseline.remove(&path);
                }
            }
            if target.is_empty() {
                table.remove(*key);
            }
            continue;
        }
        match (table.get_mut(*key), shared_config.get(*key)) {
            (Some(current), Some(value)) if baseline.get(*key) == Some(&fingerprint(current)) => {
                *current = value.clone();
                baseline.insert((*key).into(), fingerprint(value));
            }
            (Some(current), Some(value)) => {
                merge_missing(current, value);
                baseline.remove(*key);
            }
            (None, Some(value)) => {
                table.insert((*key).into(), value.clone());
                baseline.insert((*key).into(), fingerprint(value));
            }
            (Some(current), None) if baseline.get(*key) == Some(&fingerprint(current)) => {
                table.remove(*key);
                baseline.remove(*key);
            }
            _ => {}
        }
    }
    if config != original {
        private_atomic(
            &account.join("config.toml"),
            toml::to_string(&config)
                .map_err(std::io::Error::other)?
                .as_bytes(),
        )?;
    }
    if baseline != original_baseline {
        // Only hashes of inherited resource values, never their credentials.
        private_atomic(
            &baseline_path,
            &serde_json::to_vec(&baseline).map_err(std::io::Error::other)?,
        )?;
    }
    for name in SHARED_PATHS {
        let source = shared.join(name);
        let target = account.join(name);
        if source.exists() && std::fs::symlink_metadata(&target).is_err() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            super::mirror::link_entry(&source, &target)?;
        }
    }
    Ok(())
}
fn fingerprint(value: &toml::Value) -> String {
    use sha2::Digest;
    format!(
        "{:x}",
        sha2::Sha256::digest(format!("{value:?}").as_bytes())
    )
}
fn private_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = crate::fs_util::unique_temp_path(path, "codex");
    crate::fs_util::write_user_only_file(&tmp, bytes)?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(tmp);
        return Err(error);
    }
    Ok(())
}
fn merge_missing(target: &mut toml::Value, source: &toml::Value) {
    if let (Some(target), Some(source)) = (target.as_table_mut(), source.as_table()) {
        for (key, value) in source {
            if let Some(existing) = target.get_mut(key) {
                merge_missing(existing, value);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refresh_updates_inherited_servers_but_preserves_account_edits() {
        let root = std::env::temp_dir().join(format!("codex-refresh-{}", uuid::Uuid::new_v4()));
        let shared = root.join("shared");
        let account = root.join("account");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(shared.join("config.toml"),"[mcp_servers.inherited]\ncommand='old'\n[mcp_servers.edited]\ncommand='old'\n[mcp_servers.removed]\ncommand='gone'").unwrap();
        inherit_from(&shared, &account).unwrap();
        let mut local: toml::Value = read_config(&account).unwrap();
        local["mcp_servers"]["edited"]["command"] = toml::Value::String("account-custom".into());
        std::fs::write(
            account.join("config.toml"),
            toml::to_string(&local).unwrap(),
        )
        .unwrap();
        std::fs::write(
            shared.join("config.toml"),
            "[mcp_servers.inherited]\ncommand='new'\n[mcp_servers.edited]\ncommand='new'",
        )
        .unwrap();
        inherit_from(&shared, &account).unwrap();
        let local = read_config(&account).unwrap();
        assert_eq!(
            local["mcp_servers"]["inherited"]["command"].as_str(),
            Some("new")
        );
        assert_eq!(
            local["mcp_servers"]["edited"]["command"].as_str(),
            Some("account-custom")
        );
        assert!(local["mcp_servers"].get("removed").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn inheritance_merges_resources_preserves_overrides_and_excludes_private_state() {
        let root = std::env::temp_dir().join(format!("codex-inherit-{}", uuid::Uuid::new_v4()));
        let shared = root.join("shared");
        let account = root.join("account");
        std::fs::create_dir_all(shared.join("skills/demo")).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(shared.join("skills/demo/SKILL.md"), "demo").unwrap();
        std::fs::create_dir_all(shared.join("agents")).unwrap();
        std::fs::write(shared.join("agents/core.toml"), "agent").unwrap();
        std::fs::write(shared.join("hooks.json"), "{}").unwrap();
        std::fs::write(shared.join("config.toml"), "model = 'global'\nforced_chatgpt_workspace_id = 'private'\n[mcp_servers.shared]\ncommand = 'tool'\n[mcp_servers.same]\ncommand = 'global'\n").unwrap();
        std::fs::write(
            account.join("config.toml"),
            "model = 'account'\n[mcp_servers.same]\ncommand = 'account'\n",
        )
        .unwrap();
        for file in ["auth.json", "history.jsonl", "sessions", "credentials.json"] {
            std::fs::write(shared.join(file), "private").unwrap();
        }
        inherit_from(&shared, &account).unwrap();
        let config: toml::Value =
            toml::from_str(&std::fs::read_to_string(account.join("config.toml")).unwrap()).unwrap();
        assert_eq!(config["model"].as_str(), Some("account"));
        assert_eq!(
            config["mcp_servers"]["same"]["command"].as_str(),
            Some("account")
        );
        assert_eq!(
            config["mcp_servers"]["shared"]["command"].as_str(),
            Some("tool")
        );
        assert!(config.get("forced_chatgpt_workspace_id").is_none());
        assert!(account.join("skills/demo/SKILL.md").is_file());
        assert!(account.join("agents/core.toml").is_file());
        assert!(account.join("hooks.json").is_file());
        for file in ["auth.json", "history.jsonl", "sessions", "credentials.json"] {
            assert!(!account.join(file).exists());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_account_config_is_never_overwritten() {
        let root = std::env::temp_dir().join(format!("codex-invalid-{}", uuid::Uuid::new_v4()));
        let shared = root.join("shared");
        let account = root.join("account");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::create_dir_all(&account).unwrap();
        std::fs::write(shared.join("config.toml"), "model = 'global'").unwrap();
        std::fs::write(account.join("config.toml"), "[broken").unwrap();
        assert!(inherit_from(&shared, &account).is_err());
        assert_eq!(
            std::fs::read_to_string(account.join("config.toml")).unwrap(),
            "[broken"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
