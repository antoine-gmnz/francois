#!/usr/bin/env python3
"""Generate native Cohorte RPC frames and run the three François regressions."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main() -> int:
    francois_repo = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cohorte-repo",
        type=Path,
        default=francois_repo.parent / "cohorte",
        help="Cohorte checkout (default: sibling ../cohorte)",
    )
    args = parser.parse_args()
    source = args.cohorte_repo.resolve() / "src"
    if not (source / "cohorte" / "protocol" / "rpc.py").is_file():
        parser.error(f"No Cohorte RPC source under {source}")
    sys.path.insert(0, str(source))
    from cohorte.application.service import CohorteService
    from cohorte.domain.models import RunState, RunStatus, Stage
    from cohorte.persistence.sqlite import Database
    from cohorte.protocol.rpc import RpcServer

    with tempfile.TemporaryDirectory(prefix="francois-cohorte-rpc-") as temporary:
        base = Path(temporary)
        data = base / "data"
        data.mkdir()
        project_root = base / "project"
        project_root.mkdir()
        foreign_root = base / "foreign"
        foreign_root.mkdir()
        # If a regression needs the CLI, it uses this interpreter and this source.
        cli = base / "cohorte-fixture"
        cli.write_text(
            f"#!{sys.executable}\n"
            "import sys\n"
            f"sys.path.insert(0, {str(source)!r})\n"
            "from cohorte.cli.main import main\n"
            "raise SystemExit(main())\n",
            encoding="utf-8",
        )
        cli.chmod(0o700)
        database = Database(data / "cohorte.sqlite3")
        try:
            service = CohorteService(database)
            project = service.init_project(project_root)
            project_id = project["profile"]["project_id"]
            foreign = service.init_project(foreign_root)
            database.create_feature("feature", project_id, "Native fixture")
            database.create_feature("other", foreign["profile"]["project_id"], "Foreign fixture")
            now = datetime.datetime.now(datetime.UTC)
            run = RunState(
                id="native-run", project_id=project_id, feature_id="feature",
                stage=Stage.SHIP, status=RunStatus.WAITING_USER, state_version=1,
                base_commit="a" * 40, candidate_tree_hash="b" * 64,
                created_at=now, updated_at=now,
            )
            database.create_run(run)
            for kind, payload in (
                ("run.context", {
                    "worktree": str(base / "worktree"),
                    "spec_ref": {"id": "spec", "revision": 1},
                    "profile_ref": {"id": "profile", "revision": 1},
                }),
                ("phase.checks.completed", {"passed": True, "candidate_tree_hash": "b" * 64}),
                ("phase.review.completed", {
                    "ready": True, "verdict": "ready", "findings": [],
                    "candidate_tree_hash": "b" * 64,
                }),
            ):
                database.append_event(kind, payload, project_id=project_id, run_id=run.id)
            ship_id = database.create_request(
                run.id, "ship", {"reason": "Approve fixture candidate"}, "b" * 64
            )
            candidate = database.put_artifact(
                "feature-spec-candidate",
                b'{"feature_id":"feature","goal":"Inspectable native spec"}',
            )
            plan = database.put_artifact("task-plan", b'{"tasks":[]}')
            profile_hash = hashlib.sha256(json.dumps(
                project["profile"], ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode()).hexdigest()
            freeze_id = database.create_request(None, "spec.freeze", {
                "feature_id": "feature", "candidate_ref": candidate, "plan_ref": plan,
                "profile_hash": profile_hash,
            }, candidate["sha256"])
            foreign_id = database.create_request(
                None, "spec.freeze", {"feature_id": "other"}, "d" * 64
            )
            server = RpcServer(service)

            def raw_rpc(identifier: int, method: str, params: dict) -> bytes:
                return server.handle_line(json.dumps({
                    "jsonrpc": "2.0", "id": identifier, "method": method, "params": params,
                }).encode())

            def rpc(identifier: int, method: str, params: dict) -> tuple[bytes, dict]:
                raw = raw_rpc(identifier, method, params)
                document = json.loads(raw)
                if "error" in document:
                    raise RuntimeError(f"{method}: {document['error']}")
                return raw, document["result"]

            rpc(0, "initialize", {
                "protocol_major": 1, "protocol_minor": 0,
                "client": {"name": "francois-regressions", "version": "1"},
                "capabilities": ["events.replay"],
            })
            run_calls = [
                ("runs.get", {"run_id": run.id}),
                ("projects.list", {}),
                ("features.get", {"feature_id": "feature"}),
                ("requests.list", {"run_id": run.id}),
                ("runs.export", {"run_id": run.id, "max_bytes": 768 * 1024}),
            ]

            def write_frames(name: str, calls: list[tuple[str, dict]]) -> None:
                frames = b"".join(rpc(i, method, params)[0]
                                  for i, (method, params) in enumerate(calls, 1))
                (base / f"{name}.ndjson").write_bytes(frames)

            write_frames("before", run_calls)
            profile_ref = rpc(30, "projects.get", {"project_id": project_id})[1]["profile_ref"]
            artifact = lambda ref: ("artifacts.get", {
                "id": ref["id"], "revision": ref["revision"], "offset": 0, "limit": 128 * 1024,
            })
            write_frames("review", [
                ("features.list", {"project_id": project_id}),
                ("requests.list", {"status": "pending"}),
                artifact(candidate), artifact(plan),
                ("projects.get", {"project_id": project_id}), artifact(profile_ref),
            ])
            if len(rpc(20, "requests.list", {"status": "pending"})[1]["items"]) != 3:
                raise RuntimeError("Expected exactly three synthetic pending requests")
            rpc(21, "requests.respond", {
                "request_id": freeze_id, "response_id": "fixture-freeze-approval",
                "subject_hash": candidate["sha256"], "response": {"approved": True},
            })
            rpc(22, "requests.respond", {
                "request_id": ship_id, "response_id": "fixture-ship-approval",
                "subject_hash": "b" * 64, "response": {"approved": True},
            })
            write_frames("after", run_calls)
            for ordinal in range(50):
                database.append_event("agent.tool", {"fixture_blob": "x" * 24000, "ordinal": ordinal},
                                      project_id=project_id, run_id=run.id)
            oversized = b"".join(rpc(i, method, params)[0]
                                 for i, (method, params) in enumerate(run_calls[:4], 1))
            error_frame = raw_rpc(5, "runs.export", {"run_id": run.id, "max_bytes": 768 * 1024})
            if json.loads(error_frame).get("error", {}).get("data", {}).get("code") != "OUTPUT_INVALID":
                raise RuntimeError("Oversized native export did not return OUTPUT_INVALID")
            oversized += error_frame
            after, identifier = 0, 6
            while True:
                raw, page = rpc(identifier, "events.subscribe", {"run_id": run.id, "after_seq": after})
                identifier += 1
                oversized += raw
                if not page["items"]:
                    break
                after = page["watermark"]
            (base / "oversized.ndjson").write_bytes(oversized)
        finally:
            database.close()

        environment = os.environ | {
            "COHORTE_PYTHON_CLI": str(cli), "COHORTE_PYTHON_DATA_DIR": str(data),
            "PYTHONPATH": str(source), "COHORTE_TEST_PROJECT_ROOT": str(project_root),
            "COHORTE_TEST_RUN_ID": run.id, "COHORTE_TEST_PROJECT_ID": project_id,
            "COHORTE_TEST_REQUEST_ID": ship_id, "COHORTE_TEST_PROJECT_REQUEST_ID": freeze_id,
            "COHORTE_TEST_OTHER_REQUEST_ID": foreign_id, "COHORTE_TEST_RPC_FRAMES": str(base),
        }
        print("Native source RPC frames generated in disposable storage; running three Rust regressions.")
        result = subprocess.run([
            "cargo", "test", "--offline", "--manifest-path", str(francois_repo / "src-tauri/Cargo.toml"),
            "--quiet", "python_source_", "--", "--ignored", "--test-threads=1",
        ], cwd=francois_repo, env=environment, capture_output=True, text=True, timeout=180)
        print("\n".join((result.stdout + result.stderr).splitlines()[-25:]))
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
