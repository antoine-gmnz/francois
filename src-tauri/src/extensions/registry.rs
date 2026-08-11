//! FR-1/FR-2 — the compiled-in registry. PURE DATA: this file declares three
//! `ExtensionDefinition` values and the lookups over them, and contains no I/O
//! whatsoever. There is deliberately no `from_file`, no `parse`, no `Deserialize`
//! anywhere in this module — a repository (or a `~/.claude` plugin) cannot
//! declare a panel or impersonate one because nothing ever reads a definition.
//!
//! FR-53's cohorte panels are declared here in full even though
//! `cohorte panels <name> --json` does not exist yet: they resolve
//! `EXT_PROVIDER_EXIT` at runtime until that subcommand ships, which is the
//! spec's expected state (§blocker banner), not a defect. No stub, no mock, no
//! feature flag — the registry entry is real.

use super::*;

/// The `\x1f` unit separator: a byte no `git` field content can contain, passed
/// through argv as a literal character in the declared `--format` string.
const SEP: &str = "\u{1f}";

/// FR-2: exactly three entries, in this order. The order IS the tab order
/// (FR-10), so it is part of the contract rather than an implementation detail.
pub(crate) static REGISTRY: &[ExtensionDefinition] = &[COHORTE, GIT, DOCKER];

// ---------- FR-53: cohorte ----------

const COHORTE: ExtensionDefinition = ExtensionDefinition {
    id: "cohorte",
    label: "cohorte",
    min_version_label: Some("cohorte ≥ 2.4.0"),
    detect: DetectSpec::JsonKey {
        rel: ".claude/pipeline.json",
        key: "pipeline",
        value: "cohorte",
        reason: "no cohorte pipeline here (.claude/pipeline.json)",
    },
    panels: COHORTE_PANELS,
};

