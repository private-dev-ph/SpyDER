import copy
import json

import pytest

from spyder_cctv.workflow import WorkflowService


def _node(node_id, kind, params=None):
    return {"id": node_id, "type": kind, "x": 0, "y": 0, "params": params or {}}


def _definition(subflow_id="reusable", version=None, camera="cam1"):
    graph = {
        "id": "definition",
        "name": "Definition",
        "enabled": False,
        "camera_ids": [],
        "nodes": [
            _node("input", "subflow_input"),
            _node("camera", "camera", {"camera_id": camera}),
            _node("detect", "detections", {}),
            _node("cool", "cooldown", {"seconds": 10}),
            _node("event", "event", {"message": "Seen"}),
            _node("output", "subflow_output"),
        ],
        "edges": [
            {"from": "input", "to": "detect"},
            {"from": "camera", "to": "detect", "input": "camera"},
            {"from": "detect", "to": "cool"},
            {"from": "cool", "to": "event"},
            {"from": "event", "to": "output"},
        ],
    }
    raw = {
        "id": subflow_id,
        "name": "Reusable",
        "description": "Reusable detection branch",
        "graph": graph,
        "parameters": [
            {
                "name": "camera",
                "type": "string",
                "default": camera,
                "node_id": "camera",
                "field": "camera_id",
            },
            {
                "name": "cooldown_seconds",
                "type": "number",
                "default": 10,
                "node_id": "cool",
                "field": "seconds",
            },
            {
                "name": "message",
                "type": "string",
                "default": "Seen",
                "node_id": "event",
                "field": "message",
            },
        ],
    }
    if version is not None:
        raw["version"] = version
    return raw


def _workflow(calls=1):
    nodes = [_node("source", "detections", {})]
    edges = []
    for index in range(calls):
        call_id = f"call{index}"
        nodes.append(
            _node(call_id, "subflow", {"subflow_id": "reusable", "version": 1, "arguments": {}})
        )
        edges.append({"from": "source", "to": call_id})
    return {
        "id": "outer",
        "name": "Outer",
        "enabled": False,
        "camera_ids": [],
        "nodes": nodes,
        "edges": edges,
    }


class _Manager:
    pre_event_buffer = None
    workers = {}

    def set_workflow_vision_cameras(self, _cameras):
        pass

    def statuses(self):
        return []


class _Recorder:
    def status(self):
        return {"state": "idle", "camera_ids": []}


@pytest.fixture
def service(tmp_path):
    result = WorkflowService(_Manager(), _Recorder(), tmp_path)
    result._stop.set()
    result._thread.join(timeout=2)
    yield result
    result.close()


def test_catalog_versions_are_immutable_and_persist(service, tmp_path):
    first = service.subflows.publish(_definition())
    second_raw = _definition(camera="cam2")
    second = service.subflows.publish(second_raw)
    assert first["version"] == 1
    assert second["version"] == 2
    assert service.subflows.get("reusable", 1)["parameters"][0]["default"] == "cam1"
    assert service.subflows.list()["subflows"][0]["version"] == 2
    restored = WorkflowService(service.manager, service.recorder, tmp_path)
    try:
        assert (
            restored.subflows.get("reusable", 2)["graph"]["nodes"][1]["params"]["camera_id"]
            == "cam2"
        )
    finally:
        restored.close()


