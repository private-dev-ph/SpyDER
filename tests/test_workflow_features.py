"""Integration coverage for archived workflow runs and portable subflow calls."""

import copy
import json
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from spyder_cctv.cameras import CameraManager
from spyder_cctv.web import create_server
from spyder_cctv.workflow import WorkflowService


class Manager:
    def __init__(self):
        self.workers = {"cam": object()}
        self.cv = {
            "state": "ready",
            "engine": "opencv",
            "sequence": 1,
            "result_age_seconds": 0.01,
            "frame_size": [100, 100],
            "detections": [{"label": "person", "confidence": 0.9, "bbox": [1, 1, 10, 10]}],
        }

    def statuses(self):
        return [
            {
                "id": "cam",
                "name": "Entrance",
                "state": "running",
                "capture_session": "one",
                "metadata": {"cv": self.cv},
            }
        ]


class Recorder:
    def __init__(self):
        self.calls = []

    def status(self):
        return {"state": "idle", "camera_ids": [], "items": []}

    def capture(self, ids):
        self.calls.append(ids)
        return {}


@pytest.fixture
def service(tmp_path):
    service = WorkflowService(Manager(), Recorder(), tmp_path)
    service._stop.set()
    service._thread.join(2)
    yield service
    service.close()


def graph():
    return {
        "id": "visitors",
        "name": "Visitors",
        "enabled": True,
        "camera_ids": ["cam"],
        "nodes": [
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {"id": "filter", "type": "filter", "x": 200, "y": 0, "params": {"confidence": 0.5}},
            {"id": "event", "type": "event", "x": 400, "y": 0, "params": {"message": "Visitor"}},
        ],
        "edges": [{"from": "detect", "to": "filter"}, {"from": "filter", "to": "event"}],
    }


def subflow():
    return {
        "id": "trusted-filter",
        "name": "Trusted filter",
        "description": "Reusable confidence filter",
        "parameters": [
            {
                "name": "confidence",
                "type": "number",
                "default": 0.7,
                "node_id": "filter",
                "field": "confidence",
            }
        ],
        "graph": {
            "id": "trusted-filter",
            "name": "Trusted filter",
            "enabled": False,
            "camera_ids": [],
            "nodes": [
                {"id": "input", "type": "subflow_input", "x": 0, "y": 0, "params": {}},
                {"id": "filter", "type": "filter", "x": 200, "y": 0, "params": {}},
                {"id": "output", "type": "subflow_output", "x": 400, "y": 0, "params": {}},
            ],
            "edges": [{"from": "input", "to": "filter"}, {"from": "filter", "to": "output"}],
        },
    }


def test_summary_history_persists_real_node_outcomes_without_detection_payloads(service):
    service.save(graph())
    service._tick(1)
    assert service.history.flush()
    rows = service.history.list()["runs"]
    assert len(rows) == 1
    detail = service.history_detail(rows[0]["id"])
    assert [n["type"] for n in detail["nodes"]] == ["detections", "filter", "event"]
    assert all("inputs" not in n and "outputs" not in n for n in detail["nodes"])
    assert not detail.get("context")
    assert detail["actions"][0]["state"] == "saved"
    assert detail["actions"][0]["event_id"]
    assert detail["graph"]["name"] == "Visitors"
    assert detail["state"] == "completed"


def test_diagnostic_replay_isolated_from_events_recordings_and_live_state(service):
    service.history.configure({**service.history.settings(), "mode": "diagnostic"})
    live = graph()
    live["nodes"].insert(
        2, {"id": "cool", "type": "cooldown", "x": 300, "y": 0, "params": {"seconds": 30}}
    )
    live["edges"] = [
        {"from": "detect", "to": "filter"},
        {"from": "filter", "to": "cool"},
        {"from": "cool", "to": "event"},
    ]
    service.save(live)
    service._tick(1)
    assert service.history.flush()
    detail = service.history_detail(service.history.list()["runs"][0]["id"])
    assert detail["context"]["cv"]["frame_size"] == [100, 100]
    before = copy.deepcopy(
        (service._cooldowns, service._debug, service.event_store.list(), service.recorder.calls)
    )
    result = service.replay_history(detail["id"])
    assert result["actions_enabled"] is False
    assert result["run"]["source"] == "replay"
    assert result["run"]["nodes"]
    assert (
        service._cooldowns,
        service._debug,
        service.event_store.list(),
        service.recorder.calls,
    ) == before
    assert service.history.list()["total"] == 1


def test_summary_replay_rejected_and_missing_history_is_explicit(service):
    service.save(graph())
    service._tick(1)
    assert service.history.flush()
    with pytest.raises(ValueError, match="diagnostic"):
        service.replay_history(service.history.list()["runs"][0]["id"])
    with pytest.raises(KeyError):
        service.history_detail("unknown")