static COHORTE_PANELS: &[PanelDefinition] = &[
    PanelDefinition {
        id: "cohorte:health",
        label: "Health",
        scope: PanelScope::Project,
        primitive: PrimitiveKind::KeyValue,
        paginated: false,
        refresh_ms: None,
        columns: None,
        empty_copy: "nothing to report",
        token_source: None,
        // FR-46: the ONE action in the whole registry.
        action: Some(ActionSpec {
            id: "cohorte-dashboard",
            label: "dashboard",
            argv: &["cohorte", "dashboard", "--open"],
        }),
        provider: Some(ProviderSpec {
            argv0: "cohorte",
            args: &[Arg::Lit("panels"), Arg::Lit("health"), Arg::Lit("--json")],
            page_args: &[],
            output: OutputFormat::Json,
        }),
        source: None,
    },
    PanelDefinition {
        id: "cohorte:fleet",
        label: "Fleet",
        // FR-53: cohorte's own fleet.js maps over every tracked project, so
        // Francois calls the provider ONCE. No fan-out, no `--project` slot.
        scope: PanelScope::Fleet,
        primitive: PrimitiveKind::Table,
        paginated: false,
        refresh_ms: None,
        columns: Some(&[
            ColumnSpec {
                key: "project",
                label: "Project",
                kind: ColumnKind::Text,
                weight: Some(2),
            },
            ColumnSpec {
                key: "feature",
                label: "Feature",
                kind: ColumnKind::Text,
                weight: Some(2),
            },
            ColumnSpec {
                key: "phase",
                label: "Phase",
                kind: ColumnKind::Status,
                weight: None,
            },
            ColumnSpec {
                key: "updated",
                label: "Updated",
                kind: ColumnKind::Time,
                weight: None,
            },
        ]),
        empty_copy: "no projects tracked",
        token_source: None,
        action: None,
        provider: Some(ProviderSpec {
            argv0: "cohorte",
            args: &[Arg::Lit("panels"), Arg::Lit("fleet"), Arg::Lit("--json")],
            page_args: &[],
            output: OutputFormat::Json,
        }),
        source: None,
    },
    PanelDefinition {
        id: "cohorte:specs",
        label: "Specs",
        scope: PanelScope::Project,
        primitive: PrimitiveKind::Table,
        paginated: false,
        refresh_ms: None,
        columns: Some(&[
            ColumnSpec {
                key: "id",
                label: "Id",
                kind: ColumnKind::Text,
                weight: Some(2),
            },
            ColumnSpec {
                key: "title",
                label: "Title",
                kind: ColumnKind::Text,
                weight: Some(3),
            },
            ColumnSpec {
                key: "status",
                label: "Status",
                kind: ColumnKind::Status,
                weight: None,
            },
            ColumnSpec {
                key: "updated",
                label: "Updated",
                kind: ColumnKind::Time,
                weight: None,
            },
        ]),
        empty_copy: "no specs yet",
        token_source: None,
        action: None,
        provider: Some(ProviderSpec {
            argv0: "cohorte",
            args: &[Arg::Lit("panels"), Arg::Lit("specs"), Arg::Lit("--json")],
            page_args: &[],
            output: OutputFormat::Json,
        }),
        source: None,
    },
    PanelDefinition {
        id: "cohorte:loops",
        label: "Loops",
        scope: PanelScope::Project,
        primitive: PrimitiveKind::Table,
        paginated: false,
        refresh_ms: Some(5_000),
        columns: Some(&[
            ColumnSpec {
                key: "id",
                label: "Feature",
                kind: ColumnKind::Text,
                weight: Some(2),
            },
            ColumnSpec {
                key: "phase",
                label: "Phase",
                kind: ColumnKind::Status,
                weight: None,
            },
            ColumnSpec {
                key: "pass",
                label: "Pass",
                kind: ColumnKind::Number,
                weight: None,
            },
            ColumnSpec {
                key: "updated",
                label: "Updated",
                kind: ColumnKind::Time,
                weight: None,
            },
        ]),
        empty_copy: "no loop running",
        token_source: None,
        action: None,
        provider: Some(ProviderSpec {
            argv0: "cohorte",
            args: &[Arg::Lit("panels"), Arg::Lit("loops"), Arg::Lit("--json")],
            page_args: &[],
            output: OutputFormat::Json,
        }),
        source: None,
    },
    PanelDefinition {
        id: "cohorte:loop-log",
        label: "Loop log",
        scope: PanelScope::Project,
        primitive: PrimitiveKind::LogTail,
        paginated: false,
        refresh_ms: None,
        columns: None,
        empty_copy: "no output yet",
        // FR-38: the token comes from a SIBLING panel's validated rows.
        token_source: Some(TokenSourceSpec {
            panel_id: "cohorte:loops",
            row_key: "id",
        }),
        action: None,
        provider: None,
        source: Some(Source::File(&[
            PathSeg::Lit("specs/reports/"),
            PathSeg::Token,
            PathSeg::Lit(".loop.log"),
        ])),
    },
    PanelDefinition {
        id: "cohorte:cost",
        label: "Cost",
        scope: PanelScope::Project,
        primitive: PrimitiveKind::StatRow,
        paginated: false,
        refresh_ms: None,
        columns: None,
        empty_copy: "no spend recorded",
        token_source: None,
        action: None,
        provider: Some(ProviderSpec {
            argv0: "cohorte",
            args: &[Arg::Lit("panels"), Arg::Lit("cost"), Arg::Lit("--json")],
            page_args: &[],
            output: OutputFormat::Json,
        }),
        source: None,
    },
];

// ---------- FR-54: git ----------

const GIT: ExtensionDefinition = ExtensionDefinition {
    id: "git",
    label: "git",
    min_version_label: None,
    detect: DetectSpec::PathExists {
        // File OR directory — a linked worktree's `.git` is a file (FR-3).
        rel: ".git",
        reason: "not a git repository",
    },
    panels: GIT_PANELS,
};