def test_compile_pins_arguments_namespaces_each_caller_and_runtime_executes(service):
    service.subflows.publish(_definition())
    service.subflows.publish(_definition(camera="cam2"))
    compiled = service.compile_graph(_workflow(2))
    ids = [node["id"] for node in compiled["nodes"]]
    assert len(ids) == len(set(ids))
    cooldowns = [node["id"] for node in compiled["nodes"] if node["type"] == "cooldown"]
    assert len(cooldowns) == 2 and cooldowns[0] != cooldowns[1]
    assert compiled["_compiled"] is True
    assert len(compiled["_paths"]) == len(compiled["nodes"])
    assert service._camera_ids(service.compile_graph(_workflow())) == ["cam1"]
    assert WorkflowService._inference_camera_ids(compiled) == {"cam1"}
    override = _workflow()
    override["nodes"][1]["params"]["arguments"] = {
        "camera": "cam2",
        "cooldown_seconds": 25.5,
        "message": "Configured",
    }
    compiled_override = service.compile_graph(override)
    assert service._camera_ids(compiled_override) == ["cam2"]
    assert (
        next(n for n in compiled_override["nodes"] if n["type"] == "cooldown")["params"]["seconds"]
        == 25.5
    )
    assert (
        next(n for n in compiled_override["nodes"] if n["type"] == "event")["params"]["message"]
        == "Configured"
    )

    cv = {"detections": [{"label": "person", "confidence": 0.9}], "engine": "opencv"}
    service._evaluate(_workflow(2), "cam1", cv, 100.0)
    assert len(service.event_store.list()["events"]) == 2
    service._evaluate(_workflow(2), "cam1", cv, 101.0)
    assert len(service.event_store.list()["events"]) == 2


def test_missing_version_bad_argument_and_recursive_reference_rejected(service):
    service.subflows.publish(_definition())
    with pytest.raises(KeyError):
        service.compile_graph(
            {
                **_workflow(),
                "nodes": [
                    _node(
                        "call", "subflow", {"subflow_id": "reusable", "version": 4, "arguments": {}}
                    )
                ],
                "edges": [],
            }
        )
    wrong = _workflow()
    wrong["nodes"][1]["params"]["arguments"] = {"camera": 3}
    with pytest.raises(ValueError, match="parameter camera"):
        service.compile_graph(wrong)
    wrong = _workflow()
    wrong["nodes"][1]["params"]["arguments"] = {"cooldown_seconds": 5000}
    with pytest.raises(ValueError, match="seconds"):
        service.compile_graph(wrong)
    recursive = _definition("recursive")
    recursive["parameters"] = []
    recursive["graph"]["nodes"] = [
        _node("input", "subflow_input"),
        _node("inner", "subflow", {"subflow_id": "recursive", "version": 1, "arguments": {}}),
        _node("output", "subflow_output"),
    ]
    recursive["graph"]["edges"] = [
        {"from": "input", "to": "inner"},
        {"from": "inner", "to": "output"},
    ]
    with pytest.raises(ValueError, match="Recursive"):
        service.subflows.publish(recursive)


def test_nesting_depth_is_bounded(service):
    service.subflows.publish(_definition("base"))
    for index in range(1, 4):
        subflow_id = f"level{index}"
        graph = {
            "id": f"graph{index}",
            "name": f"Level {index}",
            "enabled": False,
            "camera_ids": [],
            "nodes": [
                _node("input", "subflow_input"),
                _node(
                    "call",
                    "subflow",
                    {
                        "subflow_id": "base" if index == 1 else f"level{index - 1}",
                        "version": 1,
                        "arguments": {},
                    },
                ),
                _node("output", "subflow_output"),
            ],
            "edges": [
                {"from": "input", "to": "call"},
                {"from": "call", "to": "output"},
            ],
        }
        service.subflows.publish(
            {
                "id": subflow_id,
                "name": subflow_id,
                "description": "Nested definition",
                "graph": graph,
                "parameters": [],
            }
        )
    level4 = {
        "id": "graph4",
        "name": "Level 4",
        "enabled": False,
        "camera_ids": [],
        "nodes": [
            _node("input", "subflow_input"),
            _node(
                "call",
                "subflow",
                {"subflow_id": "level3", "version": 1, "arguments": {}},
            ),
            _node("output", "subflow_output"),
        ],
        "edges": [{"from": "input", "to": "call"}, {"from": "call", "to": "output"}],
    }
    with pytest.raises(ValueError, match="depth exceeds 4"):
        service.subflows.publish(
            {
                "id": "level4",
                "name": "level4",
                "description": "Too deep",
                "graph": level4,
                "parameters": [],
            }
        )


