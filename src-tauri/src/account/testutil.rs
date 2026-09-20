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
        kind: AccountKind::ClaudeCodeOauth,
        endpoint: None,
        pi: None,
    }
}

/// pi-provider-auth: a `pi` row pointing at a real temp dir (`tmp_account_dir`)
/// so fingerprint/trust tests can write configuration files into it.
pub(crate) fn pi_record_fixture(id: &str, label: &str, trusted: bool) -> AccountRecord {
    let dir = tmp_account_dir(&format!("pi-{id}"));
    let fingerprint = trusted
        .then(|| super::compute_fingerprint(&dir.to_string_lossy()).into_baseline())
        .flatten();
    AccountRecord {
        id: id.into(),
        label: label.into(),
        email: None,
        organization: None,
        config_dir: dir.to_string_lossy().into_owned(),
        created_at: 1_000,
        kind: AccountKind::Pi,
        endpoint: None,
        pi: Some(PiRecord {
            runtime: "native".into(),
            distro: None,
            inherit_environment_credentials: false,
            trusted,
            fingerprint,
        }),
    }
}

/// multi-provider-endpoint: an `openai-compatible` row, config dir on real
/// disk (`tmp_account_dir`) so `hasKey`/key-file tests can write into it.
pub(crate) fn endpoint_record_fixture(id: &str, label: &str, base_url: &str) -> AccountRecord {
    AccountRecord {
        id: id.into(),
        label: label.into(),
        email: None,
        organization: None,
        config_dir: tmp_account_dir(&format!("endpoint-{id}"))
            .to_string_lossy()
            .into_owned(),
        created_at: 1_000,
        kind: AccountKind::OpenAiCompatible,
        endpoint: Some(EndpointRecord {
            base_url: base_url.into(),
            model_ids: None,
        }),
        pi: None,
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
        pi_setups: HashMap::new(),
    }
}

/// pi-provider-auth FR-3: a live-shaped `LoginHandle` for the `pi_setups` map
/// — a real PTY pair (never read, never written) and a no-op killer, so the
/// FR-4/FR-8 in-use gates can be exercised without spawning anything.
pub(crate) fn pi_setup_handle_fixture(account_id: &str) -> LoginHandle {
    #[derive(Debug)]
    struct NoopKiller;
    impl portable_pty::ChildKiller for NoopKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }
        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(NoopKiller)
        }
    }
    let master = portable_pty::native_pty_system()
        .openpty(portable_pty::PtySize {
            rows: 1,
            cols: 1,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap()
        .master;
    LoginHandle {
        login_id: format!("login-{account_id}"),
        account_id: account_id.into(),
        label: None,
        config_dir: "/pi/home".into(),
        existing: true,
        writer: Box::new(std::io::sink()),
        master,
        killer: Box::new(NoopKiller),
        settled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        kind: AccountKind::Pi,
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
