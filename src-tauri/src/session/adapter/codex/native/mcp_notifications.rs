//! Refresh the live server inventory after startup/OAuth without blocking its reader.
use super::runtime::Inner;
use crate::session::application::{ResourceRequest, RuntimeEvent};
use serde_json::Value;
use std::sync::Arc;

impl Inner {
    pub(super) fn refresh_mcp(self: &Arc<Self>, params: &Value) {
        {
            let mut state = self.state.lock().unwrap();
            if state.closed
                || state.thread_id.is_none()
                || params["threadId"]
                    .as_str()
                    .is_some_and(|thread| state.thread_id.as_deref() != Some(thread))
            {
                return;
            }
            if state.mcp_refreshing {
                state.mcp_refresh_again = true;
                return;
            }
            state.mcp_refreshing = true;
        }
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            let Some(inner) = weak.upgrade() else {
                return;
            };
            loop {
                let result = inner.resource(ResourceRequest::McpList);
                let (emitter, again) = {
                    let mut state = inner.state.lock().unwrap();
                    let emitter = state.turn.as_ref().map(|turn| turn.emitter.clone());
                    let again = state.mcp_refresh_again && !state.closed;
                    state.mcp_refresh_again = false;
                    if !again {
                        state.mcp_refreshing = false;
                    }
                    (emitter, again)
                };
                if let (Some(emitter), Ok(Value::Array(servers))) = (emitter, result) {
                    for server in servers {
                        if let Ok(server) = serde_json::from_value(server) {
                            let _ = emitter.publish(RuntimeEvent::McpObserved(server));
                        }
                    }
                }
                if !again {
                    break;
                }
            }
        });
    }
}
