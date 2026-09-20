//! session/adapter/pi/dispatcher/child.rs — the child process a connection
//! owns: its stdin, its wait/kill pair, and the ONE "this connection is over"
//! path (`retire`) that both `PiConnection`'s verbs and the reader thread take.
//!
//! Split out of `dispatcher.rs` (CLAUDE.md's ~1000-line cap) when the reader
//! needed to retire the child too: review round 4's HIGH was about a
//! DISPATCH-side failure leaking a live child, and the reader's own terminal
//! paths (EOF, a read error, a frame error) leaked it exactly the same way —
//! a read error in particular does not mean the child is gone. Sharing this
//! one `Arc` is what lets both sides retire through a single implementation,
//! instead of the reader holding an `Arc<PiConnection>` and keeping the very
//! object it belongs to alive forever.
//!
//! Every wait here is BOUNDED, deliberately: a child that has stopped draining
//! its own stdin must never be able to stop the app from quitting.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// FR-7: how long a child gets to exit on its own once its stdin is closed.
pub(super) const EXIT_GRACE: Duration = Duration::from_secs(5);

/// MED (review round 4): how long retirement waits for an IN-FLIGHT write
/// before it gives up on closing stdin politely. Long enough that a submit
/// racing app-exit still gets its graceful close; short enough that a child
/// which stopped draining its pipe cannot hold the app open.
const STDIN_CLOSE_GRACE: Duration = Duration::from_millis(250);

/// How often a bounded lock acquisition re-tries. Nothing next to a wire
/// round trip, and it keeps a stalled writer from spinning a core.
const LOCK_POLL: Duration = Duration::from_millis(2);

/// Why a command's bytes did not reach the child.
pub(super) enum WriteFault {
    /// Another command's write is still in flight and this one ran out of its
    /// own deadline. Nothing is known to be wrong with the connection itself.
    Busy,
    /// stdin is already closed — this connection is being retired.
    Closed,
    /// The pipe failed: the connection is over.
    Io(std::io::Error),
}

pub(super) struct ChildLink {
    /// The child's stdin, and the only thing a dispatch holds exclusively —
    /// for the WRITE alone (§4, review round 4: a separate lock used to be
    /// held across the whole round trip, which made every verb queue behind
    /// the slowest one). Always acquired with a deadline.
    stdin: Mutex<Option<Box<dyn Write + Send>>>,
    wait_timeout: Mutex<Option<Box<dyn FnMut(Duration) -> bool + Send>>>,
    /// FR-7: terminates the TRACKED process tree, not just the direct child.
    kill: Mutex<Option<Box<dyn FnMut() + Send>>>,
    /// Latched the instant this connection is over, whichever side ended it —
    /// read by the reader thread, which stops the moment it sees it.
    retired: AtomicBool,
    /// What the FIRST `retire` recorded, and its idempotence guard in one:
    /// every later caller reports what it finds here and the child is never
    /// killed twice (FR-7: `session_remove` and app-exit both call
    /// `shutdown()`, and either terminal path may have retired it already).
    exit_status: Mutex<Option<&'static str>>,
}

impl ChildLink {
    pub(super) fn new(
        stdin: Box<dyn Write + Send>,
        wait_timeout: Box<dyn FnMut(Duration) -> bool + Send>,
        kill: Box<dyn FnMut() + Send>,
    ) -> Self {
        Self {
            stdin: Mutex::new(Some(stdin)),
            wait_timeout: Mutex::new(Some(wait_timeout)),
            kill: Mutex::new(Some(kill)),
            retired: AtomicBool::new(false),
            exit_status: Mutex::new(None),
        }
    }

    pub(super) fn is_retired(&self) -> bool {
        self.retired.load(Ordering::SeqCst)
    }

    /// Latch retirement WITHOUT reaping yet. `PiConnection::fail_connection`
    /// takes this first so no further line can reach a session whose failure
    /// is still being published, and spends the child's grace period after —
    /// the frontend never waits on a dying child to learn the connection
    /// failed.
    pub(super) fn latch(&self) {
        self.retired.store(true, Ordering::SeqCst);
    }

    /// One command's bytes, and nothing else, under the stdin lock —
    /// acquired only until `deadline`, so a verb that cannot reach the wire
    /// in the time it was willing to wait for an answer gives up instead of
    /// parking behind whatever is writing.
    pub(super) fn write_line(&self, line: &str, deadline: Instant) -> Result<(), WriteFault> {
        let Some(mut stdin) = lock_by(&self.stdin, deadline) else {
            return Err(WriteFault::Busy);
        };
        let Some(writer) = stdin.as_mut() else {
            return Err(WriteFault::Closed);
        };
        writer
            .write_all(line.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(WriteFault::Io)
    }

    /// FR-7: close stdin (letting Pi's own shutdown cleanup run — the audit's
    /// linked RPC implementation notes "EOF follows shutdown cleanup"), give
    /// the child `grace` to exit on its own, then terminate the tracked
    /// process tree. Returns the exit status for the diagnostics line.
    ///
    /// Idempotent and bounded: an already-reaped child costs one mutex and
    /// nothing else, and closing stdin waits at most `STDIN_CLOSE_GRACE` for
    /// an in-flight write rather than blocking behind a child that has
    /// stopped draining its own pipe — the kill below is what unblocks that
    /// write in the first place.
    pub(super) fn retire(&self, grace: Duration) -> &'static str {
        self.latch();
        let mut recorded = self.exit_status.lock().unwrap();
        if let Some(status) = *recorded {
            return status;
        }
        let closed = match lock_by(&self.stdin, Instant::now() + STDIN_CLOSE_GRACE) {
            Some(mut stdin) => {
                stdin.take();
                true
            }
            None => false,
        };
        // A child still holding a write hostage never got its EOF, so the
        // grace period would be waiting on a shutdown cleanup that cannot
        // have started.
        let exited = closed
            && match self.wait_timeout.lock().unwrap().as_mut() {
                Some(wait) => wait(grace),
                None => true,
            };
        if !exited {
            if let Some(kill) = self.kill.lock().unwrap().as_mut() {
                kill();
            }
        }
        let status = if exited { "exited" } else { "killed" };
        *recorded = Some(status);
        status
    }
}

/// `std::sync::Mutex` has no timed acquisition, and every wait on the child's
/// stdin has to be bounded — by the verb's own deadline while dispatching,
/// by `STDIN_CLOSE_GRACE` while retiring. A short poll is the whole
/// implementation.
fn lock_by<T>(mutex: &Mutex<T>, deadline: Instant) -> Option<std::sync::MutexGuard<'_, T>> {
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Some(guard),
            // Same "a poisoned lock is a bug, not a condition" stance every
            // other `.lock().unwrap()` in this module takes.
            Err(std::sync::TryLockError::Poisoned(e)) => {
                panic!("the Pi connection's lock is poisoned: {e}")
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(LOCK_POLL);
            }
        }
    }
}
