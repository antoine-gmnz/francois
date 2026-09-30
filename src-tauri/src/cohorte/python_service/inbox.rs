//! Pending requests require proven project ownership, including runless gates.
use super::*;
pub(super) fn belongs(request: &Value, project: &Value, features: &[Value]) -> bool {
    let payload = &request["payload"];
    if payload["project_id"].is_string() {
        return payload["project_id"] == project["id"];
    }
    if let Some(id) = payload["feature_id"].as_str() {
        return features
            .iter()
            .any(|feature| feature["id"] == id && feature["project_id"] == project["id"]);
    }
    let Some(root) = project["root_path"]
        .as_str()
        .and_then(|root| Path::new(root).canonicalize().ok())
    else {
        return false;
    };
    if let Some(paths) = payload["write_paths"].as_array() {
        return !paths.is_empty()
            && paths.iter().all(|path| {
                path.as_str()
                    .map(Path::new)
                    .filter(|path| path.is_absolute())
                    .and_then(|path| path.canonicalize().ok())
                    .is_some_and(|path| path.starts_with(&root))
            });
    }
    false
}
pub(super) fn unexpired(request: &Value) -> bool {
    request["status"] == "pending"
        && (request["expires_at"].is_null() || millis_or_zero(&request["expires_at"]) > now_ms())
}
pub(super) fn pending(client: &mut RpcClient, registered: &Value) -> Result<Vec<Gate>, AppError> {
    let features = client.call("features.list", json!({"project_id":registered["id"]}))?;
    let pending = client.call("requests.list", json!({"status":"pending"}))?;
    let mut gates = Vec::new();
    for request in items(&pending)? {
        if !request["run_id"].is_null()
            || !unexpired(request)
            || !belongs(request, registered, items(&features)?)
        {
            continue;
        }
        if let Some(mut gate) = gate_for("", std::slice::from_ref(request)) {
            if request["kind"] == "spec.freeze" {
                if let Some(id) = request["payload"]["feature_id"].as_str().filter(|id| {
                    !id.is_empty()
                        && id.len() <= 200
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                }) {
                    gate.request.cli = format!("cohorte spec {id}");
                }
            }
            if request["kind"] != "question" {
                match review_text(client, registered, request) {
                    Ok(Some(text)) => gate.request.preview.text = text,
                    _ => {
                        gate.actions.retain(|action| action.id != "approve");
                        gate.request.preview.truncated = true;
                        gate.request.preview.text="The exact review evidence is unavailable, stale, or too large for this preview. Review this request in native Cohorte before approving it.".into();
                    }
                }
            }
            gates.push(gate);
        }
    }
    Ok(gates)
}
pub(super) fn review_text(
    client: &mut RpcClient,
    registered: &Value,
    request: &Value,
) -> Result<Option<String>, AppError> {
    let payload = &request["payload"];
    if request["kind"] == "spec.freeze" {
        let candidate = execution::artifact(client, &payload["candidate_ref"])?;
        let plan = execution::artifact(client, &payload["plan_ref"])?;
        let project = client.call("projects.get", json!({"project_id":registered["id"]}))?;
        let profile = execution::stored_profile(client, &project)?;
        if profile["project_id"] != registered["id"] {
            return Ok(None);
        }
        return freeze_preview(request, &candidate, &plan, &profile);
    }
    Ok(None)
}
fn freeze_preview(
    request: &Value,
    candidate: &[u8],
    plan: &[u8],
    profile: &Value,
) -> Result<Option<String>, AppError> {
    use sha2::Digest;
    let payload = &request["payload"];
    let mut canonical_profile = profile.clone();
    canonical_profile.sort_all_objects();
    let profile_bytes = serde_json::to_vec(&canonical_profile)
        .map_err(|_| bad("Project profile cannot be verified"))?;
    for (bytes, hash) in [
        (candidate, &payload["candidate_ref"]["sha256"]),
        (plan, &payload["plan_ref"]["sha256"]),
        (profile_bytes.as_slice(), &payload["profile_hash"]),
    ] {
        if *hash != format!("{:x}", sha2::Sha256::digest(bytes)) {
            return Ok(None);
        }
    }
    if request["subject_hash"] != payload["candidate_ref"]["sha256"] {
        return Ok(None);
    }
    let candidate: Value =
        serde_json::from_slice(candidate).map_err(|_| bad("Spec candidate is not valid JSON"))?;
    if candidate["feature_id"] != payload["feature_id"] {
        return Ok(None);
    }
    let plan: Value =
        serde_json::from_slice(plan).map_err(|_| bad("Task plan is not valid JSON"))?;
    let text =
        serde_json::to_string_pretty(&json!({"spec":candidate,"taskPlan":plan,"profile":profile}))
            .map_err(|_| bad("Review evidence cannot be rendered"))?;
    Ok((text.len() <= 32 * 1024).then_some(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runless_requests_never_cross_projects_and_expired_are_excluded() {
        let project = json!({"id":"p","root_path":"/tmp"});
        let features = vec![json!({"id":"feature","project_id":"other"})];
        assert!(!belongs(
            &json!({"payload":{"feature_id":"feature"}}),
            &project,
            &features
        ));
        assert!(!belongs(
            &json!({"payload":{"project_id":"other"}}),
            &project,
            &features
        ));
        assert!(belongs(
            &json!({"payload":{"project_id":"p"}}),
            &project,
            &features
        ));
        assert!(!belongs(
            &json!({"payload":{"refactor_id":"unscoped","write_paths":["relative/file"]}}),
            &project,
            &features
        ));
        assert!(!unexpired(
            &json!({"status":"pending","expires_at":"2020-01-01T00:00:00Z"})
        ));
        assert!(unexpired(&json!({"status":"pending","expires_at":null})));
    }
}

#[cfg(test)]
mod evidence_tests {
    use super::*;
    #[test]
    fn spec_approval_requires_exact_complete_candidate_plan_and_profile_evidence() {
        use sha2::Digest;
        let candidate = br#"{"feature_id":"f","goal":"Inspectable spec"}"#;
        let plan = br#"{"tasks":[{"id":"t","write_paths":["src"]}]}"#;
        let profile = json!({"project_id":"p","policy":{"max_fix_cycles":3}});
        let mut canonical_profile = profile.clone();
        canonical_profile.sort_all_objects();
        let profile_bytes = serde_json::to_vec(&canonical_profile).unwrap();
        let hash = |bytes: &[u8]| format!("{:x}", sha2::Sha256::digest(bytes));
        let request = json!({"kind":"spec.freeze","subject_hash":hash(candidate),"payload":{"feature_id":"f","candidate_ref":{"sha256":hash(candidate)},"plan_ref":{"sha256":hash(plan)},"profile_hash":hash(&profile_bytes)}});
        let preview = freeze_preview(&request, candidate, plan, &profile)
            .unwrap()
            .unwrap();
        assert!(preview.contains("Inspectable spec"));
        assert!(preview.contains("write_paths"));
        assert!(preview.contains("max_fix_cycles"));
        assert!(
            freeze_preview(&request, candidate, plan, &json!({"project_id":"changed"}))
                .unwrap()
                .is_none()
        );
        let mut foreign = request.clone();
        foreign["payload"]["feature_id"] = json!("other");
        assert!(freeze_preview(&foreign, candidate, plan, &profile)
            .unwrap()
            .is_none());
        let mut wrong = request.clone();
        wrong["subject_hash"] = json!("stale");
        assert!(freeze_preview(&wrong, candidate, plan, &profile)
            .unwrap()
            .is_none());
    }
}
