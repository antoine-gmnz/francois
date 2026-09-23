use super::*;

#[test]
fn maps_pending_request_and_status() {
    let request = json!({
        "id":"request-1", "kind":"ship", "status":"pending",
        "created_at":"2026-09-23T12:00:00Z", "payload":{"reason":"Ready to ship"}
    });
    let gate = gate_for("run-1", &[request]).expect("pending request maps to a gate");
    assert_eq!(gate.request.approval_id, "request-1");
    assert_eq!(gate.actions.len(), 2);
    assert!(gate.actions[1].stops_run);
    assert_eq!(run_view("waiting_user", true), "gate");
    assert_eq!(run_view("blocked_uncertain", false), "blocked");
}

#[test]
#[ignore = "requires an isolated Python service and a seeded feature"]
fn python_service_run_lifecycle() {
    let root = std::env::var("COHORTE_TEST_PROJECT_ROOT").expect("project root");
    let feature_id = std::env::var("COHORTE_TEST_FEATURE_ID").expect("feature id");
    let mut connection = client().expect("Python service");
    let project = project(&mut connection, &root).expect("registered project");
    assert_eq!(detected(&mut connection, &root).unwrap().state, "detected");
    let choices = connection
        .call("features.list", json!({"project_id":project["id"]}))
        .unwrap();
    assert!(items(&choices)
        .unwrap()
        .iter()
        .any(|item| item["id"] == feature_id));
    let started = connection
        .call(
            "runs.start",
            json!({"project_id":project["id"], "feature_id":feature_id,
                   "path":root, "stage":"plan", "request_id":python_rpc::mutation_id()}),
        )
        .unwrap();
    let run_id = started["run_id"].as_str().unwrap();
    let run = get_run(&mut connection, &root, run_id, 0).unwrap();
    assert_eq!(run.run_id, run_id);
    assert_eq!(run.view, "idle");
    let all = runs(&mut connection, &root, 0).unwrap();
    assert!(all.iter().any(|item| item.run_id == run_id));
    let replay = connection
        .call("events.subscribe", json!({"run_id":run_id,"after_seq":0}))
        .unwrap();
    assert!(!items(&replay).unwrap().is_empty());
    let paused = connection
        .call(
            "runs.pause",
            json!({"run_id":run_id,"request_id":python_rpc::mutation_id()}),
        )
        .unwrap();
    assert_eq!(paused["data"]["status"], "paused");
    let resumed = connection
        .call(
            "runs.resume",
            json!({"run_id":run_id,"request_id":python_rpc::mutation_id()}),
        )
        .unwrap();
    assert_eq!(resumed["data"]["status"], "running");
    let cancelled = connection
        .call(
            "runs.cancel",
            json!({"run_id":run_id,"request_id":python_rpc::mutation_id()}),
        )
        .unwrap();
    assert_eq!(cancelled["data"]["status"], "cancelled");
}

#[test]
#[ignore = "requires an isolated Python service and a seeded pending request"]
fn python_service_approval() {
    let root = std::env::var("COHORTE_TEST_PROJECT_ROOT").expect("project root");
    let run_id = std::env::var("COHORTE_TEST_RUN_ID").expect("run id");
    let request_id = std::env::var("COHORTE_TEST_REQUEST_ID").expect("request id");
    let before = get_run(&mut client().unwrap(), &root, &run_id, 0).unwrap();
    assert_eq!(
        before.gate.as_ref().unwrap().request.approval_id,
        request_id
    );
    let outcome = respond(&root, &run_id, &request_id, true, false).unwrap();
    assert_eq!(outcome.steps[0].outcome, "completed");
    assert!(outcome.run.unwrap().gate.is_none());
    let answered = client()
        .unwrap()
        .call("requests.list", json!({"run_id":run_id}))
        .unwrap();
    assert!(items(&answered)
        .unwrap()
        .iter()
        .any(|item| item["id"] == request_id && item["status"] == "answered"));
}

#[test]
#[ignore = "requires an isolated Python service and a seeded feature"]
fn python_service_live_and_replay() {
    let root = std::env::var("COHORTE_TEST_PROJECT_ROOT").expect("project root");
    let feature_id = std::env::var("COHORTE_TEST_FEATURE_ID").expect("feature id");
    let mut subscriber = client().unwrap();
    let project = project(&mut subscriber, &root).unwrap();
    let initial = subscriber
        .call(
            "events.subscribe",
            json!({"project_id":project["id"],"after_seq":0}),
        )
        .unwrap();
    let initial_watermark = initial["watermark"].as_u64().unwrap();
    let mut actor = client().unwrap();
    let started = actor
        .call(
            "runs.start",
            json!({
                "project_id":project["id"], "feature_id":feature_id, "path":root,
                "stage":"plan", "request_id":python_rpc::mutation_id()
            }),
        )
        .unwrap();
    let run_id = started["run_id"].as_str().unwrap();
    let live = subscriber.read_frame().unwrap();
    assert_eq!(live["method"], "events.notification");
    assert_eq!(live["params"]["run_id"], run_id);
    let live_seq = live["params"]["seq"].as_u64().unwrap();
    assert!(live_seq > initial_watermark);
    drop(subscriber);
    actor
        .call(
            "runs.pause",
            json!({"run_id":run_id,"request_id":python_rpc::mutation_id()}),
        )
        .unwrap();
    let mut reconnected = client().unwrap();
    let replay = reconnected
        .call(
            "events.subscribe",
            json!({"run_id":run_id,"after_seq":live_seq}),
        )
        .unwrap();
    let rows = items(&replay).unwrap();
    assert!(!rows.is_empty());
    assert_eq!(rows[0]["seq"], live_seq + 1);
    actor
        .call(
            "runs.cancel",
            json!({"run_id":run_id,"request_id":python_rpc::mutation_id()}),
        )
        .unwrap();
}

#[test]
#[ignore = "requires an isolated Python service and a seeded question"]
fn python_service_question_response() {
    let root = std::env::var("COHORTE_TEST_PROJECT_ROOT").expect("project root");
    let run_id = std::env::var("COHORTE_TEST_RUN_ID").expect("run id");
    let request_id = std::env::var("COHORTE_TEST_REQUEST_ID").expect("request id");
    let before = get_run(&mut client().unwrap(), &root, &run_id, 0).unwrap();
    let gate = before.gate.unwrap();
    assert_eq!(gate.request.approval_id, request_id);
    assert_eq!(gate.request.kind, "question");
    assert!(gate.actions.is_empty());
    assert_eq!(gate.request.options.unwrap(), vec!["A", "B"]);
    let outcome = respond_value(&root, &run_id, &request_id, json!({"answer":"A"}), false).unwrap();
    assert!(outcome.run.unwrap().gate.is_none());
}