def test_definition_bridge_and_graph_bounds_validate(service):
    malformed = _definition()
    malformed["graph"]["nodes"].append(_node("extra", "subflow_input"))
    with pytest.raises(ValueError, match="one parameterless input"):
        service.subflows.publish(malformed)
    definition = _definition()
    definition["graph"]["nodes"].extend(
        _node(f"extra{n}", "cooldown", {"seconds": 10}) for n in range(55)
    )
    definition["graph"]["edges"][-1]["to"] = "extra0"
    definition["graph"]["edges"].extend(
        {"from": f"extra{n}", "to": f"extra{n + 1}"} for n in range(54)
    )
    definition["graph"]["edges"].append({"from": "extra54", "to": "output"})
    service.subflows.publish(definition)
    wide = _workflow(5)
    with pytest.raises(ValueError, match="256 nodes"):
        service.compile_graph(wide)


def test_catalog_import_is_atomic_and_keeps_pinned_versions(service, tmp_path):
    first = _definition()
    first["version"] = 1
    second = _definition(camera="cam2")
    second["version"] = 2
    imported = service.subflows.import_definitions([second, first])
    assert [item["version"] for item in imported] == [1, 2]
    before = (tmp_path / "subflows.json").read_text(encoding="utf-8")
    invalid = copy.deepcopy(second)
    invalid["name"] = "Conflicting version"
    with pytest.raises(ValueError):
        service.subflows.import_definitions([invalid])
    assert (tmp_path / "subflows.json").read_text(encoding="utf-8") == before
    assert json.loads(before)["subflows"][0]["version"] == 1


def test_sparse_pinned_import_and_next_publish_version(service):
    pinned = _definition()
    pinned["version"] = 3
    service.subflows.import_definitions([pinned])
    assert service.subflows.list()["subflows"][0]["versions"] == [3]
    assert service.subflows.get("reusable", 3)["version"] == 3
    published = service.subflows.publish(_definition(camera="cam2"))
    assert published["version"] == 4


def test_bad_subflow_storage_does_not_stop_plain_workflows_or_get_overwritten(service, tmp_path):
    plain = {
        "id": "plain",
        "name": "Plain",
        "enabled": False,
        "camera_ids": [],
        "nodes": [_node("detect", "detections", {})],
        "edges": [],
    }
    service.save(plain)
    catalog_path = tmp_path / "subflows.json"
    catalog_path.write_text("{broken", encoding="utf-8")
    broken = _workflow()
    broken["enabled"] = True
    plain["enabled"] = True
    (tmp_path / "workflows.json").write_text(
        json.dumps({"workflows": [broken, plain]}), encoding="utf-8"
    )
    restored = WorkflowService(service.manager, service.recorder, tmp_path)
    restored._stop.set()
    restored._thread.join(timeout=2)
    try:
        assert restored.list()["subflow_storage_error"]
        plain_loaded = next(
            graph for graph in restored.list()["workflows"] if graph["id"] == "plain"
        )
        assert restored.compile_graph(plain_loaded)["nodes"][0]["type"] == "detections"
        restored._tick_locked({}, 0)
        assert "plain" in restored._runtime
        assert any(error.get("workflow_id") == "outer" for error in restored.list()["errors"])
        with pytest.raises(RuntimeError, match="catalog storage is unavailable"):
            restored.subflows.publish(_definition())
        assert catalog_path.read_text(encoding="utf-8") == "{broken"
    finally:
        restored.close()


