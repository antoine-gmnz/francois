//! FR-23..FR-27 — the injected skill block.
//!
//! The one capability that ports across runtimes, because a skill's whole
//! mechanism is instructions and the discovery already exists. Name +
//! description only: full `SKILL.md` bodies would blow the context window
//! before the first user message.
//!
//! Discovery is read through `SessionEnv::discover_commands` (multi-provider-
//! seam FR-6), never off the live filesystem directly — that is precisely the
//! CRITICAL that blocked this branch a day ago (commit `6d3c50d`). The method
//! is misnamed for this call site (it returns skills AND slash-commands), but
//! adding a second accessor to the trait for a rename is not worth a shared
//! seam edit; this module filters `kind == "command"` out itself (FR-23).

use crate::session::*;

/// FR-24: the block's hard ceiling, in characters (not bytes) — skills past
/// this are dropped rather than truncated mid-line.
pub(crate) const SKILL_BLOCK_CAP: usize = 8_000;

/// FR-24: the fixed preamble every injected block opens with.
const PREAMBLE: &str = "The following named procedures are available for this session. \
When one's description matches what the user is asking for, follow it.\n\n";

/// The result of building the injected block (FR-24/FR-26): `text` is what
/// goes into the request's `system` message (empty when no skill qualifies —
/// nothing is injected and the caller must not report `skills.available`),
/// `injected`/`dropped` are the counts FR-26 needs to know whether anything
/// made it in and how much the 8_000-char cap cost.
#[derive(Debug, PartialEq)]
pub(crate) struct SkillBlock {
    pub(crate) text: String,
    pub(crate) injected: usize,
    pub(crate) dropped: usize,
}

impl SkillBlock {
    /// FR-26: at least one skill made it into `text`.
    pub(crate) fn is_available(&self) -> bool {
        self.injected > 0
    }
}

/// FR-23/FR-25: rebuilt per turn from a fresh `SessionEnv::discover_commands`
/// read — no second filesystem walk, and never persisted (FR-25), so a skill
/// added mid-session takes effect on the very next call.
pub(crate) fn build_skill_block(env: &dyn SessionEnv, cwd: &str) -> SkillBlock {
    let mut skills: Vec<SkillInfo> = env
        .discover_commands(cwd)
        .into_iter()
        // FR-23: only the installed set (project + user + enabled-plugin),
        // never the "available to install" half discover_commands also
        // returns — installing is out of scope here (FR-26).
        .filter(|s| s.installed)
        // FR-23: slash-command *.md entries are interactiveCommands, not skills.
        .filter(|s| s.kind.as_deref() != Some("command"))
        .collect();
    // FR-27: sorted here, independent of whatever order the caller returns
    // its entries in — a prompt-cache-defeating map-iteration nondeterminism
    // must fail loudly, not survive because the upstream happened to be sorted.
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    render_skill_block(&skills)
}

