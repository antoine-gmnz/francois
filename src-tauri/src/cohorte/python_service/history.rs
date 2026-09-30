//! Bounded native evidence when full export exceeds the protocol frame budget.
use super::*;
use std::collections::{BTreeMap, VecDeque};
use std::time::Instant;
type Call<'a> = dyn FnMut(&str, Value) -> Result<Value, AppError> + 'a;
pub(super) fn summary(
    client: &mut RpcClient,
    raw: &Value,
    requests: &[Value],
) -> Result<Value, AppError> {
    read_summary(raw, requests, &mut |method, params| {
        client.call(method, params)
    })
}
pub(super) fn has_context(client: &mut RpcClient, run_id: &str) -> Result<bool, AppError> {
    let mut after = 0;
    for _ in 0..32 {
        let batch = client.call(
            "events.subscribe",
            json!({"run_id":run_id,"after_seq":after}),
        )?;
        let page = items(&batch)?;
        if page.is_empty() {
            return Ok(false);
        }
        for event in page {
            if event["type"] == "run.context" {
                return Ok(true);
            }
            let seq = event["seq"]
                .as_u64()
                .ok_or_else(|| bad("Invalid native event sequence"))?;
            if seq <= after {
                return Err(bad("Native history did not advance"));
            }
            after = seq;
        }
    }
    Err(bad("Run context was not found within the bounded native history; inspect this run with the configured CLI"))
}
fn read_summary(raw: &Value, requests: &[Value], call: &mut Call<'_>) -> Result<Value, AppError> {
    let run_id = raw["id"].as_str().ok_or_else(|| bad("Run has no id"))?;
    match call("runs.export", json!({"run_id":run_id,"max_bytes":768*1024})) {
        Ok(document) => return Ok(document),
        Err(error)
            if error
                .detail
                .as_ref()
                .is_some_and(|detail| detail["code"] == "OUTPUT_INVALID") => {}
        Err(error) => return Err(error),
    }
    let mut after = 0;
    let mut latest = BTreeMap::new();
    let mut tail = VecDeque::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    for _ in 0..128 {
        if Instant::now() >= deadline {
            break;
        }
        let batch = call(
            "events.subscribe",
            json!({"run_id":run_id,"after_seq":after}),
        )?;
        let page = items(&batch)?;
        if page.is_empty() {
            break;
        }
        for event in page {
            let seq = event["seq"]
                .as_u64()
                .ok_or_else(|| bad("Invalid native event sequence"))?;
            if seq <= after {
                return Err(bad("Native history did not advance"));
            }
            after = seq;
            let ty = event["type"].as_str().unwrap_or("");
            if ty == "run.context"
                || ty.starts_with("phase.")
                || matches!(ty, "run.failed" | "run.blocked" | "run.effect_uncertain")
            {
                latest.insert(ty.to_owned(), event.clone());
            }
            tail.push_back(event.clone());
            if tail.len() > 512 {
                tail.pop_front();
            }
        }
    }
    for event in latest.into_values() {
        if !tail.iter().any(|entry| entry["seq"] == event["seq"]) {
            tail.push_back(event);
        }
    }
    let mut events = tail.into_iter().collect::<Vec<_>>();
    events.sort_by_key(|event| event["seq"].as_u64().unwrap_or(0));
    Ok(
        json!({"run":{"state":raw},"events":events,"requests":requests,"approvals":[],"limited":true,"tasks":[],"attempts":[],"checks":[]}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_export_keeps_context_and_latest_native_evidence_without_inventing_approval() {
        let mut pages = 0;
        let doc=read_summary(&json!({"id":"run"}),&[],&mut |method,params|{
            if method=="runs.export" {return Err(AppError::with_detail(ErrorCode::CohorteRejected,"Export exceeds limit",json!({"code":"OUTPUT_INVALID"})));}
            assert_eq!(method,"events.subscribe");assert_eq!(params["run_id"],"run");pages+=1;
            if pages==1 {Ok(json!({"items":[{"seq":1,"type":"run.context","data":{"worktree":"/owned"}},{"seq":2,"type":"phase.checks.completed","data":{"passed":true}}]}))}else{Ok(json!({"items":[]}))}
        }).unwrap();
        assert_eq!(doc["limited"], true);
        assert_eq!(doc["events"].as_array().unwrap().len(), 2);
        assert!(doc["approvals"].as_array().unwrap().is_empty());
        assert_eq!(pages, 2);
    }
}
