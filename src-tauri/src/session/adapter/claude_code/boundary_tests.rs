#[test]
fn native_claude_entry_does_not_reach_application_infrastructure() {
    let source = include_str!("../claude_code.rs").replace("\r\n", "\n");
    let production = source.split("\n#[cfg(test)]\nmod tests").next().unwrap();
    for forbidden in [
        "AppHandle",
        "impl SessionAdapter",
        "crate::account::config_dir_of",
    ] {
        assert!(
            !production.contains(forbidden),
            "native Claude entry still depends on {forbidden}"
        );
    }
}

#[test]
fn native_claude_decoder_has_no_engine_or_tauri_access() {
    for (name, source) in [
        ("stream", include_str!("../../stream/mod.rs")),
        ("blocks", include_str!("../../stream/blocks.rs")),
        ("lines", include_str!("../../stream/lines.rs")),
        ("results", include_str!("../../stream/tool_results.rs")),
    ] {
        let source = source.replace("\r\n", "\n");
        let production = source
            .split("\n#[cfg(test)]\nmod tests")
            .next()
            .unwrap()
            .split("\n#[cfg(test)]\nmod golden_replay_tests")
            .next()
            .unwrap();
        for forbidden in [".engine()", "tauri::", "AppHandle"] {
            assert!(
                !production.contains(forbidden),
                "native Claude {name} still depends on {forbidden}"
            );
        }
    }
}

/// Production code only: everything before the first test/harness-gated item,
/// with comments dropped (they legitimately name the old coupling).
fn production(source: &str) -> String {
    let source = source.replace("\r\n", "\n");
    let end = ["\n#[cfg(test)]", "\n#[cfg(any(test"]
        .iter()
        .filter_map(|gate| source.find(gate))
        .min()
        .unwrap_or(source.len());
    source[..end]
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// claude-process-adapter AC-5: the native adapter, its decoder and its
/// control-channel helpers reach the application only through the injected
/// `RuntimeEventSink` — no Engine lookup, persistence or Tauri publication.
#[test]
fn native_claude_path_has_no_engine_persistence_or_event_publication() {
    for (name, source) in [
        ("adapter", include_str!("../claude_code.rs")),
        ("context", include_str!("context.rs")),
        ("stdio", include_str!("../../stdio.rs")),
        ("control", include_str!("../../control.rs")),
        ("stream", include_str!("../../stream/mod.rs")),
        ("blocks", include_str!("../../stream/blocks.rs")),
        ("lines", include_str!("../../stream/lines.rs")),
        ("results", include_str!("../../stream/tool_results.rs")),
        ("environment", include_str!("../../stream/environment.rs")),
    ] {
        let code = production(source);
        for forbidden in [
            "AppHandle",
            "tauri::",
            "Manager",
            ".engine()",
            "Engine",
            "SessionEnv",
            "persistence::",
            "append_transcript",
            "emit(",
            "emit_session",
            "runtime_bridge",
        ] {
            assert!(
                !code.contains(forbidden),
                "native Claude {name} still reaches {forbidden}"
            );
        }
    }
}
