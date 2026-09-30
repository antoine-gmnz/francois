//! Bounded live tool previews. Vendor ids never leave this map.
use crate::session::{
    application::RuntimeEvent, runtime_events::RuntimeToolCall, step_detail::StepBody,
};
use serde_json::Value;
use std::collections::HashMap;
const CAP: usize = 64 * 1024;
#[derive(Default)]
pub(super) struct Progress(HashMap<String, RuntimeToolCall>);
fn bound(text: &mut String) -> bool {
    if text.len() <= CAP {
        return false;
    }
    let mut start = text.len() - CAP;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text.drain(..start);
    true
}
impl Progress {
    pub(super) fn buffered(&self, id: &str) -> Option<&str> {
        self.0.get(id).map(|tool| tool.output_text.as_str())
    }
    pub(super) fn observe(
        &mut self,
        native_id: &str,
        completed: bool,
        events: &mut Vec<RuntimeEvent>,
    ) {
        for event in events.iter() {
            if let RuntimeEvent::ToolStarted {
                block_id,
                tool,
                summary,
            } = event
            {
                let mut input = summary.clone();
                let truncated = bound(&mut input);
                self.0.entry(native_id.into()).or_insert(RuntimeToolCall {
                    id: block_id.clone(),
                    name: tool.clone(),
                    status: "running".into(),
                    input_text: input,
                    output_text: String::new(),
                    input_truncated: truncated,
                    output_truncated: false,
                    started_at: Some(crate::ids::now_ms()),
                    completed_at: None,
                });
            }
        }
        if completed {
            if let Some(mut tool) = self.0.remove(native_id) {
                Self::settle(&mut tool, events);
                let index = events
                    .iter()
                    .position(|event| matches!(event, RuntimeEvent::ToolCompleted { .. }))
                    .unwrap_or(events.len());
                events.insert(
                    index,
                    RuntimeEvent::ToolSnapshot {
                        block_id: tool.id.clone(),
                        tool,
                    },
                );
            }
        }
    }
    fn settle(tool: &mut RuntimeToolCall, events: &[RuntimeEvent]) {
        tool.status = "unknown".into();
        tool.completed_at = Some(crate::ids::now_ms());
        for event in events {
            if let RuntimeEvent::ToolCompleted {
                block_id,
                detail: Some(detail),
                ..
            } = event
            {
                if block_id != &tool.id {
                    continue;
                }
                tool.status = if detail.is_error {
                    "failed"
                } else {
                    "succeeded"
                }
                .into();
                let output = match &detail.body {
                    StepBody::Command { output, .. } | StepBody::Generic { output, .. } => output,
                };
                tool.output_text = output.text.clone();
                tool.output_truncated |= output.dropped_lines > 0;
                tool.output_truncated |= bound(&mut tool.output_text);
            }
        }
    }
    pub(super) fn update(&mut self, params: &Value, append: bool) -> Option<RuntimeEvent> {
        let tool = self.0.get_mut(params["itemId"].as_str()?)?;
        if append {
            tool.output_text.push_str(params["delta"].as_str()?);
        } else {
            tool.output_text = params["message"].as_str()?.into();
        }
        tool.output_truncated |= bound(&mut tool.output_text);
        Some(RuntimeEvent::ToolSnapshot {
            block_id: tool.id.clone(),
            tool: tool.clone(),
        })
    }
    pub(super) fn close(&mut self, events: &mut Vec<RuntimeEvent>) {
        let mut snapshots = Vec::new();
        for (_, mut tool) in self.0.drain() {
            Self::settle(&mut tool, events);
            tool.status = "cancelled".into();
            snapshots.push(RuntimeEvent::ToolSnapshot {
                block_id: tool.id.clone(),
                tool,
            });
        }
        snapshots.append(events);
        *events = snapshots;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_output_is_bounded_scoped_and_settles_without_vendor_id() {
        let mut progress = Progress::default();
        let mut events = vec![RuntimeEvent::ToolStarted {
            block_id: "local".into(),
            tool: "Bash".into(),
            summary: "ls".into(),
        }];
        progress.observe("vendor", false, &mut events);
        assert!(progress
            .update(
                &serde_json::json!({"itemId":"foreign","delta":"dropped"}),
                true
            )
            .is_none());
        let RuntimeEvent::ToolSnapshot { block_id, tool } = progress
            .update(
                &serde_json::json!({"itemId":"vendor","delta":"é".repeat(CAP)}),
                true,
            )
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(block_id, "local");
        assert!(tool.output_text.len() <= CAP);
        assert!(tool.output_truncated);
        let mut events = vec![];
        progress.close(&mut events);
        assert!(
            matches!(&events[0],RuntimeEvent::ToolSnapshot { tool,.. } if tool.status=="cancelled")
        );
        assert!(progress
            .update(&serde_json::json!({"itemId":"vendor","delta":"late"}), true)
            .is_none());
    }
}
