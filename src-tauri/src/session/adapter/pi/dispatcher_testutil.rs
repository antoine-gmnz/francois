// The fake Pi child — CLAUDE.md's "shared test fixtures live in a
// `#[cfg(test)] mod testutil`". Split out of dispatcher_tests.rs when the
// retirement/shutdown tests (review round 4) pushed that file over the
// ~1000-line cap.
//
// Visible to the WHOLE `adapter::pi` module (`pub(in crate::session::adapter::
// pi)`), not just `dispatcher`, because it used to be private and two siblings
// — `controls.rs`'s `wire_tests` and `recovery/shell_tests.rs` — each carried
// their own copy of it. Three fake processes with three hand-rolled read
// deadlines is three places for the next hang to come from; this is one.
//
// Every wait here is BOUNDED, deliberately: these tests drive real threads
// (the reader, a dispatch, a shutdown) against a fake child, and a deadlock
// between them must fail a test rather than hang `cargo test` — a hung run
// also strands the shared cargo lock the parallel core agents serialise on.

use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Condvar;

/// LOW (review round 4): every wait in this harness is bounded. A deadlock
/// between a test and the reader/dispatch threads must FAIL this test, not
/// hang `cargo test` — a hung run also strands the shared target lock the
/// parallel core agents serialise on.
const LINE_TIMEOUT: Duration = Duration::from_secs(5);

/// The "fake child" the spec's acceptance criteria ask for: a loopback
/// TCP pair stands in for the process's stdin/stdout, so these tests
/// exercise the REAL reader thread, REAL `mpsc` timeouts, and the REAL
/// `RuntimeSessionControl` implementation with no external `pi` binary
/// and no AppHandle.
pub(in crate::session::adapter::pi) fn test_pipe_pair() -> (TcpStream, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let client = TcpStream::connect(addr).unwrap();
    let (server, _) = listener.accept().unwrap();
    client.set_nodelay(true).ok();
    server.set_nodelay(true).ok();
    // The fake child's own end POLLS rather than blocking, which is what lets
    // `read_line` below enforce `LINE_TIMEOUT` instead of parking forever.
    server
        .set_read_timeout(Some(Duration::from_millis(25)))
        .unwrap();
    (client, server)
}

#[derive(Default)]
pub(in crate::session::adapter::pi) struct Recording {
    pub(in crate::session::adapter::pi) run_states: Mutex<Vec<RuntimeRunState>>,
    pub(in crate::session::adapter::pi) failures: Mutex<Vec<(ErrorCode, String)>>,
    pub(in crate::session::adapter::pi) transcripts: Mutex<Vec<RuntimeEventPayload>>,
    /// LOW (review round 3): previously a no-op — nothing distinguished
    /// healthy transcript traffic from `ProtocolEngine`'s own "unknown event
    /// kind ignored" diagnostic, so a regression there had no test that
    /// could have caught it.
    pub(in crate::session::adapter::pi) diagnostics: Mutex<Vec<String>>,
}
impl EventPublisher for Recording {
    fn run_state(&self, s: RuntimeRunState) {
        self.run_states.lock().unwrap().push(s);
    }
    fn failure(&self, code: ErrorCode, reason: &str, _ctx: DiagnosticContext) {
        self.failures
            .lock()
            .unwrap()
            .push((code, reason.to_string()));
    }
    fn diagnostic(&self, message: &str, _ctx: DiagnosticContext) {
        self.diagnostics.lock().unwrap().push(message.to_string());
    }
    fn transcript(&self, event: RuntimeEventPayload) {
        self.transcripts.lock().unwrap().push(event);
    }
}

/// What a test may want to control about the fake child beyond its
/// already-exited flag — all defaulted, so the common case stays
/// `handle_over(end, kill_flag)`.
#[derive(Default)]
pub(in crate::session::adapter::pi) struct FakeChildOpts {
    /// Park the child's stdin mid-write (a child that stopped draining it).
    pub(in crate::session::adapter::pi) gate: Option<Arc<StdinGate>>,
    /// Make the child's stdout fail with a read ERROR — which, unlike an EOF,
    /// says nothing about whether the child is still alive.
    pub(in crate::session::adapter::pi) stdout_fault: Option<Arc<AtomicBool>>,
    /// Count how many times `kill` actually ran — what proves a second
    /// terminal path does not re-kill an already-reaped child.
    pub(in crate::session::adapter::pi) kills: Option<Arc<Mutex<u32>>>,
}