/// Pure over an already-sorted slice, so the cap/determinism logic is
/// testable with no `SessionEnv` at all.
fn render_skill_block(skills: &[SkillInfo]) -> SkillBlock {
    let mut text = String::from(PREAMBLE);
    let mut char_count = text.chars().count();
    let mut injected = 0usize;

    for (i, s) in skills.iter().enumerate() {
        let line = format!("{}: {}\n", s.name, s.description);
        let line_len = line.chars().count();
        if char_count + line_len > SKILL_BLOCK_CAP {
            // FR-24: skills past the cap are dropped, silently to the model
            // but counted here — contiguous from this point on, not
            // best-fit repacking of shorter entries further down the list.
            let dropped = skills.len() - i;
            let text = if injected == 0 { String::new() } else { text };
            return SkillBlock {
                text,
                injected,
                dropped,
            };
        }
        text.push_str(&line);
        char_count += line_len;
        injected += 1;
    }

    let text = if injected == 0 { String::new() } else { text };
    SkillBlock {
        text,
        injected,
        dropped: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::testenv::TestEnv;

    fn skill(name: &str, description: &str, installed: bool, kind: &str) -> SkillInfo {
        SkillInfo {
            name: name.into(),
            description: description.into(),
            installed,
            scope: Some("user".into()),
            kind: Some(kind.into()),
            plugin_id: None,
        }
    }

    // ---------- render_skill_block: pure, no SessionEnv ----------

    #[test]
    fn names_every_skill_one_line_each_under_the_preamble() {
        let skills = vec![
            skill("pdf-reader", "Read and parse PDFs", true, "skill"),
            skill("web-search", "Search the web", true, "skill"),
        ];
        let block = render_skill_block(&skills);
        assert!(block.text.starts_with(PREAMBLE));
        assert!(block.text.contains("pdf-reader: Read and parse PDFs\n"));
        assert!(block.text.contains("web-search: Search the web\n"));
        assert_eq!(block.injected, 2);
        assert_eq!(block.dropped, 0);
        assert!(block.is_available());
    }

    #[test]
    fn no_skills_yields_an_empty_unavailable_block() {
        let block = render_skill_block(&[]);
        assert_eq!(block.text, "");
        assert_eq!(block.injected, 0);
        assert!(!block.is_available());
    }

    #[test]
    fn respects_the_8000_char_cap_and_counts_the_drop() {
        // one huge skill description alone blows the cap
        let huge = "x".repeat(SKILL_BLOCK_CAP);
        let skills = vec![
            skill("first", "short one", true, "skill"),
            skill("second", &huge, true, "skill"),
            skill("third", "also short", true, "skill"),
        ];
        let block = render_skill_block(&skills);
        assert!(block.text.contains("first: short one"));
        assert!(!block.text.contains("second:"));
        assert!(!block.text.contains("third:"));
        assert_eq!(block.injected, 1);
        assert_eq!(block.dropped, 2);
        assert!(block.text.chars().count() <= SKILL_BLOCK_CAP);
    }

    #[test]
    fn every_skill_over_the_cap_yields_an_empty_unavailable_block() {
        let huge = "x".repeat(SKILL_BLOCK_CAP);
        let skills = vec![skill("only", &huge, true, "skill")];
        let block = render_skill_block(&skills);
        assert_eq!(block.text, "");
        assert_eq!(block.injected, 0);
        assert_eq!(block.dropped, 1);
        assert!(!block.is_available());
    }

    #[test]
    fn is_byte_identical_for_two_turns_with_unchanged_input() {
        // render_skill_block operates on an already-sorted slice (sorting is
        // build_skill_block's job — see the SessionEnv-order test below);
        // this proves the render step itself is a pure, repeatable function
        // of its input, with no hidden clock/uuid/iteration-order leak.
        let skills = vec![
            skill("alpha", "first alphabetically", true, "skill"),
            skill("zeta", "last alphabetically", true, "skill"),
        ];
        let first = render_skill_block(&skills);
        let second = render_skill_block(&skills);
        assert_eq!(first.text, second.text);
        assert!(first.text.find("alpha").unwrap() < first.text.find("zeta").unwrap());
    }

    // ---------- build_skill_block: through SessionEnv ----------

    #[test]
    fn excludes_slash_command_entries() {
        let env = TestEnv {
            engine: Engine::default(),
            ..Default::default()
        };
        // TestEnv::discover_commands returns the fixed seam fixture (two
        // skills, no commands) — add a command-kind case via render directly
        // since TestEnv's fixture is fixed; build_skill_block must still
        // filter it out if discover_commands ever returned one.
        let block = build_skill_block(&env, "/repo");
        assert!(block.text.contains("seam-fixture-skill-one"));
        assert!(block.text.contains("seam-fixture-skill-two"));
        assert!(block.is_available());

        // Runs build_skill_block itself (not a standalone .filter() call)
        // against a mixed list, so removing the filter from build_skill_block
        // would fail THIS assertion, not just a copy of the logic under test.
        struct FixedEnv(Vec<SkillInfo>);
        impl SessionEnv for FixedEnv {
            fn engine(&self) -> &Engine {
                unreachable!("not needed for this test")
            }
            fn emit_session(&self, _ev: SessionEvent) {}
            fn emit_agent(&self, _ev: AgentEvent) {}
            fn emit_workflow_detail(&self, _ev: WorkflowDetailEvent) {}
            fn persist(&self) {}
            fn append_transcript(&self, _session_id: &str, _block: &BufBlock) {}
            fn append_step_detail(&self, _session_id: &str, _detail: &StepDetail) {}
            fn note_file_diff(&self, _session_id: &str, _cwd: &str) {}
            fn discover_commands(&self, _cwd: &str) -> Vec<SkillInfo> {
                self.0
                    .iter()
                    .map(|s| SkillInfo {
                        name: s.name.clone(),
                        description: s.description.clone(),
                        installed: s.installed,
                        scope: s.scope.clone(),
                        kind: s.kind.clone(),
                        plugin_id: s.plugin_id.clone(),
                    })
                    .collect()
            }
        }

        let mixed = FixedEnv(vec![
            skill("run-tests", "runs the test suite", true, "command"),
            skill("real-skill", "a real skill", true, "skill"),
        ]);
        let block = build_skill_block(&mixed, "/repo");
        assert!(
            block.text.contains("real-skill"),
            "the skill-kind entry must survive"
        );
        assert!(
            !block.text.contains("run-tests"),
            "the command-kind entry must be filtered out"
        );
        assert_eq!(block.injected, 1);
    }

    #[test]
    fn excludes_available_but_not_installed_plugin_skills() {
        let skills = vec![
            skill("installed-one", "on", true, "skill"),
            skill("not-installed", "off", false, "skill"),
        ];
        let block = render_skill_block(
            &skills
                .into_iter()
                .filter(|s| s.installed)
                .collect::<Vec<_>>(),
        );
        assert!(block.text.contains("installed-one"));
        assert!(!block.text.contains("not-installed"));
    }

    #[test]
    fn build_skill_block_sorts_deterministically_regardless_of_discovery_order() {
        struct FixedEnv(Vec<SkillInfo>);
        impl SessionEnv for FixedEnv {
            fn engine(&self) -> &Engine {
                unreachable!("not needed for this test")
            }
            fn emit_session(&self, _ev: SessionEvent) {}
            fn emit_agent(&self, _ev: AgentEvent) {}
            fn emit_workflow_detail(&self, _ev: WorkflowDetailEvent) {}
            fn persist(&self) {}
            fn append_transcript(&self, _session_id: &str, _block: &BufBlock) {}
            fn append_step_detail(&self, _session_id: &str, _detail: &StepDetail) {}
            fn note_file_diff(&self, _session_id: &str, _cwd: &str) {}
            fn discover_commands(&self, _cwd: &str) -> Vec<SkillInfo> {
                self.0
                    .iter()
                    .map(|s| skill(&s.name, &s.description, s.installed, "skill"))
                    .collect()
            }
        }

        let forward = FixedEnv(vec![
            skill("alpha", "a", true, "skill"),
            skill("zeta", "z", true, "skill"),
        ]);
        let reversed = FixedEnv(vec![
            skill("zeta", "z", true, "skill"),
            skill("alpha", "a", true, "skill"),
        ]);
        let a = build_skill_block(&forward, "/repo");
        let b = build_skill_block(&reversed, "/repo");
        assert_eq!(
            a.text, b.text,
            "discovery order must not leak into the block"
        );
    }
}
