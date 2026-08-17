//! FR-7/FR-9: the `extraArgsRaw` tokenizer and the denylist check.

/// FR-9. Refused at save time with a named reason. Mirrors
/// `contract/session-profiles.ts`'s `DENIED_ARG_FLAGS`, in the same order.
pub(crate) const DENIED_ARG_FLAGS: &[&str] = &[
    "--output-format",
    "--input-format",
    "-p",
    "--print",
    "--include-partial-messages",
    "--resume",
    "-c",
    "--continue",
    "--model",
    "--system-prompt",
    "--append-system-prompt",
    "--permission-mode",
    "--dangerously-skip-permissions",
    "--permission-prompt-tool",
];

/// The named reason behind a denial (FR-9). Grouped the same way the contract
/// comments the list: the stream/control-channel flags Francois's own parser
/// depends on, the flags a session control already sets, and the v1 non-goal.
fn reason_for(flag: &str) -> &'static str {
    match flag {
        "--output-format"
        | "--input-format"
        | "-p"
        | "--print"
        | "--include-partial-messages"
        | "--resume"
        | "-c"
        | "--continue" => "reserved for the stream-json control channel Francois depends on",
        "--model" => "the session's model control already sets this",
        "--system-prompt" => "the profile's own system prompt field already sets this",
        "--append-system-prompt" => {
            "append-system-prompt mode is not supported (v1 replaces, full stop)"
        }
        "--permission-mode" | "--dangerously-skip-permissions" => {
            "the session's permission mode control already sets this"
        }
        "--permission-prompt-tool" => "reserved for the stdio control channel Francois depends on",
        _ => "this flag is not allowed in a profile's extra args",
    }
}

/// FR-9: the flag half of a token — everything before a `--flag=value` `=`, or
/// the whole token when there is none.
fn flag_of(token: &str) -> &str {
    token.split('=').next().unwrap_or(token)
}

/// FR-9/FR-11: the first denied token, as `(flag, reason)`. Shared by
/// `profiles_create`/`profiles_update` (over the freshly-parsed tokens) and
/// `session_create` (FR-11: re-run over the resolved `extraArgs` it received —
/// the frontend is not trusted with the parser contract).
pub(crate) fn check_denied(tokens: &[String]) -> Option<(String, &'static str)> {
    tokens.iter().find_map(|t| {
        let flag = flag_of(t);
        DENIED_ARG_FLAGS
            .iter()
            .find(|&&d| d == flag)
            .map(|&d| (d.to_string(), reason_for(d)))
    })
}

/// FR-7: `extraArgsRaw` split with POSIX-ish rules — whitespace separates
/// tokens; single and double quotes group; a backslash escapes the next
/// character. `Err` on an unterminated quote.
pub(crate) fn parse_extra_args(raw: &str) -> Result<Vec<String>, ()> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let mut quote: Option<char> = None;
    let mut chars = raw.chars();

    while let Some(c) = chars.next() {
        match quote {
            Some(q) => {
                if c == '\\' {
                    match chars.next() {
                        Some(next) => current.push(next),
                        None => return Err(()), // trailing backslash inside a quote
                    }
                } else if c == q {
                    quote = None;
                } else {
                    current.push(c);
                }
            }
            None => {
                if c.is_whitespace() {
                    if in_token {
                        tokens.push(std::mem::take(&mut current));
                        in_token = false;
                    }
                } else if c == '\'' || c == '"' {
                    quote = Some(c);
                    in_token = true;
                } else if c == '\\' {
                    match chars.next() {
                        Some(next) => {
                            current.push(next);
                            in_token = true;
                        }
                        None => return Err(()), // trailing backslash
                    }
                } else {
                    current.push(c);
                    in_token = true;
                }
            }
        }
    }
    if quote.is_some() {
        return Err(()); // unterminated quote (FR-7)
    }
    if in_token {
        tokens.push(current);
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- FR-7: tokenizer ----------

    #[test]
    fn splits_on_whitespace() {
        assert_eq!(
            parse_extra_args("--add-dir /tmp --foo").unwrap(),
            vec!["--add-dir", "/tmp", "--foo"]
        );
        assert_eq!(parse_extra_args("   ").unwrap(), Vec::<String>::new());
        assert_eq!(parse_extra_args("").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn double_and_single_quotes_group_a_token() {
        // §9 acceptance: round-trips into the editor and resolves to 3 tokens.
        assert_eq!(
            parse_extra_args(r#"--add-dir "/a b" --foo"#).unwrap(),
            vec!["--add-dir", "/a b", "--foo"]
        );
        assert_eq!(
            parse_extra_args("--add-dir '/a b' --foo").unwrap(),
            vec!["--add-dir", "/a b", "--foo"]
        );
    }

    #[test]
    fn backslash_escapes_the_next_character() {
        assert_eq!(parse_extra_args(r"a\ b").unwrap(), vec!["a b"]);
        assert_eq!(
            parse_extra_args(r#"\"quoted\""#).unwrap(),
            vec![r#""quoted""#]
        );
    }

    #[test]
    fn quotes_can_abut_bare_text_in_one_token() {
        assert_eq!(parse_extra_args(r#"--x="a b"c"#).unwrap(), vec!["--x=a bc"]);
    }

    #[test]
    fn unterminated_quote_is_an_error() {
        assert!(parse_extra_args(r#"--add-dir "/a b"#).is_err());
        assert!(parse_extra_args("'unterminated").is_err());
    }

    #[test]
    fn trailing_backslash_is_an_error() {
        assert!(parse_extra_args(r"foo\").is_err());
    }

    // ---------- FR-9: denylist ----------

    #[test]
    fn denies_a_listed_flag_and_names_a_reason() {
        let (flag, reason) = check_denied(&["--foo".into(), "--model".into()]).unwrap();
        assert_eq!(flag, "--model");
        assert!(!reason.is_empty());
    }

    #[test]
    fn denylist_matches_the_flag_equals_value_form() {
        let (flag, _) = check_denied(&["--permission-mode=plan".into()]).unwrap();
        assert_eq!(flag, "--permission-mode");
    }

    #[test]
    fn denylist_covers_every_listed_spelling() {
        for flag in DENIED_ARG_FLAGS {
            let (matched, _) = check_denied(&[(*flag).to_string()]).unwrap();
            assert_eq!(&matched, flag);
        }
    }

    #[test]
    fn an_unmodelled_flag_is_not_denied() {
        // FR-10: --add-dir is not on the list — saves normally.
        assert!(check_denied(&["--add-dir".into(), "/tmp".into()]).is_none());
        assert!(check_denied(&[]).is_none());
    }
}
