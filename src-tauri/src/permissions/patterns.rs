//! FR-5: deriving a settings.json rule pattern (and its label) from a call.

use super::*;

use serde_json::Value;

// ---------- FR-5: pattern generation ----------

/// Programs whose FIRST ARGUMENT is a subcommand, so a useful rule prefix is two
/// tokens (`git commit`, `npm test`) rather than the bare program (`git` — which
/// would trust every git operation including `push --force`).
pub(crate) const SUBCOMMAND_PROGRAMS: [&str; 30] = [
    "git",
    "gh",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "cargo",
    "docker",
    "kubectl",
    "go",
    "make",
    "uv",
    "pip",
    "pip3",
    "poetry",
    "dotnet",
    "bundle",
    "rails",
    "terraform",
    "aws",
    "gcloud",
    "brew",
    "apt",
    "apt-get",
    "systemctl",
    "python",
    "python3",
    "node",
    "deno",
    "bun",
];

/// Shell metacharacters that make a prefix rule unsafe: with any of these present
/// `Bash(cd x:*)` would also authorize whatever rides after the operator, so the
/// generated rule pins the EXACT command instead (FR-5, §7 #11).
///
/// SINGLE characters, deliberately: `&&`/`||`/`$(` are covered by `&`/`|`/`$`,
/// and the review found the pair-only list let `npm test & rm -rf ~` through the
/// PREFIX branch — a bare `&` separates commands exactly like `&&` does. Being
/// over-inclusive here only ever makes a generated rule NARROWER (an exact-command
/// pin instead of a prefix), so anything that could plausibly chain, substitute,
/// redirect or comment gets listed.
pub(crate) const SHELL_OPERATORS: [char; 15] = [
    '&', '|', ';', '`', '$', '>', '<', '(', ')', '{', '}', '#', '!', '\n', '\r',
];

pub(crate) fn has_shell_operator(cmd: &str) -> bool {
    cmd.contains(SHELL_OPERATORS)
}

/// FR-5: the command prefix a `Bash(<prefix>:*)` rule is built from — the first
/// token, extended with the second when the first is a subcommand-style program
/// and the second is not a flag.
pub(crate) fn bash_prefix(cmd: &str) -> String {
    let mut it = cmd.split_whitespace();
    let Some(first) = it.next() else {
        return String::new();
    };
    let second = it.next();
    match second {
        Some(sec)
            if SUBCOMMAND_PROGRAMS.contains(&first) && !sec.starts_with('-') && !sec.is_empty() =>
        {
            format!("{first} {sec}")
        }
        _ => first.to_string(),
    }
}

pub(crate) fn slashed(p: &str) -> String {
    p.replace('\\', "/")
}

/// A tool path expressed relative to the session cwd when it lives inside it,
/// otherwise verbatim (with `/` separators). Case-insensitive prefix match — the
/// two platforms Francois runs on disagree about path case, and a rule that
/// silently fails to match is worse than one that is slightly too generous about
/// spelling.
pub(crate) fn path_relative_to_cwd(path: &str, cwd: &str) -> String {
    let p = slashed(path);
    let c = slashed(cwd);
    let c = c.trim_end_matches('/');
    if c.is_empty() {
        return p;
    }
    // Compare and slice on the SAME string. The earlier version matched on
    // `to_lowercase()` copies but sliced `p` at the original byte offset —
    // `char::to_lowercase` is not length-preserving (`İ` U+0130 is 2 bytes and
    // lowercases to 3), so a case-differing path could slice off a UTF-8
    // boundary and PANIC on the turn's reader thread, poisoning every pending
    // map behind it. ASCII-only case folding keeps byte offsets exact.
    let head = match p.get(..c.len()) {
        Some(h) if h.eq_ignore_ascii_case(c) => h,
        _ => return p,
    };
    debug_assert_eq!(head.len(), c.len());
    match p.get(c.len()..) {
        Some(rest) if rest.starts_with('/') => p[c.len() + 1..].to_string(),
        _ => p,
    }
}

