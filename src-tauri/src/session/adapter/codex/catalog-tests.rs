use super::*;
use serde_json::json;

fn row(model: &str) -> Value {
    json!({"id":model,"model":model,"displayName":"","description":"new model",
        "hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"ultra","description":"deep"},{"reasoningEffort":"ultra","description":"duplicate"}],
        "defaultReasoningEffort":"ultra","isDefault":true})
}

#[test]
fn validates_new_models_and_efforts_without_an_allowlist() {
    let mut catalog = Accumulator::default();
    catalog
        .page(json!({"data":[row("future-model"),row("future-model")],"nextCursor":null}))
        .unwrap();
    assert_eq!(catalog.models.len(), 1);
    assert_eq!(catalog.models[0].efforts, ["ultra"]);
    assert_eq!(catalog.models[0].default_effort.as_deref(), Some("ultra"));
    assert_eq!(catalog.models[0].context_tokens, None);
    assert_eq!(catalog.default_id.as_deref(), Some("future-model"));
}

#[test]
fn malformed_rows_and_repeated_cursors_reject_the_whole_page() {
    let mut catalog = Accumulator::default();
    let mut malformed = row("bad");
    malformed.as_object_mut().unwrap().remove("hidden");
    assert!(catalog
        .page(json!({"data":[row("good"),malformed],"nextCursor":null}))
        .is_err());
    let mut catalog = Accumulator::default();
    catalog
        .page(json!({"data":[],"nextCursor":"again"}))
        .unwrap();
    assert!(catalog
        .page(json!({"data":[],"nextCursor":"again"}))
        .is_err());
}

#[test]
fn hidden_empty_and_unknown_default_effort_are_honest() {
    let mut hidden = row("hidden");
    hidden["hidden"] = json!(true);
    let mut visible = row("visible");
    visible["defaultReasoningEffort"] = json!("max");
    let mut catalog = Accumulator::default();
    catalog
        .page(json!({"data":[hidden, visible],"nextCursor":null}))
        .unwrap();
    assert_eq!(catalog.models.len(), 1);
    assert!(catalog.models[0].default_effort.is_none());
    assert!(Accumulator::default()
        .page(json!({"data":[],"nextCursor":null}))
        .unwrap()
        .is_none());
}

