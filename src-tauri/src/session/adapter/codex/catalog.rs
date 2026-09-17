//! Memory-only catalogue cache. Identity is rechecked before both hits and publication.
use super::models::{probe, spawn_failure};
use crate::ipc::{AppError, ErrorCode};
use crate::session::models::ModelCatalog;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    home: PathBuf,
    program: PathBuf,
    fingerprints: Vec<Option<u64>>,
}
fn fingerprint(path: &Path, content: bool) -> Option<u64> {
    let metadata = std::fs::metadata(path).ok()?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    metadata.len().hash(&mut hash);
    metadata.modified().ok().hash(&mut hash);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.ino().hash(&mut hash);
        metadata.ctime().hash(&mut hash);
        metadata.ctime_nsec().hash(&mut hash);
    }
    if content {
        std::fs::read(path).ok()?.hash(&mut hash);
    }
    Some(hash.finish())
}
fn identity(app: &AppHandle, id: &str) -> Result<Identity, AppError> {
    if !crate::account::known_ids(app).contains(id) {
        return Err(AppError::new(
            ErrorCode::AccountNotFound,
            "Account no longer exists.",
        ));
    }
    let home = crate::account::config_dir_of(app, id)
        .ok_or_else(|| AppError::new(ErrorCode::AccountNotFound, "Account no longer exists."))?;
    if !crate::account::codex_auth_file_exists(&home) {
        return Err(AppError::new(
            ErrorCode::AccountNotAuthenticated,
            "Sign in to this Codex account first.",
        ));
    }
    let home = std::fs::canonicalize(home).map_err(|_| spawn_failure())?;
    let program = crate::process_util::resolve_program("codex").ok_or_else(spawn_failure)?;
    let program = std::fs::canonicalize(program).map_err(|_| spawn_failure())?;
    let fingerprints = vec![
        fingerprint(&program, false),
        fingerprint(&home.join("auth.json"), true),
        fingerprint(&home.join("config.toml"), true),
    ];
    Ok(Identity {
        home,
        program,
        fingerprints,
    })
}
#[derive(Default)]
struct Entry {
    identity: Option<Identity>,
    cached: Option<ModelCatalog>,
    running: bool,
    generation: u64,
    outcome: Option<Result<ModelCatalog, AppError>>,
}
#[derive(Default)]
struct Slot {
    entry: Mutex<Entry>,
    ready: Condvar,
}
static CACHE: OnceLock<Mutex<HashMap<String, Arc<Slot>>>> = OnceLock::new();
fn cache() -> &'static Mutex<HashMap<String, Arc<Slot>>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn invalidate(id: &str) {
    if let Some(slot) = cache().lock().unwrap().remove(id) {
        let mut entry = slot.entry.lock().unwrap();
        entry.identity = None;
        entry.cached = None;
        entry.generation += 1;
        entry.outcome = None;
        slot.ready.notify_all();
    }
}
fn age(catalog: &ModelCatalog, now: u64) -> u64 {
    now.saturating_sub(catalog.fetched_at.unwrap_or(0))
}
fn cached(mut catalog: ModelCatalog, warning: Option<AppError>) -> ModelCatalog {
    catalog.source = "memory-cache".into();
    catalog.freshness = if warning.is_some() { "stale" } else { "fresh" }.into();
    catalog.warning = warning;
    catalog
}
pub(crate) fn get(app: &AppHandle, id: &str, refresh: bool) -> Result<ModelCatalog, AppError> {
    let started = Instant::now();
    let key = match identity(app, id) {
        Ok(key) => key,
        Err(error) => {
            invalidate(id);
            return Err(error);
        }
    };
    let slot = {
        let known = crate::account::known_ids(app);
        let mut cache = cache().lock().unwrap();
        cache.retain(|id, _| known.contains(id));
        cache.entry(id.to_owned()).or_default().clone()
    };
    get_in_slot(
        &slot,
        id,
        key,
        refresh,
        || identity(app, id),
        crate::ids::now_ms,
        |key| {
            probe(
                &key.program,
                &key.home,
                Duration::from_secs(10).saturating_sub(started.elapsed()),
            )
        },
    )
}
fn get_in_slot(
    slot: &Slot,
    id: &str,
    key: Identity,
    refresh: bool,
    resolve: impl Fn() -> Result<Identity, AppError>,
    now: impl Fn() -> u64,
    fetch: impl FnOnce(&Identity) -> Result<(Vec<crate::ipc::ModelInfo>, Option<String>), AppError>,
) -> Result<ModelCatalog, AppError> {
    let mut entry = slot.entry.lock().unwrap();
    if entry.identity.as_ref() != Some(&key) {
        entry.identity = Some(key.clone());
        entry.cached = None;
        entry.outcome = None;
        entry.generation += 1;
    }
    if entry.running {
        let generation = entry.generation;
        while entry.running && entry.generation == generation {
            entry = slot.ready.wait(entry).unwrap();
        }
        if entry.generation == generation {
            if let Some(result) = &entry.outcome {
                if resolve()? != key {
                    return Err(AppError::new(
                        ErrorCode::InvalidInput,
                        "Account settings changed. Retry model discovery.",
                    ));
                }
                return result.clone();
            }
        }
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "Account settings changed. Retry model discovery.",
        ));
    }
    if !refresh {
        if let Some(catalog) = &entry.cached {
            if age(catalog, now()) < 60_000 {
                if resolve()? != key {
                    return Err(AppError::new(
                        ErrorCode::InvalidInput,
                        "Account settings changed. Retry model discovery.",
                    ));
                }
                return Ok(cached(catalog.clone(), None));
            }
        }
    }
    entry.running = true;
    let generation = entry.generation;
    drop(entry);
    let result = fetch(&key);
    let checked = resolve();
    let mut entry = slot.entry.lock().unwrap();
    let result = match checked {
        Err(error) => {
            entry.cached = None;
            Err(error)
        }
        Ok(current) if current != key || entry.generation != generation => {
            entry.cached = None;
            Err(AppError::new(
                ErrorCode::InvalidInput,
                "Account settings changed. Retry model discovery.",
            ))
        }
        Ok(_) => match result {
            Ok((models, default_model_id)) => {
                let catalog = ModelCatalog {
                    account_id: id.to_owned(),
                    agent_runtime: crate::session::AgentRuntime::Codex,
                    models,
                    default_model_id,
                    source: "codex-app-server".into(),
                    freshness: "fresh".into(),
                    fetched_at: Some(now()),
                    warning: None,
                };
                entry.cached = Some(catalog.clone());
                Ok(catalog)
            }
            Err(error) => match &entry.cached {
                Some(catalog) if age(catalog, now()) <= 24 * 60 * 60 * 1000 => {
                    Ok(cached(catalog.clone(), Some(error)))
                }
                _ => Err(error),
            },
        },
    };
    entry.running = false;
    entry.outcome = Some(result.clone());
    slot.ready.notify_all();
    result
}