/// `dispatcher_end` is what `PiConnection` writes to/reads from;
/// `fake_child_end` is driven directly by the test, standing in for the
/// Pi process on the other side of the pipe.
pub(in crate::session::adapter::pi) fn handle_over(
    dispatcher_end: TcpStream,
    kill_flag: Arc<Mutex<bool>>,
) -> ProcessHandle {
    handle_with(dispatcher_end, kill_flag, FakeChildOpts::default())
}

/// `handle_over` with a gate on the child's stdin, so a test can park a write
/// mid-flight the way a child that has stopped draining its own pipe does.
pub(in crate::session::adapter::pi) fn handle_with_gate(
    dispatcher_end: TcpStream,
    kill_flag: Arc<Mutex<bool>>,
    gate: Arc<StdinGate>,
) -> ProcessHandle {
    handle_with(
        dispatcher_end,
        kill_flag,
        FakeChildOpts {
            gate: Some(gate),
            ..Default::default()
        },
    )
}

pub(in crate::session::adapter::pi) fn handle_with(
    dispatcher_end: TcpStream,
    kill_flag: Arc<Mutex<bool>>,
    opts: FakeChildOpts,
) -> ProcessHandle {
    let gate = opts.gate.unwrap_or_default();
    let kills = opts.kills.unwrap_or_default();
    let stdout = dispatcher_end.try_clone().unwrap();
    // A short read timeout makes a killed fake child's socket-shutdown
    // observable on the READER's next poll rather than depending on an
    // in-flight blocking `read()` being interrupted by a shutdown on a
    // different cloned handle, which is not reliable cross-platform —
    // see `spawn_reader`'s WouldBlock/TimedOut handling.
    stdout
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    // A real `kill_tree` on a real child closes ITS end of the pipe,
    // which is what unblocks the dispatcher's blocking `read()` — a fake
    // `kill` that only flips a flag would leave the reader thread (and
    // so `shutdown()`'s `join()`) hanging forever whenever the fake
    // child is still "alive" (i.e. `fake_child` not yet dropped) at
    // shutdown time. `TcpStream::shutdown` affects the whole socket, not
    // just this one cloned handle, so it is the honest stand-in here.
    let socket = dispatcher_end.try_clone().unwrap();
    let gate_for_kill = gate.clone();
    ProcessHandle {
        stdin: Box::new(GatedStdin {
            inner: dispatcher_end,
            gate,
        }),
        stdout: Box::new(FaultyStdout {
            inner: stdout,
            fault: opts.stdout_fault.unwrap_or_default(),
        }),
        wait_timeout: Box::new({
            let kill_flag = kill_flag.clone();
            move |_| *kill_flag.lock().unwrap()
        }),
        kill: Box::new(move || {
            *kill_flag.lock().unwrap() = true;
            *kills.lock().unwrap() += 1;
            // A real kill breaks the pipe, which is what releases a write
            // parked on a child that stopped reading its own stdin.
            gate_for_kill.release();
            let _ = socket.shutdown(std::net::Shutdown::Both);
        }),
        stderr_ring: Arc::new(Mutex::new(Vec::new())),
    }
}

/// A child's stdin that can be made to STALL mid-write — the fake-child half
/// of the MED finding "the stdin write is unbounded" (review round 4). Until
/// `release` runs (what `kill` does above), a gated write parks exactly like
/// a `write_all` into a pipe nobody is draining.
#[derive(Default)]
pub(in crate::session::adapter::pi) struct StdinGate {
    state: Mutex<GateState>,
    changed: Condvar,
}

#[derive(Default)]
struct GateState {
    stalling: bool,
    parked: bool,
    released: bool,
}

impl StdinGate {
    pub(in crate::session::adapter::pi) fn stall(&self) {
        self.state.lock().unwrap().stalling = true;
    }

    pub(in crate::session::adapter::pi) fn parked(&self) -> bool {
        self.state.lock().unwrap().parked
    }

    pub(in crate::session::adapter::pi) fn release(&self) {
        let mut state = self.state.lock().unwrap();
        state.released = true;
        self.changed.notify_all();
    }

    /// `true` when the write may proceed; `false` once it was parked and the
    /// child died under it, which a real pipe reports as a write error.
    fn wait_if_stalling(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        if !state.stalling {
            return true;
        }
        state.parked = true;
        while !state.released {
            state = self.changed.wait(state).unwrap();
        }
        state.parked = false;
        false
    }
}

struct GatedStdin {
    inner: TcpStream,
    gate: Arc<StdinGate>,
}

/// A child's stdout that can be made to fail with a read ERROR rather than an
/// EOF (review round 4 follow-up): a reset pipe does not mean the child has
/// exited, which is exactly why that path has to reap it.
struct FaultyStdout {
    inner: TcpStream,
    fault: Arc<AtomicBool>,
}

