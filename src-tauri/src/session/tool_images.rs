//! tool-images: the images a tool hands back to the model — a `Read` of a
//! PNG, an MCP screenshot — shown in the transcript under the tool's row.
//!
//! Claude Code reports them as content parts of the `tool_result`:
//! `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}`
//! (verified against a real `claude -p --output-format stream-json` capture).
//!
//! The bytes never ride a block, an event or the transcript: `BufBlock` is
//! cloned and re-persisted on every settle, and a screenshot is megabytes of
//! base64. The parser lifts the parts out ([`extract_result_images`]) and the
//! projection — the layer that already does the step-detail I/O — decodes each
//! one to a file under the app-data dir ([`store_images`]). The block carries
//! only a [`ToolImage`] ref (path + mime + size), rendered by the webview
//! through the asset protocol.
//!
//! The asset scope is granted on the whole `tool-images/` directory once at
//! startup ([`grant_scope`]): every file in it was written by Francois itself,
//! and a per-file grant made at decode time would not survive a restart, so a
//! reopened session's images would 403.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The dir under `app_data_dir()` that holds every decoded image, one subdir per session.
pub const DIR_NAME: &str = "tool-images";
/// A decoded image larger than this is dropped rather than written — the API
/// itself caps an image well below it, so only a malformed result gets here.
pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
/// At most this many images are kept from one tool result.
pub const MAX_IMAGES_PER_RESULT: usize = 16;

/// One base64 image part, as lifted off the stream by the parser.
#[derive(Clone, Debug, PartialEq)]
pub struct RawToolImage {
    /// One of the whitelisted mimes ([`extension_for`] accepted it).
    pub mime: String,
    pub data_base64: String,
}

/// `ToolImage` (contract/common.ts) — the ref a tool block carries.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolImage {
    pub path: String,
    pub mime: String,
    pub bytes: u64,
}

/// The file extension for a whitelisted image mime, `None` for anything else.
/// The extension comes from this table and never from the mime string itself,
/// so a crafted `media_type` cannot choose the file name. SVG is deliberately
/// absent: it is a document, not a bitmap, and can carry script.
pub fn extension_for(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn canonical_mime(mime: &str) -> &str {
    if mime == "image/jpg" {
        "image/jpeg"
    } else {
        mime
    }
}

/// The base64 image parts of a `tool_result`'s `content`, in order. A string
/// content, a non-image part, a non-base64 source (`url`, `file`) or a mime
/// outside the whitelist contributes nothing.
pub fn extract_result_images(content: Option<&Value>) -> Vec<RawToolImage> {
    let Some(Value::Array(parts)) = content else {
        return Vec::new();
    };
    parts
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("image"))
        .filter_map(|p| {
            let source = p.get("source")?;
            if source.get("type").and_then(Value::as_str) != Some("base64") {
                return None;
            }
            let mime = source.get("media_type").and_then(Value::as_str)?;
            extension_for(mime)?;
            let data = source.get("data").and_then(Value::as_str)?;
            Some(RawToolImage {
                mime: canonical_mime(mime).to_string(),
                data_base64: data.to_string(),
            })
        })
        .take(MAX_IMAGES_PER_RESULT)
        .collect()
}

/// A path segment built from an id the core did not necessarily mint: only
/// `[A-Za-z0-9_-]` survives, so it can never climb out of its directory.
fn safe_segment(id: &str) -> Option<String> {
    let s: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    (!s.is_empty() && s.chars().any(|c| c != '_')).then_some(s)
}

/// Decode `images` and write them under `root/<session>/<block>-<n>.<ext>`.
/// Best effort, per image: one that fails to decode, is empty or oversized,
/// or cannot be written is skipped and the rest still land.
pub fn store_images(
    root: &Path,
    session_id: &str,
    block_id: &str,
    images: &[RawToolImage],
) -> Vec<ToolImage> {
    if images.is_empty() {
        return Vec::new();
    }
    let (Some(session), Some(block)) = (safe_segment(session_id), safe_segment(block_id)) else {
        return Vec::new();
    };
    let dir = root.join(session);
    if std::fs::create_dir_all(&dir).is_err() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (n, image) in images.iter().enumerate() {
        let Some(ext) = extension_for(&image.mime) else {
            continue;
        };
        // A base64 string decodes to 3/4 of its length: refuse before decoding.
        if image.data_base64.len() / 4 * 3 > MAX_IMAGE_BYTES + 3 {
            continue;
        }
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(image.data_base64.trim())
        else {
            continue;
        };
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            continue;
        }
        let path = dir.join(format!("{block}-{n}.{ext}"));
        if std::fs::write(&path, &bytes).is_err() {
            continue;
        }
        out.push(ToolImage {
            path: path.to_string_lossy().into_owned(),
            mime: canonical_mime(&image.mime).to_string(),
            bytes: bytes.len() as u64,
        });
    }
    out
}

