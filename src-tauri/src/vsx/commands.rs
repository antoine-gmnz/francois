// vsx/commands.rs — the seven `francois:vsx:*` commands. Every one runs its
// network/disk work on the blocking pool (`spawn_blocking`, as editor search
// does), so a slow registry never holds an async-runtime worker. The `*_impl`
// functions take the registry and root explicitly, so they test without Tauri.

use super::classify::classify;
use super::registry::{page_url, Entry};
use super::{
    contributions, default_root, icons, install, store, ExtId, Registry, VsxContributions,
    VsxDetails, VsxInstalled, VsxResult, VsxSearchData, VsxSummary, VsxSupport,
};
use crate::ipc::{AppError, ErrorCode, IpcResult};
use serde::Serialize;
use std::path::{Path, PathBuf};

fn root() -> VsxResult<PathBuf> {
    default_root().ok_or_else(|| {
        AppError::new(
            ErrorCode::Internal,
            "No home directory — extensions cannot be stored.",
        )
    })
}

fn cache_of(root: &Path) -> PathBuf {
    root.join("cache")
}

fn summary(entry: &Entry, icon: Option<String>, support: Option<VsxSupport>) -> VsxSummary {
    VsxSummary {
        id: entry.id(),
        namespace: entry.namespace.clone(),
        name: entry.name.clone(),
        display_name: entry.display_name.clone(),
        description: entry.description.clone(),
        version: entry.version.clone(),
        publisher: entry.publisher.clone(),
        download_count: entry.download_count,
        average_rating: entry.average_rating,
        icon,
        support,
        verified: entry.verified,
    }
}