static GIT_PANELS: &[PanelDefinition] = &[
    PanelDefinition {
        id: "git:branches",
        label: "Branches",
        scope: PanelScope::Project,
        primitive: PrimitiveKind::Table,
        paginated: false,
        refresh_ms: None,
        columns: Some(&[
            ColumnSpec {
                key: "branch",
                label: "Branch",
                kind: ColumnKind::Text,
                weight: Some(2),
            },
            ColumnSpec {
                key: "commit",
                label: "Commit",
                kind: ColumnKind::Text,
                weight: None,
            },
            ColumnSpec {
                key: "updated",
                label: "Updated",
                kind: ColumnKind::Time,
                weight: None,
            },
            ColumnSpec {
                key: "subject",
                label: "Subject",
                kind: ColumnKind::Text,
                weight: Some(3),
            },
        ]),
        empty_copy: "no branches",
        token_source: None,
        action: None,
        provider: Some(ProviderSpec {
            argv0: "git",
            args: &[
                Arg::Lit("for-each-ref"),
                Arg::Lit(concat!(
                    "--format=%(refname:short)\u{1f}%(objectname:short)\u{1f}",
                    "%(committerdate:unix)\u{1f}%(contents:subject)"
                )),
                Arg::Lit("refs/heads"),
            ],
            page_args: &[],
            output: OutputFormat::Lines(LineFormat {
                sep: SEP,
                fields: &[
                    FieldSpec {
                        key: "branch",
                        transform: FieldTransform::None,
                    },
                    FieldSpec {
                        key: "commit",
                        transform: FieldTransform::None,
                    },
                    FieldSpec {
                        key: "updated",
                        transform: FieldTransform::SecondsToMillis,
                    },
                    FieldSpec {
                        key: "subject",
                        transform: FieldTransform::None,
                    },
                ],
                id_field: Some("branch"),
                tone: ToneRule::Fixed(StatusTone::Neutral),
            }),
        }),
        source: None,
    },
    PanelDefinition {
        id: "git:stashes",
        label: "Stashes",
        scope: PanelScope::Project,
        primitive: PrimitiveKind::Table,
        paginated: false,
        refresh_ms: None,
        columns: Some(&[
            ColumnSpec {
                key: "ref",
                label: "Ref",
                kind: ColumnKind::Text,
                weight: None,
            },
            ColumnSpec {
                key: "commit",
                label: "Commit",
                kind: ColumnKind::Text,
                weight: None,
            },
            ColumnSpec {
                key: "created",
                label: "Created",
                kind: ColumnKind::Time,
                weight: None,
            },
            ColumnSpec {
                key: "subject",
                label: "Subject",
                kind: ColumnKind::Text,
                weight: Some(3),
            },
        ]),
        empty_copy: "no stashes",
        token_source: None,
        action: None,
        provider: Some(ProviderSpec {
            argv0: "git",
            args: &[
                Arg::Lit("stash"),
                Arg::Lit("list"),
                Arg::Lit("--format=%gd\u{1f}%h\u{1f}%ct\u{1f}%s"),
            ],
            page_args: &[],
            output: OutputFormat::Lines(LineFormat {
                sep: SEP,
                fields: &[
                    FieldSpec {
                        key: "ref",
                        transform: FieldTransform::None,
                    },
                    FieldSpec {
                        key: "commit",
                        transform: FieldTransform::None,
                    },
                    FieldSpec {
                        key: "created",
                        transform: FieldTransform::SecondsToMillis,
                    },
                    FieldSpec {
                        key: "subject",
                        transform: FieldTransform::None,
                    },
                ],
                id_field: Some("ref"),
                tone: ToneRule::Fixed(StatusTone::Neutral),
            }),
        }),
        source: None,
    },
    PanelDefinition {
        id: "git:remotes",
        label: "Remotes",
        scope: PanelScope::Project,
        primitive: PrimitiveKind::Table,
        paginated: false,
        refresh_ms: None,
        columns: Some(&[
            ColumnSpec {
                key: "name",
                label: "Name",
                kind: ColumnKind::Text,
                weight: None,
            },
            ColumnSpec {
                key: "url",
                label: "URL",
                kind: ColumnKind::Path,
                weight: Some(4),
            },
        ]),
        empty_copy: "no remotes",
        token_source: None,
        action: None,
        provider: Some(ProviderSpec {
            argv0: "git",
            args: &[Arg::Lit("remote"), Arg::Lit("-v")],
            page_args: &[],
            output: OutputFormat::Lines(LineFormat {
                // `git remote -v` is tab-separated: `origin\t<url> (fetch)`.
                sep: "\t",
                fields: &[
                    FieldSpec {
                        key: "name",
                        transform: FieldTransform::None,
                    },
                    FieldSpec {
                        key: "url",
                        transform: FieldTransform::None,
                    },
                ],
                // Both the fetch and the push line carry the same name, so the
                // row index is the only stable id here.
                id_field: None,
                tone: ToneRule::Fixed(StatusTone::Neutral),
            }),
        }),
        source: None,
    },
    PanelDefinition {
        id: "git:log",
        label: "Log",
        scope: PanelScope::Project,
        primitive: PrimitiveKind::Table,
        paginated: true,
        refresh_ms: None,
        columns: Some(&[
            ColumnSpec {
                key: "commit",
                label: "Commit",
                kind: ColumnKind::Text,
                weight: None,
            },
            ColumnSpec {
                key: "author",
                label: "Author",
                kind: ColumnKind::Text,
                weight: None,
            },
            ColumnSpec {
                key: "when",
                label: "When",
                kind: ColumnKind::Time,
                weight: None,
            },
            ColumnSpec {
                key: "subject",
                label: "Subject",
                kind: ColumnKind::Text,
                weight: Some(4),
            },
        ]),
        empty_copy: "no commits",
        token_source: None,
        action: None,
        provider: Some(ProviderSpec {
            argv0: "git",
            args: &[
                Arg::Lit("log"),
                Arg::Lit("--format=%H\u{1f}%h\u{1f}%an\u{1f}%ct\u{1f}%s"),
            ],
            // FR-31/FR-33: every page is a fresh spawn under the same caps.
            page_args: &[Arg::Offset("--skip="), Arg::Lit("-n"), Arg::Limit("")],
            output: OutputFormat::Lines(LineFormat {
                sep: SEP,
                fields: &[
                    FieldSpec {
                        key: "sha",
                        transform: FieldTransform::None,
                    },
                    FieldSpec {
                        key: "commit",
                        transform: FieldTransform::None,
                    },
                    FieldSpec {
                        key: "author",
                        transform: FieldTransform::None,
                    },
                    FieldSpec {
                        key: "when",
                        transform: FieldTransform::SecondsToMillis,
                    },
                    FieldSpec {
                        key: "subject",
                        transform: FieldTransform::None,
                    },
                ],
                id_field: Some("sha"),
                tone: ToneRule::Fixed(StatusTone::Neutral),
            }),
        }),
        source: None,
    },
];