/// Remove one session's decoded images (session removed, or `/clear`).
pub fn remove_session_images(root: &Path, session_id: &str) {
    if let Some(session) = safe_segment(session_id) {
        let _ = std::fs::remove_dir_all(root.join(session));
    }
}

/// `app_data_dir()/tool-images`.
pub fn images_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|d| d.join(DIR_NAME))
}

/// Grant the webview read access to the whole `tool-images/` dir — see the
/// module doc for why a directory grant is safe here and a per-file one is not
/// enough. Best effort: a refused grant costs thumbnails, never the transcript.
pub fn grant_scope(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(root) = images_root(app) {
        let _ = std::fs::create_dir_all(&root);
        let _ = app.asset_protocol_scope().allow_directory(&root, true);
    }
}

/// [`remove_session_images`] against the app's own root.
pub fn remove_for_session(app: &tauri::AppHandle, session_id: &str) {
    if let Some(root) = images_root(app) {
        remove_session_images(&root, session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A real 1×1 PNG, as the CLI sent it.
    const DOT_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "francois-tool-images-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn extracts_base64_image_parts_in_order_and_skips_the_rest() {
        let content = json!([
            { "type": "text", "text": "hello" },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": DOT_PNG } },
            { "type": "image", "source": { "type": "url", "url": "https://x/y.png" } },
            { "type": "image", "source": { "type": "base64", "media_type": "image/svg+xml", "data": "PHN2Zz4=" } },
            { "type": "image", "source": { "type": "base64", "media_type": "image/jpg", "data": "AAAA" } },
        ]);
        let images = extract_result_images(Some(&content));
        assert_eq!(images.len(), 2);
        assert_eq!(images[0].mime, "image/png");
        assert_eq!(images[0].data_base64, DOT_PNG);
        assert_eq!(images[1].mime, "image/jpeg");
    }

    #[test]
    fn a_string_or_missing_content_has_no_images() {
        assert!(extract_result_images(Some(&json!("text"))).is_empty());
        assert!(extract_result_images(None).is_empty());
    }

    #[test]
    fn caps_the_number_of_images_per_result() {
        let part = json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": DOT_PNG } });
        let content = Value::Array(vec![part; MAX_IMAGES_PER_RESULT + 5]);
        assert_eq!(
            extract_result_images(Some(&content)).len(),
            MAX_IMAGES_PER_RESULT
        );
    }

    #[test]
    fn stores_decoded_bytes_under_session_and_block() {
        let root = tmp("store");
        let raw = RawToolImage {
            mime: "image/png".into(),
            data_base64: DOT_PNG.into(),
        };
        let out = store_images(&root, "s-1", "b-1", &[raw]);
        assert_eq!(out.len(), 1);
        let expected = root.join("s-1").join("b-1-0.png");
        assert_eq!(out[0].path, expected.to_string_lossy());
        assert_eq!(out[0].mime, "image/png");
        let bytes = std::fs::read(&expected).unwrap();
        assert_eq!(out[0].bytes, bytes.len() as u64);
        assert_eq!(&bytes[1..4], b"PNG");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn skips_undecodable_images_but_keeps_the_good_ones() {
        let root = tmp("partial");
        let bad = RawToolImage {
            mime: "image/png".into(),
            data_base64: "!!not base64!!".into(),
        };
        let good = RawToolImage {
            mime: "image/png".into(),
            data_base64: DOT_PNG.into(),
        };
        let out = store_images(&root, "s", "b", &[bad, good]);
        assert_eq!(out.len(), 1);
        assert!(out[0].path.ends_with("b-1.png"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ids_cannot_escape_the_root() {
        let root = tmp("escape");
        let raw = RawToolImage {
            mime: "image/png".into(),
            data_base64: DOT_PNG.into(),
        };
        let out = store_images(&root, "../..", "b", std::slice::from_ref(&raw));
        assert!(out.is_empty(), "an id made only of separators is refused");
        let out = store_images(&root, "a/../b", "c\\d", &[raw]);
        assert_eq!(out.len(), 1);
        assert!(Path::new(&out[0].path).starts_with(&root));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn removing_a_session_drops_only_its_dir() {
        let root = tmp("remove");
        let raw = RawToolImage {
            mime: "image/png".into(),
            data_base64: DOT_PNG.into(),
        };
        store_images(&root, "s1", "b", std::slice::from_ref(&raw));
        store_images(&root, "s2", "b", &[raw]);
        remove_session_images(&root, "s1");
        assert!(!root.join("s1").exists());
        assert!(root.join("s2").join("b-0.png").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn tool_image_serializes_to_the_contract_shape() {
        let image = ToolImage {
            path: "/a/b.png".into(),
            mime: "image/png".into(),
            bytes: 7,
        };
        assert_eq!(
            serde_json::to_value(&image).unwrap(),
            json!({ "path": "/a/b.png", "mime": "image/png", "bytes": 7 })
        );
    }
}
