//! Codex 0.159 private App Server protocol and request authority.
//!
//! These modules are transport-independent pieces of the native adapter, not
//! application state. The connection owner serializes ledger mutations and
//! stdin writes. Only redacted resolutions may cross the normalized event sink.

mod agents;
mod control;
mod elicitation;
mod events;
mod invocation;
mod item_details;
mod mcp_notifications;
mod notifications;
mod progress;
mod protocol;
mod remote;
mod requests;
mod resources;
pub(crate) use resources::probe;
mod runtime;
mod startup;
mod transport;

pub(super) fn session_runtime() -> std::sync::Arc<dyn crate::session::application::SessionRuntime> {
    std::sync::Arc::new(runtime::NativeRuntime::new())
}

#[cfg(test)]
mod integration_tests;
#[cfg(test)]
mod product_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod transcript_tests;

#[cfg(test)]
mod parity_tests;
