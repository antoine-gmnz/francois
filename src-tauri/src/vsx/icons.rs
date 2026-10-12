// vsx/icons.rs — FR-1: extension icons cross IPC as `data:` URLs (the webview
// never fetches from the registry). Fetched capped at 256 KiB, cached on disk
// by URL under `~/.francois/vsx/cache/` with an LRU bound of 20 MiB — recency
// is the file's mtime, refreshed on every hit.

use super::{Registry, SHORT_TIMEOUT};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::SystemTime;

pub(crate) const ICON_CAP: u64 = 256 * 1024;
pub(crate) const CACHE_CAP: u64 = 20 * 1024 * 1024;

/// The image type from its magic bytes — never from the URL, which the
/// registry controls but the bytes may contradict. Unknown types are refused.
fn mime_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]).to_ascii_lowercase();
        head.contains("<svg").then_some("image/svg+xml")
    }
}

pub(crate) fn data_url(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() || bytes.len() as u64 > ICON_CAP {
        return None;
    }
    let mime = mime_of(bytes)?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn cache_key(url: &str) -> String {
    Sha256::digest(url.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The icon at `url` as a data URL, through the disk cache when there is one.
/// Every failure is `None` — an icon is never worth failing a command for.
pub(crate) fn icon(reg: &Registry, cache_dir: Option<&Path>, url: &str) -> Option<String> {
    let cached = cache_dir.map(|d| d.join(cache_key(url)));
    if let Some(path) = &cached {
        if let Ok(text) = std::fs::read_to_string(path) {
            if text.starts_with("data:image/") {
                if let Ok(f) = std::fs::File::options().write(true).open(path) {
                    let _ = f.set_modified(SystemTime::now());
                }
                return Some(text);
            }
        }
    }
    let bytes = reg.get_bytes(url, SHORT_TIMEOUT, ICON_CAP).ok()?;
    let data = data_url(&bytes)?;
    if let (Some(dir), Some(path)) = (cache_dir, &cached) {
        if crate::fs_util::ensure_dir_0700(dir).is_ok()
            && crate::fs_util::write_atomic(path, data.as_bytes()).is_ok()
        {
            evict(dir, CACHE_CAP);
        }
    }
    Some(data)
}

/// Drop least-recently-used entries until the directory is within `cap`.
pub(crate) fn evict(dir: &Path, cap: u64) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(SystemTime, u64, std::path::PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file().then(|| {
                (
                    m.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    m.len(),
                    e.path(),
                )
            })
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= cap {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::testutil::TempDir;
    use crate::vsx::testutil::{registry, FakeFetch, BASE};
    use std::time::Duration;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";

    #[test]
    fn data_urls_sniff_the_bytes_and_refuse_unknown_or_oversized() {
        assert_eq!(
            data_url(PNG).unwrap(),
            "data:image/png;base64,iVBORw0KGgpyZXN0"
        );
        assert!(data_url(b"<?xml?><svg xmlns='x'/>")
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        assert!(data_url(&[0xFF, 0xD8, 0xFF, 0])
            .unwrap()
            .starts_with("data:image/jpeg"));
        assert_eq!(data_url(b"MZ\x90\x00"), None);
        assert_eq!(data_url(b""), None);
        let mut big = PNG.to_vec();
        big.resize(ICON_CAP as usize + 1, 0);
        assert_eq!(data_url(&big), None);
    }

    #[test]
    fn icons_are_cached_by_url_and_served_offline() {
        let tmp = TempDir::new();
        let cache = tmp.path().join("cache");
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        let url = format!("{BASE}/icon.png");
        fake.bytes(&url, PNG.to_vec());
        let first = icon(&reg, Some(&cache), &url).unwrap();
        // gone from the "network": the cache answers
        fake.status(&url, 500);
        assert_eq!(icon(&reg, Some(&cache), &url).unwrap(), first);
        assert_eq!(fake.hit_count(&url), 1);
        // no cache dir: straight fetch, and a failure is just None
        assert_eq!(icon(&reg, None, &url), None);
    }

    #[test]
    fn oversized_icons_are_not_fetched_whole() {
        let fake = FakeFetch::default();
        let reg = registry(&fake);
        let url = format!("{BASE}/big.png");
        let mut big = PNG.to_vec();
        big.resize(ICON_CAP as usize + 10, 0);
        fake.bytes(&url, big);
        assert_eq!(icon(&reg, None, &url), None);
    }

    #[test]
    fn eviction_drops_least_recently_used_first() {
        let tmp = TempDir::new();
        let dir = tmp.path();
        let base = SystemTime::now() - Duration::from_secs(100);
        for (i, name) in ["old", "mid", "new"].iter().enumerate() {
            let p = dir.join(name);
            std::fs::write(&p, vec![0u8; 10]).unwrap();
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_modified(base + Duration::from_secs(i as u64 * 10))
                .unwrap();
        }
        evict(dir, 20);
        assert!(!dir.join("old").exists());
        assert!(dir.join("mid").exists());
        assert!(dir.join("new").exists());
        evict(dir, 100);
        assert!(dir.join("mid").exists());
    }
}
