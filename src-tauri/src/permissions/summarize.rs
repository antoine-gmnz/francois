//! FR-4: the human-readable one-line summary of a tool input.

use serde_json::Value;

// ---------- FR-4: input summary ----------

/// FR-4: the one-line human rendering of a tool call — the line the card leads
/// with. `''` when the tool exposes no obvious "what" key (the card still shows
/// the whole input JSON, so nothing is hidden).
pub fn summarize_input(tool: &str, input: &Value) -> String {
    let s = |key: &str| -> Option<String> {
        input
            .get(key)
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let picked = match tool {
        "Bash" => s("command"),
        "Read" | "Edit" | "Write" | "MultiEdit" => s("file_path"),
        "NotebookEdit" => s("notebook_path").or_else(|| s("file_path")),
        "Glob" | "Grep" | "LS" => s("path"),
        "WebFetch" => s("url"),
        "WebSearch" => s("query"),
        _ => None,
    };
    picked.unwrap_or_default()
}

/// code-editor-agents FR-1: the file a mutating tool call touches, and how.
/// Reuses `summarize_input`'s tool→path-field table rather than a third copy;
/// `None` for a non-mutating tool or a call with no path.
pub fn file_touch(tool: &str, input: &Value) -> Option<(crate::session::FileTouchKind, String)> {
    use crate::session::FileTouchKind;
    let kind = match tool {
        "Edit" | "MultiEdit" | "NotebookEdit" => FileTouchKind::Edit,
        "Write" => FileTouchKind::Write,
        _ => return None,
    };
    let path = summarize_input(tool, input);
    (!path.is_empty()).then_some((kind, path))
}

/// FR-4: the whole tool input, pretty-printed, truncated to 4000 chars. A
/// non-object input still renders (the CLI is free to send anything).
pub fn input_json(input: &Value) -> String {
    let full = serde_json::to_string_pretty(input).unwrap_or_else(|_| "{}".into());
    if full.chars().count() <= 4000 {
        return full;
    }
    let head: String = full.chars().take(4000).collect();
    format!("{head}\n…")
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    // ---- FR-4: card content ----

    #[test]
    fn file_touch_names_the_mutating_tools_and_their_path() {
        use crate::session::FileTouchKind;
        let p = json!({ "file_path": "/r/a.ts" });
        assert_eq!(
            file_touch("Edit", &p),
            Some((FileTouchKind::Edit, "/r/a.ts".into()))
        );
        assert_eq!(
            file_touch("MultiEdit", &p),
            Some((FileTouchKind::Edit, "/r/a.ts".into()))
        );
        assert_eq!(
            file_touch("Write", &p),
            Some((FileTouchKind::Write, "/r/a.ts".into()))
        );
        assert_eq!(
            file_touch("NotebookEdit", &json!({ "notebook_path": "/r/n.ipynb" })),
            Some((FileTouchKind::Edit, "/r/n.ipynb".into()))
        );
        assert_eq!(file_touch("Read", &p), None);
        assert_eq!(
            file_touch("Bash", &json!({ "command": "sed -i x a" })),
            None
        );
        assert_eq!(file_touch("Edit", &json!({})), None);
    }

    #[test]
    fn summary_picks_the_tool_s_what_key_and_json_is_truncated() {
        assert_eq!(
            summarize_input("Bash", &json!({ "command": "npm test" })),
            "npm test"
        );
        assert_eq!(
            summarize_input("Read", &json!({ "file_path": "/a/b" })),
            "/a/b"
        );
        assert_eq!(
            summarize_input("WebFetch", &json!({ "url": "https://x" })),
            "https://x"
        );
        assert_eq!(summarize_input("Frobnicate", &json!({ "x": 1 })), "");
        let big = json!({ "command": "x".repeat(9000) });
        let out = input_json(&big);
        assert!(
            out.chars().count() <= 4002,
            "truncated to 4000 + the … marker"
        );
        assert!(out.ends_with('…'));
    }
}