// ---------- FR-55: docker ----------

const DOCKER: ExtensionDefinition = ExtensionDefinition {
    id: "docker",
    label: "docker",
    min_version_label: None,
    // FR-5: the ONE exec predicate, capped and cached like everything else.
    detect: DetectSpec::CommandOk {
        argv: &["docker", "info"],
        missing_reason: "docker is not installed",
        failed_reason: "docker daemon not reachable",
    },
    panels: DOCKER_PANELS,
};

static DOCKER_PANELS: &[PanelDefinition] = &[
    PanelDefinition {
        id: "docker:containers",
        label: "Containers",
        scope: PanelScope::Project,
        primitive: PrimitiveKind::Table,
        paginated: false,
        refresh_ms: Some(5_000),
        columns: Some(&[
            ColumnSpec {
                key: "name",
                label: "Name",
                kind: ColumnKind::Text,
                weight: Some(2),
            },
            ColumnSpec {
                key: "image",
                label: "Image",
                kind: ColumnKind::Path,
                weight: Some(2),
            },
            ColumnSpec {
                key: "state",
                label: "State",
                kind: ColumnKind::Status,
                weight: None,
            },
            ColumnSpec {
                key: "status",
                label: "Status",
                kind: ColumnKind::Text,
                weight: Some(2),
            },
        ]),
        empty_copy: "no containers",
        token_source: None,
        action: None,
        provider: Some(ProviderSpec {
            argv0: "docker",
            args: &[
                Arg::Lit("ps"),
                Arg::Lit("-a"),
                Arg::Lit("--format"),
                Arg::Lit("{{json .}}"),
            ],
            page_args: &[],
            output: OutputFormat::Ndjson(NdjsonFormat {
                fields: &[
                    ("id", "ID"),
                    ("name", "Names"),
                    ("image", "Image"),
                    ("state", "State"),
                    ("status", "Status"),
                ],
                id_field: Some("id"),
                tone: ToneRule::Map {
                    key: "state",
                    entries: &[
                        ("running", StatusTone::Ok),
                        ("restarting", StatusTone::Busy),
                        ("paused", StatusTone::Warn),
                        ("created", StatusTone::Neutral),
                        ("exited", StatusTone::Neutral),
                        ("dead", StatusTone::Error),
                    ],
                    default: StatusTone::Neutral,
                },
            }),
        }),
        source: None,
    },
    PanelDefinition {
        id: "docker:images",
        label: "Images",
        scope: PanelScope::Project,
        primitive: PrimitiveKind::Table,
        paginated: false,
        refresh_ms: None,
        columns: Some(&[
            ColumnSpec {
                key: "repository",
                label: "Repository",
                kind: ColumnKind::Path,
                weight: Some(3),
            },
            ColumnSpec {
                key: "tag",
                label: "Tag",
                kind: ColumnKind::Text,
                weight: None,
            },
            ColumnSpec {
                key: "size",
                label: "Size",
                kind: ColumnKind::Number,
                weight: None,
            },
            ColumnSpec {
                key: "created",
                label: "Created",
                kind: ColumnKind::Text,
                weight: None,
            },
        ]),
        empty_copy: "no images",
        token_source: None,
        action: None,
        provider: Some(ProviderSpec {
            argv0: "docker",
            args: &[
                Arg::Lit("images"),
                Arg::Lit("--format"),
                Arg::Lit("{{json .}}"),
            ],
            page_args: &[],
            output: OutputFormat::Ndjson(NdjsonFormat {
                fields: &[
                    ("id", "ID"),
                    ("repository", "Repository"),
                    ("tag", "Tag"),
                    ("size", "Size"),
                    ("created", "CreatedSince"),
                ],
                id_field: Some("id"),
                tone: ToneRule::Fixed(StatusTone::Neutral),
            }),
        }),
        source: None,
    },
    PanelDefinition {
        id: "docker:logs",
        label: "Logs",
        scope: PanelScope::Project,
        primitive: PrimitiveKind::LogTail,
        paginated: false,
        refresh_ms: None,
        columns: None,
        empty_copy: "no output yet",
        token_source: Some(TokenSourceSpec {
            panel_id: "docker:containers",
            row_key: "id",
        }),
        action: None,
        provider: None,
        source: Some(Source::Process {
            argv0: "docker",
            args: &[
                Arg::Lit("logs"),
                Arg::Lit("-f"),
                Arg::Lit("--tail"),
                Arg::Lit("200"),
                // FR-38: the token goes after `--`, so even a value that somehow
                // looked like a flag could not be read as one.
                Arg::Lit("--"),
                Arg::Token(""),
            ],
        }),
    },
];

