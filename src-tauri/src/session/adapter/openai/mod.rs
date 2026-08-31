//! The Francois agent loop (specs/multi-provider-openai.md): a Rust-native
//! turn over `POST <baseUrl>/chat/completions` + SSE, six tools carrying Claude
//! Code's names verbatim, and every one of those calls through the permission
//! gate this app already owns. `AgentRuntime::Francois` resolves here.
//!
//! Per PIPELINE.md §Code layout this file owns the **shared data model** — the
//! types the whole module touches — and declares the children, each of which
//! owns one concern plus its own `#[cfg(test)] mod tests`:
//!
//! - `gate`   — FR-9..FR-13: rule evaluation, permission modes, `cwd` containment
//! - `tools`  — FR-14/FR-15: the six tool implementations
//! - `wire`   — FR-3..FR-7: request bodies, SSE decoding, tool-call accumulation
//! - `thread` — FR-16/FR-17: the adapter-owned wire-message file
//! - `skills` — FR-23..FR-27: the injected system block
//! - `blocks` — pure round-trip decision helpers (FR-6/FR-7/§7) and the
//!   transcript block-emission helpers `runner`'s loop drives them into
//!
//! **No async runtime.** This crate has none, and `ureq` (blocking) is its only
//! HTTP client. The loop runs on a spawned thread, which is the shape
//! `ClaudeCodeAdapter::begin_turn` already uses for its NDJSON reader.
//! (Decision logged 2026-08-16 in specs/_decisions.md.)

mod blocks;
pub(crate) mod gate;
mod runner;
pub(crate) mod skills;
pub(crate) mod thread;
pub(crate) mod tools;
pub(crate) mod wire;

pub(crate) use runner::OpenAiAdapter;

use std::fmt;
use std::str::FromStr;

/// Mirrors `FrancoisToolName` in contract/multi-provider-openai.ts. These are
/// Claude Code's tool names VERBATIM and deliberately so: permission rules are
/// one vocabulary, so a rule written as `Bash(npm test:*)` on a Claude session
/// reads identically here and the rules editor never renders a second dialect.
///
/// `Display` is the wire name — it is what goes into the request's `tools`
/// array, what comes back in `delta.tool_calls[].function.name`, and what
/// `permissions::build_ask` is handed. One string, three roles, no mapping
/// table to drift.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FrancoisTool {
    Read,
    Write,
    Edit,
    Grep,
    Glob,
    Bash,
}

impl FrancoisTool {
    /// Declaration order matches `FRANCOIS_TOOLS` in the contract, and the
    /// parity test below is what keeps the two lists from drifting.
    pub const ALL: [FrancoisTool; 6] = [
        FrancoisTool::Read,
        FrancoisTool::Write,
        FrancoisTool::Edit,
        FrancoisTool::Grep,
        FrancoisTool::Glob,
        FrancoisTool::Bash,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            FrancoisTool::Read => "Read",
            FrancoisTool::Write => "Write",
            FrancoisTool::Edit => "Edit",
            FrancoisTool::Grep => "Grep",
            FrancoisTool::Glob => "Glob",
            FrancoisTool::Bash => "Bash",
        }
    }
}

impl fmt::Display for FrancoisTool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for FrancoisTool {
    type Err = ();

    /// Case-SENSITIVE and total: a model that emits `read` or `run_bash` gets
    /// the §7 "unknown tool" error string back, never a coerced match. Guessing
    /// here would route a call past a rule written against the exact name.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        FrancoisTool::ALL
            .into_iter()
            .find(|tool| tool.as_str() == s)
            .ok_or(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §5: "a test asserts the two lists match, so a tool renamed on one side
    /// fails on the other". Written out rather than derived from `ALL` — a test
    /// that reads its members back off the thing under test would pass no
    /// matter which one went missing. The literal below must stay identical to
    /// `FRANCOIS_TOOLS` in contract/multi-provider-openai.ts.
    #[test]
    fn the_tool_enum_matches_the_contract_list() {
        let contract = ["Read", "Write", "Edit", "Grep", "Glob", "Bash"];
        let rust: Vec<&str> = FrancoisTool::ALL.iter().map(|t| t.as_str()).collect();
        assert_eq!(rust, contract);
    }

    #[test]
    fn parsing_round_trips_every_tool() {
        for tool in FrancoisTool::ALL {
            assert_eq!(FrancoisTool::from_str(tool.as_str()), Ok(tool));
            assert_eq!(tool.to_string(), tool.as_str());
        }
    }

    /// §7: a tool name outside the vocabulary is an error string to the model,
    /// so `from_str` must not near-match its way to a call the user never
    /// allowed.
    #[test]
    fn parsing_refuses_anything_outside_the_vocabulary() {
        for name in ["read", "BASH", "Read ", "run_command", "WebFetch", ""] {
            assert_eq!(FrancoisTool::from_str(name), Err(()), "accepted {name:?}");
        }
    }
}
