import json
import threading

import pytest

from spyder_cctv.workflow import WorkflowService


def graph(*, enabled=True, camera_ids=None, nodes=None, edges=None):
    return {
        "id": "people",
        "name": "People",
        "enabled": enabled,
        "camera_ids": ["cam1"] if camera_ids is None else camera_ids,
        "nodes": nodes
        if nodes is not None
        else [
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {"id": "event", "type": "event", "x": 1, "y": 0, "params": {"message": "Person seen"}},
        ],
        "edges": edges if edges is not None else [{"from": "detect", "to": "event"}],
    }


class Manager:
    def __init__(self):
        self.worker = object()
        self.capture_session = "session-1"
        self.cv = {
            "state": "ready",
            "engine": "opencv",
            "sequence": 1,
            "result_age_seconds": 0.1,
            "frame_size": [100, 100],
            "detections": [{"label": "person", "confidence": 0.8, "bbox": [10, 10, 30, 30]}],
        }
        self.vision_calls = []

    def set_vision(self, camera_id, settings):
        self.vision_calls.append((camera_id, settings))
        worker = self.workers.get(camera_id)
        if worker is not None and hasattr(worker, "config"):
            worker.config.vision = settings
        return {}

    @property
    def workers(self):
        return {"cam1": self.worker}

    def statuses(self):
        return [
            {
                "id": "cam1",
                "state": "running",
                "capture_session": self.capture_session,
                "metadata": {"cv": self.cv},
            }
        ]


class Recorder:
    def __init__(self):
        self.calls = []
        self.current = {"state": "idle", "camera_ids": []}

    def capture(self, ids):
        self.calls.append(("capture", list(ids)))

    def status(self):
        return dict(self.current)

    def start(self, ids):
        self.calls.append(("start", list(ids)))
        self.current = {"state": "recording", "camera_ids": list(ids)}

    def select(self, ids):
        self.calls.append(("select", list(ids)))
        self.current["camera_ids"] = list(ids)


@pytest.fixture
def service(tmp_path):
    instance = WorkflowService(Manager(), Recorder(), tmp_path)
    # These tests advance inference explicitly; avoid a background tick racing setup.
    instance._stop.set()
    instance._thread.join(timeout=2)
    yield instance
    instance.close()


def test_validates_persists_and_loads_normalized_graph(service, tmp_path):
    saved = service.save(graph())
    assert saved["nodes"][0]["params"] == {"engine": "any"}
    assert json.loads((tmp_path / "workflows.json").read_text())["workflows"][0]["id"] == "people"
    reloaded = WorkflowService(service.manager, service.recorder, tmp_path)
    try:
        assert reloaded.list()["workflows"] == [saved]
    finally:
        reloaded.close()


def test_model_references_include_disabled_workflow_nodes(service):
    saved = graph(
        enabled=False,
        nodes=[
            {
                "id": "model-node",
                "type": "model",
                "x": 0,
                "y": 0,
                "params": {"model_id": "a" * 32},
            },
            {
                "id": "classifier-node",
                "type": "classifier",
                "x": 1,
                "y": 0,
                "params": {"model_id": "b" * 32},
            },
        ],
        edges=[],
    )
    service.save(saved)

    assert service.model_references("a" * 32) == ["Workflow People / node model-node"]
    assert service.model_references("b" * 32) == ["Workflow People / node classifier-node"]


def test_model_references_include_latest_persisted_workflows_and_fail_closed(service, tmp_path):
    graph_with_model = graph(
        enabled=False,
        nodes=[
            {
                "id": "model-node",
                "type": "model",
                "x": 0,
                "y": 0,
                "params": {"model_id": "c" * 32},
            }
        ],
        edges=[],
    )
    other = WorkflowService(service.manager, service.recorder, tmp_path)
    other._stop.set()
    other._thread.join(timeout=2)
    try:
        service.save(graph_with_model)
        assert other.model_references("c" * 32) == ["Workflow People / node model-node"]
        (tmp_path / "workflows.json").write_text("{broken", encoding="utf-8")
        with pytest.raises(RuntimeError, match="unreadable"):
            other.model_references("c" * 32)
    finally:
        other.close()


def test_bindings_validate_upstream_type_and_round_trip(service, tmp_path):
    g = graph(
        nodes=[
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {
                "id": "filter",
                "type": "filter",
                "x": 1,
                "y": 0,
                "params": {},
                "bindings": {"label": {"node": "detect", "signal": "labels"}},
            },
        ],
        edges=[{"from": "detect", "to": "filter"}],
    )
    saved = service.save(g)
    assert saved["nodes"][1]["bindings"] == g["nodes"][1]["bindings"]
    loaded = WorkflowService(service.manager, service.recorder, tmp_path)
    try:
        assert loaded.list()["workflows"] == [saved]
    finally:
        loaded.close()


@pytest.mark.parametrize(
    "binding,edges",
    [
        ({"label": {"node": "missing", "signal": "labels"}}, [{"from": "detect", "to": "filter"}]),
        (
            {"confidence": {"node": "detect", "signal": "labels"}},
            [{"from": "detect", "to": "filter"}],
        ),
        ({"label": {"node": "other", "signal": "labels"}}, [{"from": "detect", "to": "filter"}]),
    ],
)
def test_binding_rejects_dangling_incompatible_or_disconnected_sources(service, binding, edges):
    g = graph(
        nodes=[
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {"id": "other", "type": "detections", "x": 0, "y": 1, "params": {}},
            {"id": "filter", "type": "filter", "x": 1, "y": 0, "params": {}, "bindings": binding},
        ],
        edges=edges,
    )
    with pytest.raises(ValueError):
        service.save(g)


def test_bound_filter_uses_live_upstream_output_and_fails_closed(service):
    g = graph(
        nodes=[
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {"id": "source", "type": "filter", "x": 1, "y": 0, "params": {"label": "person"}},
            {
                "id": "target",
                "type": "filter",
                "x": 2,
                "y": 0,
                "params": {},
                "bindings": {"label": {"node": "source", "signal": "labels"}},
            },
            {"id": "event", "type": "event", "x": 3, "y": 0, "params": {"message": "hit"}},
        ],
        edges=[
            {"from": "detect", "to": "source"},
            {"from": "source", "to": "target"},
            {"from": "target", "to": "event"},
        ],
    )
    g = service.save(g)
    service._evaluate(g, "cam1", service.manager.cv, 1.0)
    assert len(service.list()["events"]) == 1
    service._events.clear()
    service.manager.cv["detections"] = []
    service.manager.cv["sequence"] = 2
    service._evaluate(g, "cam1", service.manager.cv, 2.0)
    assert service.list()["events"] == []