/// The host of a URL: everything between `://` and the next path/query/fragment
/// delimiter, minus any userinfo and port. `None` when the string has no
/// recognizable host.
///
/// `\` is a delimiter too: WHATWG URL parsing treats it as `/` in a special
/// scheme, so `https://evil.com\@good.com/x` FETCHES evil.com. Splitting on `/`
/// alone made this function report `good.com` — the card would have read "fetch
/// from good.com" and offered that domain as the rule for a call going somewhere
/// else. Anything still containing a delimiter-ish character after the split is
/// rejected outright rather than guessed at.
pub(crate) fn url_host(url: &str) -> Option<String> {
    let after = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = after.split(['/', '?', '#', '\\']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    let host = host.trim();
    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '\\' | '@' | '[' | ']' | '/'))
    {
        return None;
    }
    Some(host.to_lowercase())
}

/// The exact-command form `Bash(<cmd>)` — a rule that pins ONE command instead of
/// a prefix, used whenever a shell operator makes a prefix unsafe.
///
/// Two inputs cannot be expressed in that form and must NOT be smuggled into it:
///   * a command ending in `:*` — Claude re-reads `Bash(echo x:*)` as a PREFIX
///     rule, so the "exact pin" branch would silently hand out a wildcard;
///   * a command containing `)` — the pattern's closing paren becomes ambiguous.
/// Both degrade to the bare tool name, whose label reads "any Bash call" (§7 #12).
/// That is deliberately a rule the user is likely to REFUSE: failing toward
/// something obviously too broad is safe, failing toward something that LOOKS
/// narrow while granting more is not.
pub(crate) fn exact_bash_pattern(cmd: &str) -> String {
    if cmd.ends_with(":*") || cmd.contains(')') {
        return "Bash".to_string();
    }
    format!("Bash({cmd})")
}

/// Tools whose input names a filesystem path, and the key that holds it.
pub(crate) fn path_key(tool: &str) -> Option<&'static [&'static str]> {
    match tool {
        "Read" | "Edit" | "Write" | "MultiEdit" => Some(&["file_path"]),
        "NotebookEdit" => Some(&["notebook_path", "file_path"]),
        "Glob" | "Grep" | "LS" => Some(&["path"]),
        _ => None,
    }
}

/// FR-5: the Claude permission pattern Francois would write for this call.
/// Pure; the whole §9 pattern table is pinned against it.
pub fn generate_pattern(tool: &str, input: &Value, cwd: &str) -> String {
    if tool.starts_with("mcp__") {
        // An MCP tool name IS its own pattern (`mcp__server__tool` scopes one
        // tool, `mcp__server` the whole server).
        return tool.to_string();
    }
    if tool == "Bash" {
        let cmd = input
            .get("command")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .trim();
        if cmd.is_empty() {
            return "Bash".to_string();
        }
        if has_shell_operator(cmd) {
            return exact_bash_pattern(cmd);
        }
        let prefix = bash_prefix(cmd);
        if prefix.is_empty() {
            return "Bash".to_string();
        }
        return format!("Bash({prefix}:*)");
    }
    if tool == "WebFetch" {
        if let Some(host) = input.get("url").and_then(|u| u.as_str()).and_then(url_host) {
            return format!("WebFetch(domain:{host})");
        }
        return "WebFetch".to_string();
    }
    if let Some(keys) = path_key(tool) {
        for k in keys {
            if let Some(p) = input
                .get(*k)
                .and_then(|v| v.as_str())
                .filter(|p| !p.is_empty())
            {
                return format!("{tool}({})", path_relative_to_cwd(p, cwd));
            }
        }
    }
    tool.to_string()
}

/// The verb a path-shaped tool reads as in a rule label.
pub(crate) fn tool_verb(tool: &str) -> String {
    match tool {
        "Read" => "read".into(),
        "Edit" | "MultiEdit" | "NotebookEdit" => "edit".into(),
        "Write" => "write".into(),
        "Glob" | "LS" => "list".into(),
        "Grep" => "search".into(),
        other => other.to_lowercase(),
    }
}

