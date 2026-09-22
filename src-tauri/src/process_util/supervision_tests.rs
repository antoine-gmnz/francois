use super::*;
use std::io::{BufReader, Cursor};

#[test]
#[ignore = "subprocess fixture, launched only with a test-specific environment"]
fn native_child_fixture() {
    let Ok(mode) = std::env::var("FRANCOIS_NATIVE_TEST_MODE") else {
        return;
    };
    match mode.as_str() {
        "grandchild" => {
            let mut child = crate::process_util::spawn(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "process_util::supervision::tests::native_child_fixture",
                ])
                .env("FRANCOIS_NATIVE_TEST_MODE", "sleep")
                .stderr(Stdio::inherit())
                .start()
                .unwrap();
            // Deliberately leave a live descendant holding inherited stderr.
            assert!(child.try_wait().unwrap().is_none());
        }
        "sleep" => std::thread::sleep(Duration::from_secs(5)),
        "eof" => {
            #[cfg(windows)]
            {
                use std::os::windows::io::AsRawHandle;
                unsafe {
                    windows_sys::Win32::Foundation::CloseHandle(std::io::stdout().as_raw_handle());
                }
            }
            #[cfg(unix)]
            unsafe {
                libc::close(libc::STDOUT_FILENO);
            }
            std::thread::sleep(Duration::from_secs(5));
            std::process::exit(0);
        }
        "flood" => {
            use std::io::Write;
            std::io::stderr()
                .write_all(&vec![b'x'; 256 * 1024])
                .unwrap();
        }
        "crash" => std::process::exit(7),
        _ => panic!("unknown fixture"),
    }
}
fn fixture(mode: &str) -> OwnedChild {
    crate::process_util::spawn(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "process_util::supervision::tests::native_child_fixture",
        ])
        .env("FRANCOIS_NATIVE_TEST_MODE", mode)
        .start_owned()
        .unwrap()
}
#[test]
fn leader_exit_does_not_leave_stderr_descendant_blocking_cleanup() {
    let child = fixture("grandchild");
    let started = Instant::now();
    child.wait().unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "cleanup waited for unowned descendant lifetime"
    );
}
#[test]
fn stderr_flood_and_crash_are_drained_and_reaped() {
    let child = fixture("flood");
    assert!(child.wait().unwrap().success());
    let tail = child.diagnostic.lock().unwrap();
    assert_eq!(tail.bytes.len(), DIAGNOSTIC_LIMIT);
    assert!(tail.truncated);
    drop(tail);
    assert!(!fixture("crash").wait().unwrap().success());
}
#[test]
fn stdout_eof_before_process_exit_closes_transport_within_grace() {
    let owner = Arc::new(
        crate::process_util::spawn(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "process_util::supervision::tests::native_child_fixture",
            ])
            .env("FRANCOIS_NATIVE_TEST_MODE", "eof")
            .stdout(Stdio::piped())
            .start_owned()
            .unwrap(),
    );
    let mut frames = owner.take_frames().unwrap();
    let start = Instant::now();
    while frames.read_frame().unwrap().is_some() {}
    drop(frames);
    assert!(owner.try_wait().unwrap().is_some());
    assert!(start.elapsed() < Duration::from_secs(4));
}

#[test]
fn frames_buffer_split_utf8_and_reject_partial_eof() {
    let bytes = "{\"text\":\"é😀\"}\n{}\n".as_bytes();
    let mut reader = FrameReader::new(BufReader::with_capacity(1, Cursor::new(bytes)));
    assert_eq!(
        reader.read_frame().unwrap().as_deref(),
        Some("{\"text\":\"é😀\"}")
    );
    assert_eq!(reader.read_frame().unwrap().as_deref(), Some("{}"));
    assert!(reader.read_frame().unwrap().is_none());
    let mut reader = FrameReader::new(Cursor::new(b"{\"partial\":"));
    assert_eq!(
        reader.read_frame().unwrap_err().code,
        crate::ipc::ErrorCode::RuntimeProtocolError
    );
}
#[test]
fn oversized_frame_is_rejected_before_unbounded_allocation() {
    let mut reader = FrameReader::new(Cursor::new(vec![b'x'; FRAME_LIMIT + 1]));
    assert_eq!(
        reader.read_frame().unwrap_err().code,
        crate::ipc::ErrorCode::RuntimeProtocolError
    );
}
#[test]
fn diagnostics_keep_only_a_bounded_tail_and_mark_truncation() {
    let mut tail = DiagnosticTail::default();
    tail.push(&vec![b'x'; DIAGNOSTIC_LIMIT + 123]);
    tail.push(b"end");
    assert_eq!(tail.bytes.len(), DIAGNOSTIC_LIMIT);
    assert!(tail.truncated);
    assert!(tail.bytes.ends_with(b"end"));
}
#[test]
fn missing_executable_is_an_honest_spawn_failure() {
    assert!(
        crate::process_util::spawn("francois-no-such-native-cli-394729")
            .start_owned()
            .is_err()
    );
}
#[test]
fn owned_children_are_isolated_and_termination_is_idempotent() {
    fn sleeping() -> OwnedChild {
        #[cfg(windows)]
        let builder = crate::process_util::spawn("powershell.exe").args([
            "-NoProfile",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        #[cfg(unix)]
        let builder = crate::process_util::spawn("sh").args(["-c", "sleep 30"]);
        builder.start_owned().unwrap()
    }
    let one = sleeping();
    let two = sleeping();
    one.terminate().unwrap();
    one.terminate().unwrap();
    assert!(one.try_wait().unwrap().is_some());
    assert!(two.try_wait().unwrap().is_none());
    two.terminate().unwrap();
}