def test_bound_values_are_evaluated_separately_for_each_camera(service):
    from spyder_cctv.workflow import _validate_graph

    g = _validate_graph(
        graph(
            camera_ids=["cam1", "cam2"],
            nodes=[
                {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
                {
                    "id": "event",
                    "type": "event",
                    "x": 1,
                    "y": 0,
                    "params": {"message": "fallback"},
                    "bindings": {"message": {"node": "detect", "signal": "labels"}},
                },
            ],
            edges=[{"from": "detect", "to": "event"}],
        )
    )
    for camera_id, label in (("cam1", "person"), ("cam2", "car")):
        cv = {**service.manager.cv, "detections": [{"label": label, "confidence": 0.8}]}
        service._evaluate(g, camera_id, cv, 10.0)
    assert [event["message"] for event in service.list()["events"]] == ["person", "car"]


def test_bound_string_array_rules_use_membership_operators():
    from spyder_cctv.workflow import WorkflowService

    detection = {"label": "person"}
    assert WorkflowService._matches_rules(
        detection, [{"field": "label", "operator": "eq", "value": ["person", "car"]}], "all"
    )
    assert WorkflowService._matches_rules(
        detection, [{"field": "label", "operator": "neq", "value": ["car"]}], "all"
    )


def test_bound_model_classes_are_loaded_live_each_evaluation(service):
    model = {
        "id": "person",
        "engine": "opencv",
        "path": None,
        "classes": ["person"],
        "settings": {},
    }
    service.model_library = type("Library", (), {"get": lambda _self, _key: model})()
    service._model_matches = lambda *_args: True
    g = graph(
        nodes=[
            {"id": "camera", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam1"}},
            {"id": "model", "type": "model", "x": 0, "y": 1, "params": {"model_id": "person"}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
            {
                "id": "filter",
                "type": "filter",
                "x": 2,
                "y": 0,
                "params": {},
                "bindings": {"label": {"node": "model", "signal": "classes"}},
            },
            {"id": "event", "type": "event", "x": 3, "y": 0, "params": {"message": "hit"}},
        ],
        edges=[
            {"from": "camera", "to": "detect", "input": "camera"},
            {"from": "model", "to": "detect", "input": "model"},
            {"from": "detect", "to": "filter"},
            {"from": "filter", "to": "event"},
        ],
    )
    from spyder_cctv.workflow import _validate_graph

    g = _validate_graph(g)
    service._evaluate(g, "cam1", service.manager.cv, 1.0)
    assert len(service.list()["events"]) == 1
    service._events.clear()
    model["classes"] = ["car"]
    service._evaluate(g, "cam1", service.manager.cv, 2.0)
    assert service.list()["events"] == []

    # Binding the Detections schema must also follow model metadata, not stale CV labels.
    g["nodes"][3]["bindings"]["label"]["node"] = "detect"
    model["classes"] = ["person"]
    service.manager.cv["classes"] = ["stale-runtime-label"]
    service._evaluate(g, "cam1", service.manager.cv, 3.0)
    assert len(service.list()["events"]) == 1
    service._events.clear()
    model["classes"] = []
    service._evaluate(g, "cam1", service.manager.cv, 4.0)
    assert service.list()["events"] == []


def test_missing_bound_cooldown_does_not_consume_interval(service):
    from spyder_cctv.workflow import _validate_graph

    g = _validate_graph(
        graph(
            nodes=[
                {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
                {"id": "empty", "type": "filter", "x": 1, "y": 0, "params": {"label": "car"}},
                {
                    "id": "cooldown",
                    "type": "cooldown",
                    "x": 2,
                    "y": 0,
                    "params": {"seconds": 10},
                    "bindings": {"seconds": {"node": "empty", "signal": "count"}},
                },
                {"id": "event", "type": "event", "x": 3, "y": 0, "params": {"message": "hit"}},
            ],
            edges=[
                {"from": "detect", "to": "empty"},
                {"from": "empty", "to": "cooldown"},
                {"from": "detect", "to": "cooldown"},
                {"from": "cooldown", "to": "event"},
            ],
        )
    )
    service._evaluate(g, "cam1", service.manager.cv, 1.0)
    assert service.list()["events"] == []
    assert service._cooldowns == {}
    g["nodes"][1]["params"]["label"] = "person"
    service._evaluate(g, "cam1", service.manager.cv, 1.1)
    assert len(service.list()["events"]) == 1


def test_inactive_camera_node_does_not_emit_another_cameras_signals(service):
    from spyder_cctv.workflow import _validate_graph

    g = _validate_graph(
        graph(
            camera_ids=["cam1", "cam2"],
            nodes=[
                {
                    "id": "cam-one",
                    "type": "camera",
                    "x": 0,
                    "y": 0,
                    "params": {"camera_id": "cam1"},
                },
                {
                    "id": "cam-two",
                    "type": "camera",
                    "x": 0,
                    "y": 1,
                    "params": {"camera_id": "cam2"},
                },
                {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
                {
                    "id": "event",
                    "type": "event",
                    "x": 2,
                    "y": 0,
                    "params": {"message": "fallback"},
                    "bindings": {"message": {"node": "cam-one", "signal": "camera_id"}},
                },
            ],
            edges=[
                {"from": "cam-one", "to": "detect", "input": "camera"},
                {"from": "cam-two", "to": "detect", "input": "camera"},
                {"from": "detect", "to": "event"},
            ],
        )
    )
    service._evaluate(g, "cam2", service.manager.cv, 1.0)
    assert service.list()["events"] == []
    service._evaluate(g, "cam1", service.manager.cv, 2.0)
    assert service.list()["events"][0]["message"] == "cam1"


@pytest.mark.parametrize(
    "change",
    [
        lambda g: g.update(extra=1),
        lambda g: g["nodes"].append(
            {"id": "z", "type": "capture", "x": 0, "y": 0, "params": {"url": "https://x"}}
        ),
        lambda g: g["edges"].append({"from": "event", "to": "detect"}),
        lambda g: g["edges"].append({"from": "missing", "to": "event"}),
    ],
)
def test_rejects_invalid_graphs_without_persisting(service, change):
    invalid = graph()
    change(invalid)
    with pytest.raises(ValueError):
        service.save(invalid)
    assert service.list()["workflows"] == []


def test_only_fresh_ready_status_and_new_sequence_triggers_once(service):
    service.save(graph())
    service._tick()
    service._tick()
    assert len(service.list()["events"]) == 1
    service.manager.cv["sequence"] = 2
    service.manager.cv["result_age_seconds"] = 2.1
    service._tick()
    assert len(service.list()["events"]) == 1
    service.manager.cv.update(sequence=3, result_age_seconds=0.1, state="error")
    service._tick()
    assert len(service.list()["events"]) == 1


@pytest.mark.parametrize(
    "params",
    [
        {"title": "", "message": "ok"},
        {"title": " ", "message": "ok"},
        {"title": "x" * 129, "message": "ok"},
        {"title": "ok", "message": ""},
        {"title": "ok", "message": " "},
        {"title": "ok", "message": "x" * 501},
    ],
)
def test_notification_rejects_invalid_title_or_message(service, params):
    g = graph(
        nodes=[
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {"id": "notify", "type": "notification", "x": 1, "y": 0, "params": params},
        ],
        edges=[{"from": "detect", "to": "notify"}],
    )
    with pytest.raises(ValueError, match="notification (title|message)"):
        service.save(g)


def test_notification_catalog_defaults_and_matching_insightface_detection(service):
    from types import SimpleNamespace

    service.manager.worker = SimpleNamespace(
        config=SimpleNamespace(pipeline="vision", vision={"engine": "insightface"})
    )
    service.manager.cv.update(
        engine="insightface",
        detections=[{"label": "face", "confidence": 0.93, "identity": "Alice"}],
    )
    g = graph(
        nodes=[
            {
                "id": "detect",
                "type": "detections",
                "x": 0,
                "y": 0,
                "params": {"engine": "insightface"},
            },
            {
                "id": "filter",
                "type": "filter",
                "x": 1,
                "y": 0,
                "params": {"label": "face", "confidence": 0.9, "identity": "Alice"},
            },
            {"id": "notify", "type": "notification", "x": 2, "y": 0, "params": {}},
        ],
        edges=[{"from": "detect", "to": "filter"}, {"from": "filter", "to": "notify"}],
    )
    saved = service.save(g)
    assert saved["nodes"][-1]["params"] == {
        "title": "SpyDER detection",
        "message": "Matching face detected",
    }
    assert next(item for item in service.catalog() if item["type"] == "notification")["params"]
    service._tick(now=123.0)
    result = service.notifications()
    assert len(result["notifications"]) == 1
    event = result["notifications"][0]
    assert event["kind"] == "notification"
    assert event["id"]
    assert event["title"] == "SpyDER detection"
    assert event["message"] == "Matching face detected"
    assert event["workflow_id"] == "people"
    assert event["workflow_name"] == "People"
    assert event["camera_id"] == "cam1"
    assert isinstance(event["created_at"], float)


def test_notification_needs_fresh_enabled_matching_detection(service):
    from types import SimpleNamespace

    service.manager.worker = SimpleNamespace(
        config=SimpleNamespace(pipeline="vision", vision={"engine": "insightface"})
    )
    g = graph(
        nodes=[
            {
                "id": "detect",
                "type": "detections",
                "x": 0,
                "y": 0,
                "params": {"engine": "insightface"},
            },
            {"id": "filter", "type": "filter", "x": 1, "y": 0, "params": {"identity": "Alice"}},
            {"id": "notify", "type": "notification", "x": 2, "y": 0, "params": {}},
        ],
        edges=[{"from": "detect", "to": "filter"}, {"from": "filter", "to": "notify"}],
    )
    service.manager.cv.update(
        engine="insightface", detections=[{"label": "face", "identity": "Bob"}]
    )
    service.save(g)
    service._tick(now=10)
    assert service.notifications()["notifications"] == []
    service.manager.cv["detections"] = [{"label": "face", "identity": "Alice"}]
    service.manager.cv["sequence"] = 2
    service.manager.cv["result_age_seconds"] = 2.1
    service._tick(now=11)
    assert service.notifications()["notifications"] == []
    service.manager.cv.update(sequence=3, result_age_seconds=0.1)
    service._tick(now=12)
    assert len(service.notifications()["notifications"]) == 1
    g["enabled"] = False
    service.save(g)
    service.manager.cv["sequence"] = 4
    service._tick(now=13)
    assert len(service.notifications()["notifications"]) == 1


def test_notification_cooldown_and_unique_ids_ignore_fake_clock(service, monkeypatch):
    from types import SimpleNamespace

    service.manager.worker = SimpleNamespace(
        config=SimpleNamespace(pipeline="vision", vision={"engine": "insightface"})
    )
    import spyder_cctv.workflow as workflow_module

    monkeypatch.setattr(workflow_module.time, "time", lambda: 50.0)
    g = graph(
        nodes=[
            {
                "id": "detect",
                "type": "detections",
                "x": 0,
                "y": 0,
                "params": {"engine": "insightface"},
            },
            {"id": "cool", "type": "cooldown", "x": 1, "y": 0, "params": {"seconds": 10}},
            {"id": "notify", "type": "notification", "x": 2, "y": 0, "params": {}},
        ],
        edges=[{"from": "detect", "to": "cool"}, {"from": "cool", "to": "notify"}],
    )
    service.manager.cv["engine"] = "insightface"
    g = service.save(g)
    service._evaluate(g, "cam1", service.manager.cv, 10)
    service._evaluate(g, "cam1", service.manager.cv, 19.99)
    service._evaluate(g, "cam1", service.manager.cv, 20)
    events = service.notifications()["notifications"]
    assert len(events) == 2
    assert events[0]["id"] != events[1]["id"]
    assert events[0]["created_at"] == events[1]["created_at"] == 50.0


def test_notifications_returns_copies_and_only_notification_events(service):
    service.save(graph())
    service._tick(now=10)
    service._act("notification", {"title": "T", "message": "M"}, "people", "cam1")
    result = service.notifications()
    assert len(result["notifications"]) == 1
    result["notifications"][0]["message"] = "mutated"
    assert service.notifications()["notifications"][0]["message"] == "M"
    assert service.list()["events"][0]["message"] == "Person seen"
    restarted = WorkflowService(service.manager, service.recorder, service.storage_dir)
    try:
        assert restarted.notifications()["notifications"] == []
        assert restarted.notifications()["session_id"] != result["session_id"]
    finally:
        restarted.close()


def test_disabled_graph_and_action_rate_limit(service):
    g = graph(enabled=False)
    g = service.save(g)
    service._tick()
    assert service.list()["events"] == []
    g["enabled"] = True
    g = service.save(g)
    cv = service.manager.cv
    service._evaluate(g, "cam1", cv, 10)
    service._evaluate(g, "cam1", cv, 10.5)
    service._evaluate(g, "cam1", cv, 11.01)
    assert len(service.list()["events"]) == 2


def test_multiple_sinks_and_graphs_fire_once_for_same_fresh_result(service):
    first = graph()
    first["nodes"].append({"id": "capture", "type": "capture", "x": 2, "y": 0, "params": {}})
    first["edges"].append({"from": "detect", "to": "capture"})
    service.save(first)
    second = graph()
    second["id"] = "people2"
    service.save(second)
    service._tick()
    service._tick()
    assert len(service.list()["events"]) == 2
    assert service.recorder.calls == [("capture", ["cam1"])]


def test_camera_session_restart_replays_current_fresh_sequence_but_pause_does_not(service):
    service.save(graph())
    service._tick(now=10.0)
    service._tick(now=10.1)
    service.manager.cv["sequence"] = 2
    service._tick(now=10.2)
    assert len(service.list()["events"]) == 1
    service.manager.statuses = lambda: [
        {
            "id": "cam1",
            "state": "paused",
            "capture_session": service.manager.capture_session,
            "metadata": {"cv": service.manager.cv},
        }
    ]
    service._tick(now=10.3)
    service.manager.statuses = lambda: [
        {
            "id": "cam1",
            "state": "running",
            "capture_session": service.manager.capture_session,
            "metadata": {"cv": service.manager.cv},
        }
    ]
    service._tick(now=10.4)
    assert len(service.list()["events"]) == 1
    service.manager.capture_session = "session-2"
    service._tick(now=10.5)
    assert len(service.list()["events"]) == 2


def test_failed_save_rolls_back_memory(service, monkeypatch):
    prior = service.save(graph())
    monkeypatch.setattr(service, "_persist", lambda: (_ for _ in ()).throw(OSError("disk full")))
    changed = graph()
    changed["name"] = "Changed"
    with pytest.raises(OSError):
        service.save(changed)
    assert service.list()["workflows"] == [prior]


def test_corrupt_storage_reports_error_without_replacing_file(tmp_path):
    path = tmp_path / "workflows.json"
    path.write_text("{bad json")
    instance = WorkflowService(Manager(), Recorder(), tmp_path)
    try:
        assert instance.list()["storage_error"]
        with pytest.raises(RuntimeError):
            instance.save(graph())
        assert path.read_text() == "{bad json"
    finally:
        instance.close()


def test_disable_and_remove_release_only_owned_recording_membership(service):
    recorder = service.recorder
    recorder.current = {"state": "recording", "camera_ids": ["human"]}
    service._record("start", "people", "cam1")
    graph_data = graph(enabled=True)
    service.save(graph_data)
    graph_data["enabled"] = False
    service.save(graph_data)
    assert recorder.calls[-1] == ("select", ["human"])
    graph_data["enabled"] = True
    service.save(graph_data)
    recorder.current["camera_ids"] = ["human", "cam1"]
    service._record_owned["cam1"] = {"people"}
    service.remove("people")
    assert recorder.calls[-1] == ("select", ["human"])


def test_code_node_transforms_detections_before_event(service):
    g = graph(
        nodes=[
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {
                "id": "code",
                "type": "code",
                "x": 1,
                "y": 0,
                "params": {
                    "language": "python",
                    "source": "output = [d for d in detections if d.get('label') == 'person']",
                },
            },
            {"id": "event", "type": "event", "x": 2, "y": 0, "params": {"message": "person"}},
        ],
        edges=[{"from": "detect", "to": "code"}, {"from": "code", "to": "event"}],
    )
    saved = service.save(g)
    assert saved["nodes"][1]["params"]["language"] == "python"
    service._tick()
    assert len(service.list()["events"]) == 1


def test_code_node_compiles_at_save_and_reports_bounded_runtime_error(service):
    g = graph(
        nodes=[
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {
                "id": "code",
                "type": "code",
                "x": 1,
                "y": 0,
                "params": {"source": "output = [{'label': 'bad', 'extra': 1}]"},
            },
            {"id": "event", "type": "event", "x": 2, "y": 0, "params": {"message": "bad"}},
        ],
        edges=[{"from": "detect", "to": "code"}, {"from": "code", "to": "event"}],
    )
    service.save(g)
    service._tick()
    assert service.list()["events"] == []
    error = service.list()["errors"][-1]
    assert error["node_id"] == "code"
    assert "known detection fields" in error["message"]
    g["nodes"][1]["params"]["source"] = "import os"
    with pytest.raises(ValueError, match="Unsupported"):
        service.save(g)


def test_code_node_defaults_and_catalog(service):
    g = graph(
        nodes=[{"id": "code", "type": "code", "x": 0, "y": 0, "params": {}}],
        edges=[],
    )
    saved = service.save(g)
    assert saved["nodes"][0]["params"] == {
        "language": "python",
        "source": "output = detections",
    }
    assert any(item["type"] == "code" for item in service.list()["catalog"])


def test_detection_catalog_exposes_data_input(service):
    node = next(item for item in service.list()["catalog"] if item["type"] == "detections")
    assert node["inputs"] == ["camera", "model", "classifier", "detections"]


def test_preview_node_returns_fresh_branch_without_running_actions(service):
    g = graph(
        nodes=[
            {"id": "camera", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam1"}},
            {"id": "detect", "type": "detections", "x": 100, "y": 0, "params": {}},
            {"id": "filter", "type": "filter", "x": 200, "y": 0, "params": {"label": "person"}},
            {"id": "cool", "type": "cooldown", "x": 300, "y": 0, "params": {}},
            {"id": "preview", "type": "preview", "x": 400, "y": 0, "params": {}},
            {"id": "event", "type": "event", "x": 300, "y": 100, "params": {"message": "seen"}},
        ],
        edges=[
            {"from": "camera", "to": "detect", "input": "camera"},
            {"from": "detect", "to": "filter"},
            {"from": "filter", "to": "cool"},
            {"from": "cool", "to": "preview"},
            {"from": "filter", "to": "event"},
        ],
    )
    result = service.preview(g, "preview")
    assert result == {
        "camera_id": "cam1",
        "frame_url": "/api/cameras/cam1/preview-frame",
        "detections": service.manager.cv["detections"],
        "frame_size": [100, 100],
        "engine": "opencv",
        "state": "running",
        "message": "1 detection(s)",
        "sequence": 1,
        "generation": None,
    }
    assert service.list()["events"] == []
    assert service.recorder.calls == []
    assert service._cooldowns == {}


def test_preview_node_can_read_camera_directly_and_suppresses_stale_results(service):
    g = graph(
        nodes=[
            {"id": "camera", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam1"}},
            {"id": "preview", "type": "preview", "x": 100, "y": 0, "params": {}},
        ],
        edges=[{"from": "camera", "to": "preview", "input": "camera"}],
    )
    assert service.preview(g, "preview")["detections"] == service.manager.cv["detections"]
    service.manager.cv["result_age_seconds"] = 2.1
    stale = service.preview(g, "preview")
    assert stale["state"] == "running"
    assert stale["detections"] == []
    with pytest.raises(ValueError, match="not connected"):
        service.preview(g, "preview", "other")


def test_preview_evaluates_only_requested_branch_and_preserves_cooldown(service, monkeypatch):
    import time

    import spyder_cctv.workflow as workflow_module

    g = graph(
        nodes=[
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {"id": "cool", "type": "cooldown", "x": 100, "y": 0, "params": {"seconds": 60}},
            {"id": "preview", "type": "preview", "x": 200, "y": 0, "params": {}},
            {"id": "code", "type": "code", "x": 100, "y": 100, "params": {}},
        ],
        edges=[
            {"from": "detect", "to": "cool"},
            {"from": "cool", "to": "preview"},
            {"from": "detect", "to": "code"},
        ],
    )

    def unexpected_code(*args, **kwargs):
        pytest.fail("Unrelated Code node executed during preview")

    monkeypatch.setattr(workflow_module, "run_code", unexpected_code)
    key = ("people", "cam1", "cool")
    service._cooldowns[key] = time.monotonic()
    before = dict(service._cooldowns)
    assert service.preview(g, "preview")["detections"] == []
    assert service._cooldowns == before
    service._cooldowns.clear()
    assert service.preview(g, "preview")["detections"] == service.manager.cv["detections"]
    assert service._cooldowns == {}


def test_preview_camera_provenance_and_terminal_validation(service):
    g = graph(
        nodes=[
            {"id": "camera", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": ""}},
            {"id": "preview", "type": "preview", "x": 100, "y": 0, "params": {}},
            {"id": "event", "type": "event", "x": 200, "y": 0, "params": {"message": "Seen"}},
        ],
        edges=[{"from": "camera", "to": "preview", "input": "camera"}],
    )
    with pytest.raises(ValueError, match="not connected"):
        service.preview(g, "preview", "cam1")
    g["nodes"][0]["params"]["camera_id"] = "cam1"
    saved = service.save({**g, "enabled": False})
    assert next(n for n in saved["nodes"] if n["id"] == "preview")["params"] == {}
    g["edges"].append({"from": "preview", "to": "event"})
    with pytest.raises(ValueError):
        service.preview(g, "preview")


def test_detections_data_input_preserves_upstream_filtering(service):
    g = graph(
        nodes=[
            {"id": "source", "type": "detections", "x": 0, "y": 0, "params": {}},
            {"id": "filter", "type": "filter", "x": 1, "y": 0, "params": {"label": "car"}},
            {"id": "detect2", "type": "detections", "x": 2, "y": 0, "params": {}},
            {"id": "event", "type": "event", "x": 3, "y": 0, "params": {"message": "seen"}},
        ],
        edges=[
            {"from": "source", "to": "filter"},
            {"from": "filter", "to": "detect2", "input": "detections"},
            {"from": "detect2", "to": "event"},
        ],
    )
    service.save(g)
    service._tick()
    assert service.list()["events"] == []


def test_graph_coordinates_are_bounded(service):
    invalid = graph()
    invalid["nodes"][0]["x"] = 5001
    with pytest.raises(ValueError):
        service.save(invalid)


def test_corrupt_and_oversized_storage_is_not_replaced(tmp_path):
    path = tmp_path / "workflows.json"
    path.write_text("{bad json")
    instance = WorkflowService(Manager(), Recorder(), tmp_path)
    assert instance.list()["storage_error"]
    instance.close()
    assert path.read_text() == "{bad json"
    path.write_bytes(b"x" * (2 * 1024 * 1024 + 1))
    instance = WorkflowService(Manager(), Recorder(), tmp_path)
    assert instance.list()["storage_error"]
    instance.close()


def test_recording_stop_removes_only_workflow_owned_camera(service):
    recorder = service.recorder
    recorder.current = {"state": "recording", "camera_ids": ["human"]}
    service._record("start", "people", "cam1")
    assert recorder.calls[-1] == ("select", ["human", "cam1"])
    service._record("stop", "people", "cam1")
    assert recorder.calls[-1] == ("select", ["human"])
    service._record("stop", "people", "human")
    assert recorder.calls[-1] == ("select", ["human"])


def test_record_start_does_not_claim_preexisting_human_membership(service):
    service.recorder.current = {"state": "recording", "camera_ids": ["cam1"]}
    service._record("start", "people", "cam1")
    service._record("stop", "people", "cam1")
    assert service._record_owned == {}
    assert service.recorder.current["camera_ids"] == ["cam1"]
    assert service.recorder.calls == []


def test_none_detection_confidence_is_zero_and_filter_remains_safe(service):
    current = graph(
        nodes=[
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {"id": "filter", "type": "filter", "x": 1, "y": 0, "params": {"confidence": 0}},
            {"id": "event", "type": "event", "x": 2, "y": 0, "params": {"message": "Seen"}},
        ],
        edges=[{"from": "detect", "to": "filter"}, {"from": "filter", "to": "event"}],
    )
    service.save(current)
    service.manager.cv["detections"][0]["confidence"] = None
    service._tick()
    assert len(service.list()["events"]) == 1


def test_action_failures_are_visible_and_bounded(service):
    service.recorder.capture = lambda _ids: (_ for _ in ()).throw(
        RuntimeError("private error detail")
    )
    service._act("capture", {}, "people", "cam1")
    errors = service.list()["errors"]
    assert errors == [
        {
            "workflow_id": "people",
            "camera_id": "cam1",
            "action": "capture",
            "message": "Action failed",
        }
    ]


def test_remove_clears_workflow_runtime_counters(service):
    service.save(graph())
    service._last_action[("people", "cam1", "event")] = 2.0
    service._cooldowns[("people", "cam1", "cool")] = 3.0
    service._runtime["people"] = {"state": "enabled"}
    service.remove("people")
    assert service._last_action == {}
    assert service._cooldowns == {}
    assert "people" not in service._runtime


def test_manual_handover_relinquishes_workflow_owned_camera(service):
    service.recorder.current = {"state": "recording", "camera_ids": []}
    service._record("start", "people", "cam1")
    assert service._record_owned == {"cam1": {"people"}}
    # Human calls recorder.select(["cam1"]), then transfers ownership.
    service.relinquish_recording(["cam1"])
    service._record("stop", "people", "cam1")
    assert service.recorder.current["camera_ids"] == ["cam1"]
    assert service._record_owned == {}


def test_global_action_budget_caps_sinks_at_twenty_per_second(service):
    accepted = [service._action_allowed("graph", f"cam{i}", "sink", 10.0) for i in range(25)]
    assert sum(accepted) == 20
    assert service._action_allowed("graph", "cam0", "sink", 11.0)


def test_disable_waits_for_inflight_tick_then_prevents_later_action(service):
    service._stop.set()
    g = graph(
        nodes=[
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {"id": "capture", "type": "capture", "x": 1, "y": 0, "params": {}},
        ],
        edges=[{"from": "detect", "to": "capture"}],
    )
    service.save(g)
    entered, release, disabled = threading.Event(), threading.Event(), threading.Event()
    calls = []

    def blocked_capture(ids):
        entered.set()
        assert release.wait(2)
        calls.append(list(ids))

    service.recorder.capture = blocked_capture
    tick_thread = threading.Thread(target=service._tick, kwargs={"now": 10})
    tick_thread.start()
    assert entered.wait(1)
    g["enabled"] = False
    save_thread = threading.Thread(target=lambda: (service.save(g), disabled.set()))
    save_thread.start()
    assert not disabled.wait(0.05)
    release.set()
    tick_thread.join(1)
    save_thread.join(1)
    assert disabled.is_set()
    service.manager.cv["sequence"] = 2
    service._tick(now=12)
    assert calls == [["cam1"]]


def test_manual_select_handover_serializes_with_workflow_record_action(service):
    service._stop.set()
    service.recorder.current = {"state": "recording", "camera_ids": ["human"]}
    g = graph(
        nodes=[
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {"id": "record", "type": "record", "x": 1, "y": 0, "params": {"action": "start"}},
        ],
        edges=[{"from": "detect", "to": "record"}],
    )
    service.save(g)
    entered, release, manual_done = threading.Event(), threading.Event(), threading.Event()
    original_select = service.recorder.select

    def blocked_select(ids):
        result = original_select(ids)
        entered.set()
        assert release.wait(2)
        return result

    service.recorder.select = blocked_select
    tick_thread = threading.Thread(target=service._tick, kwargs={"now": 10})
    tick_thread.start()
    assert entered.wait(1)
    manual_thread = threading.Thread(
        target=lambda: (service.manual_recording("select", ["cam1"]), manual_done.set())
    )
    manual_thread.start()
    assert not manual_done.wait(0.05)
    release.set()
    tick_thread.join(1)
    manual_thread.join(1)
    assert manual_done.is_set()
    service.recorder.select = original_select
    g["nodes"][1]["params"]["action"] = "stop"
    service.save(g)
    service.manager.cv["sequence"] = 2
    service._tick(now=12)
    assert service.recorder.current["camera_ids"] == ["cam1"]


def test_windows_sharing_lock_retries_atomic_workflow_save(service, monkeypatch):
    import spyder_cctv.workflow as module

    real_replace = module.os.replace
    calls = []

    def briefly_locked(source, target):
        calls.append((source, target))
        if len(calls) == 1:
            error = PermissionError("file is busy")
            error.winerror = 32
            raise error
        return real_replace(source, target)

    monkeypatch.setattr(module.os, "replace", briefly_locked)
    monkeypatch.setattr(module.time, "sleep", lambda seconds: None)
    service.save(graph())
    assert len(calls) >= 2
    assert service.list()["workflows"][0]["id"] == "people"


def test_permission_denial_is_not_retried_and_preserves_graph(service, monkeypatch):
    import spyder_cctv.workflow as module

    service.save(graph())
    original = service.list()["workflows"]
    calls = []

    def denied(source, target):
        calls.append((source, target))
        raise PermissionError("access denied")

    monkeypatch.setattr(module.os, "replace", denied)
    with pytest.raises(PermissionError):
        service.save({**graph(), "name": "Changed"})
    assert len(calls) == 1
    assert service.list()["workflows"] == original


def test_tick_reads_camera_state_after_acquiring_workflow_lock(service):
    entered = threading.Event()
    original_statuses = service.manager.statuses

    def statuses():
        entered.set()
        return original_statuses()

    service.manager.statuses = statuses
    with service._lock:
        tick = threading.Thread(target=service._tick)
        tick.start()
        assert not entered.wait(0.05)
    tick.join(2)
    assert entered.is_set() and not tick.is_alive()


def test_typed_camera_model_sources_and_legacy_edges(service):
    g = graph(
        camera_ids=[],
        nodes=[
            {"id": "cam", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam1"}},
            {"id": "model", "type": "model", "x": 0, "y": 1, "params": {"model_id": "hog"}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
            {"id": "event", "type": "event", "x": 2, "y": 0, "params": {"message": "seen"}},
        ],
        edges=[
            {"from": "cam", "to": "detect", "input": "camera"},
            {"from": "model", "to": "detect", "input": "model"},
            {"from": "detect", "to": "event"},
        ],
    )
    library = type(
        "Library",
        (),
        {
            "get": lambda _self, key: {
                "id": key,
                "engine": "opencv",
                "path": "",
                "classes": [],
                "settings": {},
            }
        },
    )()
    service.model_library = library
    saved = service.save(g)
    assert saved["edges"][-1] == {"from": "detect", "to": "event"}
    assert service.manager.vision_calls == [("cam1", {"engine": "opencv"})]
    service._tick()
    assert len(service.list()["events"]) == 1


def test_camera_source_isolates_camera_and_adds_effective_camera(service):
    g = graph(
        camera_ids=[],
        nodes=[
            {"id": "cam", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam2"}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
            {"id": "event", "type": "event", "x": 2, "y": 0, "params": {"message": "seen"}},
        ],
        edges=[
            {"from": "cam", "to": "detect", "input": "camera"},
            {"from": "detect", "to": "event"},
        ],
    )
    assert WorkflowService._camera_ids(g) == ["cam2"]
    service.save(g)
    service._evaluate(g, "cam1", service.manager.cv, 1)
    assert service.list()["events"] == []


def test_empty_connected_camera_source_does_not_fall_back_to_legacy_ids(service):
    g = graph(
        nodes=[
            {"id": "cam", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": ""}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
        ],
        edges=[{"from": "cam", "to": "detect", "input": "camera"}],
    )
    assert WorkflowService._camera_ids(g) == []
    g["enabled"] = False
    service.save(g)
    g["enabled"] = True
    with pytest.raises(ValueError, match="needs a camera selection"):
        service.save({**g, "enabled": True})


def test_enabled_graph_rejects_empty_connected_model_node(service):
    g = graph(
        nodes=[
            {"id": "model", "type": "model", "x": 0, "y": 0, "params": {"model_id": ""}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
        ],
        edges=[{"from": "model", "to": "detect", "input": "model"}],
    )
    service.save({**g, "enabled": False})
    with pytest.raises(ValueError, match="needs a model selection"):
        service.save(g)


def test_detection_node_rejects_multiple_model_inputs(service):
    g = graph(
        nodes=[
            {"id": "m1", "type": "model", "x": 0, "y": 0, "params": {"model_id": "one"}},
            {"id": "m2", "type": "model", "x": 0, "y": 1, "params": {"model_id": "one"}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
        ],
        edges=[
            {"from": "m1", "to": "detect", "input": "model"},
            {"from": "m2", "to": "detect", "input": "model"},
        ],
    )
    with pytest.raises(ValueError, match="only one model"):
        service.save(g)


@pytest.mark.parametrize(
    "edge",
    [
        {"from": "cam", "to": "event", "input": "camera"},
        {"from": "model", "to": "event", "input": "model"},
        {"from": "detect", "to": "cam", "input": "detections"},
        {"from": "cam", "to": "detect", "input": "model"},
        {"from": "detect", "to": "event", "input": "unknown"},
    ],
)
def test_rejects_invalid_typed_edges(service, edge):
    g = graph(
        nodes=[
            {"id": "cam", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam1"}},
            {"id": "model", "type": "model", "x": 0, "y": 1, "params": {"model_id": "m1"}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
            {"id": "event", "type": "event", "x": 2, "y": 0, "params": {"message": "seen"}},
        ],
        edges=[edge],
    )
    with pytest.raises(ValueError):
        service.save(g)


def test_enabled_graph_rejects_conflicting_model_binding(service):
    library = type(
        "Library",
        (),
        {
            "get": lambda _self, key: {
                "id": key,
                "engine": "opencv",
                "path": "",
                "classes": [],
                "settings": {},
            }
        },
    )()
    service.model_library = library

    def modeled(model_id, graph_id):
        g = graph()
        g["id"] = graph_id
        g["nodes"] = [
            {"id": "camera", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam1"}},
            {"id": "model", "type": "model", "x": 0, "y": 1, "params": {"model_id": model_id}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
        ]
        g["edges"] = [
            {"from": "camera", "to": "detect", "input": "camera"},
            {"from": "model", "to": "detect", "input": "model"},
        ]
        return g

    service.save(modeled("one", "one"))
    with pytest.raises(ValueError, match="Conflicting models target camera cam1"):
        service.save(modeled("two", "two"))
    assert [call[1]["engine"] for call in service.manager.vision_calls] == ["opencv"]


@pytest.mark.parametrize("detection_path,preserves", [("detect.onnx", True), ("other.onnx", False)])
def test_insightface_template_preserves_recognition_only_for_same_detection_model(
    service, detection_path, preserves
):
    from spyder_cctv.cv.contracts import VisionConfig

    service.manager.worker = type(
        "Worker",
        (),
        {
            "config": type(
                "Config",
                (),
                {
                    "vision": VisionConfig(
                        engine="insightface",
                        model="detect.onnx",
                        recognition_model="recognition.onnx",
                        identity_gallery="people.json",
                        recognition_threshold=0.82,
                    )
                },
            )()
        },
    )()
    service.model_library = type(
        "Library",
        (),
        {
            "get": lambda _self, key: {
                "id": key,
                "engine": "insightface",
                "path": detection_path,
                "classes": [],
                "settings": {
                    "recognition_model": None,
                    "identity_gallery": None,
                },
            }
        },
    )()
    g = graph(
        camera_ids=[],
        nodes=[
            {"id": "camera", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam1"}},
            {"id": "model", "type": "model", "x": 0, "y": 1, "params": {"model_id": "face-model"}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
        ],
        edges=[
            {"from": "camera", "to": "detect", "input": "camera"},
            {"from": "model", "to": "detect", "input": "model"},
        ],
    )
    service.save(g)
    active = service.manager.worker.config.vision
    if preserves:
        assert active["recognition_model"] == "recognition.onnx"
        assert active["identity_gallery"] == "people.json"
        assert active["recognition_threshold"] == 0.82
    else:
        assert active["recognition_model"] is None
        assert active["identity_gallery"] is None
        assert active.get("recognition_threshold", 0.65) == 0.65


def test_disabled_model_graph_save_does_not_change_pipeline(service):
    service.model_library = type(
        "Library",
        (),
        {
            "get": lambda _self, key: {
                "id": key,
                "engine": "yolo",
                "path": "weights.pt",
                "classes": [],
                "settings": {},
            }
        },
    )()
    g = graph(
        enabled=False,
        nodes=[
            {"id": "camera", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam1"}},
            {"id": "model", "type": "model", "x": 0, "y": 1, "params": {"model_id": "person"}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
        ],
        edges=[
            {"from": "camera", "to": "detect", "input": "camera"},
            {"from": "model", "to": "detect", "input": "model"},
        ],
    )
    service.save(g)
    assert service.manager.vision_calls == []


def test_failed_model_binding_restores_every_camera_before_return(tmp_path):
    class Worker:
        def __init__(self):
            self.config = type("Config", (), {"vision": {"engine": "opencv"}})()

    class BindingManager:
        def __init__(self):
            self.workers = {"cam1": Worker(), "cam2": Worker()}
            self.calls = []

        def get_worker(self, camera_id):
            return self.workers[camera_id]

        def set_vision(self, camera_id, settings):
            self.calls.append((camera_id, settings))
            if camera_id == "cam2" and settings.get("engine") == "yolo":
                raise ValueError("camera rejected model")
            self.workers[camera_id].config.vision = settings

    manager = BindingManager()
    instance = WorkflowService(
        manager,
        Recorder(),
        tmp_path,
        model_library=type(
            "Library",
            (),
            {
                "get": lambda _self, key: {
                    "id": key,
                    "engine": "yolo",
                    "path": "weights.pt",
                    "classes": [],
                    "settings": {},
                }
            },
        )(),
    )
    try:
        g = graph(
            camera_ids=["cam1", "cam2"],
            nodes=[
                {"id": "model", "type": "model", "x": 0, "y": 0, "params": {"model_id": "person"}},
                {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
            ],
            edges=[{"from": "model", "to": "detect", "input": "model"}],
        )
        with pytest.raises(ValueError, match="camera rejected model"):
            instance.save(g)
        assert manager.workers["cam1"].config.vision == {"engine": "opencv"}
        assert manager.workers["cam2"].config.vision == {"engine": "opencv"}
        assert instance.list()["workflows"] == []
    finally:
        instance.close()


def test_persist_failure_restores_previous_camera_models(service, monkeypatch):
    worker = type(
        "Worker",
        (),
        {"config": type("Config", (), {"pipeline": "motion", "vision": None})()},
    )()
    service.manager.worker = worker
    service.manager.restore_vision = lambda _camera_id, config: setattr(worker, "config", config)
    set_vision = service.manager.set_vision

    def change_pipeline(camera_id, settings):
        result = set_vision(camera_id, settings)
        worker.config.pipeline = "vision"
        return result

    service.manager.set_vision = change_pipeline
    service.model_library = type(
        "Library",
        (),
        {
            "get": lambda _self, key: {
                "id": key,
                "engine": "yolo",
                "path": "weights.pt",
                "classes": [],
                "settings": {},
            }
        },
    )()
    g = graph(
        nodes=[
            {"id": "camera", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam1"}},
            {"id": "model", "type": "model", "x": 0, "y": 1, "params": {"model_id": "person"}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
        ],
        edges=[
            {"from": "camera", "to": "detect", "input": "camera"},
            {"from": "model", "to": "detect", "input": "model"},
        ],
    )
    monkeypatch.setattr(service, "_persist", lambda: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError, match="disk full"):
        service.save(g)
    assert worker.config.pipeline == "motion"
    assert worker.config.vision is None
    assert service.list()["workflows"] == []


def test_filter_rule_matching_any_and_identity_not(service):
    g = graph(
        nodes=[
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {
                "id": "filter",
                "type": "filter",
                "x": 1,
                "y": 0,
                "params": {
                    "match": "any",
                    "rules": [
                        {"field": "identity", "operator": "neq", "value": "intruder"},
                        {"field": "confidence", "operator": "gte", "value": 0.9},
                    ],
                },
            },
            {"id": "event", "type": "event", "x": 2, "y": 0, "params": {"message": "seen"}},
        ],
        edges=[{"from": "detect", "to": "filter"}, {"from": "filter", "to": "event"}],
    )
    service.save(g)
    service.manager.cv["detections"] = [
        {"label": "person", "identity": "friend", "confidence": 0.2},
        {"label": "person", "identity": "intruder", "confidence": 0.2},
    ]
    service._tick()
    assert len(service.list()["events"]) == 1


def test_filter_rule_all_requires_every_rule_and_bounds_string_values(service):
    rules = [
        {"field": "identity", "operator": "neq", "value": "intruder"},
        {"field": "confidence", "operator": "gte", "value": 0.5},
    ]
    assert WorkflowService._matches_rules({"identity": "friend", "confidence": 0.8}, rules, "all")
    assert not WorkflowService._matches_rules(
        {"identity": "friend", "confidence": 0.2}, rules, "all"
    )
    g = graph(
        nodes=[
            {
                "id": "filter",
                "type": "filter",
                "x": 0,
                "y": 0,
                "params": {"rules": [{"field": "label", "operator": "eq", "value": "x" * 129}]},
            }
        ],
        edges=[],
    )
    with pytest.raises(ValueError, match="Invalid string rule value"):
        service.save(g)


def test_class_identity_source_uses_detection_label_for_scalar_and_rules(service):
    g = graph(
        nodes=[
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}},
            {
                "id": "filter",
                "type": "filter",
                "x": 1,
                "y": 0,
                "params": {
                    "identity_source": "class",
                    "identity": "person",
                    "rules": [
                        {"field": "identity", "operator": "eq", "value": "person"},
                        {"field": "identity", "operator": "neq", "value": "car"},
                    ],
                },
            },
            {"id": "event", "type": "event", "x": 2, "y": 0, "params": {"message": "seen"}},
        ],
        edges=[{"from": "detect", "to": "filter"}, {"from": "filter", "to": "event"}],
    )
    saved = service.save(g)
    assert saved["nodes"][1]["params"]["identity_source"] == "class"
    catalog_filter = next(item for item in service.catalog() if item["type"] == "filter")
    assert catalog_filter["params"]["identity_source"] == {
        "type": "string",
        "enum": ["identity", "class"],
        "default": "identity",
    }
    service.manager.cv["detections"] = [
        {"label": "person", "identity": None, "confidence": 0.99},
        {"label": "car", "identity": "person", "confidence": 0.99},
    ]
    service._tick()
    assert len(service.list()["events"]) == 1


def test_activation_preview_warns_for_legacy_motion_and_enabled_analysis(tmp_path):
    from types import SimpleNamespace

    class ActivationManager(Manager):
        def __init__(self):
            super().__init__()
            self.worker = SimpleNamespace(
                config=SimpleNamespace(
                    pipeline="motion",
                    vision=None,
                    analysis=SimpleNamespace(enabled=True, threshold=21, roi=[0, 0, 1, 1]),
                    name="Front Door",
                )
            )

        def get_worker(self, camera_id):
            if camera_id != "cam1":
                raise KeyError(camera_id)
            return self.worker

        def set_analysis(self, camera_id, settings):
            self.worker.config.analysis = SimpleNamespace(**settings)

    manager = ActivationManager()
    instance = WorkflowService(manager, Recorder(), tmp_path)
    try:
        direct = graph(
            nodes=[
                {
                    "id": "detect",
                    "type": "detections",
                    "x": 0,
                    "y": 0,
                    "params": {"engine": "insightface"},
                },
                {"id": "event", "type": "event", "x": 1, "y": 0, "params": {"message": "seen"}},
            ]
        )
        with pytest.raises(ValueError, match="active InsightFace vision pipeline"):
            instance.activation_preview(direct)
        instance.model_library = type(
            "Library",
            (),
            {
                "get": lambda _self, key: {
                    "id": key,
                    "engine": "insightface",
                    "path": "face.onnx",
                    "classes": [],
                    "settings": {},
                }
            },
        )()
        g = graph(
            camera_ids=[],
            nodes=[
                {"id": "camera", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam1"}},
                {"id": "model", "type": "model", "x": 0, "y": 1, "params": {"model_id": "face"}},
                {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
            ],
            edges=[
                {"from": "camera", "to": "detect", "input": "camera"},
                {"from": "model", "to": "detect", "input": "model"},
            ],
        )
        preview = instance.activation_preview(g)
        assert preview == {
            "cameras": [
                {
                    "id": "cam1",
                    "name": "Front Door",
                    "current_pipeline": "motion",
                    "target_engine": "insightface",
                    "motion_enabled": True,
                    "replaces_motion_pipeline": True,
                    "disable_motion": True,
                }
            ],
            "requires_motion_confirmation": True,
        }
        assert manager.worker.config.analysis.enabled is True
        assert manager.vision_calls == []
    finally:
        instance.close()


def test_insightface_motion_consent_and_failure_restore_analysis(tmp_path, monkeypatch):
    from types import SimpleNamespace

    class ActivationManager(Manager):
        def __init__(self):
            super().__init__()
            self.worker = SimpleNamespace(
                config=SimpleNamespace(
                    pipeline="vision",
                    vision={"engine": "insightface", "model": "face.onnx"},
                    analysis=SimpleNamespace(enabled=True, threshold=21, roi=[0, 0, 1, 1]),
                    name="Front Door",
                )
            )

        def get_worker(self, camera_id):
            if camera_id != "cam1":
                raise KeyError(camera_id)
            return self.worker

        def set_analysis(self, camera_id, settings):
            self.worker.config.analysis = SimpleNamespace(**settings)

    manager = ActivationManager()
    instance = WorkflowService(manager, Recorder(), tmp_path)
    try:
        g = graph(
            nodes=[
                {
                    "id": "detect",
                    "type": "detections",
                    "x": 0,
                    "y": 0,
                    "params": {"engine": "insightface"},
                },
                {"id": "event", "type": "event", "x": 1, "y": 0, "params": {"message": "seen"}},
            ]
        )
        with pytest.raises(ValueError, match="Front Door"):
            instance.save(g)
        assert manager.worker.config.analysis.enabled is True
        assert instance.list()["workflows"] == []

        monkeypatch.setattr(
            instance, "_persist", lambda: (_ for _ in ()).throw(OSError("disk full"))
        )
        with pytest.raises(OSError, match="disk full"):
            instance.save(g, disable_motion=True)
        analysis = vars(manager.worker.config.analysis)
        assert analysis == {"enabled": True, "threshold": 21, "roi": [0, 0, 1, 1]}
        assert instance.list()["workflows"] == []
    finally:
        instance.close()


def test_failed_face_model_save_restores_pipeline_and_analysis(tmp_path, monkeypatch):
    from types import SimpleNamespace

    class BindingManager(Manager):
        def __init__(self):
            super().__init__()
            self.worker = SimpleNamespace(
                config=SimpleNamespace(
                    pipeline="motion",
                    vision=None,
                    analysis=SimpleNamespace(enabled=True, threshold=18, roi=[0.1, 0.2, 0.8, 0.9]),
                    name="Entry",
                )
            )

        def get_worker(self, camera_id):
            if camera_id != "cam1":
                raise KeyError(camera_id)
            return self.worker

        def set_vision(self, camera_id, settings):
            self.worker.config.pipeline = "vision" if settings else "none"
            self.worker.config.vision = settings

        def restore_vision(self, camera_id, previous):
            self.worker.config.pipeline = previous.pipeline
            self.worker.config.vision = previous.vision

        def set_analysis(self, camera_id, settings):
            self.worker.config.analysis = SimpleNamespace(**settings)

    manager = BindingManager()
    library = type(
        "Library",
        (),
        {
            "get": lambda _self, key: {
                "id": key,
                "engine": "insightface",
                "path": "face.onnx",
                "classes": [],
                "settings": {},
            }
        },
    )()
    instance = WorkflowService(manager, Recorder(), tmp_path, model_library=library)
    try:
        g = graph(
            camera_ids=[],
            nodes=[
                {"id": "camera", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam1"}},
                {"id": "model", "type": "model", "x": 0, "y": 1, "params": {"model_id": "face"}},
                {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
            ],
            edges=[
                {"from": "camera", "to": "detect", "input": "camera"},
                {"from": "model", "to": "detect", "input": "model"},
            ],
        )
        monkeypatch.setattr(
            instance, "_persist", lambda: (_ for _ in ()).throw(OSError("disk full"))
        )
        with pytest.raises(OSError, match="disk full"):
            instance.save(g, disable_motion=True)
        assert manager.worker.config.pipeline == "motion"
        assert manager.worker.config.vision is None
        assert vars(manager.worker.config.analysis) == {
            "enabled": True,
            "threshold": 18,
            "roi": [0.1, 0.2, 0.8, 0.9],
        }
        assert instance.list()["workflows"] == []
    finally:
        instance.close()


def test_activation_restore_attempts_analysis_even_when_vision_restore_fails(service, monkeypatch):
    restored = []

    def fail_vision(_settings):
        raise OSError("camera unavailable")

    monkeypatch.setattr(service, "_restore_vision_settings", fail_vision)
    monkeypatch.setattr(service, "_restore_analysis_settings", restored.append)
    settings = {"cam1": {"enabled": True}}
    with pytest.raises(RuntimeError, match="fully restore"):
        service._restore_activation_settings({"cam1": {}}, settings)
    assert restored == [settings]


def test_filter_rejects_more_than_32_rules(service):
    g = graph(
        nodes=[
            {
                "id": "filter",
                "type": "filter",
                "x": 0,
                "y": 0,
                "params": {"rules": [{"field": "label", "operator": "eq", "value": "person"}] * 33},
            },
        ],
        edges=[],
    )
    with pytest.raises(ValueError, match="Invalid filter rules"):
        service.save(g)


def test_detection_fanin_deduplicates_and_fanout_runs_sinks(service):
    g = graph(
        nodes=[
            {"id": "source", "type": "detections", "x": 0, "y": 0, "params": {}},
            {"id": "left", "type": "filter", "x": 1, "y": 0, "params": {}},
            {"id": "right", "type": "filter", "x": 1, "y": 1, "params": {}},
            {"id": "join", "type": "count", "x": 2, "y": 0, "params": {"minimum": 2}},
            {"id": "event", "type": "event", "x": 3, "y": 0, "params": {"message": "seen"}},
            {"id": "capture", "type": "capture", "x": 3, "y": 1, "params": {}},
        ],
        edges=[
            {"from": "source", "to": "left"},
            {"from": "source", "to": "right"},
            {"from": "left", "to": "join"},
            {"from": "right", "to": "join"},
            {"from": "join", "to": "event"},
            {"from": "source", "to": "capture"},
        ],
    )
    service.save(g)
    service._tick()
    assert service.list()["events"] == []  # Same detection arrives on both fan-in paths.
    assert service.recorder.calls == [("capture", ["cam1"])]


def test_model_match_uses_active_pipeline_metadata(service):
    descriptor = {"engine": "yolo", "path": "expected.pt"}
    assert not service._model_matches(descriptor, "cam1", {"engine": "yolo", "model": "old.pt"}, {})
    assert service._model_matches(
        descriptor, "cam1", {"engine": "yolo", "model": "expected.pt"}, {}
    )


def test_model_match_requires_current_worker_snapshot_generation(service):
    descriptor = {"engine": "yolo", "path": "expected.pt"}

    class Worker:
        def vision_snapshot(self):
            return {
                "pipeline": "vision",
                "state": "running",
                "settings": {"engine": "yolo", "model": "expected.pt"},
                "runtime": {"state": "ready", "sequence": 4, "generation": 7},
            }

    service.manager.get_worker = lambda _camera_id: Worker()
    cv = {"engine": "yolo", "sequence": 4, "generation": 7}
    assert service._model_matches(descriptor, "cam1", cv, {})
    assert not service._model_matches(descriptor, "cam1", {**cv, "generation": 6}, {})


def test_classifier_metadata_is_readable_but_cannot_enable_as_a_detector(service):
    service.model_library = type(
        "Library",
        (),
        {
            "get": lambda *_: {
                "id": "classifier",
                "engine": "insightface",
                "path": "classifier.onnx",
                "classes": ["identity-one"],
                "settings": {},
                "metadata": {"model_type": "face_classifier"},
            }
        },
    )()
    g = graph(
        nodes=[
            {"id": "model", "type": "model", "x": 0, "y": 0, "params": {"model_id": "classifier"}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {}},
        ],
        edges=[{"from": "model", "to": "detect", "input": "model"}],
    )
    with pytest.raises(ValueError, match="face identity classifier"):
        service.activation_preview(g)
    assert service.manager.vision_calls == []


class FakeDetectors:
    def __init__(self):
        self.calls = []

    def resolve(self, detector):
        self.calls.append(detector)
        return detector + ".onnx"


def face_classifier_graph():
    return graph(
        nodes=[
            {"id": "camera", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "cam1"}},
            {
                "id": "classifier",
                "type": "classifier",
                "x": 0,
                "y": 1,
                "params": {"model_id": "identities", "threshold": 0.8},
            },
            {
                "id": "detect",
                "type": "detections",
                "x": 1,
                "y": 0,
                "params": {"engine": "insightface"},
            },
            {
                "id": "filter",
                "type": "filter",
                "x": 2,
                "y": 0,
                "params": {"identity": "Alice", "identity_source": "class"},
            },
            {"id": "event", "type": "event", "x": 3, "y": 0, "params": {"message": "Alice seen"}},
        ],
        edges=[
            {"from": "camera", "to": "detect", "input": "camera"},
            {"from": "classifier", "to": "detect", "input": "classifier"},
            {"from": "detect", "to": "filter"},
            {"from": "filter", "to": "event"},
        ],
    )


def classifier_library():
    return type(
        "Library",
        (),
        {
            "get": lambda _, key: {
                "id": key,
                "engine": "insightface",
                "path": "identities.onnx",
                "classes": ["Alice", "Bob"],
                "settings": {},
                "metadata": {"model_type": "face_classifier"},
            }
        },
    )()


def test_builtin_detector_defaults_lightest_and_attaches_classifier(service):
    service.detector_catalog = FakeDetectors()
    service.model_library = classifier_library()
    g = face_classifier_graph()
    preview = service.activation_preview(g)
    assert service.manager.vision_calls == []
    assert preview["requires_motion_confirmation"] is False
    service.save(g)
    settings = service.manager.vision_calls[-1][1]
    assert settings["model"] == "scrfd-500mf.onnx"
    assert settings["classifier_model"] == "identities.onnx"
    assert settings["classifier_labels"] == ("Alice", "Bob")
    assert settings["classifier_threshold"] == 0.8
    assert settings["classifier_output"] == "probabilities"
    assert settings["classifier_preprocessing"] == "arcface"
    assert "scrfd-500mf" in service.detector_catalog.calls


def test_classifier_requires_insightface_and_only_one_input(service):
    g = face_classifier_graph()
    g["enabled"] = False
    g["nodes"][2]["params"]["engine"] = "yolo"
    with pytest.raises(ValueError, match="edge types"):
        service.save(g)
    g = face_classifier_graph()
    g["enabled"] = False
    g["nodes"].append(
        {
            "id": "classifier2",
            "type": "classifier",
            "x": 0,
            "y": 2,
            "params": {"model_id": "identities"},
        }
    )
    g["edges"].append({"from": "classifier2", "to": "detect", "input": "classifier"})
    with pytest.raises(ValueError, match="only one classifier"):
        service.save(g)


def test_missing_builtin_does_not_mutate_pipeline(service):
    service.model_library = classifier_library()
    service.detector_catalog = type(
        "Missing",
        (),
        {"resolve": lambda *_: (_ for _ in ()).throw(ValueError("Install SCRFD-500MF first"))},
    )()
    with pytest.raises(ValueError, match="Install SCRFD"):
        service.activation_preview(face_classifier_graph())
    assert service.manager.vision_calls == []
    assert service.list()["workflows"] == []


def test_classifier_identity_filter_and_live_classes(service):
    service.detector_catalog = FakeDetectors()
    service.model_library = classifier_library()
    service.manager.worker = type(
        "Worker", (), {"config": type("Config", (), {"vision": None})()}
    )()
    service.manager.cv.update(
        engine="insightface",
        model="scrfd-500mf.onnx",
        detections=[
            {
                "label": "face",
                "bbox": [1, 1, 20, 20],
                "confidence": 0.95,
                "identity": "Alice",
                "identity_confidence": 0.9,
            }
        ],
    )
    service.save(face_classifier_graph())
    service._tick()
    assert len(service.list()["events"]) == 1
    service.manager.cv["sequence"] += 1
    service.manager.cv["detections"][0]["identity"] = "Bob"
    service._tick()
    assert len(service.list()["events"]) == 1
    service.manager.worker.config.vision["classifier_model"] = "another.onnx"
    service.manager.cv["sequence"] += 1
    service.manager.cv["detections"][0]["identity"] = "Alice"
    service._tick()
    assert len(service.list()["events"]) == 1


def test_conflicting_classifier_settings_on_same_camera_are_rejected(service):
    service.detector_catalog = FakeDetectors()
    service.model_library = classifier_library()
    g = face_classifier_graph()
    service.save(g)
    g["id"] = "other"
    g["nodes"][1]["params"]["threshold"] = 0.9
    with pytest.raises(ValueError, match="Conflicting models"):
        service.save(g)


def test_disabled_classifier_graph_round_trip_does_not_need_download(service):
    g = face_classifier_graph()
    g["enabled"] = False
    saved = service.save(g)
    assert saved["nodes"][1]["params"]["output"] == "probabilities"
    assert saved["edges"][1]["input"] == "classifier"
    assert service.manager.vision_calls == []


def test_classifier_match_rejects_old_inference_generation(service):
    config = {
        "engine": "insightface",
        "model": "detector.onnx",
        "classifier_model": "identities.onnx",
        "classifier_labels": ["Alice", "Bob"],
        "classifier_threshold": 0.8,
        "classifier_output": "probabilities",
        "classifier_preprocessing": "arcface",
    }
    snapshot = {
        "pipeline": "vision",
        "state": "running",
        "settings": config,
        "runtime": {"state": "ready", "sequence": 4, "generation": 7},
    }
    service.manager.worker = type("Worker", (), {"vision_snapshot": lambda _: snapshot})()
    descriptor = classifier_library().get("identities")
    params = {"threshold": 0.8, "output": "probabilities", "preprocessing": "arcface"}
    assert service._classifier_matches(
        descriptor, params, "cam1", {"engine": "insightface", "sequence": 4, "generation": 7}
    )
    assert not service._classifier_matches(
        descriptor, params, "cam1", {"engine": "insightface", "sequence": 4, "generation": 6}
    )


def test_unused_detector_choice_does_not_conflict_with_same_custom_pipeline():
    legacy = graph(
        nodes=[
            {"id": "model", "type": "model", "x": 0, "y": 0, "params": {"model_id": "same"}},
            {"id": "detect", "type": "detections", "x": 1, "y": 0, "params": {"engine": "any"}},
        ],
        edges=[{"from": "model", "to": "detect", "input": "model"}],
    )
    import copy

    newer = copy.deepcopy(legacy)
    newer["nodes"][1]["params"]["detector"] = "scrfd-500mf"
    assert WorkflowService._node_pipeline_signatures(
        legacy
    ) == WorkflowService._node_pipeline_signatures(newer)


@pytest.mark.parametrize(
    "model_id,detector",
    [
        ("builtin-scrfd-500mf", "scrfd-500mf"),
        ("builtin-scrfd-2-5gf", "scrfd-2.5gf"),
        ("builtin-scrfd-10gf", "scrfd-10gf"),
    ],
)
def test_model_node_resolves_builtin_detector_with_classifier(service, model_id, detector):
    service.detector_catalog = FakeDetectors()
    service.model_library = classifier_library()
    g = face_classifier_graph()
    g["nodes"].append(
        {"id": "model", "type": "model", "x": 0, "y": 2, "params": {"model_id": model_id}}
    )
    g["edges"].append({"from": "model", "to": "detect", "input": "model"})
    service.activation_preview(g)
    assert service.manager.vision_calls == []
    service.save(g)
    config = service.manager.vision_calls[-1][1]
    assert config["model"] == detector + ".onnx"
    assert config["classifier_labels"] == ("Alice", "Bob")
    assert config["classifier_model"] == "identities.onnx"
    assert (
        "detector"
        not in next(
            n for n in service.list()["workflows"][0]["nodes"] if n["type"] == "detections"
        )["params"]
    )


def test_old_and_model_node_builtin_pipeline_signatures_are_equivalent():
    import copy

    old = face_classifier_graph()
    old["nodes"][2]["params"]["detector"] = "scrfd-500mf"
    new = copy.deepcopy(old)
    new["nodes"][2]["params"].pop("detector")
    new["nodes"].append(
        {
            "id": "model",
            "type": "model",
            "x": 0,
            "y": 2,
            "params": {"model_id": "builtin-scrfd-500mf"},
        }
    )
    new["edges"].append({"from": "model", "to": "detect", "input": "model"})
    assert WorkflowService._node_pipeline_signatures(
        old
    ) == WorkflowService._node_pipeline_signatures(new)


def test_classifier_stability_settings_reach_pipeline_and_round_trip(service):
    service.detector_catalog = FakeDetectors()
    service.model_library = classifier_library()
    g = face_classifier_graph()
    g["nodes"][1]["params"].update(confirmations=4, switch_confirmations=6, margin=0.2)
    saved = service.save(g)
    options = service.manager.vision_calls[-1][1]
    assert options["classifier_confirmation_frames"] == 4
    assert options["classifier_switch_frames"] == 6
    assert options["classifier_min_margin"] == 0.2
    assert saved["nodes"][1]["params"]["confirmations"] == 4
    worker = type("Worker", (), {"config": type("Config", (), {"vision": options})()})()
    service.manager.worker = worker
    descriptor = classifier_library().get("identities")
    assert service._classifier_matches(
        descriptor, saved["nodes"][1]["params"], "cam1", {"engine": "insightface"}
    )
    worker.config.vision = {**options, "classifier_confirmation_frames": 3}
    assert not service._classifier_matches(
        descriptor, saved["nodes"][1]["params"], "cam1", {"engine": "insightface"}
    )


@pytest.mark.parametrize(
    "params",
    [{"confirmations": 0}, {"confirmations": 5, "switch_confirmations": 3}, {"margin": 1.1}],
)
def test_workflow_rejects_invalid_classifier_stability(service, params):
    g = face_classifier_graph()
    g["enabled"] = False
    g["nodes"][1]["params"].update(params)
    with pytest.raises(ValueError, match="classifier parameters"):
        service.save(g)


def test_unconfirmed_classifier_identity_never_matches_negative_identity_rule():
    detection = {"label": "face", "identity": None, "identity_confidence": 0.99}
    rule = [{"field": "identity", "operator": "neq", "value": "Alice"}]
    assert not WorkflowService._matches_rules(detection, rule, "all", identity_source="identity")


def test_preview_catalog_matches_terminal_camera_and_data_ports(service):
    descriptor = next(node for node in service.catalog() if node["type"] == "preview")
    assert descriptor["inputs"] == ["camera", "detections"]
    assert descriptor["outputs"] == []