#[cfg(test)]
mod tests {
    use super::super::models::failure;
    use super::*;
    fn key() -> Identity {
        Identity {
            home: "home".into(),
            program: "fake".into(),
            fingerprints: vec![Some(1), None],
        }
    }
    fn rows() -> Result<(Vec<crate::ipc::ModelInfo>, Option<String>), AppError> {
        Ok((
            vec![crate::ipc::model("future", "Future")],
            Some("future".into()),
        ))
    }
    fn request(
        slot: &Slot,
        at: u64,
        refresh: bool,
        fetch: impl FnOnce(&Identity) -> Result<(Vec<crate::ipc::ModelInfo>, Option<String>), AppError>,
    ) -> Result<ModelCatalog, AppError> {
        get_in_slot(slot, "account", key(), refresh, || Ok(key()), || at, fetch)
    }
    #[test]
    fn freshness_refresh_staleness_and_empty_success_boundaries() {
        let slot = Slot::default();
        assert_eq!(
            request(&slot, 1_000, false, |_| rows()).unwrap().source,
            "codex-app-server"
        );
        assert_eq!(
            request(&slot, 60_999, false, |_| panic!("fresh cache hit"))
                .unwrap()
                .source,
            "memory-cache"
        );
        assert_eq!(
            request(&slot, 61_000, false, |_| Err(failure("runtime")))
                .unwrap()
                .freshness,
            "stale"
        );
        assert_eq!(
            request(&slot, 1_000 + 86_400_000, false, |_| Err(failure(
                "runtime"
            )))
            .unwrap()
            .freshness,
            "stale"
        );
        assert!(request(&slot, 1_001 + 86_400_000, false, |_| Err(failure(
            "runtime"
        )))
        .is_err());
        assert!(request(&slot, 2_000, true, |_| Ok((vec![], None)))
            .unwrap()
            .models
            .is_empty());
        assert!(request(&slot, 2_001, false, |_| panic!(
            "empty cache is authoritative"
        ))
        .unwrap()
        .models
        .is_empty());
    }
    #[test]
    fn identity_changes_drop_stale_entries_and_inflight_results() {
        let slot = Slot::default();
        request(&slot, 1_000, false, |_| rows()).unwrap();
        let mut changed = key();
        changed.fingerprints[0] = Some(2);
        let error = get_in_slot(
            &slot,
            "account",
            changed.clone(),
            false,
            || Ok(changed.clone()),
            || 1_001,
            |_| Err(failure("runtime")),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::ModelCatalogUnavailable);
        let error = get_in_slot(
            &slot,
            "account",
            key(),
            true,
            || Ok(changed.clone()),
            || 1_001,
            |_| rows(),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(slot.entry.lock().unwrap().cached.is_none());
        let error = get_in_slot(
            &slot,
            "account",
            key(),
            true,
            || Err(AppError::new(ErrorCode::AccountNotAuthenticated, "Sign in")),
            || 1_001,
            |_| rows(),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::AccountNotAuthenticated);
    }
    #[test]
    fn simultaneous_refreshes_join_one_probe() {
        let slot = Arc::new(Slot::default());
        let (begun, rx) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let first = slot.clone();
        let handle = std::thread::spawn(move || {
            request(&first, 1_000, true, |_| {
                begun.send(()).unwrap();
                wait.recv().unwrap();
                rows()
            })
        });
        rx.recv().unwrap();
        let second = slot.clone();
        let joined = std::thread::spawn(move || {
            request(&second, 1_000, true, |_| panic!("must join active probe"))
        });
        // Wait until the joiner has parked on the condition variable.
        std::thread::sleep(Duration::from_millis(30));
        release.send(()).unwrap();
        assert_eq!(handle.join().unwrap().unwrap().models.len(), 1);
        assert_eq!(joined.join().unwrap().unwrap().models.len(), 1);
    }
    #[test]
    fn file_fingerprints_distinguish_missing_changed_and_replaced_files() {
        let dir =
            std::env::temp_dir().join(format!("francois-fingerprints-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("auth.json");
        assert_eq!(fingerprint(&file, true), None);
        std::fs::write(&file, b"first").unwrap();
        let first = fingerprint(&file, true);
        std::fs::write(&file, b"other").unwrap();
        assert_ne!(fingerprint(&file, true), first);
        let _ = std::fs::remove_dir_all(dir);
    }
}
