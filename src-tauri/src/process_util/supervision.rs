//! Native child ownership; provider protocols remain in their adapters.
mod framed_pipe;
use super::CommandBuilder;
use crate::ipc::{AppError, ErrorCode};
pub(crate) use framed_pipe::FrameStream;
use std::io::{self, BufRead, Read};
use std::process::{Child, ChildStdin, ChildStdout, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub(crate) const FRAME_LIMIT: usize = 8 * 1024 * 1024;
const DIAGNOSTIC_LIMIT: usize = 64 * 1024;
const CLOSE_GRACE: Duration = Duration::from_secs(2);
// Native interactive transports use this bound; exec has no handshake.
pub(crate) const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);

pub(crate) struct FrameReader<R> {
    reader: R,
}
impl<R: BufRead> FrameReader<R> {
    pub fn new(reader: R) -> Self {
        Self { reader }
    }
    pub fn read_frame(&mut self) -> Result<Option<String>, AppError> {
        let mut frame = Vec::new();
        loop {
            let available = self.reader.fill_buf().map_err(|_| {
                AppError::new(
                    ErrorCode::RuntimeUnavailable,
                    "native output channel closed",
                )
            })?;
            if available.is_empty() {
                return if frame.is_empty() {
                    Ok(None)
                } else {
                    Err(AppError::new(
                        ErrorCode::RuntimeProtocolError,
                        "native output ended with an incomplete frame",
                    ))
                };
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let take = newline.map_or(available.len(), |i| i + 1);
            let bytes_before_newline = take - usize::from(newline.is_some());
            if frame.len() + bytes_before_newline > FRAME_LIMIT {
                return Err(AppError::new(
                    ErrorCode::RuntimeProtocolError,
                    "native output frame exceeds 8 MiB",
                ));
            }
            frame.extend_from_slice(&available[..take]);
            self.reader.consume(take);
            if newline.is_some() {
                frame.pop();
                if frame.last() == Some(&b'\r') {
                    frame.pop();
                }
                return String::from_utf8(frame).map(Some).map_err(|_| {
                    AppError::new(
                        ErrorCode::RuntimeProtocolError,
                        "native output is not valid UTF-8",
                    )
                });
            }
        }
    }
}
#[derive(Default)]
struct DiagnosticTail {
    bytes: Vec<u8>,
    truncated: bool,
}
impl DiagnosticTail {
    fn push(&mut self, chunk: &[u8]) {
        if chunk.len() >= DIAGNOSTIC_LIMIT {
            self.truncated |= !self.bytes.is_empty() || chunk.len() > DIAGNOSTIC_LIMIT;
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&chunk[chunk.len() - DIAGNOSTIC_LIMIT..]);
        } else {
            let excess = (self.bytes.len() + chunk.len()).saturating_sub(DIAGNOSTIC_LIMIT);
            if excess > 0 {
                self.bytes.drain(..excess);
                self.truncated = true;
            }
            self.bytes.extend_from_slice(chunk);
        }
    }
}
pub(crate) struct OwnedChild {
    child: Mutex<Child>,
    tree_stopped: Mutex<bool>,
    stderr: Mutex<Option<std::thread::JoinHandle<()>>>,
    // Retained for diagnostics consumers; raw native stderr is never published.
    #[allow(dead_code)]
    diagnostic: Arc<Mutex<DiagnosticTail>>,
    #[cfg(windows)]
    job: windows::Job,
}
impl CommandBuilder {
    pub(crate) fn start_owned(mut self) -> io::Result<OwnedChild> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            self.cmd.process_group(0);
        }
        self.cmd.stderr(Stdio::piped());
        let mut child = self.cmd.spawn()?;
        #[cfg(windows)]
        let job = match windows::Job::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let diagnostic = Arc::new(Mutex::new(DiagnosticTail::default()));
        let stderr = child.stderr.take().map(|mut reader| {
            let tail = diagnostic.clone();
            std::thread::spawn(move || {
                let mut buf = [0; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => tail.lock().unwrap().push(&buf[..n]),
                    }
                }
            })
        });
        Ok(OwnedChild {
            child: Mutex::new(child),
            tree_stopped: Mutex::new(false),
            stderr: Mutex::new(stderr),
            diagnostic,
            #[cfg(windows)]
            job,
        })
    }
}
impl OwnedChild {
    pub fn take_stdin(&self) -> Option<ChildStdin> {
        self.child.lock().unwrap().stdin.take()
    }
    pub fn take_stdout(&self) -> Option<ChildStdout> {
        self.child.lock().unwrap().stdout.take()
    }
    pub fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
        self.child.lock().unwrap().try_wait()
    }
    pub fn wait(&self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.try_wait()? {
                self.stop_tree()?;
                if let Some(pump) = self.stderr.lock().unwrap().take() {
                    let deadline = Instant::now() + CLOSE_GRACE;
                    while !pump.is_finished() {
                        if Instant::now() >= deadline {
                            return Err(io::Error::new(
                                io::ErrorKind::TimedOut,
                                "native stderr did not close after tree termination",
                            ));
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    let _ = pump.join();
                }
                return Ok(status);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn stop_tree(&self) -> io::Result<()> {
        let mut stopped = self.tree_stopped.lock().unwrap();
        if *stopped {
            return Ok(());
        }
        #[cfg(unix)]
        {
            let child = self.child.lock().unwrap();
            let result = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            if result != 0 && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                return Err(io::Error::last_os_error());
            }
        }
        #[cfg(windows)]
        self.job.terminate()?;
        *stopped = true;
        Ok(())
    }
    pub fn terminate(&self) -> io::Result<ExitStatus> {
        self.stop_tree()?;
        self.wait()
    }
    pub fn close(&self) -> io::Result<ExitStatus> {
        // A protocol-specific graceful shutdown is sent by the adapter first.
        let deadline = Instant::now() + CLOSE_GRACE;
        loop {
            if self.try_wait()?.is_some() {
                return self.wait();
            }
            if Instant::now() >= deadline {
                return self.terminate();
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if let Err(error) = self.terminate() {
            eprintln!("native child cleanup failed: {error}");
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::*;
    pub(super) struct Job(HANDLE);
    // Job handles are kernel-owned and the APIs used here are thread-safe.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    impl Job {
        pub fn attach(child: &Child) -> io::Result<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Self(handle);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }
        pub fn terminate(&self) -> io::Result<()> {
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(test)]
#[path = "supervision_tests.rs"]
mod tests;
