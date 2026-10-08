//! code-editor: contract-shape and command-level tests (specs/code-editor.md).

use super::testutil::TempDir;
use super::*;
use serde_json::json;

fn noop_emit() -> watch::Emitter {
    Arc::new(|_| {})
}

fn sroot() -> EditorRoot {
    EditorRoot::Session {
        session_id: "s".into(),
    }
}

#[test]
fn editor_root_round_trips_both_kinds() {
    let p = EditorRoot::Project {
        project_id: "p".into(),
    };
    let wire = json!({ "kind": "project", "projectId": "p" });
    assert_eq!(serde_json::to_value(&p).unwrap(), wire);
    assert_eq!(serde_json::from_value::<EditorRoot>(wire).unwrap(), p);
    let wire = json!({ "kind": "session", "sessionId": "s" });
    assert_eq!(serde_json::to_value(sroot()).unwrap(), wire);
    assert_eq!(serde_json::from_value::<EditorRoot>(wire).unwrap(), sroot());
    assert!(serde_json::from_value::<EditorRoot>(json!({ "kind": "path", "path": "/" })).is_err());
}

#[test]
fn editor_files_data_serialises_to_the_contract_shape() {
    let mut changes = BTreeMap::new();
    changes.insert("a.ts".to_string(), GitChange::M);
    changes.insert("b.ts".to_string(), GitChange::A);
    let d = EditorFilesData {
        root_label: "orbit-api".into(),
        branch: None,
        paths: vec!["a.ts".into(), "b.ts".into()],
        truncated: false,
        changes,
    };
    assert_eq!(
        serde_json::to_value(&d).unwrap(),
        json!({
            "rootLabel": "orbit-api", "branch": null, "paths": ["a.ts", "b.ts"],
            "truncated": false, "changes": { "a.ts": "M", "b.ts": "A" }
        })
    );
}

#[test]
fn files_impl_labels_the_listing_and_refuses_a_vanished_root() {
    let d = TempDir::new();
    std::fs::write(d.path().join("a.txt"), "").unwrap();
    let dir = root::RootDir {
        dir: d.path().to_string_lossy().into_owned(),
        label: "orbit".into(),
    };
    let data = files_impl(&dir).unwrap();
    assert_eq!(data.root_label, "orbit");
    assert_eq!(data.paths, vec!["a.txt"]);
    assert!(data.changes.is_empty());
    let gone = root::RootDir {
        dir: d.path().join("gone").to_string_lossy().into_owned(),
        label: "x".into(),
    };
    assert_eq!(files_impl(&gone).err().unwrap().code, ErrorCode::Internal);
}

#[test]
fn open_external_checks_the_file_then_the_editor() {
    let d = TempDir::new();
    let dir = d.path().to_string_lossy().into_owned();
    std::fs::write(d.path().join("a.ts"), "").unwrap();
    let r = open_external_impl(&[], &dir, EditorId::Vscode, Some("../x"), Some(3));
    assert_eq!(
        serde_json::to_value(&r).unwrap()["error"]["code"],
        "EDITOR_OUTSIDE_ROOT"
    );
    let r = open_external_impl(&[], &dir, EditorId::Vscode, Some("a.ts"), Some(3));
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["error"]["code"], "EDITOR_NOT_FOUND");
    assert_eq!(v["error"]["detail"]["editorId"], "vscode");
}

#[test]
fn editor_file_serialises_to_the_contract_shape() {
    let f = EditorFile {
        root: sroot(),
        path: "a/b.ts".into(),
        text: "x".into(),
        version: "1:1:ab".into(),
        line_ending: LineEnding::Crlf,
        bom: true,
        trailing_newline: false,
        read_only: true,
        read_only_reason: Some(ReadOnlyReason::TooLarge),
        head_text: None,
    };
    assert_eq!(
        serde_json::to_value(&f).unwrap(),
        json!({
            "root": { "kind": "session", "sessionId": "s" }, "path": "a/b.ts", "text": "x", "version": "1:1:ab",
            "lineEnding": "crlf", "bom": true, "trailingNewline": false,
            "readOnly": true, "readOnlyReason": "too-large", "headText": null
        })
    );
    let g = EditorFile {
        read_only_reason: None,
        ..f
    };
    assert!(serde_json::to_value(&g)
        .unwrap()
        .get("readOnlyReason")
        .is_none());
}

