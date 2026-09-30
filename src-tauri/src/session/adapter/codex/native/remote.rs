//! Ephemeral remote control belongs to the existing session's native process.
use super::{protocol, runtime::Inner, transport};
use crate::ipc::{AppError, ErrorCode};
use crate::session::{
    application::{ResourceRequest, RuntimeEvent},
    remote::RemoteState,
};
use serde_json::{json, Value};

fn status(current: &RemoteState, native: &Value) -> Result<RemoteState, AppError> {
    let name = match current {
        RemoteState::Pairing { name, .. }
        | RemoteState::Enabled { name, .. }
        | RemoteState::Starting { name, .. }
        | RemoteState::Failed { name, .. } => name.clone(),
        _ => "Codex".into(),
    };
    Ok(match native["status"].as_str() {
        Some("disabled") => RemoteState::Off,
        Some("connected") => match current {
            RemoteState::Pairing { expires_at, .. } if *expires_at > crate::ids::now_ms() => current.clone(),
            RemoteState::Enabled { .. } => current.clone(),
            _ => RemoteState::Enabled { name, started_at: crate::ids::now_ms() },
        },
        Some("connecting") => RemoteState::Starting { name, started_at: crate::ids::now_ms(), provider: Some("codex".into()) },
        Some("errored") => RemoteState::Failed { name, error: crate::session::remote::RemoteError { code: ErrorCode::RemoteControlFailed, message: "Codex could not connect remote control. Retry after checking your sign-in and network.".into() } },
        _ => return Err(transport::protocol_error()),
    })
}
impl Inner {
    pub(super) fn remote(&self, request: ResourceRequest) -> Result<Value, AppError> {
        let _guard = self.remote_gate.lock().unwrap();
        let connection = self
            .state
            .lock()
            .unwrap()
            .transport
            .clone()
            .ok_or_else(transport::unavailable)?;
        let call = |method: &str, params: Value| {
            connection.call(super::transport::Transport::deadline(), |id| {
                Ok(protocol::request(id, method, params))
            })
        };
        let next = match request {
            ResourceRequest::RemoteStart(name) => {
                let cached = self.state.lock().unwrap().remote.clone();
                if matches!(cached, RemoteState::Pairing { expires_at, .. } if expires_at > crate::ids::now_ms())
                {
                    let actual = call("remoteControl/status/read", Value::Null)?;
                    if actual["status"] == "connected" {
                        return serde_json::to_value(cached)
                            .map_err(|_| transport::protocol_error());
                    }
                }
                let enabled = call("remoteControl/enable", json!({"ephemeral":true}))?;
                if !matches!(enabled["status"].as_str(), Some("connecting" | "connected")) {
                    return Err(AppError::new(
                        ErrorCode::RemoteControlFailed,
                        "Codex did not enable remote control",
                    ));
                }
                let pairing = (|| {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                    let mut status = enabled;
                    while status["status"] == "connecting" && std::time::Instant::now() < deadline {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        status = call("remoteControl/status/read", Value::Null)?;
                    }
                    if status["status"] != "connected" {
                        return Err(AppError::new(ErrorCode::RemoteControlFailed,"Codex remote control could not finish connecting. Check your sign-in and network, then retry."));
                    }
                    call("remoteControl/pairing/start", json!({"manualCode":true}))
                })();
                let pairing = match pairing {
                    Ok(pairing) => pairing,
                    Err(error) => {
                        let _ = call("remoteControl/disable", json!({"ephemeral":true}));
                        return Err(error);
                    }
                };
                let parsed = (|| {
                    let code = pairing["manualPairingCode"]
                        .as_str()
                        .or_else(|| pairing["pairingCode"].as_str())
                        .filter(|code| !code.is_empty())
                        .ok_or_else(transport::protocol_error)?;
                    Ok(RemoteState::Pairing {
                        name,
                        started_at: crate::ids::now_ms(),
                        pairing_code: code.into(),
                        environment_id: pairing["environmentId"]
                            .as_str()
                            .filter(|id| !id.is_empty())
                            .ok_or_else(transport::protocol_error)?
                            .into(),
                        expires_at: pairing["expiresAt"]
                            .as_u64()
                            .and_then(|seconds| seconds.checked_mul(1000))
                            .filter(|at| *at > crate::ids::now_ms())
                            .ok_or_else(transport::protocol_error)?,
                    })
                })();
                match parsed {
                    Ok(next) => next,
                    Err(error) => {
                        let _ = call("remoteControl/disable", json!({"ephemeral":true}));
                        return Err(error);
                    }
                }
            }
            ResourceRequest::RemoteStop => {
                let disabled = call("remoteControl/disable", json!({"ephemeral":true}))?;
                if disabled["status"] != "disabled" {
                    return Err(AppError::new(
                        ErrorCode::RemoteControlFailed,
                        "Codex did not confirm that remote control stopped",
                    ));
                }
                RemoteState::Off
            }
            ResourceRequest::RemoteGet => {
                let native = call("remoteControl/status/read", Value::Null)?;
                status(&self.state.lock().unwrap().remote, &native)?
            }
            _ => return Err(transport::protocol_error()),
        };
        let emitter = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(transport::unavailable());
            }
            state.remote = next.clone();
            state.turn.as_ref().map(|turn| turn.emitter.clone())
        };
        if let Some(emitter) = emitter {
            let _ = emitter.publish(RuntimeEvent::RemoteObserved(next.clone()));
        }
        serde_json::to_value(next).map_err(|_| transport::protocol_error())
    }
    pub(super) fn remote_notification(&self, params: &Value) {
        let (emitter, next) = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            let Ok(next) = status(&state.remote, params) else {
                return;
            };
            state.remote = next.clone();
            (state.turn.as_ref().map(|turn| turn.emitter.clone()), next)
        };
        if let Some(emitter) = emitter {
            let _ = emitter.publish(RuntimeEvent::RemoteObserved(next));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_connected_service_is_visible_without_a_cached_pairing_code() {
        assert!(matches!(
            status(&RemoteState::Off, &json!({"status":"connected"})).unwrap(),
            RemoteState::Enabled { .. }
        ));
        assert!(
            matches!(status(&RemoteState::Off,&json!({"status":"connecting"})).unwrap(),RemoteState::Starting {provider:Some(provider),..} if provider=="codex")
        );
    }
}