impl Read for FaultyStdout {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.fault.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "the fake child's pipe was reset",
            ));
        }
        self.inner.read(buf)
    }
}

impl Write for GatedStdin {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if !self.gate.wait_if_stalling() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "the fake child is gone",
            ));
        }
        self.inner.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

pub(in crate::session::adapter::pi) fn read_line(child: &mut TcpStream) -> String {
    let deadline = std::time::Instant::now() + LINE_TIMEOUT;
    let mut byte = [0u8; 1];
    let mut line = Vec::new();
    loop {
        match child.read(&mut byte) {
            Ok(0) => panic!("the dispatcher's peer closed before a full line arrived"),
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => line.push(byte[0]),
            // An empty poll is ordinary (see `test_pipe_pair`); only the
            // deadline is a failure — and it FAILS rather than hangs.
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                assert!(
                    std::time::Instant::now() < deadline,
                    "no complete line arrived from the dispatcher within {LINE_TIMEOUT:?}"
                );
            }
            Err(e) => panic!("reading the dispatcher's line failed: {e}"),
        }
    }
    String::from_utf8(line).unwrap()
}

pub(in crate::session::adapter::pi) fn write_line(child: &mut TcpStream, line: &str) {
    child.write_all(line.as_bytes()).unwrap();
    child.write_all(b"\n").unwrap();
}

pub(in crate::session::adapter::pi) fn json_of(line: &str) -> serde_json::Value {
    serde_json::from_str(line).unwrap()
}

pub(in crate::session::adapter::pi) fn extract_id(line: &str) -> String {
    json_of(line)["id"].as_str().unwrap().to_string()
}

pub(in crate::session::adapter::pi) fn resp(id: &str, command: &str, success: bool) -> String {
    serde_json::json!({ "id": id, "command": command, "success": success }).to_string()
}

/// The FR-4 handshake, already done: every test that only needs an idle
/// connection — and does not care what was published on the way — starts
/// here. Bounded throughout, like the rest of this harness.
pub(in crate::session::adapter::pi) fn connected() -> (Arc<PiConnection>, TcpStream) {
    connect_and_handshake(None)
}

/// `connected` with the wire deadlines shortened, for a test that drives a
/// SILENT child and must still finish in well under a second. Production keeps
/// `Deadlines::default`'s real bounds.
pub(in crate::session::adapter::pi) fn connected_with_deadlines(
    deadlines: Deadlines,
) -> (Arc<PiConnection>, TcpStream) {
    connect_and_handshake(Some(deadlines))
}

fn connect_and_handshake(deadlines: Option<Deadlines>) -> (Arc<PiConnection>, TcpStream) {
    let (dispatcher_end, mut fake_child) = test_pipe_pair();
    // `wait_timeout` reports NOT-yet-exited until `kill()` runs and closes the
    // socket — which is what a trailing `conn.shutdown()` needs in order to
    // return at all: a fake kill that only flips a flag would leave the reader
    // thread, and so `shutdown()`'s `join()`, parked forever.
    let handle = handle_over(dispatcher_end, Arc::new(Mutex::new(false)));
    let connect = std::thread::spawn(move || {
        let publisher = Arc::new(Recording::default());
        match deadlines {
            Some(deadlines) => PiConnection::connect_with_deadlines(publisher, handle, deadlines),
            None => PiConnection::connect_with(publisher, handle),
        }
    });
    let req = read_line(&mut fake_child);
    write_line(&mut fake_child, &resp(&extract_id(&req), "get_state", true));
    (connect.join().unwrap().unwrap(), fake_child)
}

/// Everything the REDUCER emits to say the wire was wrong: an error-toned
/// notice (what `normalize::protocol_notice` produces for a malformed field)
/// or a `Failure` payload. Both ride the TRANSCRIPT stream, not
/// `EventPublisher::failure` — which is exactly why a test asserting on
/// `Recording::failures` alone could not see a reducer regression at all
/// (LOW, review round 4).
pub(in crate::session::adapter::pi) fn transcript_faults(publisher: &Recording) -> Vec<String> {
    publisher
        .transcripts
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            // `RuntimeFailure`'s fields are private to `ipc`; its Debug shape
            // is all this needs — the assertion is about existence, and the
            // message only has to be readable when one fails.
            RuntimeEventPayload::Failure { failure } => Some(format!("{failure:?}")),
            RuntimeEventPayload::Notice { tone, text, .. } if tone == "error" => Some(text.clone()),
            _ => None,
        })
        .collect()
}

pub(in crate::session::adapter::pi) fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !condition() {
        assert!(
            std::time::Instant::now() < deadline,
            "condition never became true"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