#[test]
fn editor_events_are_tagged_unions() {
    let c = EditorEvent::Changed {
        root: sroot(),
        path: "p".into(),
        version: "v".into(),
    };
    assert_eq!(
        serde_json::to_value(&c).unwrap(),
        json!({
            "type": "editor.changed",
            "root": { "kind": "session", "sessionId": "s" },
            "path": "p",
            "version": "v"
        })
    );
    let d = EditorEvent::Deleted {
        root: sroot(),
        path: "p".into(),
    };
    assert_eq!(
        serde_json::to_value(&d).unwrap(),
        json!({
            "type": "editor.deleted",
            "root": { "kind": "session", "sessionId": "s" },
            "path": "p"
        })
    );
}

#[test]
fn line_ending_deserialises_from_the_wire_strings() {
    assert_eq!(
        serde_json::from_value::<LineEnding>(json!("lf")).unwrap(),
        LineEnding::Lf
    );
    assert_eq!(
        serde_json::from_value::<LineEnding>(json!("crlf")).unwrap(),
        LineEnding::Crlf
    );
}

#[test]
fn open_save_close_flow_keeps_one_watch_and_reopen_rereads_disk() {
    let d = TempDir::new();
    let root = d.path().to_string_lossy().into_owned();
    std::fs::write(d.path().join("a.txt"), "one\r\n").unwrap();
    let state = EditorState::default();
    let f = open_impl(&root, &state, noop_emit(), &sroot(), "a.txt").unwrap();
    assert_eq!(f.text, "one\n");
    let saved = save_impl(
        &root,
        &state,
        &sroot(),
        "a.txt",
        SaveInput {
            text: "two\n",
            base_version: &f.version,
            line_ending: f.line_ending,
            bom: f.bom,
        },
    )
    .unwrap();
    assert_eq!(std::fs::read(d.path().join("a.txt")).unwrap(), b"two\r\n");
    let again = open_impl(&root, &state, noop_emit(), &sroot(), "./a.txt").unwrap();
    assert_eq!(again.text, "two\n");
    assert_eq!(again.version, saved.version);
    assert_eq!(state.len(), 1);
    close_impl(&root, &state, &sroot(), "./a.txt");
    assert_eq!(state.len(), 0);
    close_impl(&root, &state, &sroot(), "never-opened.txt");
}

#[test]
fn open_and_save_refuse_paths_outside_the_root() {
    let d = TempDir::new();
    let root = d.path().to_string_lossy().into_owned();
    let state = EditorState::default();
    let e = open_impl(&root, &state, noop_emit(), &sroot(), "../x").unwrap_err();
    assert_eq!(e.code, ErrorCode::EditorOutsideRoot);
    let e = save_impl(
        &root,
        &state,
        &sroot(),
        ".git/hooks/pre-commit",
        SaveInput {
            text: "x",
            base_version: "0",
            line_ending: LineEnding::Lf,
            bom: false,
        },
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::EditorOutsideRoot);
    assert_eq!(state.len(), 0);
}

#[test]
fn launch_argv_at_targets_file_and_line() {
    assert_eq!(
        launch_argv_at("code", "/w", Some(("src/a.ts", Some(42)))),
        vec![
            "code".to_string(),
            "/w".to_string(),
            "-g".to_string(),
            std::path::Path::new("/w")
                .join("src/a.ts")
                .to_string_lossy()
                .into_owned()
                + ":42"
        ]
    );
    assert_eq!(
        launch_argv_at("code", "/w", None),
        launch_argv("code", "/w")
    );
    let wsl = launch_argv_at(
        "code",
        r"\\wsl.localhost\Ubuntu\home\u\app",
        Some(("a.ts", Some(3))),
    );
    assert_eq!(
        wsl,
        vec![
            "code",
            "--remote",
            "wsl+Ubuntu",
            "/home/u/app",
            "-g",
            "/home/u/app/a.ts:3"
        ]
    );
}
