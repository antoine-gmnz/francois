//! FR-1/FR-2: the two paths a `Workflow` dispatch ack can carry. Parsing is
//! pure text; resolution is the one filesystem check the feature makes before
//! it trusts either of them.

use super::*;

// ---------- FR-1/FR-2: the paths the dispatch ack names ----------

/// The two paths a `Workflow` dispatch ack can carry.
#[derive(Default, Clone, PartialEq, Debug)]
pub struct AckPaths {
    pub(crate) transcript_dir: Option<String>,
    pub(crate) script_path: Option<String>,
}

/// The remainder of the line introduced by `label`, trimmed.
fn labeled_path(text: &str, label: &str) -> Option<String> {
    text.lines()
        .find_map(|l| l.trim().strip_prefix(label).map(|rest| rest.trim()))
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
}

/// FR-1, pure: `Transcript dir: <path>` / `Script file: <path>`, each the
/// remainder of its line. Neither present ⇒ both absent.
pub fn parse_ack_paths(text: &str) -> AckPaths {
    AckPaths {
        transcript_dir: labeled_path(text, "Transcript dir:"),
        script_path: labeled_path(text, "Script file:"),
    }
}

/// FR-2: a path is used only if it resolves — a DIRECTORY for the transcript, a
/// FILE for the script. Nothing here ever writes inside the run directory.
pub fn resolve_ack_paths(text: &str) -> AckPaths {
    let parsed = parse_ack_paths(text);
    AckPaths {
        transcript_dir: parsed.transcript_dir.filter(|p| Path::new(p).is_dir()),
        script_path: parsed.script_path.filter(|p| Path::new(p).is_file()),
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    // ---------- FR-1 / FR-2: the ack's paths ----------

    #[test]
    fn ack_paths_take_the_remainder_of_their_line_trimmed() {
        let ack = "Workflow started: wf_abc123\n  Transcript dir: /tmp/wf/run-1  \nScript file: /tmp/wf/run-1.js\nsee /workflows\n";
        let p = parse_ack_paths(ack);
        assert_eq!(p.transcript_dir.as_deref(), Some("/tmp/wf/run-1"));
        assert_eq!(p.script_path.as_deref(), Some("/tmp/wf/run-1.js"));
        // FR-1: a dispatch whose ack carries neither leaves both absent
        let none = parse_ack_paths("Workflow started: wf_abc123");
        assert_eq!(none.transcript_dir, None);
        assert_eq!(none.script_path, None);
    }

    #[test]
    fn ack_paths_are_kept_only_when_they_resolve_on_disk() {
        // FR-2: a directory for the transcript, a FILE for the script.
        let d = RunDir::new();
        d.write("wf.js", "//");
        let dir = d.path().to_string_lossy().to_string();
        let script = d.path().join("wf.js").to_string_lossy().to_string();
        let good = resolve_ack_paths(&format!("Transcript dir: {dir}\nScript file: {script}\n"));
        assert_eq!(good.transcript_dir.as_deref(), Some(dir.as_str()));
        assert_eq!(good.script_path.as_deref(), Some(script.as_str()));

        // swapped: a file is not a directory and a directory is not a file
        let bad = resolve_ack_paths(&format!("Transcript dir: {script}\nScript file: {dir}\n"));
        assert_eq!(bad.transcript_dir, None);
        assert_eq!(bad.script_path, None);
        let missing = resolve_ack_paths("Transcript dir: /no/such/dir\nScript file: /no/such.js");
        assert_eq!(missing.transcript_dir, None);
        assert_eq!(missing.script_path, None);
    }
}