#[cfg(unix)]
fn fake(script: &str) -> (TempDir, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let dir =
        TempDir(std::env::temp_dir().join(format!("francois-catalog-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(dir.path()).unwrap();
    let executable = dir.path().join("fake-codex");
    std::fs::write(&executable, format!("#!/usr/bin/python3\n{script}")).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    (dir, executable)
}

#[cfg(unix)]
#[test]
fn fake_server_paginates_isolates_and_reaps() {
    let first_row = format!("json.loads({:?})", row("future").to_string());
    let second_row = format!("json.loads({:?})", row("second").to_string());
    let source = format!(
        r#"
import sys,json,os
assert sys.argv[1:] == ['app-server','--listen','stdio://']
assert os.getcwd() == os.path.realpath(os.environ['CODEX_HOME'])
assert 'ANTHROPIC_API_KEY' not in os.environ
open('pid','w').write(str(os.getpid()))
def read(): return json.loads(sys.stdin.readline())
def reply(id,result): print(json.dumps(dict(id=id,result=result)),flush=True)
v=read(); assert v['id']==1 and v['method']=='initialize'
assert v['params']['capabilities']=={{'experimentalApi':False}}
reply(1,{{}})
assert read()=={{'method':'initialized'}}
v=read(); assert v['params']=={{'cursor':None,'limit':100,'includeHidden':False}}
print(json.dumps({{'id':99,'method':'unexpected','params':{{}}}}),flush=True)
assert read()['error']['code']==-32601
print(json.dumps({{'method':'unknown-notification'}}),flush=True)
reply(v['id'],{{'data':[{row}], 'nextCursor':'page2'}})
v=read(); assert v['params']['cursor']=='page2'
reply(v['id'],{{'data':[{row},{second}], 'nextCursor':None}})
sys.stdin.read()
"#,
        row = first_row,
        second = second_row
    );
    let (dir, executable) = fake(&source);
    let (models, default) = probe(&executable, dir.path(), Duration::from_secs(2)).unwrap();
    assert_eq!(
        models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["future", "second"]
    );
    assert_eq!(default.as_deref(), Some("future"));
    let pid = std::fs::read_to_string(dir.path().join("pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "probe child must be reaped"
    );
}

#[cfg(unix)]
#[test]
fn fake_server_failures_are_bounded_and_sanitized() {
    for (source, reason) in [
        ("import time; time.sleep(5)", "timeout"),
        ("import sys; print('secret invalid protocol',flush=True)", "protocol"),
        ("print('x' * (2*1024*1024+1),flush=True)", "limit"),
        ("import sys,json; sys.stdin.readline(); print(json.dumps({'id':1,'error':{'code':-32601,'message':'secret'}}),flush=True)", "unsupported-cli"),
        ("import sys; sys.exit(3)", "runtime"),
    ] {
        let (dir, executable) = fake(source);
        let start=Instant::now();
        let error = probe(&executable, dir.path(), if reason == "timeout" { Duration::from_millis(100) } else { Duration::from_secs(2) }).unwrap_err();
        assert_eq!(error.detail.unwrap()["reason"],reason);
        assert!(!error.message.contains("secret"));
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}

#[cfg(unix)]
struct TempDir(std::path::PathBuf);
#[cfg(unix)]
impl TempDir {
    fn path(&self) -> &Path {
        &self.0
    }
}
#[cfg(unix)]
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn catalogue_validation_enforces_row_and_field_bounds() {
    let mut too_many = row("many");
    too_many["supportedReasoningEfforts"] = json!((0..33)
        .map(|_| json!({"reasoningEffort":"ultra","description":""}))
        .collect::<Vec<_>>());
    let mut bad_id = row("bad\nmodel");
    bad_id["futureField"] = json!({"ignored":true});
    for invalid in [too_many, bad_id] {
        assert!(Accumulator::default()
            .page(json!({"data":[invalid],"nextCursor":null}))
            .is_err());
    }
    let rows = (0..1001)
        .map(|i| row(&format!("model-{i}")))
        .collect::<Vec<_>>();
    assert_eq!(
        Accumulator::default()
            .page(json!({"data":rows,"nextCursor":null}))
            .unwrap_err()
            .detail
            .unwrap()["reason"],
        "limit"
    );
    let mut future = row("future");
    future["newUnknownField"] = json!([1, 2, 3]);
    assert!(Accumulator::default()
        .page(json!({"data":[future],"nextCursor":null}))
        .is_ok());
}

#[cfg(unix)]
#[test]
fn page_and_total_stdout_limits_fail_instead_of_truncating() {
    for body in [
        "for i in range(33):\n v=json.loads(sys.stdin.readline()); print(json.dumps({'id':v['id'],'result':{'data':[],'nextCursor':str(i)}}),flush=True)",
        "for i in range(9):\n print(json.dumps({'method':'unknown','padding':'x'*1024*1024}),flush=True)",
    ] {
        let source = format!("import sys,json\nsys.stdin.readline()\nprint(json.dumps({{'id':1,'result':{{}}}}),flush=True)\nsys.stdin.readline()\n{body}\nsys.stdin.read()\n");
        let (dir, executable)=fake(&source);
        assert_eq!(probe(&executable,dir.path(),Duration::from_secs(3)).unwrap_err().detail.unwrap()["reason"],"limit");
    }
    let (dir, executable) = fake("pass");
    std::fs::write(&executable, "#!/definitely/missing/interpreter\n").unwrap();
    for program in [dir.path().join("missing"), executable] {
        let error = probe(&program, dir.path(), Duration::from_secs(1)).unwrap_err();
        assert_eq!(error.code, ErrorCode::SpawnFailed);
        assert!(error.detail.is_none());
        assert!(!error.message.contains(&dir.path().display().to_string()));
    }
}