pub(crate) fn search_impl(
    reg: &Registry,
    cache: Option<&Path>,
    query: &str,
    offset: u32,
) -> VsxResult<VsxSearchData> {
    let (entries, total) = reg.search(query, offset)?;
    // Icons in parallel: a page is ≤ 30 short, capped, mostly-cached fetches.
    let icons: Vec<Option<String>> = std::thread::scope(|s| {
        let handles: Vec<_> = entries
            .iter()
            .map(|e| {
                s.spawn(move || {
                    e.files
                        .icon
                        .as_deref()
                        .and_then(|u| icons::icon(reg, cache, u))
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().ok().flatten())
            .collect()
    });
    let results = entries
        .iter()
        .zip(icons)
        .map(|(e, icon)| summary(e, icon, None))
        .collect();
    Ok(VsxSearchData { results, total })
}

pub(crate) fn details_impl(
    reg: &Registry,
    cache: Option<&Path>,
    id: &str,
) -> VsxResult<VsxDetails> {
    let ext = ExtId::parse(id)?;
    let entry = reg.version(&ext, None)?;
    let manifest = reg.manifest(&entry)?;
    let cls = classify(&manifest);
    let icon = entry
        .files
        .icon
        .as_deref()
        .and_then(|u| icons::icon(reg, cache, u));
    Ok(VsxDetails {
        summary: summary(&entry, icon, Some(cls.support)),
        contributions: cls.counts,
        language_ids: cls.language_ids,
        license: entry.license.clone(),
        repository: entry.repository.clone(),
        page_url: page_url(&reg.base, &entry),
        readme: reg.readme(&entry),
    })
}

async fn blocking<T, F>(what: &'static str, job: F) -> IpcResult<T>
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> VsxResult<T> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(job).await {
        Ok(r) => r.into(),
        Err(e) => AppError::new(ErrorCode::Internal, format!("{what} failed: {e}")).into(),
    }
}

/// francois:vsx:search
#[tauri::command]
pub async fn vsx_search(query: String, offset: u32) -> IpcResult<VsxSearchData> {
    blocking("search", move || {
        let cache = root().ok().map(|r| cache_of(&r));
        search_impl(&Registry::production(), cache.as_deref(), &query, offset)
    })
    .await
}

/// francois:vsx:details
#[tauri::command]
pub async fn vsx_details(id: String) -> IpcResult<VsxDetails> {
    blocking("details", move || {
        let cache = root().ok().map(|r| cache_of(&r));
        details_impl(&Registry::production(), cache.as_deref(), &id)
    })
    .await
}

/// francois:vsx:install
#[tauri::command]
pub async fn vsx_install(id: String, version: Option<String>) -> IpcResult<VsxInstalled> {
    blocking("install", move || {
        let root = root()?;
        install::install(
            &Registry::production(),
            &root,
            Some(&cache_of(&root)),
            &id,
            version.as_deref(),
            crate::ids::now_ms(),
        )
    })
    .await
}

/// francois:vsx:uninstall
#[tauri::command]
pub async fn vsx_uninstall(id: String) -> IpcResult<()> {
    blocking("uninstall", move || store::uninstall(&root()?, &id)).await
}

/// francois:vsx:setEnabled
#[tauri::command]
pub async fn vsx_set_enabled(id: String, enabled: bool) -> IpcResult<VsxInstalled> {
    blocking("setEnabled", move || {
        store::set_enabled(&root()?, &id, enabled)
    })
    .await
}

/// francois:vsx:list — never hits the network.
#[tauri::command]
pub async fn vsx_list() -> IpcResult<Vec<VsxInstalled>> {
    blocking("list", || Ok(store::list(&root()?))).await
}

/// francois:vsx:contributions — never hits the network.
#[tauri::command]
pub async fn vsx_contributions() -> IpcResult<VsxContributions> {
    blocking("contributions", || {
        Ok(contributions::contributions(&root()?))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::testutil::TempDir;
    use crate::vsx::testutil::{registry, toml_manifest, FakeFetch, BASE};
    use serde_json::json;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nicon";

    #[test]
    fn search_builds_summaries_with_icons_and_null_support() {
        let tmp = TempDir::new();
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        fake.json(
            &reg.search_url("", 0),
            json!({ "totalSize": 99, "extensions": [
                { "namespace": "Acme", "name": "toml", "version": "1.0.0", "files": { "icon": format!("{BASE}/i.png") } },
                { "namespace": "acme", "name": "noicon", "version": "1.0.0", "files": { "icon": format!("{BASE}/gone.png") } }
            ]}),
        );
        fake.bytes(&format!("{BASE}/i.png"), PNG.to_vec());
        let data = search_impl(&reg, Some(&tmp.path().join("cache")), "", 0).unwrap();
        assert_eq!(data.total, 99);
        assert_eq!(data.results.len(), 2);
        assert_eq!(data.results[0].id, "acme.toml");
        assert!(data.results[0]
            .icon
            .as_deref()
            .unwrap()
            .starts_with("data:image/png"));
        assert_eq!(data.results[0].support, None);
        assert_eq!(
            data.results[1].icon, None,
            "a failed icon is null, not an error"
        );
        let v = serde_json::to_value(&data).unwrap();
        assert_eq!(v["results"][0]["support"], json!(null));
    }

    #[test]
    fn search_offline_is_unreachable() {
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        let e = search_impl(&reg, None, "toml", 0).unwrap_err();
        assert_eq!(e.code, ErrorCode::VsxUnreachable);
    }

    #[test]
    fn details_classify_the_manifest_and_carry_the_readme() {
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        let mut m = toml_manifest("1.0.0");
        m["main"] = json!("./out/main.js");
        fake.json(
            &format!("{BASE}/api/acme/toml"),
            json!({
                "namespace": "acme", "name": "toml", "version": "1.0.0", "license": "MIT",
                "files": { "manifest": format!("{BASE}/pkg.json"), "readme": format!("{BASE}/README.md") }
            }),
        );
        fake.json(&format!("{BASE}/pkg.json"), m);
        fake.bytes(
            &format!("{BASE}/README.md"),
            b"# TOML\n![b](x.png)".to_vec(),
        );
        let d = details_impl(&reg, None, "acme.toml").unwrap();
        assert_eq!(d.summary.support, Some(VsxSupport::Partial));
        assert_eq!(d.contributions.languages, 1);
        assert_eq!(d.contributions.language_configurations, 1);
        assert_eq!(d.language_ids, vec!["toml"]);
        assert_eq!(d.license.as_deref(), Some("MIT"));
        assert_eq!(d.readme.as_deref(), Some("# TOML"));
        assert_eq!(d.page_url, format!("{BASE}/extension/acme/toml"));
        assert_eq!(d.summary.icon, None);
    }

    #[test]
    fn details_of_an_unknown_id_is_not_found() {
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        fake.status(&format!("{BASE}/api/acme/nope"), 404);
        assert_eq!(
            details_impl(&reg, None, "acme.nope").unwrap_err().code,
            ErrorCode::VsxNotFound
        );
        assert_eq!(
            details_impl(&reg, None, "not-an-id").unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
}