// ---------- lookups ----------

pub(crate) fn extension(id: &str) -> Option<&'static ExtensionDefinition> {
    REGISTRY.iter().find(|e| e.id == id)
}

/// The `(extension, panel)` a `panelId` names. `None` ⇒ `EXT_PANEL_NOT_FOUND`.
pub(crate) fn panel(
    panel_id: &str,
) -> Option<(&'static ExtensionDefinition, &'static PanelDefinition)> {
    REGISTRY.iter().find_map(|ext| {
        ext.panels
            .iter()
            .find(|p| p.id == panel_id)
            .map(|p| (ext, p))
    })
}

/// FR-46: the one action in the registry, by id.
pub(crate) fn action(action_id: &str) -> Option<&'static ActionSpec> {
    REGISTRY.iter().find_map(|ext| {
        ext.panels
            .iter()
            .filter_map(|p| p.action.as_ref())
            .find(|a| a.id == action_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // FR-2: exactly three, in this order — the order IS the tab order (FR-10).
    #[test]
    fn the_registry_is_cohorte_git_docker_in_that_order() {
        let ids: Vec<&str> = REGISTRY.iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["cohorte", "git", "docker"]);
    }

    // FR-53/FR-54/FR-55: the declared sections, in the spec's order.
    #[test]
    fn every_extension_declares_its_spec_panels_in_order() {
        let panels = |id: &str| -> Vec<&str> {
            extension(id).unwrap().panels.iter().map(|p| p.id).collect()
        };
        assert_eq!(
            panels("cohorte"),
            vec![
                "cohorte:health",
                "cohorte:fleet",
                "cohorte:specs",
                "cohorte:loops",
                "cohorte:loop-log",
                "cohorte:cost",
            ]
        );
        assert_eq!(
            panels("git"),
            vec!["git:branches", "git:stashes", "git:remotes", "git:log"]
        );
        assert_eq!(
            panels("docker"),
            vec!["docker:containers", "docker:images", "docker:logs"]
        );
    }

    // FR-26: a label for message composition only — pinned for cohorte, null
    // for the two that need no version.
    #[test]
    fn only_cohorte_declares_a_min_version_label() {
        assert_eq!(
            extension("cohorte").unwrap().min_version_label,
            Some("cohorte ≥ 2.4.0")
        );
        assert_eq!(extension("git").unwrap().min_version_label, None);
        assert_eq!(extension("docker").unwrap().min_version_label, None);
    }

    // FR-53: fleet is called ONCE for the whole fleet — it is the only
    // fleet-scoped panel and it takes no project slot.
    #[test]
    fn cohorte_fleet_is_the_only_fleet_scoped_panel() {
        let fleet: Vec<&str> = REGISTRY
            .iter()
            .flat_map(|e| e.panels.iter())
            .filter(|p| p.scope == PanelScope::Fleet)
            .map(|p| p.id)
            .collect();
        assert_eq!(fleet, vec!["cohorte:fleet"]);
    }

    // FR-46: exactly one action in the registry, with static argv and no slots.
    #[test]
    fn exactly_one_action_exists_and_it_is_static() {
        let actions: Vec<&str> = REGISTRY
            .iter()
            .flat_map(|e| e.panels.iter())
            .filter_map(|p| p.action.as_ref())
            .map(|a| a.id)
            .collect();
        assert_eq!(actions, vec!["cohorte-dashboard"]);
        let a = action("cohorte-dashboard").unwrap();
        assert_eq!(a.argv, &["cohorte", "dashboard", "--open"]);
        assert!(action("docker-restart").is_none());
    }

    // FR-38: the token slot exists ONLY on log-tail panels, and every log-tail
    // panel declares where its token comes from.
    #[test]
    fn only_log_tail_panels_carry_a_token_slot() {
        for panel in REGISTRY.iter().flat_map(|e| e.panels.iter()) {
            let is_log_tail = panel.primitive == PrimitiveKind::LogTail;
            assert_eq!(
                panel.token_source.is_some(),
                is_log_tail,
                "{} declares a token source it may not have",
                panel.id
            );
            assert_eq!(
                panel.source.is_some(),
                is_log_tail,
                "{} declares a stream source it may not have",
                panel.id
            );
            // A log-tail panel never resolves through extensions_panel.
            assert_eq!(panel.provider.is_some(), !is_log_tail, "{}", panel.id);
            let has_token_arg = panel.provider.as_ref().is_some_and(|p| {
                p.args
                    .iter()
                    .chain(p.page_args.iter())
                    .any(|a| matches!(a, Arg::Token(_)))
            });
            assert!(!has_token_arg, "{} put a token in provider argv", panel.id);
        }
    }

    // FR-38: a token source must name a panel that exists in the SAME tab.
    #[test]
    fn a_token_source_names_a_sibling_panel_and_a_column_it_has() {
        for ext in REGISTRY.iter() {
            for p in ext.panels.iter() {
                let Some(ts) = p.token_source.as_ref() else {
                    continue;
                };
                let sibling = ext
                    .panels
                    .iter()
                    .find(|s| s.id == ts.panel_id)
                    .unwrap_or_else(|| panic!("{} points at a non-sibling", p.id));
                assert_eq!(sibling.primitive, PrimitiveKind::Table);
            }
        }
    }

    // FR-31: only a `table` declares pagination, and only `git:log` does.
    #[test]
    fn git_log_is_the_only_paginated_panel() {
        let paginated: Vec<&str> = REGISTRY
            .iter()
            .flat_map(|e| e.panels.iter())
            .filter(|p| p.paginated)
            .map(|p| p.id)
            .collect();
        assert_eq!(paginated, vec!["git:log"]);
        let (_, log) = panel("git:log").unwrap();
        assert_eq!(log.primitive, PrimitiveKind::Table);
        assert!(!log.provider.as_ref().unwrap().page_args.is_empty());
    }

    // FR-19: no argv element is a shell invocation, and every table declares
    // the columns its rows are rendered into.
    #[test]
    fn no_provider_is_a_shell_and_every_table_declares_columns() {
        for p in REGISTRY.iter().flat_map(|e| e.panels.iter()) {
            if let Some(provider) = p.provider.as_ref() {
                assert!(
                    !matches!(provider.argv0, "sh" | "bash" | "zsh" | "cmd" | "powershell"),
                    "{} spawns a shell",
                    p.id
                );
                for a in provider.args.iter() {
                    if let Arg::Lit(s) = a {
                        assert_ne!(*s, "-c", "{} passes -c", p.id);
                    }
                }
            }
            if p.primitive == PrimitiveKind::Table {
                assert!(p.columns.is_some(), "{} declares no columns", p.id);
            }
        }
    }

    // FR-28: `to_info` is where the floor is applied, and it is applied to the
    // registry's own 5 000 ms declarations too (unchanged, they are above it).
    #[test]
    fn the_wire_projection_clamps_refresh_and_hides_non_table_columns() {
        let (_, loops) = panel("cohorte:loops").unwrap();
        assert_eq!(loops.to_info().refresh_ms, Some(5_000));
        let (_, health) = panel("cohorte:health").unwrap();
        let info = health.to_info();
        assert_eq!(info.refresh_ms, None);
        assert_eq!(info.columns, None);
        assert_eq!(
            info.action.unwrap().resolved_command,
            "cohorte dashboard --open"
        );
        let (_, branches) = panel("git:branches").unwrap();
        assert_eq!(branches.to_info().columns.unwrap().len(), 4);
    }

    // Every panel id is `<extensionId>:<slug>` and unique registry-wide.
    #[test]
    fn panel_ids_are_namespaced_and_unique() {
        let mut seen: Vec<&str> = Vec::new();
        for ext in REGISTRY.iter() {
            for p in ext.panels.iter() {
                assert!(
                    p.id.starts_with(&format!("{}:", ext.id)),
                    "{} is not namespaced",
                    p.id
                );
                assert!(!seen.contains(&p.id), "duplicate panel id {}", p.id);
                seen.push(p.id);
            }
        }
        assert!(panel("git:log").is_some());
        assert!(panel("git:nope").is_none());
    }
}