def test_nested_subflow_versions_and_delete_reference_guards(service):
    service.subflows.publish(_definition())
    outer = _definition("outerflow")
    nodes = outer["graph"]["nodes"]
    edges = outer["graph"]["edges"]
    nodes[:] = [node for node in nodes if node["id"] not in ("camera", "detect")]
    outer["parameters"] = []
    nodes.append(
        _node("nested", "subflow", {"subflow_id": "reusable", "version": 1, "arguments": {}})
    )
    edges[:] = [
        {"from": "input", "to": "nested"},
        {"from": "nested", "to": "cool"},
        {"from": "cool", "to": "event"},
        {"from": "event", "to": "output"},
    ]
    service.subflows.publish(outer)
    nested_call = _workflow()
    nested_call["nodes"][1]["params"] = {
        "subflow_id": "outerflow",
        "version": 1,
        "arguments": {},
    }
    compiled = service.compile_graph(nested_call)
    nested_path = next(
        path
        for node_id, path in compiled["_paths"].items()
        if node_id.startswith("sf_") and len(path) > 2 and path[-1] == "cool"
    )
    assert nested_path == ["call0", "nested", "cool"]
    assert [
        item["id"]
        for item in service.subflows.dependencies(
            {
                "nodes": [
                    _node(
                        "call",
                        "subflow",
                        {"subflow_id": "outerflow", "version": 1, "arguments": {}},
                    )
                ]
            }
        )
    ] == ["outerflow", "reusable"]
    workflow = _workflow(1)
    service.save(workflow)
    with pytest.raises(ValueError, match="referenced"):
        service.remove_subflow("reusable")
    with pytest.raises(ValueError, match="referenced"):
        service.subflows.delete("reusable")


def test_child_and_call_bindings_survive_namespacing_and_identity_bridge(service):
    definition = _definition()
    definition["graph"]["nodes"][-2]["bindings"] = {
        "message": {"node": "camera", "signal": "camera_id"}
    }
    service.subflows.publish(definition)
    compiled = service.compile_graph(_workflow())
    nodes = {node["id"]: node for node in compiled["nodes"]}
    child_event = next(node for node in compiled["nodes"] if node["type"] == "event")
    child_camera_id = child_event["bindings"]["message"]["node"]
    assert nodes[child_camera_id]["type"] == "camera"
    assert any(node["id"] == "call0" and node["type"] == "subflow" for node in compiled["nodes"])
    assert "call0" in compiled["_paths"]

    passthrough = {
        "id": "passthrough",
        "name": "Passthrough",
        "description": "Identity detection flow",
        "graph": {
            "id": "identity",
            "name": "Identity",
            "enabled": False,
            "camera_ids": [],
            "nodes": [_node("input", "subflow_input"), _node("output", "subflow_output")],
            "edges": [{"from": "input", "to": "output"}],
        },
        "parameters": [],
    }
    service.subflows.publish(passthrough)
    root = {
        "id": "identity_call",
        "name": "Identity call",
        "enabled": False,
        "camera_ids": [],
        "nodes": [
            _node("source", "detections", {}),
            _node("call", "subflow", {"subflow_id": "passthrough", "version": 1, "arguments": {}}),
            {
                **_node("filter", "filter", {}),
                "bindings": {"label": {"node": "call", "signal": "labels"}},
            },
            _node("event", "event", {"message": "Matched"}),
        ],
        "edges": [
            {"from": "source", "to": "call"},
            {"from": "call", "to": "filter"},
            {"from": "filter", "to": "event"},
        ],
    }
    expanded = service.compile_graph(root)
    assert any(node["id"] == "call" and node["type"] == "subflow" for node in expanded["nodes"])
    assert (
        next(node for node in expanded["nodes"] if node["id"] == "filter")["bindings"]["label"][
            "node"
        ]
        == "call"
    )
    service._evaluate(root, "cam1", {"detections": [{"label": "person"}], "engine": "opencv"}, 500)
    assert service.event_store.list()["events"][-1]["message"] == "Matched"
    before = len(service.event_store.list()["events"])
    service._evaluate(root, "cam1", {"detections": [], "engine": "opencv"}, 501)
    assert len(service.event_store.list()["events"]) == before


def test_model_usage_in_any_pinned_subflow_version_is_protected(service):
    first = _definition()
    first["graph"]["nodes"].append(_node("model", "model", {"model_id": "a" * 32}))
    first["graph"]["edges"].append({"from": "model", "to": "detect", "input": "model"})
    service.subflows.publish(first)
    second = copy.deepcopy(first)
    second["graph"]["nodes"][-1]["params"]["model_id"] = "b" * 32
    service.subflows.publish(second)
    assert service.model_references("a" * 32) == ["Subflow reusable v1 / node model"]
    assert service.model_references("b" * 32) == ["Subflow reusable v2 / node model"]