/// FR-5/FR-17: the human reading of a RAW pattern. Deliberately derived from the
/// pattern rather than from the call, so a rule generated by Francois and the
/// same rule read back off disk (or hand-written by the user) always read the
/// same way in the card and in the editor.
pub fn label_for_pattern(pattern: &str) -> String {
    if let Some(rest) = pattern.strip_prefix("mcp__") {
        return match rest.split_once("__") {
            Some((server, tool)) if !tool.is_empty() => {
                format!("{tool} on the {server} MCP server")
            }
            _ => format!("any tool on the {rest} MCP server"),
        };
    }
    let Some((tool, arg)) = split_pattern(pattern) else {
        return format!("any {pattern} call");
    };
    if tool == "Bash" {
        return match arg.strip_suffix(":*") {
            Some(prefix) => format!("{prefix} (any arguments)"),
            // FR-5's wording. The command itself is always rendered beside the
            // label (the card's summary + pattern, the editor's pattern column),
            // so repeating it here would only duplicate.
            None => "run exactly this command".to_string(),
        };
    }
    if tool == "WebFetch" {
        if let Some(domain) = arg.strip_prefix("domain:") {
            return format!("fetch from {domain}");
        }
    }
    format!("{} {}", tool_verb(tool), arg)
}

/// `Tool(arg)` → `("Tool", "arg")`. `None` for a bare tool name. The argument may
/// itself contain parentheses (a Bash command does), so the match is on the FIRST
/// `(` and the LAST `)`.
pub(crate) fn split_pattern(pattern: &str) -> Option<(&str, &str)> {
    let open = pattern.find('(')?;
    let close = pattern.rfind(')')?;
    if close <= open {
        return None;
    }
    Some((&pattern[..open], &pattern[open + 1..close]))
}

