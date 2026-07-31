//! Shared fixtures for the account module's unit tests.

use super::*;

use std::path::PathBuf;

pub(crate) fn record_fixture(id: &str, label: &str) -> AccountRecord {
    AccountRecord {
        id: id.into(),
        label: label.into(),
        email: None,
        organization: None,
        config_dir: format!("/tmp/accounts/{id}"),
        created_at: 1_000,
    }
}

/// An `AccountInner` holding the given records (labeled `work`, `perso`, …) with
/// `default_id` carrying the FR-4 flag. No login, no auth failures.
pub(crate) fn inner_fixture(ids: &[&str], default_id: &str) -> AccountInner {
    const LABELS: [&str; 3] = ["work", "perso", "client"];
    AccountInner {
        records: ids
            .iter()
            .enumerate()
            .map(|(i, id)| record_fixture(id, LABELS.get(i).copied().unwrap_or("account")))
            .collect(),
        default_account_id: default_id.to_string(),
        auth_failed_at: HashMap::new(),
        default_email: None,
        default_organization: None,
        login: None,
    }
}

/// A throwaway directory that really exists on disk — the identity read and the
/// FR-8 recursive delete both touch the filesystem, so the fixtures must too.
pub(crate) fn tmp_account_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "francois-acct-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