def _nested_demo_bundle():
    from pathlib import Path

    return json.loads(
        (
            Path(__file__).parents[1] / "examples/workflows/three-level-nested-subflows.json"
        ).read_text(encoding="utf-8")
    )


def _assigned_demo_graph(service, bundle=None):
    graph = service.import_bundle(bundle or _nested_demo_bundle())["workflow"]
    graph["camera_ids"] = ["demo-camera"]
    graph["nodes"][0]["params"]["camera_id"] = "demo-camera"
    return graph


def test_three_level_demo_expands_with_unique_paths_and_stays_disabled(service):
    graph = _assigned_demo_graph(service)
    compiled = service.compile_graph(graph)
    assert graph["enabled"] is False
    assert len(compiled["nodes"]) == 16
    assert len({node["id"] for node in compiled["nodes"]}) == 16
    assert sum(node["type"] == "subflow" for node in compiled["nodes"]) == 3
    assert max(map(len, compiled["_paths"].values())) == 4
    cooldown_path = next(
        compiled["_paths"][node["id"]] for node in compiled["nodes"] if node["type"] == "cooldown"
    )
    assert cooldown_path == ["call_level_1", "call_level_2", "call_level_3", "cooldown"]


def test_three_level_demo_filters_and_cooldown_execute_in_temporary_storage(service):
    graph = _assigned_demo_graph(service)

    def evaluate(label, confidence, now, camera="demo-camera"):
        service._evaluate(
            graph,
            camera,
            {"engine": "insightface", "detections": [{"label": label, "confidence": confidence}]},
            now,
        )
        return len(service.event_store.list()["events"])

    assert evaluate("person", 0.95, 100) == 0
    assert evaluate("face", 0.4, 101) == 0
    assert evaluate("face", 0.9, 102, camera="another-camera") == 0
    assert evaluate("face", 0.9, 103) == 1
    assert evaluate("face", 0.9, 104) == 1
    assert evaluate("face", 0.9, 109) == 2
    events = service.event_store.list()["events"]
    assert all(event["message"] == "Three-level subflow demo matched" for event in events)
    assert all(not event.get("media") for event in events)


def test_three_level_demo_middle_count_gate_and_outer_override(service):
    bundle = _nested_demo_bundle()
    middle = next(item for item in bundle["subflows"] if item["id"] == "demo-nested-level-2")
    next(node for node in middle["graph"]["nodes"] if node["id"] == "count")["params"][
        "minimum"
    ] = 2
    middle["parameters"][0]["default"] = 2
    graph = _assigned_demo_graph(service, bundle)
    outer = next(node for node in graph["nodes"] if node["type"] == "subflow")
    outer["params"]["arguments"] = {"min_confidence": 0.8}

    def evaluate(detections, now):
        service._evaluate(
            graph, "demo-camera", {"engine": "insightface", "detections": detections}, now
        )
        return len(service.event_store.list()["events"])

    face = {"label": "face", "confidence": 0.95}
    assert evaluate([face], 100) == 0
    assert evaluate([face, {"label": "face", "confidence": 0.7}], 101) == 0
    assert evaluate([face, {**face, "bbox": [20, 20, 50, 50]}], 102) == 1


def test_three_level_demo_bundle_round_trip_retains_all_exact_versions(service):
    graph = _assigned_demo_graph(service)
    exported = service.export_bundle(graph)
    assert len(exported["subflows"]) == 3
    assert all(item["version"] == 1 for item in exported["subflows"])
    # Reimport is idempotent and preserves a disabled parent.
    imported = service.import_bundle(exported)
    assert imported["workflow"]["enabled"] is False
    assert (
        service.compile_graph(imported["workflow"])["_paths"]
        == service.compile_graph(graph)["_paths"]
    )