/// FR-2..FR-5: everything the approval card needs, derived purely from the
/// control request plus the session's cwd.
pub fn build_ask(tool: &str, input: &Value, cwd: &str) -> PermissionAsk {
    let pattern = generate_pattern(tool, input, cwd);
    PermissionAsk {
        tool_name: tool.to_string(),
        summary: summarize_input(tool, input),
        input_json: input_json(input),
        cwd: cwd.to_string(),
        pattern_label: label_for_pattern(&pattern),
        pattern,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    // ---- FR-5: pattern generation (the §9 table) ----

    #[test]
    fn bash_patterns_use_a_two_token_prefix_for_subcommand_programs() {
        let p = |cmd: &str| generate_pattern("Bash", &json!({ "command": cmd }), "/repo");
        assert_eq!(p("npm test"), "Bash(npm test:*)");
        assert_eq!(p("npm test -- --watch"), "Bash(npm test:*)");
        assert_eq!(p("git commit -m 'x'"), "Bash(git commit:*)");
        assert_eq!(p("cargo build --release"), "Bash(cargo build:*)");
        // A flag second token is not a subcommand — fall back to the program.
        assert_eq!(p("git --version"), "Bash(git:*)");
        // Not a subcommand-style program — one token.
        assert_eq!(p("ls -la"), "Bash(ls:*)");
        assert_eq!(p("ls"), "Bash(ls:*)");
    }

    #[test]
    fn every_fr5_subcommand_program_is_listed() {
        // Regression: `bun` was missing, so `bun test` generated `Bash(bun:*)` —
        // "always allow" on a test run silently granting `bun install`, `bun x`,
        // `bun run <script>`. Pin the whole FR-5 list, not just a sample.
        const FR5: [&str; 30] = [
            "git",
            "gh",
            "npm",
            "npx",
            "pnpm",
            "yarn",
            "cargo",
            "docker",
            "kubectl",
            "go",
            "make",
            "uv",
            "pip",
            "pip3",
            "poetry",
            "dotnet",
            "bundle",
            "rails",
            "terraform",
            "aws",
            "gcloud",
            "brew",
            "apt",
            "apt-get",
            "systemctl",
            "python",
            "python3",
            "node",
            "deno",
            "bun",
        ];
        for prog in FR5 {
            assert!(
                SUBCOMMAND_PROGRAMS.contains(&prog),
                "FR-5 lists `{prog}` but SUBCOMMAND_PROGRAMS does not"
            );
            let cmd = format!("{prog} sub --flag");
            assert_eq!(
                generate_pattern("Bash", &json!({ "command": cmd }), "/r"),
                format!("Bash({prog} sub:*)")
            );
        }
        assert_eq!(SUBCOMMAND_PROGRAMS.len(), FR5.len());
    }

    #[test]
    fn bash_patterns_pin_the_exact_command_when_shell_operators_are_present() {
        // §7 #11: `Bash(cd x:*)` would authorize whatever rides after the `&&`.
        let p = |cmd: &str| generate_pattern("Bash", &json!({ "command": cmd }), "/repo");
        assert_eq!(p("cd x && rm -rf y"), "Bash(cd x && rm -rf y)");
        assert_eq!(p("cat a | grep b"), "Bash(cat a | grep b)");
        assert_eq!(p("ls > out.txt"), "Bash(ls > out.txt)");
        assert_eq!(p("a\nb"), "Bash(a\nb)");
        assert_eq!(p("a\rb"), "Bash(a\rb)");
        // A BARE `&` separates commands exactly like `&&`. The pair-only operator
        // list let this through the PREFIX branch, so "always allow" on a test run
        // wrote `Bash(npm test:*)` — and every later `npm test & <payload>` would
        // then be auto-approved by the CLI with no card at all.
        assert_eq!(p("npm test & rm -rf y"), "Bash(npm test & rm -rf y)");
        assert_eq!(p("rm -rf $TARGET"), "Bash(rm -rf $TARGET)");
        assert_eq!(p("ls # nothing to see"), "Bash(ls # nothing to see)");
        assert_eq!(p("cat {a,b}"), "Bash(cat {a,b})");
    }

    #[test]
    fn the_exact_command_branch_never_emits_a_wildcard_or_an_ambiguous_pattern() {
        let p = |cmd: &str| generate_pattern("Bash", &json!({ "command": cmd }), "/repo");
        // A command ENDING in `:*` would be re-read by Claude as a PREFIX rule —
        // the "exact pin" branch handing out a wildcard. Degrade to the bare tool
        // name, whose label reads "any Bash call": obviously too broad, so the
        // user refuses it. Failing toward refusal is safe; failing toward
        // something that LOOKS narrow while granting more is not.
        assert_eq!(p("echo a && echo b:*"), "Bash");
        // A `)` makes the pattern's own closing paren ambiguous.
        assert_eq!(p("echo $(whoami)"), "Bash");
        assert_eq!(p("(rm -rf /)"), "Bash");
        assert_eq!(label_for_pattern("Bash"), "any Bash call");
    }

    #[test]
    fn bash_without_a_command_falls_back_to_the_bare_tool() {
        assert_eq!(generate_pattern("Bash", &json!({}), "/repo"), "Bash");
        assert_eq!(
            generate_pattern("Bash", &json!({ "command": "   " }), "/repo"),
            "Bash"
        );
    }

    #[test]
    fn path_tools_scope_to_the_file_relative_to_cwd_when_inside_it() {
        assert_eq!(
            generate_pattern("Read", &json!({ "file_path": "/repo/src/a.ts" }), "/repo"),
            "Read(src/a.ts)"
        );
        assert_eq!(
            generate_pattern(
                "Edit",
                &json!({ "file_path": "D:\\repo\\src\\a.ts" }),
                "D:\\repo"
            ),
            "Edit(src/a.ts)"
        );
        // Outside the cwd: verbatim (with / separators) — a weak rule, but the
        // card shows the pattern before the user commits to it.
        assert_eq!(
            generate_pattern("Write", &json!({ "file_path": "/etc/hosts" }), "/repo"),
            "Write(/etc/hosts)"
        );
        assert_eq!(
            generate_pattern("Grep", &json!({ "path": "/repo/src" }), "/repo"),
            "Grep(src)"
        );
        assert_eq!(
            generate_pattern(
                "NotebookEdit",
                &json!({ "notebook_path": "/repo/n.ipynb" }),
                "/repo"
            ),
            "NotebookEdit(n.ipynb)"
        );
        // No path key at all → the bare tool name.
        assert_eq!(generate_pattern("Read", &json!({}), "/repo"), "Read");
    }

    #[test]
    fn webfetch_scopes_to_the_url_host() {
        let p = |url: &str| generate_pattern("WebFetch", &json!({ "url": url }), "/repo");
        assert_eq!(
            p("https://example.com/a/b?c=1"),
            "WebFetch(domain:example.com)"
        );
        assert_eq!(
            p("http://user:pw@Docs.Example.COM:8080/x"),
            "WebFetch(domain:docs.example.com)"
        );
        assert_eq!(
            generate_pattern("WebFetch", &json!({}), "/repo"),
            "WebFetch"
        );
    }

    #[test]
    fn webfetch_treats_a_backslash_as_a_path_separator() {
        // WHATWG URL parsing treats `\` as `/` in a special scheme, so
        // `https://evil.com\@good.com/x` FETCHES evil.com. Splitting on `/` alone
        // reported `good.com` — the card would have read "fetch from good.com"
        // and offered that domain as the rule for a call going elsewhere.
        assert_eq!(
            url_host("https://evil.com\\@good.com/x").as_deref(),
            Some("evil.com")
        );
        // Anything still delimiter-ish after the split is refused, not guessed at.
        assert_eq!(url_host("https://a b.com/x"), None);
        assert_eq!(url_host("https://[::1]/x"), None);
        assert_eq!(url_host("https://"), None);
    }

    #[test]
    fn mcp_and_unknown_tools_pattern_as_themselves() {
        assert_eq!(
            generate_pattern("mcp__ctx7__query", &json!({}), "/r"),
            "mcp__ctx7__query"
        );
        assert_eq!(generate_pattern("mcp__ctx7", &json!({}), "/r"), "mcp__ctx7");
        assert_eq!(
            generate_pattern("WebSearch", &json!({ "query": "x" }), "/r"),
            "WebSearch"
        );
        assert_eq!(
            generate_pattern("Frobnicate", &json!({ "x": 1 }), "/r"),
            "Frobnicate"
        );
    }

    // ---- FR-5/FR-17: labels ----

    #[test]
    fn labels_read_back_from_the_raw_pattern() {
        assert_eq!(
            label_for_pattern("Bash(npm test:*)"),
            "npm test (any arguments)"
        );
        assert_eq!(
            label_for_pattern("Bash(cd x && ls)"),
            "run exactly this command"
        );
        assert_eq!(label_for_pattern("Read(src/a.ts)"), "read src/a.ts");
        assert_eq!(label_for_pattern("Edit(src/a.ts)"), "edit src/a.ts");
        assert_eq!(label_for_pattern("Grep(src)"), "search src");
        assert_eq!(
            label_for_pattern("WebFetch(domain:example.com)"),
            "fetch from example.com"
        );
        assert_eq!(
            label_for_pattern("mcp__ctx7__query"),
            "query on the ctx7 MCP server"
        );
        assert_eq!(
            label_for_pattern("mcp__ctx7"),
            "any tool on the ctx7 MCP server"
        );
        assert_eq!(label_for_pattern("WebSearch"), "any WebSearch call");
    }

    #[test]
    fn build_ask_carries_the_pattern_and_its_label() {
        let ask = build_ask("Bash", &json!({ "command": "npm test" }), "/repo");
        assert_eq!(ask.tool_name, "Bash");
        assert_eq!(ask.summary, "npm test");
        assert_eq!(ask.pattern, "Bash(npm test:*)");
        assert_eq!(ask.pattern_label, "npm test (any arguments)");
        assert_eq!(ask.cwd, "/repo");
    }

    #[test]
    fn permission_ask_serializes_to_the_contract_shape() {
        let v = serde_json::to_value(build_ask("Bash", &json!({ "command": "ls" }), "/r")).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        for k in [
            "toolName",
            "summary",
            "inputJson",
            "cwd",
            "pattern",
            "patternLabel",
        ] {
            assert!(keys.contains(&k), "missing {k} in {keys:?}");
        }
        assert_eq!(keys.len(), 6);
    }

    #[test]
    fn path_scoping_never_panics_on_a_case_folding_length_change() {
        // `char::to_lowercase` is not length-preserving (`İ` U+0130 is 2 bytes and
        // lowercases to 3), so comparing on lowercased copies while slicing at the
        // ORIGINAL byte offset could land off a UTF-8 boundary and PANIC — on the
        // turn's reader thread, poisoning every pending map behind it.
        for (path, cwd) in [
            ("/İ/src/a.ts", "/i\u{307}"),
            ("/i\u{307}/src/a.ts", "/İ"),
            ("/İstanbul/x", "/İSTANBUL"),
            ("/ünïcødé/a", "/ÜNÏCØDÉ"),
        ] {
            let out = generate_pattern("Read", &json!({ "file_path": path }), cwd);
            assert!(out.starts_with("Read("), "{out}");
        }
        // ASCII case folding still scopes (the case Francois actually hits).
        assert_eq!(
            generate_pattern(
                "Read",
                &json!({ "file_path": "D:/Repo/src/a.ts" }),
                "d:\\repo"
            ),
            "Read(src/a.ts)"
        );
    }
}
