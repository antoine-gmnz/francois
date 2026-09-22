use super::*;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};

pub(crate) struct FrameStream {
    owner: Arc<OwnedChild>,
    receiver: Option<Receiver<Result<Option<String>, AppError>>>,
    reader: Option<std::thread::JoinHandle<()>>,
    ended: bool,
}
impl OwnedChild {
    pub fn take_frames(self: &Arc<Self>) -> Option<crate::process_util::FrameStream> {
        let stdout = self.take_stdout()?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let owner = Arc::downgrade(self);
        let reader = std::thread::spawn(move || {
            let mut frames = FrameReader::new(io::BufReader::new(stdout));
            loop {
                let frame = frames.read_frame();
                let terminal = !matches!(&frame, Ok(Some(_)));
                if frame.is_err() {
                    if let Some(owner) = owner.upgrade() {
                        let _ = owner.terminate();
                    }
                }
                if sender.send(frame).is_err() || terminal {
                    break;
                }
            }
        });
        Some(FrameStream {
            owner: self.clone(),
            receiver: Some(receiver),
            reader: Some(reader),
            ended: false,
        })
    }
}
impl FrameStream {
    pub fn read_frame(&mut self) -> Result<Option<String>, AppError> {
        self.read_with_deadline(None)
    }
    #[allow(dead_code)] // Native interactive initialization in08/09 uses this exact bound.
    pub fn read_handshake(&mut self) -> Result<Option<String>, AppError> {
        self.read_until(Instant::now() + HANDSHAKE_DEADLINE)
    }
    pub fn read_until(&mut self, deadline: Instant) -> Result<Option<String>, AppError> {
        self.read_with_deadline(Some(deadline.saturating_duration_since(Instant::now())))
    }
    fn read_with_deadline(
        &mut self,
        timeout: Option<Duration>,
    ) -> Result<Option<String>, AppError> {
        if self.ended {
            return Ok(None);
        }
        let receiver = self.receiver.as_ref().expect("live frame receiver");
        let packet = match timeout {
            Some(timeout) => receiver.recv_timeout(timeout),
            None => receiver.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        let frame = match packet {
            Ok(frame) => frame,
            Err(RecvTimeoutError::Timeout) => {
                let _ = self.owner.terminate();
                Err(AppError::new(
                    ErrorCode::RuntimeTimeout,
                    "native protocol handshake timed out",
                ))
            }
            Err(RecvTimeoutError::Disconnected) => Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "native output channel closed",
            )),
        };
        self.ended = !matches!(&frame, Ok(Some(_)));
        frame
    }
}
impl Drop for FrameStream {
    fn drop(&mut self) {
        drop(self.receiver.take());
        let _ = self.owner.close();
        if let Some(reader) = self.reader.take() {
            let deadline = Instant::now() + CLOSE_GRACE;
            while !reader.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if reader.is_finished() {
                let _ = reader.join();
            } else {
                eprintln!("native frame reader did not stop after transport cleanup");
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handshake_deadline_cancels_the_owned_transport_without_replaying() {
        #[cfg(windows)]
        let builder = crate::process_util::spawn("powershell.exe").args([
            "-NoProfile",
            "-Command",
            "Start-Sleep -Seconds 5",
        ]);
        #[cfg(unix)]
        let builder = crate::process_util::spawn("sh").args(["-c", "sleep 5"]);
        let owner = Arc::new(builder.stdout(Stdio::piped()).start_owned().unwrap());
        let mut stream = owner.take_frames().unwrap();
        assert_eq!(HANDSHAKE_DEADLINE, Duration::from_secs(10));
        assert_eq!(
            stream
                .read_with_deadline(Some(Duration::from_millis(20)))
                .unwrap_err()
                .code,
            ErrorCode::RuntimeTimeout
        );
        assert!(owner.try_wait().unwrap().is_some());
        assert!(stream.read_frame().unwrap().is_none());
    }
}
