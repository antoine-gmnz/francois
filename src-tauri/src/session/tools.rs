//! tool summary / meta derivation for transcript blocks (§5.4).

use serde_json::Value;

// ---------- tool summary / meta derivation (§5.4) ----------

pub(crate) fn rel_path(path: &str, cwd: &str) -> String {
    if !cwd.is_empty() {
        if let Some(stripped) = path.strip_prefix(cwd) {
            let s = stripped.trim_start_matches(['/', '\\']);
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    path.to_string()
}

pub(crate) fn truncate(s: &str, n: usize) -> String {
    let collapsed: String = s
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    if collapsed.chars().count() > n {
        collapsed.chars().take(n).collect()
    } else {
        collapsed
    }
}

pub(crate) fn str_field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(|v| v.as_str())
}

pub(crate) fn tool_summary(tool: &str, input: &Value, cwd: &str) -> String {
    match tool {
        "Read" | "Edit" | "MultiEdit" | "Write" => str_field(input, "file_path")
            .map(|p| rel_path(p, cwd))
            .unwrap_or_default(),
        "Grep" => truncate(str_field(input, "pattern").unwrap_or(""), 60),
        "Glob" => str_field(input, "pattern").unwrap_or("").to_string(),
        "Bash" => truncate(str_field(input, "command").unwrap_or(""), 60),
        "Task" | "Agent" => str_field(input, "subagent_type")
            .or_else(|| str_field(input, "description"))
            .unwrap_or("subagent")
            .to_string(),
        "WebFetch" => str_field(input, "url").unwrap_or("").to_string(),
        "WebSearch" => str_field(input, "query").unwrap_or("").to_string(),
        _ => {
            if let Some(obj) = input.as_object() {
                for (k, val) in obj {
                    if k.starts_with("__") {
                        continue;
                    }
                    if let Some(s) = val.as_str() {
                        return truncate(s, 60);
                    }
                }
            }
            truncate(&input.to_string(), 60)
        }
    }
}

pub(crate) fn line_count(s: &str) -> usize {
    if s.is_empty() {
        0
    } else {
        s.lines().count()
    }
}

pub(crate) fn edit_counts(old: &str, new: &str) -> (usize, usize) {
    let old_lines: Vec<&str> = old.split('\n').collect();
    let new_lines: Vec<&str> = new.split('\n').collect();
    let mut lead = 0;
    while lead < old_lines.len() && lead < new_lines.len() && old_lines[lead] == new_lines[lead] {
        lead += 1;
    }
    let mut trail = 0;
    while trail < (old_lines.len() - lead)
        && trail < (new_lines.len() - lead)
        && old_lines[old_lines.len() - 1 - trail] == new_lines[new_lines.len() - 1 - trail]
    {
        trail += 1;
    }
    let m = old_lines.len() - lead - trail; // removed
    let n = new_lines.len() - lead - trail; // added
    (n, m)
}

pub(crate) fn tool_meta(tool: &str, input: &Value, result: &str) -> String {
    match tool {
        "Read" => format!("{} lines", line_count(result)),
        "Grep" => {
            let matches = line_count(result);
            if matches == 0 {
                return "no matches".into();
            }
            let files: std::collections::HashSet<&str> = result
                .lines()
                .filter_map(|l| l.split(':').next())
                .filter(|p| !p.is_empty())
                .collect();
            if result.lines().any(|l| l.contains(':')) {
                format!("{matches} matches · {} files", files.len())
            } else {
                format!("{matches} files")
            }
        }
        "Glob" => format!("{} files", line_count(result)),
        "Edit" => {
            let old = str_field(input, "old_string").unwrap_or("");
            let new = str_field(input, "new_string").unwrap_or("");
            let (n, m) = edit_counts(old, new);
            format!("+{n} \u{2212}{m}")
        }
        "MultiEdit" => {
            let mut tn = 0;
            let mut tm = 0;
            if let Some(edits) = input.get("edits").and_then(|e| e.as_array()) {
                for e in edits {
                    let old = e.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
                    let new = e.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
                    let (n, m) = edit_counts(old, new);
                    tn += n;
                    tm += m;
                }
            }
            format!("+{tn} \u{2212}{tm}")
        }
        "Write" => format!(
            "{} lines",
            line_count(str_field(input, "content").unwrap_or(""))
        ),
        "Bash" => {
            if result.trim().is_empty() {
                "done".into()
            } else {
                format!("{} lines", line_count(result))
            }
        }
        "Task" | "Agent" => {
            let first = result
                .lines()
                .next()
                .unwrap_or("")
                .chars()
                .take(80)
                .collect::<String>();
            if first.is_empty() {
                "done".into()
            } else {
                first
            }
        }
        "WebFetch" | "WebSearch" => "done".into(),
        _ => "done".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    #[test]
    fn edit_counts_replace_one_line() {
        assert_eq!(edit_counts("a\nb\nc", "a\nX\nc"), (1, 1)); // +1 −1
    }

    #[test]
    fn edit_counts_noop() {
        assert_eq!(edit_counts("a\nb", "a\nb"), (0, 0));
    }

    #[test]
    fn edit_counts_pure_insertion() {
        // insert a line between a and b: +1 −0
        assert_eq!(edit_counts("a\nb", "a\nX\nb"), (1, 0));
    }

    #[test]
    fn edit_counts_pure_deletion() {
        assert_eq!(edit_counts("a\nX\nb", "a\nb"), (0, 1));
    }

    #[test]
    fn read_meta_counts_lines() {
        assert_eq!(tool_meta("Read", &json!({}), "l1\nl2\nl3"), "3 lines");
    }

    #[test]
    fn grep_meta_content_mode() {
        let r = "src/a.ts:1:foo\nsrc/b.ts:2:foo";
        assert_eq!(tool_meta("Grep", &json!({}), r), "2 matches \u{b7} 2 files");
    }

    #[test]
    fn grep_meta_no_matches() {
        assert_eq!(tool_meta("Grep", &json!({}), ""), "no matches");
    }

    #[test]
    fn edit_meta_uses_minus_sign() {
        let input = json!({ "old_string": "a\nb\nc", "new_string": "a\nX\nc" });
        assert_eq!(tool_meta("Edit", &input, ""), "+1 \u{2212}1");
    }

    #[test]
    fn multiedit_meta_sums_edits() {
        let input = json!({ "edits": [
            { "old_string": "a\nb", "new_string": "a\nX\nb" },   // +1 -0
            { "old_string": "p\nq\nr", "new_string": "p\nr" },   // +0 -1
        ]});
        assert_eq!(tool_meta("MultiEdit", &input, ""), "+1 \u{2212}1");
    }

    #[test]
    fn write_meta_counts_input_lines() {
        assert_eq!(
            tool_meta("Write", &json!({ "content": "a\nb" }), ""),
            "2 lines"
        );
    }

    #[test]
    fn bash_meta_empty_is_done() {
        assert_eq!(tool_meta("Bash", &json!({}), "   "), "done");
    }

    #[test]
    fn read_summary_relative_to_cwd() {
        let input = json!({ "file_path": "/proj/acme/src/x.ts" });
        assert_eq!(tool_summary("Read", &input, "/proj/acme"), "src/x.ts");
    }

    #[test]
    fn grep_summary_truncates() {
        let long = "x".repeat(80);
        let input = json!({ "pattern": long });
        assert_eq!(tool_summary("Grep", &input, "").chars().count(), 60);
    }

    #[test]
    fn task_summary_prefers_subagent_type() {
        let input = json!({ "subagent_type": "reviewer", "description": "review the diff" });
        assert_eq!(tool_summary("Task", &input, ""), "reviewer");
    }

    #[test]
    fn agent_tool_summary_uses_subagent_type() {
        let input = json!({ "subagent_type": "explorer", "description": "find files" });
        assert_eq!(tool_summary("Agent", &input, ""), "explorer");
    }
}