def test_bundle_roundtrip_pins_versions_disables_import_and_is_atomic(service, tmp_path):
    published = service.publish_subflow(subflow())
    call = graph()
    call["nodes"][1] = {
        "id": "filter",
        "type": "subflow",
        "x": 200,
        "y": 0,
        "params": {
            "subflow_id": published["id"],
            "version": published["version"],
            "arguments": {"confidence": 0.8},
        },
    }
    service.save(call)
    bundle = service.export_bundle(call)
    assert bundle["format"] == "spyder-workflow-bundle"
    assert len(bundle["subflows"]) == 1
    other = WorkflowService(Manager(), Recorder(), tmp_path / "other")
    try:
        other._stop.set()
        other._thread.join(2)
        imported = other.import_bundle(bundle)
        assert imported["workflow"]["enabled"] is False
        other.save({**imported["workflow"], "enabled": True})
        other._tick(1)
        assert len(other.event_store.list()["events"]) == 1
        other.publish_subflow({**subflow(), "description": "Another version"})
        assert other.subflows.get(published["id"], 1)["description"] == published["description"]
        bad = copy.deepcopy(bundle)
        bad["workflow"]["nodes"][1]["params"]["version"] = 999
        before = other.subflows.list()
        with pytest.raises((ValueError, KeyError)):
            other.import_bundle(bad)
        assert other.subflows.list() == before
        with pytest.raises(ValueError, match="referenced"):
            other.remove_subflow(published["id"])
    finally:
        other.close()


def test_workflow_tools_routes_enforce_control_guard_and_history_validation(tmp_path, monkeypatch):
    import spyder_cctv.web as web

    instances = []
    original = web.WorkflowService

    def factory(*args, **kwargs):
        value = original(*args, **kwargs)
        instances.append(value)
        return value

    monkeypatch.setattr(web, "WorkflowService", factory)
    manager = CameraManager([], config_path=tmp_path / "config.json")
    server = create_server(manager, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"

    def get(path):
        with urlopen(base + path, timeout=5) as response:
            return json.load(response)

    def post(path, data, guard=True):
        headers = {"Content-Type": "application/json"}
        if guard:
            headers["X-Spyder-Control"] = "1"
        with urlopen(
            Request(base + path, data=json.dumps(data).encode(), headers=headers), timeout=5
        ) as response:
            return json.load(response)

    try:
        assert get("/api/workflows/subflows")["subflows"] == []
        assert get("/api/workflows/history")["runs"] == []
        with pytest.raises(HTTPError) as error:
            post("/api/workflows/subflows", {"subflow": subflow()}, guard=False)
        assert error.value.code == 403
        definition = post("/api/workflows/subflows", {"subflow": subflow()})
        assert get(f"/api/workflows/subflows/{definition['id']}?version=1")["version"] == 1
        exported = get("/api/workflows/subflows/export")
        assert exported["format"] == "spyder-subflows"
        assert exported["subflows"][0]["version"] == 1
        with pytest.raises(HTTPError) as error:
            get("/api/workflows/history/unknown")
        assert error.value.code == 404
        with pytest.raises(HTTPError) as error:
            get("/api/workflows/history?extra=1")
        assert error.value.code == 400
        state = get("/api/workflows/history")["settings"]
        assert (
            post("/api/workflows/history/settings", {**state, "mode": "diagnostic"})["mode"]
            == "diagnostic"
        )
        assert post("/api/workflows/history/delete", {"ids": []})["deleted"] == 0
        assert post("/api/workflows/history/clear", {})["deleted"] == 0
    finally:
        server.shutdown()
        server.server_close()
        manager.close()
        thread.join(2)


def test_unresolved_workflow_is_logged_without_flooding_history(service):
    bad = graph()
    bad["nodes"][1] = {
        "id": "filter",
        "type": "subflow",
        "x": 200,
        "y": 0,
        "params": {"subflow_id": "missing", "version": 1, "arguments": {}},
    }
    service._graphs[bad["id"]] = bad
    for sequence in range(5):
        service.manager.cv["sequence"] = sequence
        service._tick(sequence)
    assert service.history.flush()
    runs = service.history.list(state="error")["runs"]
    assert len(runs) == 1
    assert service.history_detail(runs[0]["id"])["nodes"][0]["type"] == "workflow"


def test_replay_preserves_recorded_detector_binding_failure(service):
    service.history.configure({**service.history.settings(), "mode": "diagnostic"})
    raw = graph()
    raw["enabled"] = False
    raw["nodes"][0]["params"] = {"engine": "insightface", "detector": "scrfd-500mf"}
    service.manager.cv["engine"] = "insightface"
    service.detector_catalog.resolve = lambda _ident: "/missing/detector.onnx"
    service._model_matches = lambda *_args: False
    service._evaluate(raw, "cam", service.manager.cv, 1)
    assert service.history.flush()
    original = service.history_detail(service.history.list()["runs"][0]["id"])
    assert original["nodes"][0]["output_count"] == 0
    replay = service.replay_history(original["id"])["run"]
    assert replay["nodes"][0]["output_count"] == 0
