"""Validated, local-only detection workflows."""

from __future__ import annotations

import copy
import json
import math
import os
import re
import tempfile
import threading
import time
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any

from .cv.contracts import VisionConfig
from .cv.detectors import DetectorCatalog
from .events import EventService
from .workflow_code import run_code, validate_code
from .workflow_features import EvaluationTrace, WorkflowFeatures
from .workflow_history import ExecutionHistory
from .workflow_subflows import SubflowCatalog

_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MAX_WORKFLOWS = 5000
_MAX_WORKFLOW_BYTES = 64 * 1024 * 1024
_ENGINES = ("opencv", "yolo", "insightface")
_BUILTIN_MODELS = {
    "builtin-scrfd-500mf": "scrfd-500mf",
    "builtin-scrfd-2-5gf": "scrfd-2.5gf",
    "builtin-scrfd-10gf": "scrfd-10gf",
}
_SIGNAL_TYPES = {
    "camera_id": "string",
    "engine": "string",
    "model_id": "string",
    "classes": "strings",
    "labels": "strings",
    "identities": "strings",
    "confidence": "number",
    "count": "integer",
}
_BINDING_TARGETS = {
    "filter.label": {"string", "strings"},
    "filter.identity": {"string", "strings"},
    "filter.confidence": {"number"},
    "event.message": {"string", "strings"},
    "notification.title": {"string", "strings"},
    "notification.message": {"string", "strings"},
    "count.minimum": {"integer"},
    "cooldown.seconds": {"integer"},
}
_SIGNALS_BY_NODE = {
    "camera": {"camera_id", "engine"},
    "model": {"model_id", "classes", "engine"},
    "classifier": {"model_id", "classes", "engine"},
    **{
        kind: set(_SIGNAL_TYPES) - {"model_id"}
        for kind in (
            "detections",
            "filter",
            "zone",
            "count",
            "cooldown",
            "event",
            "notification",
            "capture",
            "record",
            "code",
        )
    },
}
_NODE_PARAMS = {
    "camera": {"camera_id"},
    "model": {"model_id"},
    "classifier": {
        "model_id",
        "threshold",
        "output",
        "preprocessing",
        "confirmations",
        "switch_confirmations",
        "margin",
    },
    "detections": {"engine", "detector"},
    "filter": {"label", "confidence", "identity", "identity_source", "rules", "match"},
    "zone": {"roi"},
    "count": {"minimum"},
    "cooldown": {"seconds"},
    "event": {"message", "name_pattern", "attachment", "duration_seconds", "pre_event_seconds"},
    "notification": {"title", "message"},
    "capture": set(),
    "record": {"action"},
    "code": {"language", "source"},
    "preview": set(),
    "subflow": {"subflow_id", "version", "arguments"},
    "subflow_input": set(),
    "subflow_output": set(),
}
_SIGNALS_BY_NODE.update(
    {
        "subflow": set(_SIGNAL_TYPES) - {"model_id"},
        "subflow_input": set(_SIGNAL_TYPES) - {"model_id"},
        "subflow_output": set(_SIGNAL_TYPES) - {"model_id"},
    }
)


def _finite(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _validate_graph(raw: Any, *, allow_bridges: bool = False) -> dict[str, Any]:
    fields = {"id", "name", "enabled", "camera_ids", "nodes", "edges"}
    if not isinstance(raw, dict) or set(raw) not in (
        fields,
        fields | {"execution"},
        fields | {"execution", "callable_version"},
    ):
        raise ValueError(
            "Workflow must contain exactly id, name, enabled, camera_ids, nodes and edges"
        )
    if not isinstance(raw["id"], str) or not _ID.fullmatch(raw["id"]):
        raise ValueError("Invalid workflow id")
    if not isinstance(raw["name"], str) or not raw["name"].strip() or len(raw["name"]) > 128:
        raise ValueError("Invalid workflow name")
    if type(raw["enabled"]) is not bool:
        raise ValueError("enabled must be boolean")
    cams = raw["camera_ids"]
    if (
        not isinstance(cams, list)
        or len(cams) > 64
        or any(not isinstance(c, str) or not _ID.fullmatch(c) for c in cams)
    ):
        raise ValueError("Invalid camera_ids")
    if len(set(cams)) != len(cams):
        raise ValueError("Duplicate camera id")
    execution = raw.get("execution")
    if execution is not None:
        if not isinstance(execution, dict) or set(execution) != {
            "run_independently",
            "allow_calls",
            "parameters",
            "description",
        }:
            raise ValueError("Invalid workflow execution settings")
        if (
            type(execution["run_independently"]) is not bool
            or type(execution["allow_calls"]) is not bool
            or not isinstance(execution["parameters"], list)
            or len(execution["parameters"]) > 64
            or not isinstance(execution["description"], str)
            or len(execution["description"]) > 1000
        ):
            raise ValueError("Invalid workflow execution settings")
        execution = copy.deepcopy(execution)
    if "callable_version" in raw and (
        type(raw["callable_version"]) is not int or raw["callable_version"] < 1
    ):
        raise ValueError("Invalid callable version")
    nodes, edges = raw["nodes"], raw["edges"]
    # Explicit execution records may be saved while either bridge is being edited.
    # Publication enforces the complete callable contract.
    allow_bridges = allow_bridges or execution is not None
    if (
        not isinstance(nodes, list)
        or len(nodes) > 64
        or not isinstance(edges, list)
        or len(edges) > 128
    ):
        raise ValueError("Workflow node or edge limit exceeded")
    clean_nodes, by_id = [], {}
    for node in nodes:
        if not isinstance(node, dict) or set(node) not in (
            {"id", "type", "x", "y", "params"},
            {"id", "type", "x", "y", "params", "bindings"},
        ):
            raise ValueError("Invalid workflow node")
        nid, kind, params = node["id"], node["type"], node["params"]
        if not isinstance(nid, str) or not _ID.fullmatch(nid) or nid in by_id:
            raise ValueError("Invalid or duplicate node id")
        if (
            not isinstance(kind, str)
            or kind not in _NODE_PARAMS
            or not isinstance(params, dict)
            or set(params) - _NODE_PARAMS[kind]
        ):
            raise ValueError("Unknown node type or parameter")
        if (
            not _finite(node["x"])
            or not _finite(node["y"])
            or not 0 <= node["x"] <= 5000
            or not 0 <= node["y"] <= 5000
        ):
            raise ValueError("Node position must be between 0 and 5000")
        p = dict(params)
        if kind in ("subflow_input", "subflow_output"):
            if not allow_bridges or p:
                raise ValueError("Subflow bridge nodes are valid only inside subflow definitions")
        elif kind == "subflow":
            if (
                not isinstance(p.get("subflow_id"), str)
                or not _ID.fullmatch(p["subflow_id"])
                or type(p.get("version")) is not int
                or p["version"] < 1
                or not isinstance(p.get("arguments", {}), dict)
            ):
                raise ValueError("Invalid subflow call parameters")
            p.setdefault("arguments", {})
        elif kind == "camera":
            p.setdefault("camera_id", "")
            if not isinstance(p["camera_id"], str) or (
                p["camera_id"] and not _ID.fullmatch(p["camera_id"])
            ):
                raise ValueError("Invalid camera_id")
        elif kind in ("model", "classifier"):
            p.setdefault("model_id", "")
            if not isinstance(p["model_id"], str) or (
                p["model_id"] and not _ID.fullmatch(p["model_id"])
            ):
                raise ValueError("Invalid model_id")
            if kind == "classifier":
                p.setdefault("threshold", 0.5)
                p.setdefault("output", "probabilities")
                p.setdefault("preprocessing", "arcface")
                p.setdefault("confirmations", 3)
                p.setdefault("switch_confirmations", 5)
                p.setdefault("margin", 0.15)
                if (
                    not _finite(p["threshold"])
                    or not (-1 if p["model_id"].startswith("gallery-") else 0)
                    <= p["threshold"]
                    <= 1
                    or p["output"] not in ("probabilities", "logits")
                    or p["preprocessing"] not in ("arcface", "embedded")
                    or type(p["confirmations"]) is not int
                    or not 1 <= p["confirmations"] <= 15
                    or type(p["switch_confirmations"]) is not int
                    or not p["confirmations"] <= p["switch_confirmations"] <= 30
                    or not _finite(p["margin"])
                    or not 0 <= p["margin"] <= 1
                ):
                    raise ValueError("Invalid classifier parameters")
        elif kind == "detections":
            p.setdefault("engine", "any")
            if p["engine"] != "any" and p["engine"] not in _ENGINES:
                raise ValueError("Invalid detection engine")
            if "detector" in p and p["detector"] not in (
                "scrfd-500mf",
                "scrfd-2.5gf",
                "scrfd-10gf",
                "retinaface",
                "custom",
            ):
                raise ValueError("Invalid InsightFace detector")
        elif kind == "filter":
            p.setdefault("label", "")
            p.setdefault("confidence", 0.0)
            p.setdefault("identity", "")
            p.setdefault("identity_source", "identity")
            if (
                not isinstance(p["label"], str)
                or not isinstance(p["identity"], str)
                or not _finite(p["confidence"])
                or not 0 <= p["confidence"] <= 1
                or p["identity_source"] not in ("identity", "class")
            ):
                raise ValueError("Invalid filter parameters")
            p.setdefault("match", "all")
            p.setdefault("rules", [])
            if (
                p["match"] not in ("all", "any")
                or not isinstance(p["rules"], list)
                or len(p["rules"]) > 32
            ):
                raise ValueError("Invalid filter rules")
            for rule in p["rules"]:
                if not isinstance(rule, dict) or set(rule) != {"field", "operator", "value"}:
                    raise ValueError("Invalid filter rule")
                field, operator, value = rule["field"], rule["operator"], rule["value"]
                allowed = {
                    "label": {"eq", "neq"},
                    "identity": {"eq", "neq", "is_unknown", "is_known"},
                    "confidence": {"eq", "neq", "gte", "lte"},
                }
                if (
                    not isinstance(field, str)
                    or field not in allowed
                    or not isinstance(operator, str)
                    or operator not in allowed[field]
                ):
                    raise ValueError("Invalid filter rule field or operator")
                if field == "confidence":
                    if not _finite(value) or not 0 <= value <= 1:
                        raise ValueError("Invalid confidence rule value")
                elif operator in ("is_unknown", "is_known"):
                    if field != "identity" or value != "" or p["identity_source"] == "class":
                        raise ValueError(
                            "Identity status operators require identity source and empty value"
                        )
                elif not isinstance(value, str) or len(value) > 128:
                    raise ValueError("Invalid string rule value")
        elif kind == "zone":
            roi = p.get("roi")
            if (
                not isinstance(roi, list)
                or len(roi) != 4
                or any(not _finite(v) for v in roi)
                or not (0 <= roi[0] < roi[2] <= 1 and 0 <= roi[1] < roi[3] <= 1)
            ):
                raise ValueError("roi must be normalized [x1,y1,x2,y2]")
        elif kind == "count":
            if type(p.get("minimum")) is not int or p["minimum"] < 1:
                raise ValueError("minimum must be an integer >= 1")
        elif kind == "cooldown":
            p.setdefault("seconds", 10)
            if not _finite(p["seconds"]) or not 1 <= p["seconds"] <= 3600:
                raise ValueError("seconds must be between 1 and 3600")
        elif kind == "event":
            if not isinstance(p.get("message"), str) or len(p["message"]) > 500:
                raise ValueError("message must be a string of at most 500 characters")
            p.setdefault("name_pattern", "{workflow} · {camera} · {date} {time}")
            p.setdefault("attachment", "none")
            p.setdefault("duration_seconds", 10)
            p.setdefault("pre_event_seconds", 0)
            if (
                not isinstance(p["name_pattern"], str)
                or not p["name_pattern"].strip()
                or len(p["name_pattern"]) > 200
            ):
                raise ValueError("name_pattern must be nonempty and at most 200 characters")
            if p["attachment"] not in ("none", "capture", "recording"):
                raise ValueError("attachment must be none, capture or recording")
            if type(p["duration_seconds"]) is not int or not 1 <= p["duration_seconds"] <= 300:
                raise ValueError("duration_seconds must be between 1 and 300")
            if type(p["pre_event_seconds"]) is not int or not 0 <= p["pre_event_seconds"] <= 30:
                raise ValueError("pre_event_seconds must be between 0 and 30")
        elif kind == "notification":
            p.setdefault("title", "SpyDER detection")
            p.setdefault("message", "Matching face detected")
            if not isinstance(p["title"], str) or not p["title"].strip() or len(p["title"]) > 128:
                raise ValueError("notification title must be nonempty and at most 128 characters")
            if (
                not isinstance(p["message"], str)
                or not p["message"].strip()
                or len(p["message"]) > 500
            ):
                raise ValueError("notification message must be nonempty and at most 500 characters")
        elif kind == "record" and p.get("action") not in ("start", "stop"):
            raise ValueError("record action must be start or stop")
        elif kind == "code":
            p.setdefault("language", "python")
            p.setdefault("source", "output = detections")
            if p["language"] not in ("python", "javascript") or not isinstance(p["source"], str):
                raise ValueError("Code node requires Python or JavaScript source")
            validate_code(p["source"], language=p["language"])
        normalized = {"id": nid, "type": kind, "x": node["x"], "y": node["y"], "params": p}
        if "bindings" in node:
            normalized["bindings"] = copy.deepcopy(node["bindings"])
        clean_nodes.append(normalized)
        by_id[nid] = normalized
    clean_edges, seen, indegree, outgoing = [], set(), {n: 0 for n in by_id}, {n: [] for n in by_id}
    for edge in edges:
        if (
            not isinstance(edge, dict)
            or not {"from", "to"}.issubset(edge)
            or set(edge) - {"from", "to", "input", "label"}
        ):
            raise ValueError("Invalid workflow edge")
        if "label" in edge and (not isinstance(edge["label"], str) or len(edge["label"]) > 80):
            raise ValueError("Connection label must be text with at most 80 characters")
        source, target = edge["from"], edge["to"]
        input_name = edge.get("input", "detections")
        pair = (source, target, input_name)
        if source not in by_id or target not in by_id or pair in seen or source == target:
            raise ValueError("Invalid or duplicate workflow edge")
        source_kind, target_kind = by_id[source]["type"], by_id[target]["type"]
        if input_name not in ("camera", "model", "classifier", "detections"):
            raise ValueError("Invalid workflow input")
        if source_kind == "preview":
            valid = False
        elif source_kind == "camera":
            valid = input_name == "camera" and target_kind in ("detections", "preview")
        elif source_kind == "model":
            valid = input_name == "model" and target_kind == "detections"
        elif source_kind == "classifier":
            valid = (
                input_name == "classifier"
                and target_kind == "detections"
                and by_id[target]["params"]["engine"] == "insightface"
            )
        elif source_kind == "subflow_input":
            valid = input_name == "detections" and target_kind not in (
                "camera",
                "model",
                "classifier",
                "subflow_input",
            )
        elif target_kind == "subflow_output":
            valid = input_name == "detections" and source_kind not in (
                "preview",
                "model",
                "classifier",
                "subflow_output",
            )
        else:
            valid = input_name == "detections" and target_kind not in (
                "camera",
                "model",
                "classifier",
            )
        if not valid:
            raise ValueError("Invalid workflow edge types")
        seen.add(pair)
        clean_edges.append(
            {
                "from": source,
                "to": target,
                **({"input": input_name} if "input" in edge else {}),
                **({"label": edge["label"]} if "label" in edge else {}),
            }
        )
        outgoing[source].append(target)
        indegree[target] += 1
    queue = [n for n in by_id if indegree[n] == 0]
    visited = 0
    while queue:
        source = queue.pop()
        visited += 1
        for target in outgoing[source]:
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    if visited != len(by_id):
        raise ValueError("Workflow graph contains a cycle")
    for node in clean_nodes:
        if (
            node["type"] == "detections"
            and sum(
                edge["to"] == node["id"] and edge.get("input") == "classifier"
                for edge in clean_edges
            )
            > 1
        ):
            raise ValueError("Each detections node can receive only one classifier")
    _validate_bindings(clean_nodes, clean_edges)
    result = {
        "id": raw["id"],
        "name": raw["name"],
        "enabled": raw["enabled"],
        "camera_ids": list(cams),
        "nodes": clean_nodes,
        "edges": clean_edges,
    }
    if execution is not None:
        result["execution"] = execution
    if "callable_version" in raw:
        result["callable_version"] = raw["callable_version"]
    return result


def _validate_bindings(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> None:
    """Validate persisted signal links against graph ancestry and exact signal types."""
    by_id = {node["id"]: node for node in nodes}
    parents: dict[str, set[str]] = {nid: set() for nid in by_id}
    for edge in edges:
        parents[edge["to"]].add(edge["from"])
    for node in nodes:
        bindings = node.get("bindings", {})
        if not isinstance(bindings, dict) or len(bindings) > 32:
            raise ValueError("Invalid node bindings")
        for target, link in bindings.items():
            if (
                not isinstance(target, str)
                or not isinstance(link, dict)
                or set(link) != {"node", "signal"}
            ):
                raise ValueError("Invalid node binding")
            source, signal = link["node"], link["signal"]
            target_spec = target
            match = re.fullmatch(r"rules\.(\d+)\.value", target)
            if match:
                index = int(match.group(1))
                rules = node["params"].get("rules", [])
                if node["type"] != "filter" or index >= len(rules):
                    raise ValueError("Invalid bound filter rule")
                field = rules[index]["field"]
                target_spec = f"filter.{field}"
            else:
                target_spec = f"{node['type']}.{target}"
            if (
                not isinstance(source, str)
                or target_spec not in _BINDING_TARGETS
                or source not in by_id
                or source == node["id"]
            ):
                raise ValueError("Invalid binding target or source")
            if not isinstance(signal, str) or signal not in _SIGNAL_TYPES:
                raise ValueError("Invalid binding signal")
            if signal not in _SIGNALS_BY_NODE[by_id[source]["type"]]:
                raise ValueError("Signal is unavailable from source node")
            expected = _BINDING_TARGETS[target_spec]
            if signal == "model_id":
                actual = "string"
            else:
                actual = _SIGNAL_TYPES[signal]
            if actual not in expected:
                raise ValueError("Incompatible binding signal type")
            seen, pending = set(), list(parents[node["id"]])
            while pending:
                current = pending.pop()
                if current in seen:
                    continue
                seen.add(current)
                pending.extend(parents[current])
            if source not in seen:
                raise ValueError("Binding source must be upstream of target")


class WorkflowService:
    """Run bounded workflows over fresh results from configured camera engines."""

    def __init__(
        self,
        manager: Any,
        recorder: Any,
        storage_dir: Path,
        model_library: Any = None,
        detector_catalog: Any = None,
        face_galleries: Any = None,
    ) -> None:
        self.manager, self.recorder = manager, recorder
        self.model_library = model_library
        self.face_galleries = face_galleries
        self.detector_catalog = detector_catalog or DetectorCatalog()
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.subflows = SubflowCatalog(
            self.storage_dir / "subflows.json",
            lambda raw: _validate_graph(raw, allow_bridges=True),
        )
        self.event_store = EventService(
            getattr(manager, "app_data_dir", self.storage_dir), recorder
        )
        self._path = self.storage_dir / "workflows.json"
        self._lock = threading.RLock()
        self._storage_error: str | None = None
        self._summary_cache: list[dict[str, Any]] = []
        try:
            self._graphs = self._load()
            self._migrate_callable_workflows()
            self._rebuild_summary_cache()
        except (OSError, ValueError) as exc:
            self._graphs = {}
            self._storage_error = str(exc)[:200] or "Cannot load workflow storage"
        self._events: list[dict[str, Any]] = []
        self._session_id = uuid.uuid4().hex
        self._errors: list[dict[str, Any]] = []
        self._runtime: dict[str, Any] = {}
        self._compile_errors: dict[str, tuple[str, float]] = {}
        self._debug: dict[str, Any] = {}
        self._seen: dict[str, tuple[Any, int]] = {}
        self._last_action: dict[tuple[str, str, str], float] = {}
        self._global_actions: deque[float] = deque()
        self._cooldowns: dict[tuple[str, str, str], float] = {}
        self._record_owned: dict[str, set[str]] = {}
        self._motion_state: dict[str, tuple[Any, int, bool]] = {}
        self._attachment_lock = threading.Lock()
        self._event_clip_sessions: set[str] = set()
        self._event_clip_transferred: set[str] = set()
        self._clip_threads: set[threading.Thread] = set()
        self.history = ExecutionHistory(self.storage_dir / "workflow-history.sqlite3")
        self.features = WorkflowFeatures(self)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="spyder-workflows", daemon=True)
        self._sync_inference_demand()
        self._sync_pre_event_buffer()
        self._thread.start()

    def _migrate_callable_workflows(self) -> None:
        """Expose legacy callable definitions as disabled records in workflow storage."""
        if self.subflows.storage_error:
            self._storage_error = "Callable workflow migration is unavailable"
            return
        additions: dict[str, dict[str, Any]] = {}
        for versions in self.subflows._items.values():
            definition = next((item for item in reversed(versions) if item is not None), None)
            if definition is None:
                continue
            ident = definition["id"]
            existing = self._graphs.get(ident)
            if existing is not None:
                if "callable_version" in existing:
                    if existing["callable_version"] != definition["version"]:
                        additions[ident] = {
                            **existing,
                            "callable_version": definition["version"],
                        }
                    continue
                self._storage_error = f"Callable workflow ID collision: {ident}"
                return
            additions[ident] = {
                **copy.deepcopy(definition["graph"]),
                "id": ident,
                "name": definition["name"],
                "enabled": False,
                "camera_ids": [],
                "execution": {
                    "run_independently": False,
                    "allow_calls": True,
                    "parameters": copy.deepcopy(definition["parameters"]),
                    "description": definition["description"],
                },
                "callable_version": definition["version"],
            }
        if not additions:
            return
        if len(self._graphs) + len(additions) > _MAX_WORKFLOWS:
            self._storage_error = "Workflow limit exceeded during callable migration"
            return
        prior = self._graphs
        self._graphs = {**prior, **additions}
        try:
            self._persist()
        except (OSError, ValueError, TypeError) as exc:
            self._graphs = prior
            self._storage_error = str(exc)[:200] or "Callable workflow migration failed"

    @staticmethod
    def _independent_active(graph: dict[str, Any]) -> bool:
        execution = graph.get("execution")
        return graph["enabled"] and (execution is None or execution["run_independently"])

    @staticmethod
    def _inference_camera_ids(graph: dict[str, Any]) -> set[str]:
        """Only detector inputs need CV; a raw camera/preview branch does not."""
        nodes = {node["id"]: node for node in graph["nodes"]}
        cameras = set()
        if graph.get("execution", {}).get("run_independently") and any(
            node["type"] == "subflow_input" for node in graph["nodes"]
        ):
            cameras.update(graph["camera_ids"])
        for node in graph["nodes"]:
            if node["type"] != "detections":
                continue
            inputs = [
                edge
                for edge in graph["edges"]
                if edge["to"] == node["id"] and edge.get("input") == "camera"
            ]
            if inputs:
                cameras.update(
                    nodes[edge["from"]]["params"].get("camera_id", "") for edge in inputs
                )
            else:
                cameras.update(graph["camera_ids"])
        cameras.discard("")
        return cameras

    def _sync_inference_demand(self) -> None:
        publish = getattr(self.manager, "set_workflow_vision_cameras", None)
        if publish is not None:
            cameras = set()
            for graph in self._graphs.values():
                if self._independent_active(graph):
                    try:
                        cameras.update(self._inference_camera_ids(self.compile_graph(graph)))
                    except (KeyError, TypeError, ValueError, RuntimeError) as exc:
                        self._report_compile_error(graph, exc)
            publish(cameras)

    def _sync_pre_event_buffer(self) -> None:
        """Opt in existing camera workers without retaining or starting a camera."""
        history = getattr(self.manager, "pre_event_buffer", None)
        if history is None:
            return
        requirements: dict[str, int] = {}
        for graph in self._graphs.values():
            if not self._independent_active(graph):
                continue
            try:
                graph = self.compile_graph(graph)
            except (KeyError, TypeError, ValueError, RuntimeError) as exc:
                self._report_compile_error(graph, exc)
                continue
            seconds = max(
                (
                    node["params"].get("pre_event_seconds", 0)
                    for node in graph["nodes"]
                    if node["type"] == "event" and node["params"].get("attachment") == "recording"
                ),
                default=0,
            )
            if seconds:
                for camera_id in self._camera_ids(graph):
                    if camera_id in self.manager.workers:
                        requirements[camera_id] = max(requirements.get(camera_id, 0), seconds)
        history.configure(requirements)

    def list(self, current: str | None = None, first: bool = False) -> dict[str, Any]:
        """Return a legacy full snapshot, or just the selected editor graph."""
        with self._lock:
            selected = self._graphs.get(current) if current is not None else None
            if selected is None and first:
                selected = next(iter(self._graphs.values()), None)
            graphs = (
                list(self._graphs.values())
                if current is None and not first
                else ([selected] if selected is not None else [])
            )
            runtime = (
                self._runtime
                if current is None and not first
                else {
                    item["id"]: self._runtime.get(
                        item["id"],
                        {"state": "enabled" if item["enabled"] else "disabled", "cameras": {}},
                    )
                    for item in graphs
                }
            )
            return {
                "workflows": copy.deepcopy(graphs),
                "counts": self._workflow_counts(),
                "catalog": self.catalog(),
                "events": copy.deepcopy(self._events[-100:]),
                "runtime": copy.deepcopy(runtime),
                "errors": copy.deepcopy(self._errors[-100:]),
                "storage_error": self._storage_error,
                "subflow_storage_error": self.subflows.storage_error,
                "pre_event_buffer": (
                    self.manager.pre_event_buffer.status()
                    if getattr(self.manager, "pre_event_buffer", None) is not None
                    else None
                ),
            }

    def _rebuild_summary_cache(self) -> None:
        self._summary_cache = []
        for graph in self._graphs.values():
            cameras = set(graph["camera_ids"])
            engines = set()
            try:
                expanded = self.compile_graph(graph)
            except (ValueError, KeyError, RuntimeError):
                expanded = graph
            for node in expanded["nodes"]:
                if node["type"] == "camera" and node["params"].get("camera_id"):
                    cameras.add(node["params"]["camera_id"])
                if node["type"] == "detections":
                    engine = node["params"].get("engine", "any")
                    if engine != "any":
                        engines.add(engine)
            self._summary_cache.append(
                {
                    "id": graph["id"],
                    "name": graph["name"],
                    "enabled": graph["enabled"],
                    "camera_ids": sorted(cameras),
                    "engines": sorted(engines),
                    "node_count": len(graph["nodes"]),
                    "edge_count": len(graph["edges"]),
                    "execution_mode": self._execution_mode(graph),
                    "callable_version": self._latest_callable_version(graph["id"]),
                    "caller_count": self._callers(graph["id"]),
                    "versions": [
                        index
                        for index, definition in enumerate(
                            self.subflows._items.get(graph["id"], []), 1
                        )
                        if definition is not None
                    ],
                }
            )
        self._summary_cache.sort(key=lambda item: (item["name"].casefold(), item["id"]))

    def _workflow_counts(self) -> dict[str, int]:
        total = len(self._summary_cache)
        enabled = sum(item["enabled"] for item in self._summary_cache)
        return {"total": total, "enabled": enabled, "disabled": total - enabled}

    @staticmethod
    def _execution_mode(graph: dict[str, Any]) -> str:
        execution = graph.get("execution")
        independent = execution is None or execution["run_independently"]
        callable_ = bool(execution and execution["allow_calls"])
        return "both" if independent and callable_ else "independent" if independent else "callable"

    def _latest_callable_version(self, workflow_id: str) -> int | None:
        definitions = self.subflows._items.get(workflow_id, [])
        return next(
            (
                definition["version"]
                for definition in reversed(definitions)
                if definition is not None
            ),
            None,
        )

    def _callers(self, workflow_id: str) -> int:
        caller_ids = set()
        for graph in self._graphs.values():
            for node in graph["nodes"]:
                if node["type"] == "subflow" and node["params"].get("subflow_id") == workflow_id:
                    caller_ids.add(graph["id"])
        for defs in self.subflows._items.values():
            for definition in defs:
                if definition is None:
                    continue
                for node in definition["graph"]["nodes"]:
                    if (
                        node["type"] == "subflow"
                        and node["params"].get("subflow_id") == workflow_id
                    ):
                        caller_ids.add(definition["id"])
        return len(caller_ids)

    def library(
        self, *, query="", status="", camera="", engine="", mode="", sort="name", page=1, size=25
    ):
        if sort not in ("name", "name_desc", "enabled"):
            raise ValueError("Invalid workflow sort")
        if mode not in ("", "independent", "callable", "both"):
            raise ValueError("Invalid workflow mode")
        page = max(1, page)
        size = min(50, max(1, size))
        with self._lock:
            rows = self._summary_cache
            words = query.casefold().split()
            rows = [
                item
                for item in rows
                if all(
                    word
                    in " ".join(
                        (item["id"], item["name"], *item["camera_ids"], *item["engines"])
                    ).casefold()
                    for word in words
                )
            ]
            rows = [
                item
                for item in rows
                if status not in ("enabled", "disabled", "empty")
                or (
                    item["enabled"]
                    if status == "enabled"
                    else not item["enabled"]
                    if status == "disabled"
                    else item["node_count"] == 0
                )
            ]
            rows = [item for item in rows if not camera or camera in item["camera_ids"]]
            rows = [item for item in rows if not engine or engine in item["engines"]]
            rows = [
                item
                for item in rows
                if not mode
                or item["execution_mode"] == mode
                or (mode in ("independent", "callable") and item["execution_mode"] == "both")
            ]
            if sort == "name_desc":
                rows.sort(key=lambda item: item["id"])
                rows.sort(key=lambda item: item["name"].casefold(), reverse=True)
            elif sort == "enabled":
                rows.sort(
                    key=lambda item: (not item["enabled"], item["name"].casefold(), item["id"])
                )
            total = len(rows)
            pages = max(1, (total + size - 1) // size)
            page = min(page, max(1, pages))
            return {
                "items": copy.deepcopy(rows[(page - 1) * size : page * size]),
                "total": total,
                "pages": pages,
                "page": page,
                "size": size,
                "counts": self._workflow_counts(),
                "storage_error": self._storage_error,
            }

    def get(self, workflow_id: str) -> dict[str, Any]:
        with self._lock:
            graph = self._graphs.get(workflow_id)
            if graph is None:
                raise KeyError(workflow_id)
            return copy.deepcopy(graph)

    def rename(self, workflow_id: str, name: str) -> dict[str, Any]:
        if not isinstance(name, str) or not name.strip() or len(name) > 128:
            raise ValueError("Invalid workflow name")
        with self._lock:
            graph = self._graphs.get(workflow_id)
            if graph is None:
                raise KeyError(workflow_id)
            if self._storage_error:
                raise RuntimeError("Workflow storage is unavailable")
            previous = graph["name"]
            graph["name"] = name
            try:
                self._persist()
            except Exception:
                graph["name"] = previous
                raise
            self._rebuild_summary_cache()
            return copy.deepcopy(graph)

    def debug(self, workflow_id: str | None = None) -> dict[str, Any]:
        """Latest execution counters only; never store frames or detection payloads."""
        with self._lock:
            result = {}
            if workflow_id is not None and workflow_id not in self._graphs:
                raise KeyError(workflow_id)
            graphs = (
                self._graphs.items()
                if workflow_id is None
                else ((workflow_id, self._graphs[workflow_id]),)
            )
            for ident, graph in graphs:
                entry = copy.deepcopy(self._debug.get(ident, {"nodes": {}, "updated_at": None}))
                current = {node["id"] for node in graph["nodes"]}
                entry["nodes"] = {
                    key: value for key, value in entry["nodes"].items() if key in current
                }
                entry["enabled"] = graph["enabled"]
                result[ident] = entry
            return {"workflows": result}

    def model_usage(self) -> dict[str, list[str]]:
        """Read one consistent usage snapshot for a whole model-library request."""
        with self._lock:
            if self._storage_error is not None:
                raise RuntimeError("Workflow storage is unreadable; model use cannot be checked")
            try:
                persisted = self._load()
            except (OSError, ValueError) as error:
                raise RuntimeError(
                    "Workflow storage is unreadable; model use cannot be checked"
                ) from error
            references: dict[str, list[str]] = {}
            for graph in [*self._graphs.values(), *persisted.values()]:
                for node in graph["nodes"]:
                    if node["type"] in ("model", "classifier"):
                        ident = node["params"].get("model_id")
                        if ident:
                            references.setdefault(ident, []).append(
                                f"Workflow {graph['name']} / node {node['id']}"
                            )
            if self.subflows.storage_error:
                raise RuntimeError("Subflow catalog is unreadable; model use cannot be checked")
            for subflow_id, versions in self.subflows._items.items():
                for definition in versions:
                    if definition is None:
                        continue
                    for node in definition["graph"]["nodes"]:
                        if node["type"] not in ("model", "classifier"):
                            continue
                        ident = node["params"].get("model_id")
                        if ident:
                            references.setdefault(ident, []).append(
                                f"Subflow {subflow_id} v{definition['version']} / node {node['id']}"
                            )
            return {ident: list(dict.fromkeys(rows)) for ident, rows in references.items()}

    def model_references(self, model_id: str) -> list[str]:
        """Include live graphs and workflows saved by another local instance."""
        return self.model_usage().get(model_id, [])

    def notifications(self) -> dict[str, Any]:
        """Return current-process notifications and session identity for client deduplication."""
        with self._lock:
            return {
                "session_id": self._session_id,
                "notifications": copy.deepcopy(
                    [event for event in self._events if event.get("kind") == "notification"][-100:]
                ),
                "activities": [
                    {
                        "id": event.get("id")
                        or (
                            f"{event.get('workflow_id')}|{event.get('camera_id')}|"
                            f"{event.get('created_at')}"
                        ),
                        "camera_id": event.get("camera_id"),
                        "created_at": event.get("created_at"),
                    }
                    for event in self._events[-100:]
                ],
            }

    @staticmethod
    def catalog() -> list[dict[str, Any]]:
        catalog = [
            {
                "type": "classifier",
                "inputs": [],
                "outputs": ["classifier"],
                "params": {
                    "model_id": {"type": "string", "default": ""},
                    "threshold": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.5},
                    "confirmations": {"type": "integer", "minimum": 1, "maximum": 15, "default": 3},
                    "switch_confirmations": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 30,
                        "default": 5,
                    },
                    "margin": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.15},
                    "output": {
                        "type": "string",
                        "enum": ["probabilities", "logits"],
                        "default": "probabilities",
                    },
                    "preprocessing": {
                        "type": "string",
                        "enum": ["arcface", "embedded"],
                        "default": "arcface",
                    },
                },
            },
            {
                "type": "camera",
                "inputs": [],
                "outputs": ["camera"],
                "params": {"camera_id": {"type": "string", "default": ""}},
            },
            {"type": "preview", "inputs": ["camera", "detections"], "outputs": [], "params": {}},
            {
                "type": "model",
                "inputs": [],
                "outputs": ["model"],
                "params": {"model_id": {"type": "string", "default": ""}},
            },
            {
                "type": "detections",
                "inputs": ["camera", "model", "classifier", "detections"],
                "outputs": ["detections"],
                "params": {
                    "engine": {"type": "string", "enum": ["any", *_ENGINES], "default": "any"},
                    "detector": {
                        "type": "string",
                        "default": "scrfd-500mf",
                        "enum": [
                            "scrfd-500mf",
                            "scrfd-2.5gf",
                            "scrfd-10gf",
                            "retinaface",
                            "custom",
                        ],
                    },
                },
            },
            {
                "type": "filter",
                "inputs": ["detections"],
                "outputs": ["detections"],
                "params": {
                    "label": {"type": "string", "default": ""},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1, "default": 0},
                    "identity": {"type": "string", "default": ""},
                    "identity_source": {
                        "type": "string",
                        "enum": ["identity", "class"],
                        "default": "identity",
                    },
                    "match": {"type": "string", "enum": ["all", "any"], "default": "all"},
                    "rules": {"type": "array", "maximum": 32},
                },
            },
            {
                "type": "zone",
                "params": {
                    "roi": {"type": "array", "items": 4, "format": "xyxy", "normalized": True}
                },
            },
            {"type": "count", "params": {"minimum": {"type": "integer", "minimum": 1}}},
            {
                "type": "cooldown",
                "params": {
                    "seconds": {"type": "number", "minimum": 1, "maximum": 3600, "default": 10}
                },
            },
            {
                "type": "event",
                "params": {
                    "message": {"type": "string", "maximum": 500},
                    "name_pattern": {
                        "type": "string",
                        "maximum": 200,
                        "default": "{workflow} · {camera} · {date} {time}",
                    },
                    "attachment": {
                        "type": "string",
                        "enum": ["none", "capture", "recording"],
                        "default": "none",
                    },
                    "duration_seconds": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 300,
                        "default": 10,
                    },
                    "pre_event_seconds": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 30,
                        "default": 0,
                    },
                },
            },
            {
                "type": "notification",
                "params": {
                    "title": {
                        "type": "string",
                        "minimum": 1,
                        "maximum": 128,
                        "default": "SpyDER detection",
                    },
                    "message": {
                        "type": "string",
                        "minimum": 1,
                        "maximum": 500,
                        "default": "Matching face detected",
                    },
                },
            },
            {"type": "capture", "params": {}},
            {"type": "record", "params": {"action": {"type": "string", "enum": ["start", "stop"]}}},
            {
                "type": "code",
                "params": {
                    "language": {
                        "type": "string",
                        "enum": ["python", "javascript"],
                        "default": "python",
                    },
                    "source": {"type": "string", "maximum": 8000, "default": "output = detections"},
                },
            },
        ]
        port_types = {
            "preview": (["camera", "detections"], []),
            "camera": ([], ["camera"]),
            "model": ([], ["model"]),
            "classifier": ([], ["classifier"]),
            "detections": (["camera", "model", "classifier", "detections"], ["detections"]),
        }
        for item in catalog:
            inputs, outputs = port_types.get(item["type"], (["detections"], ["detections"]))
            item["inputs"] = inputs
            item["outputs"] = outputs
        return catalog

    def activation_preview(self, graph: dict[str, Any]) -> dict[str, Any]:
        """Validate graph and show camera changes before activation; never mutate state."""
        normalized = self.compile_graph(_validate_graph(graph))
        with self._lock:
            if normalized["enabled"]:
                self._validate_complete_sources(normalized)
            options = self._prepare_model_bindings(normalized) if normalized["enabled"] else {}
            target_cameras = self._camera_ids(normalized)
            nodes = {node["id"]: node for node in normalized["nodes"]}
            face_cameras = {
                camera_id
                for camera_id, settings in options.items()
                if settings.get("engine") == "insightface"
            }
            for node in normalized["nodes"]:
                if node["type"] != "detections":
                    continue
                engine = node["params"].get("engine", "any")
                if engine == "insightface":
                    camera_sources = [
                        nodes[edge["from"]]["params"].get("camera_id", "")
                        for edge in normalized["edges"]
                        if edge["to"] == node["id"] and edge.get("input") == "camera"
                    ]
                    face_cameras.update(
                        camera_id
                        for camera_id in camera_sources
                        if camera_id and camera_id not in options
                    )
                    if not camera_sources:
                        face_cameras.update(
                            camera_id
                            for camera_id in normalized["camera_ids"]
                            if camera_id not in options
                        )
            cameras = []
            for camera_id in target_cameras if normalized["enabled"] else []:
                try:
                    worker = self._camera_worker(camera_id)
                except ValueError:
                    if camera_id in options:
                        raise
                    worker = None
                config = getattr(worker, "config", None)
                pipeline = getattr(config, "pipeline", "none")
                current = getattr(config, "vision", None)
                if current is not None and not isinstance(current, dict):
                    current = vars(current)
                target_engine = options.get(camera_id, {}).get("engine")
                if (
                    camera_id in face_cameras
                    and camera_id not in options
                    and (pipeline != "vision" or (current or {}).get("engine") != "insightface")
                ):
                    raise ValueError(
                        f"InsightFace detection on camera {camera_id} requires an active "
                        "InsightFace vision pipeline or a bound InsightFace model"
                    )
                if target_engine is None:
                    target_engine = (current or {}).get("engine")
                analysis = getattr(config, "analysis", None)
                analysis_data = (
                    analysis
                    if isinstance(analysis, dict)
                    else vars(analysis)
                    if analysis is not None
                    else {}
                )
                motion_enabled = bool(analysis_data.get("enabled", False))
                replaces_motion = pipeline == "motion" and camera_id in options
                face_engine = camera_id in face_cameras or target_engine == "insightface"
                cameras.append(
                    {
                        "id": camera_id,
                        "name": getattr(config, "name", "") or camera_id,
                        "current_pipeline": pipeline,
                        "target_engine": target_engine,
                        "motion_enabled": motion_enabled,
                        "replaces_motion_pipeline": replaces_motion,
                        "disable_motion": face_engine and motion_enabled,
                    }
                )
            return {
                "cameras": cameras,
                "requires_motion_confirmation": any(item["disable_motion"] for item in cameras),
            }

    def set_enabled(
        self,
        workflow_id: str,
        enabled: bool,
        expected: dict[str, Any],
        *,
        disable_motion: bool = False,
    ) -> dict[str, Any]:
        """Change only the saved activation state, rejecting a stale library review."""
        if (
            type(enabled) is not bool
            or type(disable_motion) is not bool
            or not isinstance(expected, dict)
        ):
            raise ValueError("Send enabled state and the reviewed saved workflow")
        with self._lock:
            current = self._graphs.get(workflow_id)
            if current is None:
                raise KeyError(workflow_id)
            if current != expected:
                raise ValueError("Workflow changed since review. Refresh and try again.")
            if current["enabled"] == enabled:
                return copy.deepcopy(current)
            return self.save({**current, "enabled": enabled}, disable_motion=disable_motion)

    def save(self, graph: dict[str, Any], *, disable_motion: bool = False) -> dict[str, Any]:
        if type(disable_motion) is not bool:
            raise ValueError("disable_motion must be boolean")
        normalized = _validate_graph(graph)
        if normalized.get("execution") is None and any(
            node["type"] in ("subflow_input", "subflow_output") for node in normalized["nodes"]
        ):
            raise ValueError("Input and output bridge nodes belong in subflow definitions")
        with self._lock:
            latest_version = self._latest_callable_version(normalized["id"])
            if latest_version is None:
                normalized.pop("callable_version", None)
            else:
                normalized["callable_version"] = latest_version
            compiled = self.compile_graph(normalized)
            if self._storage_error:
                raise RuntimeError("Workflow storage is unavailable")
            if normalized["id"] not in self._graphs and len(self._graphs) >= _MAX_WORKFLOWS:
                raise ValueError("Workflow limit exceeded")
            snapshot = self._graphs.copy()
            previous = self._graphs.get(normalized["id"])
            if (
                normalized.get("execution")
                and not normalized["execution"]["run_independently"]
                and normalized["enabled"]
            ):
                raise ValueError("Callable-only workflows cannot be enabled independently")
            if (
                previous
                and previous.get("execution", {}).get("allow_calls")
                and not normalized.get("execution", {}).get("allow_calls", False)
                and self._callers(normalized["id"])
            ):
                raise ValueError(
                    "Workflow is referenced by callers; allow_calls cannot be disabled"
                )
            old_settings: dict[str, dict[str, Any] | None] = {}
            options: dict[str, dict[str, Any]] = {}
            old_analysis: dict[str, dict[str, Any]] = {}
            preview = (
                self.activation_preview(normalized) if normalized["enabled"] else {"cameras": []}
            )
            affected = [item for item in preview["cameras"] if item["disable_motion"]]
            if affected and not disable_motion:
                names = ", ".join(item["name"] for item in affected)
                raise ValueError(f"Enabling InsightFace will disable motion analysis on: {names}")
            if normalized["enabled"]:
                self._validate_complete_sources(compiled)
                options = self._prepare_model_bindings(compiled)
                old_settings = self._snapshot_vision_settings(options)
                for item in affected:
                    camera_id = item["id"]
                    worker = self._camera_worker(camera_id)
                    analysis = getattr(getattr(worker, "config", None), "analysis", None)
                    if analysis is not None:
                        old_analysis[camera_id] = copy.deepcopy(
                            analysis if isinstance(analysis, dict) else vars(analysis)
                        )
                try:
                    self._apply_model_bindings(options, old_settings)
                    for camera_id, settings in old_analysis.items():
                        self.manager.set_analysis(camera_id, {**settings, "enabled": False})
                except Exception:
                    self._restore_activation_settings(old_settings, old_analysis)
                    raise
            self._graphs[normalized["id"]] = normalized
            try:
                self._persist()
            except Exception:
                self._graphs = snapshot
                self._restore_activation_settings(old_settings, old_analysis)
                raise
            self._rebuild_summary_cache()
            if previous is None or any(
                previous.get(key) != normalized.get(key) for key in ("nodes", "edges", "camera_ids")
            ):
                self._debug.pop(normalized["id"], None)
            for camera_id in options:
                self._seen.pop(camera_id, None)
            if previous and previous["enabled"] and not normalized["enabled"]:
                self._release_workflow_recordings(normalized["id"])
                self._clear_graph_state(normalized["id"])
            self._sync_inference_demand()
            self._sync_pre_event_buffer()
            return copy.deepcopy(normalized)

    @staticmethod
    def _node_model_bindings(graph: dict[str, Any]) -> dict[str, str]:
        nodes = {node["id"]: node for node in graph["nodes"]}
        result: dict[str, str] = {}
        for edge in graph["edges"]:
            if edge.get("input") != "model":
                continue
            model = nodes[edge["from"]]["params"]["model_id"]
            detection_id = edge["to"]
            connected_cameras = [
                nodes[incoming["from"]]["params"].get("camera_id", "")
                for incoming in graph["edges"]
                if incoming["to"] == detection_id and incoming.get("input") == "camera"
            ]
            camera_ids = [value for value in connected_cameras if value]
            if not connected_cameras:
                camera_ids = graph["camera_ids"]
            for camera in camera_ids:
                if model and camera:
                    prior = result.get(camera)
                    if prior and prior != model:
                        raise ValueError(f"Conflicting models target camera {camera}")
                    result[camera] = model
        return result

    def _model_descriptor(self, model_id: str) -> dict[str, Any]:
        if model_id.startswith("gallery-"):
            if self.face_galleries is None:
                raise ValueError("Face galleries are unavailable in this application")
            gallery_id = model_id.removeprefix("gallery-")
            config = self.face_galleries.config(gallery_id)
            gallery = self.face_galleries.descriptor(gallery_id)
            return {
                "id": model_id,
                "name": gallery["name"],
                "engine": "insightface",
                "path": config["recognition_model"],
                "classes": gallery["classes"],
                "settings": {},
                "metadata": {"model_type": "face_gallery"},
                "identity_gallery": config["identity_gallery"],
            }
        if model_id in _BUILTIN_MODELS:
            return {
                "id": model_id,
                "engine": "insightface",
                "path": self.detector_catalog.resolve(_BUILTIN_MODELS[model_id]),
                "classes": ["face"],
                "settings": {},
                "metadata": {"model_type": "face_detection"},
            }
        if self.model_library is None:
            raise ValueError("Model library is unavailable")
        descriptor = self.model_library.get(model_id)
        if descriptor is None:
            raise ValueError(f"Unknown model {model_id}")
        if not isinstance(descriptor, dict):
            descriptor = vars(descriptor)
        required = {"id", "engine", "path", "classes", "settings"}
        if (
            not required <= set(descriptor)
            or descriptor["id"] != model_id
            or descriptor["engine"] not in _ENGINES
            or (descriptor["path"] is not None and not isinstance(descriptor["path"], str))
            or not isinstance(descriptor["classes"], list)
            or any(not isinstance(name, str) for name in descriptor["classes"])
            or not isinstance(descriptor["settings"], dict)
            or any(not isinstance(key, str) for key in descriptor["settings"])
        ):
            raise ValueError(f"Invalid model descriptor {model_id}")
        return copy.deepcopy(descriptor)

    @staticmethod
    def _validate_complete_sources(graph: dict[str, Any]) -> None:
        nodes = {node["id"]: node for node in graph["nodes"]}
        camera_sources, model_sources = set(), set()
        model_inputs: dict[tuple[str, str], int] = {}
        for edge in graph["edges"]:
            if edge.get("input") == "camera":
                camera_sources.add(edge["from"])
            elif edge.get("input") in ("model", "classifier"):
                model_sources.add(edge["from"])
                key = (edge["to"], edge.get("input"))
                model_inputs[key] = model_inputs.get(key, 0) + 1
        for node_id in camera_sources:
            if not nodes[node_id]["params"]["camera_id"]:
                raise ValueError(f"Camera node {node_id} needs a camera selection")
        for node_id in model_sources:
            if not nodes[node_id]["params"]["model_id"]:
                raise ValueError(f"Model node {node_id} needs a model selection")
        if any(count > 1 for count in model_inputs.values()):
            raise ValueError("Each detections node can receive only one model")

    def _prepare_model_bindings(self, graph: dict[str, Any]) -> dict[str, dict[str, Any]]:
        graph = self.compile_graph(graph)
        self._node_pipeline_signatures(graph)
        bindings = self._node_model_bindings(graph)
        for other in self._graphs.values():
            if not other["enabled"] or other["id"] == graph["id"]:
                continue
            for camera, model in self._node_model_bindings(self.compile_graph(other)).items():
                if camera in bindings and bindings[camera] != model:
                    raise ValueError(f"Conflicting models target camera {camera}")
        options_by_camera: dict[str, dict[str, Any]] = {}
        for camera_id, model_id in bindings.items():
            descriptor = self._model_descriptor(model_id)
            if descriptor.get("metadata", {}).get("model_type") in (
                "face_classifier",
                "face_gallery",
            ):
                raise ValueError(
                    "This model is a face identity classifier. Its labels are readable, but "
                    "use it in an InsightFace Classifier node connected to CLASSIFIER IN. "
                    "Select a face detection model for MODEL IN."
                )
            options = dict(descriptor["settings"])
            options["engine"] = descriptor["engine"]
            if descriptor["engine"] == "opencv":
                options.pop("model", None)
            else:
                options["model"] = descriptor["path"]
            try:
                if (
                    descriptor["engine"] == "insightface"
                    and options.get("recognition_model") is None
                    and options.get("identity_gallery") is None
                ):
                    worker = self._camera_worker(camera_id)
                    current = getattr(getattr(worker, "config", None), "vision", None)
                    if current is not None and not isinstance(current, dict):
                        current = vars(current)
                    if (
                        isinstance(current, dict)
                        and current.get("engine") == "insightface"
                        and str(current.get("model") or "") == str(descriptor["path"] or "")
                        and current.get("recognition_model") is not None
                        and current.get("identity_gallery") is not None
                    ):
                        for key in (
                            "recognition_model",
                            "identity_gallery",
                            "recognition_threshold",
                        ):
                            if key in current:
                                options[key] = current[key]
                VisionConfig(**options)
                self._camera_worker(camera_id)
            except (TypeError, ValueError, KeyError, AttributeError) as exc:
                raise ValueError(
                    f"Cannot configure model {model_id} on camera {camera_id}"
                ) from exc
            options_by_camera[camera_id] = options
        nodes = {node["id"]: node for node in graph["nodes"]}
        for node in graph["nodes"]:
            if node["type"] != "detections":
                continue
            incoming = [edge for edge in graph["edges"] if edge["to"] == node["id"]]
            model_edges = [edge for edge in incoming if edge.get("input") == "model"]
            classifier_edges = [edge for edge in incoming if edge.get("input") == "classifier"]
            camera_edges = [edge for edge in incoming if edge.get("input") == "camera"]
            if node["params"]["engine"] == "opencv" and not model_edges:
                # The built-in person detector needs no external weights or manual
                # camera pipeline panel. Explicit OpenCV nodes configure it on enable.
                camera_ids = (
                    [nodes[edge["from"]]["params"]["camera_id"] for edge in camera_edges]
                    if camera_edges
                    else graph["camera_ids"]
                )
                for camera_id in camera_ids:
                    worker = self._camera_worker(camera_id)
                    current = getattr(getattr(worker, "config", None), "vision", None)
                    if current is not None and not isinstance(current, dict):
                        current = vars(current)
                    options = (
                        dict(current)
                        if current and current.get("engine") == "opencv"
                        else {"engine": "opencv"}
                    )
                    prior = options_by_camera.get(camera_id)
                    if prior and VisionConfig(**prior) != VisionConfig(**options):
                        raise ValueError(f"Conflicting models target camera {camera_id}")
                    options_by_camera[camera_id] = options
            if node["params"]["engine"] != "insightface":
                continue
            if "detector" not in node["params"] and not model_edges and not classifier_edges:
                # Legacy nodes observe the camera's existing model pipeline.
                continue
            camera_ids = (
                [nodes[edge["from"]]["params"]["camera_id"] for edge in camera_edges]
                if camera_edges
                else graph["camera_ids"]
            )
            detector = node["params"].get("detector", "custom" if model_edges else "scrfd-500mf")
            if model_edges and detector not in ("custom", "retinaface"):
                raise ValueError("Choose Custom detector when connecting a detector Model node")
            if not model_edges and detector in ("custom", "retinaface"):
                raise ValueError("Connect a local detector Model node to MODEL IN")
            classifier = None
            if classifier_edges:
                classifier = nodes[classifier_edges[0]["from"]]["params"]
                descriptor = self._model_descriptor(classifier["model_id"])
                if descriptor.get("metadata", {}).get("model_type") == "face_gallery":
                    # Activation is a trust boundary. Evaluation uses cached metadata,
                    # but enabling a workflow must verify the model bytes again.
                    self.face_galleries.config(
                        classifier["model_id"].removeprefix("gallery-"), verify_models=True
                    )
                if (
                    descriptor["engine"] != "insightface"
                    or descriptor.get("metadata", {}).get("model_type")
                    not in ("face_classifier", "face_gallery")
                    or (
                        descriptor.get("metadata", {}).get("model_type") == "face_classifier"
                        and not descriptor["classes"]
                    )
                ):
                    raise ValueError(
                        "Classifier node requires an InsightFace identity classifier "
                        "with class labels"
                    )
            for camera_id in camera_ids:
                if model_edges:
                    options = dict(options_by_camera[camera_id])
                    if options["engine"] != "insightface":
                        raise ValueError(
                            "InsightFace Detections requires an InsightFace detector model"
                        )
                else:
                    options = {
                        "engine": "insightface",
                        "model": self.detector_catalog.resolve(detector),
                    }
                if (
                    classifier
                    and descriptor.get("metadata", {}).get("model_type") == "face_gallery"
                ):
                    for key in (
                        "classifier_model",
                        "classifier_labels",
                        "classifier_threshold",
                        "classifier_output",
                        "classifier_preprocessing",
                    ):
                        options.pop(key, None)
                    options.update(
                        recognition_model=descriptor["path"],
                        identity_gallery=descriptor["identity_gallery"],
                        recognition_threshold=classifier["threshold"],
                        classifier_confirmation_frames=classifier["confirmations"],
                        classifier_switch_frames=classifier["switch_confirmations"],
                    )
                elif classifier:
                    # An explicit classifier replaces gallery recognition.
                    for key in ("recognition_model", "identity_gallery", "recognition_threshold"):
                        options.pop(key, None)
                    options.update(
                        classifier_model=descriptor["path"],
                        classifier_labels=tuple(descriptor["classes"]),
                        classifier_threshold=classifier["threshold"],
                        classifier_output=classifier["output"],
                        classifier_preprocessing=classifier["preprocessing"],
                        classifier_confirmation_frames=classifier["confirmations"],
                        classifier_switch_frames=classifier["switch_confirmations"],
                        classifier_min_margin=classifier["margin"],
                    )
                VisionConfig(**options)
                self._camera_worker(camera_id)
                prior = options_by_camera.get(camera_id)
                if prior and not model_edges and prior != options:
                    raise ValueError(f"Conflicting models target camera {camera_id}")
                options_by_camera[camera_id] = options
        # Compare complete configurations, including classifier settings and built-in detectors.
        for other in self._graphs.values():
            if other["enabled"] and other["id"] != graph["id"]:
                for camera_id, signature in self._node_pipeline_signatures(
                    self.compile_graph(other)
                ).items():
                    current = self._node_pipeline_signatures(graph).get(camera_id)
                    if current is not None and current != signature:
                        raise ValueError(f"Conflicting models target camera {camera_id}")
        return options_by_camera

    @staticmethod
    def _node_pipeline_signatures(graph: dict[str, Any]) -> dict[str, str]:
        nodes = {node["id"]: node for node in graph["nodes"]}
        result = {}
        for node in graph["nodes"]:
            if node["type"] != "detections":
                continue
            incoming = [edge for edge in graph["edges"] if edge["to"] == node["id"]]
            models = [
                nodes[edge["from"]]["params"] for edge in incoming if edge.get("input") == "model"
            ]
            classifiers = [
                nodes[edge["from"]]["params"]
                for edge in incoming
                if edge.get("input") == "classifier"
            ]
            if not models and (
                node["params"]["engine"] not in ("opencv", "insightface")
                or (
                    node["params"]["engine"] == "insightface"
                    and "detector" not in node["params"]
                    and not classifiers
                )
            ):
                continue
            builtin = (
                (
                    "opencv"
                    if node["params"]["engine"] == "opencv"
                    else node["params"].get("detector", "scrfd-500mf")
                )
                if not models
                else None
            )
            if len(models) == 1 and models[0].get("model_id") in _BUILTIN_MODELS:
                builtin = _BUILTIN_MODELS[models[0]["model_id"]]
                models = []
            signature = json.dumps([builtin, models, classifiers], sort_keys=True)
            cameras = [
                nodes[edge["from"]]["params"]["camera_id"]
                for edge in incoming
                if edge.get("input") == "camera"
            ]
            for camera in cameras or graph["camera_ids"]:
                if camera in result and result[camera] != signature:
                    raise ValueError(f"Conflicting models target camera {camera}")
                result[camera] = signature
        return result

    def _camera_worker(self, camera_id: str) -> Any:
        getter = getattr(self.manager, "get_worker", None)
        try:
            worker = getter(camera_id) if callable(getter) else self.manager.workers[camera_id]
        except Exception as exc:
            raise ValueError(f"Camera {camera_id} is unavailable for model binding") from exc
        if worker is None:
            raise ValueError(f"Camera {camera_id} is unavailable for model binding")
        return worker

    def _snapshot_vision_settings(
        self, options: dict[str, dict[str, Any]]
    ) -> dict[str, dict[str, Any]]:
        previous: dict[str, dict[str, Any]] = {}
        for camera_id in options:
            worker = self._camera_worker(camera_id)
            config = getattr(worker, "config", None)
            snapshot = getattr(worker, "vision_snapshot", None)
            if callable(snapshot):
                settings = snapshot().get("settings")
            else:
                settings = getattr(config, "vision", None)
            if settings is not None and not isinstance(settings, dict):
                settings = vars(settings)
            previous[camera_id] = {
                "config": copy.deepcopy(config),
                "settings": copy.deepcopy(settings),
            }
        return previous

    def _apply_model_bindings(
        self, options: dict[str, dict[str, Any]], previous: dict[str, dict[str, Any]]
    ) -> None:
        applied: list[str] = []
        try:
            for camera_id, settings in options.items():
                applied.append(camera_id)
                self.manager.set_vision(camera_id, settings)
        except Exception:
            try:
                self._restore_vision_settings({key: previous[key] for key in applied})
            except Exception as rollback_error:
                raise RuntimeError(
                    "Model binding failed and prior camera configuration could not be restored"
                ) from rollback_error
            raise

    def _restore_vision_settings(self, previous: dict[str, dict[str, Any]]) -> None:
        errors = []
        restore_config = getattr(self.manager, "restore_vision", None)
        for camera_id, state in reversed(list(previous.items())):
            try:
                if callable(restore_config) and state["config"] is not None:
                    restore_config(camera_id, state["config"])
                else:
                    self.manager.set_vision(camera_id, state["settings"])
            except Exception as exc:
                errors.append(exc)
        if errors:
            raise RuntimeError("Could not restore prior camera model configuration") from errors[0]

    def _restore_activation_settings(self, vision: dict, analysis: dict) -> None:
        errors = []
        for restore, settings in (
            (self._restore_vision_settings, vision),
            (self._restore_analysis_settings, analysis),
        ):
            if settings:
                try:
                    restore(settings)
                except Exception as error:
                    errors.append(error)
        if errors:
            raise RuntimeError("Could not fully restore prior camera configuration") from errors[0]

    def _restore_analysis_settings(self, previous: dict[str, dict[str, Any]]) -> None:
        errors = []
        for camera_id, settings in reversed(list(previous.items())):
            try:
                self.manager.set_analysis(camera_id, settings)
            except Exception as exc:
                errors.append(exc)
        if errors:
            raise RuntimeError("Could not restore prior motion analysis configuration") from errors[
                0
            ]

    def remove(self, workflow_id: str) -> None:
        if not isinstance(workflow_id, str) or not _ID.fullmatch(workflow_id):
            raise ValueError("Invalid workflow id")
        with self._lock:
            if self._storage_error:
                raise RuntimeError("Workflow storage is unavailable")
            if self._callers(workflow_id):
                raise ValueError("Workflow is referenced by a saved workflow or pinned snapshot")
            snapshot = self._graphs.copy()
            callable_snapshot = workflow_id in self.subflows._items
            prior_subflows = copy.deepcopy(self.subflows._items) if callable_snapshot else None
            if callable_snapshot:
                self.subflows.delete(workflow_id)
            self._graphs.pop(workflow_id, None)
            try:
                self._persist()
            except Exception:
                self._graphs = snapshot
                if callable_snapshot:
                    try:
                        self.subflows._write(prior_subflows)
                        self.subflows._items = prior_subflows
                    except Exception as restore_error:
                        self._storage_error = (
                            "Could not restore callable snapshots after workflow deletion"
                        )
                        raise RuntimeError(self._storage_error) from restore_error
                raise
            self._rebuild_summary_cache()
            self._release_workflow_recordings(workflow_id)
            self._clear_graph_state(workflow_id)
            self._debug.pop(workflow_id, None)
            self._sync_inference_demand()
            self._sync_pre_event_buffer()

    def _transfer_event_clip(self, session_id: str) -> None:
        self._event_clip_transferred.add(session_id)
        cancel = getattr(self.recorder, "cancel_event_limit", None)
        if cancel is not None:
            cancel(session_id)

    def relinquish_recording(self, camera_ids: list[str]) -> None:
        """Transfer selected recording memberships to manual recorder control."""
        if (
            not isinstance(camera_ids, list)
            or len(camera_ids) > 64
            or any(
                not isinstance(camera_id, str) or not _ID.fullmatch(camera_id)
                for camera_id in camera_ids
            )
        ):
            raise ValueError("camera_ids must be a list of valid camera ids")
        with self._lock:
            for camera_id in set(camera_ids):
                self._record_owned.pop(camera_id, None)

    def manual_recording(self, action: str, camera_ids: list[str] | None = None) -> dict[str, Any]:
        """Apply manual recording changes atomically with workflow recording actions."""
        if action not in ("start", "select", "stop"):
            raise ValueError("Invalid manual recording action")
        if action == "stop":
            if camera_ids is not None:
                raise ValueError("stop does not accept camera_ids")
            with self._lock:
                session_id = self.recorder.status().get("session_id")
                memberships = list(self.recorder.status().get("camera_ids", []))
                result = self.recorder.stop()
                if session_id in self._event_clip_sessions:
                    self._transfer_event_clip(session_id)
                self.relinquish_recording(memberships)
                return result
        if (
            not isinstance(camera_ids, list)
            or len(camera_ids) > 64
            or any(
                not isinstance(camera_id, str) or not _ID.fullmatch(camera_id)
                for camera_id in camera_ids
            )
        ):
            raise ValueError("camera_ids must be a list of valid camera ids")
        with self._lock:
            session_id = self.recorder.status().get("session_id")
            previous = list(self.recorder.status().get("camera_ids", []))
            result = (
                self.recorder.start(camera_ids)
                if action == "start"
                else self.recorder.select(camera_ids)
            )
            if session_id in self._event_clip_sessions:
                self._transfer_event_clip(session_id)
            transferred = camera_ids if action == "start" else [*previous, *camera_ids]
            self.relinquish_recording(transferred)
            return result

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self._path.exists():
            return {}
        if self._path.stat().st_size > _MAX_WORKFLOW_BYTES:
            raise ValueError("Workflow file exceeds 64 MiB")
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if (
                not isinstance(data, dict)
                or set(data) != {"workflows"}
                or not isinstance(data["workflows"], list)
                or len(data["workflows"]) > _MAX_WORKFLOWS
            ):
                raise ValueError("Invalid workflow file")
            graphs = [_validate_graph(item) for item in data["workflows"]]
            if len({g["id"] for g in graphs}) != len(graphs):
                raise ValueError("Duplicate workflow id")
            return {g["id"]: g for g in graphs}
        except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
            raise ValueError("Cannot load workflow file") from exc

    def _persist(self) -> None:
        payload = json.dumps(
            {"workflows": list(self._graphs.values())}, ensure_ascii=False, indent=2
        ).encode("utf-8")
        if len(payload) > _MAX_WORKFLOW_BYTES:
            raise ValueError("Workflow file exceeds 64 MiB")
        fd, temp_name = tempfile.mkstemp(prefix=".workflows-", suffix=".tmp", dir=self.storage_dir)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            for attempt in range(6):
                try:
                    os.replace(temp_name, self._path)
                    break
                except PermissionError as error:
                    # Windows scanners may briefly hold a freshly written JSON file.
                    if getattr(error, "winerror", None) not in (32, 33) or attempt == 5:
                        raise
                    time.sleep(0.02 * 2**attempt)
        finally:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass

    def _run(self) -> None:
        while not self._stop.wait(0.25):
            try:
                self._tick()
            except Exception:
                continue

    def _tick(self, now: float | None = None) -> None:
        with self._lock:
            now = time.monotonic() if now is None else now
            statuses = {
                item.get("id"): item
                for item in self.manager.statuses()
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            self._tick_locked(statuses, now)

    def _tick_locked(self, statuses: dict[str, dict[str, Any]], now: float) -> None:
        self._poll_motion_events(statuses)
        with self._lock:
            graphs = []
            for graph in self._graphs.values():
                if not self._independent_active(graph):
                    continue
                try:
                    graphs.append(self.compile_graph(copy.deepcopy(graph)))
                except (KeyError, TypeError, ValueError, RuntimeError) as exc:
                    self._report_compile_error(graph, exc)
            self._runtime = {
                graph["id"]: {
                    "state": "enabled" if graph["enabled"] else "disabled",
                    "cameras": {
                        camera_id: {
                            "state": (statuses.get(camera_id) or {}).get("state", "missing"),
                            "cv_state": ((statuses.get(camera_id) or {}).get("metadata") or {})
                            .get("cv", {})
                            .get("state", "unavailable"),
                            "sequence": ((statuses.get(camera_id) or {}).get("metadata") or {})
                            .get("cv", {})
                            .get("sequence"),
                        }
                        for camera_id in self._camera_ids(graph)
                    },
                }
                for graph in graphs
            }
        fresh: dict[str, dict[str, Any]] = {}
        for camera_id in {
            camera_id
            for graph in graphs
            if graph["enabled"]
            for camera_id in self._camera_ids(graph)
        }:
            status = statuses.get(camera_id)
            cv = ((status or {}).get("metadata") or {}).get("cv") or {}
            if (
                not status
                or status.get("state") != "running"
                or cv.get("state") != "ready"
                or not _finite(cv.get("result_age_seconds"))
                or cv["result_age_seconds"] > 2
            ):
                continue
            sequence = cv.get("sequence")
            if type(sequence) is not int:
                continue
            session = (status.get("capture_session"), cv.get("generation"))
            if session == (None, None) and hasattr(self.manager, "workers"):
                session = (id(self.manager.workers.get(camera_id)), None)
            prior = self._seen.get(camera_id)
            if prior is not None and (prior[0] != session or sequence < prior[1]):
                self._last_action = {
                    key: value for key, value in self._last_action.items() if key[1] != camera_id
                }
                self._cooldowns = {
                    key: value for key, value in self._cooldowns.items() if key[1] != camera_id
                }
            elif prior is not None and sequence <= prior[1]:
                continue
            self._seen[camera_id] = (session, sequence)
            fresh[camera_id] = cv
        for graph in graphs:
            if not graph["enabled"]:
                continue
            for camera_id in self._camera_ids(graph):
                if camera_id in fresh:
                    self._evaluate(graph, camera_id, fresh[camera_id], now, statuses.get(camera_id))

    def _poll_motion_events(self, statuses: dict[str, dict[str, Any]]) -> None:
        """Persist one event when fresh native motion changes from quiet to active."""
        for camera_id, status in statuses.items():
            metadata = status.get("metadata") or {}
            analysis = metadata.get("analysis") or {}
            frame_sequence = status.get("frames")
            if (
                not isinstance(analysis, dict)
                or analysis.get("state") != "ready"
                or type(frame_sequence) is not int
                or not _finite(analysis.get("result_age_seconds"))
                or analysis["result_age_seconds"] > 2
            ):
                continue
            session = status.get("capture_session")
            previous = self._motion_state.get(camera_id)
            if previous and previous[0] == session and frame_sequence <= previous[1]:
                continue
            active = bool(analysis.get("region_count", len(analysis.get("regions", []))))
            was_active = bool(previous and previous[0] == session and previous[2])
            self._motion_state[camera_id] = (session, frame_sequence, active)
            if active and not was_active:
                camera_name = status.get("name") or status.get("camera_name") or camera_id
                try:
                    self.event_store.create(
                        name=f"Motion · {camera_name}",
                        kind="motion",
                        camera_id=camera_id,
                        camera_name=camera_name,
                        message="Motion detected",
                    )
                except (OSError, ValueError, RuntimeError):
                    continue

    def export_bundle(self, graph: dict[str, Any]) -> dict[str, Any]:
        return self.features.export_bundle(graph)

    def import_bundle(self, raw: Any) -> dict[str, Any]:
        return self.features.import_bundle(raw)

    def history_detail(self, ident: str) -> dict[str, Any]:
        return self.features.history_detail(ident)

    def replay_history(self, ident: str) -> dict[str, Any]:
        return self.features.replay_history(ident)

    def compile_graph(self, graph: dict[str, Any]) -> dict[str, Any]:
        """Expand pinned subflow calls into evaluator graph with stable internal paths."""
        with self._lock:
            if graph.get("_compiled") is True:
                return self.subflows.compile(graph)
            compiled = self.subflows.compile(_validate_graph(graph))
            _validate_bindings(compiled["nodes"], compiled["edges"])
            return compiled

    def subflow_catalog(self) -> dict[str, Any]:
        """Read one consistent latest-version catalog snapshot."""
        with self._lock:
            return self.subflows.list()

    def publish_subflow(self, raw: Any) -> dict[str, Any]:
        """Publish one immutable version after catalog validation."""
        with self._lock:
            if isinstance(raw, dict) and "id" not in raw:
                raw = {**raw, "id": "subflow-" + uuid.uuid4().hex[:16]}
            if isinstance(raw, dict) and raw.get("id") in self._graphs:
                current = self._graphs[raw["id"]]
                if not current.get("execution", {}).get("allow_calls"):
                    raise ValueError("Workflow ID belongs to a non-callable workflow")
            definition = self.subflows.publish(raw)
            self._store_callable_definition(definition)
            return definition

    def _store_callable_definition(self, definition: dict[str, Any]) -> None:
        ident = definition["id"]
        current = self._graphs.get(ident)
        if current is not None and not current.get("execution", {}).get("allow_calls"):
            self._storage_error = f"Callable workflow ID collision: {ident}"
            raise ValueError(self._storage_error)
        graph = {
            **copy.deepcopy(definition["graph"]),
            "id": ident,
            "name": definition["name"],
            "enabled": current["enabled"] if current else False,
            "camera_ids": current["camera_ids"] if current else [],
            "execution": {
                "run_independently": current.get("execution", {}).get("run_independently", False)
                if current
                else False,
                "allow_calls": True,
                "parameters": copy.deepcopy(definition["parameters"]),
                "description": definition["description"],
            },
            "callable_version": definition["version"],
        }
        self._graphs[ident] = _validate_graph(graph)
        try:
            self._persist()
        except Exception as exc:
            if current is None:
                self._graphs.pop(ident, None)
            else:
                self._graphs[ident] = current
            self._storage_error = str(exc)[:200] or "Callable workflow storage is unavailable"
            raise
        self._rebuild_summary_cache()

    def _callable_snapshot_graph(self, graph: dict[str, Any]) -> dict[str, Any]:
        nodes = {node["id"]: node for node in graph["nodes"]}
        inputs = [node["id"] for node in graph["nodes"] if node["type"] == "subflow_input"]
        outputs = [node["id"] for node in graph["nodes"] if node["type"] == "subflow_output"]
        if len(inputs) != 1 or len(outputs) != 1:
            raise ValueError("Callable workflow requires one input and one output bridge")
        outgoing: dict[str, set[str]] = {ident: set() for ident in nodes}
        incoming: dict[str, set[str]] = {ident: set() for ident in nodes}
        for edge in graph["edges"]:
            outgoing[edge["from"]].add(edge["to"])
            incoming[edge["to"]].add(edge["from"])

        def closure(seed: str, links: dict[str, set[str]]) -> set[str]:
            found, pending = set(), [seed]
            while pending:
                ident = pending.pop()
                if ident in found:
                    continue
                found.add(ident)
                pending.extend(links[ident] - found)
            return found

        keep = closure(inputs[0], outgoing) & closure(outputs[0], incoming)
        if inputs[0] not in keep or outputs[0] not in keep:
            raise ValueError("Workflow input must connect to workflow output")
        if sum(edge["to"] == outputs[0] for edge in graph["edges"]) != 1:
            raise ValueError("Workflow output bridge must have exactly one input")
        for ident in list(keep):
            node = nodes[ident]
            if node["type"] != "detections":
                continue
            keep.update(
                edge["from"]
                for edge in graph["edges"]
                if edge["to"] == ident
                and edge.get("input") in ("model", "classifier")
                and nodes[edge["from"]]["type"] in ("model", "classifier")
            )
        for ident in keep:
            for binding in nodes[ident].get("bindings", {}).values():
                if binding["node"] not in keep:
                    raise ValueError("Callable workflow binding depends on an excluded node")
        snapshot = {
            "id": graph["id"],
            "name": graph["name"],
            "enabled": False,
            "camera_ids": [],
            "nodes": [copy.deepcopy(node) for node in graph["nodes"] if node["id"] in keep],
            "edges": [
                copy.deepcopy(edge)
                for edge in graph["edges"]
                if edge["from"] in keep and edge["to"] in keep
            ],
        }
        return _validate_graph(snapshot, allow_bridges=True)

    def publish_workflow(self, workflow_id: str) -> dict[str, Any]:
        """Publish current saved callable draft as new immutable snapshot."""
        with self._lock:
            graph = self._graphs.get(workflow_id)
            if graph is None:
                raise KeyError(workflow_id)
            execution = graph.get("execution")
            if not execution or not execution["allow_calls"]:
                raise ValueError("Workflow does not allow calls")
            snapshot = self._callable_snapshot_graph(graph)
            definition = self.subflows.publish(
                {
                    "id": workflow_id,
                    "name": graph["name"],
                    "description": execution["description"],
                    "graph": snapshot,
                    "parameters": execution["parameters"],
                }
            )
            graph["callable_version"] = definition["version"]
            try:
                self._persist()
            except Exception as exc:
                self._storage_error = str(exc)[:200] or "Callable workflow storage is unavailable"
                raise
            self._rebuild_summary_cache()
            return definition

    def get_subflow(self, subflow_id: str, version: int | None = None) -> dict[str, Any]:
        """Read one consistent immutable subflow version."""
        with self._lock:
            return self.subflows.get(subflow_id, version)

    def import_subflows(self, definitions: Any, *, graph: Any = None) -> list[dict[str, Any]]:
        """Validate and persist pinned dependencies under the workflow service lock."""
        with self._lock:
            imported = self.subflows.import_definitions(definitions, graph=graph)
            if imported:
                self._migrate_callable_workflows()
                self._rebuild_summary_cache()
            return imported

    def _report_compile_error(self, graph: dict[str, Any], error: Exception) -> None:
        message = str(error)[:200]
        now = time.monotonic()
        with self._lock:
            previous = self._compile_errors.get(graph["id"])
            if previous and previous[0] == message and now - previous[1] < 30:
                return
            self._compile_errors[graph["id"]] = (message, now)
            self._errors.append({"workflow_id": graph.get("id"), "message": message})
            del self._errors[:-100]
            if hasattr(self, "history"):
                self.history.record(
                    {
                        "workflow_id": graph["id"],
                        "name": graph["name"],
                        "state": "error",
                        "camera_id": next(iter(graph["camera_ids"]), ""),
                        "source": "live",
                        "graph": graph,
                        "nodes": [
                            {
                                "id": "compile",
                                "type": "workflow",
                                "state": "error",
                                "error": message,
                                "input_count": 0,
                                "output_count": 0,
                                "duration_ms": 0,
                                "path": ["compile"],
                            }
                        ],
                    }
                )

    def remove_subflow(self, subflow_id: str) -> dict[str, Any]:
        """Delete a definition only when no saved workflow or pinned version uses it."""
        with self._lock:
            if self._callers(subflow_id):
                raise ValueError("Subflow is referenced by a saved workflow or subflow")
            if subflow_id in self._graphs:
                self.remove(subflow_id)
                return {"deleted": subflow_id}
            return self.subflows.delete(subflow_id)

    @staticmethod
    def _camera_ids(graph: dict[str, Any]) -> list[str]:
        nodes = {node["id"]: node for node in graph["nodes"]}
        camera_edges = [edge for edge in graph["edges"] if edge.get("input") == "camera"]
        selected = [nodes[edge["from"]]["params"]["camera_id"] for edge in camera_edges]
        if camera_edges and not any(selected):
            return []
        result = list(graph["camera_ids"])
        for camera_id in selected:
            if camera_id and camera_id not in result:
                result.append(camera_id)
        return result

    def preview(self, raw_graph: Any, node_id: Any, camera_id: Any = None) -> dict[str, Any]:
        """Evaluate one draft preview branch against a fresh, existing camera result."""
        graph = self.compile_graph(_validate_graph(raw_graph))
        if not isinstance(node_id, str) or not _ID.fullmatch(node_id):
            raise ValueError("Invalid preview node id")
        nodes = {node["id"]: node for node in graph["nodes"]}
        node = nodes.get(node_id)
        if not node or node["type"] != "preview":
            raise ValueError("Node must be a preview node")
        parents: dict[str, list[str]] = {nid: [] for nid in nodes}
        for edge in graph["edges"]:
            parents[edge["to"]].append(edge["from"])
        ancestors, pending = set(), list(parents[node_id])
        while pending:
            parent = pending.pop()
            if parent in ancestors:
                continue
            ancestors.add(parent)
            pending.extend(parents[parent])
        camera_ancestors = [nid for nid in ancestors if nodes[nid]["type"] == "camera"]
        connected_cameras = [
            nodes[nid]["params"]["camera_id"]
            for nid in camera_ancestors
            if nodes[nid]["params"]["camera_id"]
        ]
        allowed_cameras = list(
            dict.fromkeys(connected_cameras if camera_ancestors else graph["camera_ids"])
        )
        if camera_id is None:
            if len(allowed_cameras) != 1:
                raise ValueError("Select one camera for preview")
            camera_id = allowed_cameras[0]
        if not isinstance(camera_id, str) or camera_id not in allowed_cameras:
            raise ValueError("Camera is not connected to this workflow")
        # Preview requests renew a bounded inference lease only for detector branches.
        # Polling camera status or fetching raw frames must never wake an idle model.
        if any(nodes[parent]["type"] == "detections" for parent in ancestors):
            worker = self._camera_worker(camera_id)
            request = getattr(worker, "request_vision_preview", None)
            if request is not None:
                request()
        status = next(
            (item for item in self.manager.statuses() if item.get("id") == camera_id), None
        )
        cv = ((status or {}).get("metadata") or {}).get("cv") or {}
        sequence = cv.get("sequence")
        fresh = bool(
            status
            and status.get("state") == "running"
            and cv.get("state") == "ready"
            and _finite(cv.get("result_age_seconds"))
            and cv["result_age_seconds"] <= 2
            and type(sequence) is int
            and sequence >= 0
        )
        if not fresh:
            return {
                "camera_id": camera_id,
                "frame_url": f"/api/cameras/{camera_id}/preview-frame",
                "detections": [],
                "frame_size": cv.get("frame_size", [0, 0]),
                "engine": cv.get("engine"),
                "state": (status or {}).get("state", "unavailable"),
                "message": (
                    "Waiting for fresh camera detections"
                    if status and status.get("state") == "running"
                    else "Camera is not running"
                ),
                "sequence": sequence if type(sequence) is int else None,
                "generation": cv.get("generation"),
            }
        # Evaluate only the requested branch, including all binding ancestors.
        # Unrelated Code and Model nodes must not run during a monitor request.
        branch_ids = ancestors | {node_id}
        graph = {
            **graph,
            "nodes": [node for node in graph["nodes"] if node["id"] in branch_ids],
            "edges": [
                edge
                for edge in graph["edges"]
                if edge["from"] in branch_ids and edge["to"] in branch_ids
            ],
        }
        result = (
            self._evaluate(
                graph,
                camera_id,
                cv,
                time.monotonic(),
                status,
                preview_node_id=node_id,
            )
            or []
        )
        return {
            "camera_id": camera_id,
            "frame_url": f"/api/cameras/{camera_id}/preview-frame",
            "detections": copy.deepcopy(result),
            "frame_size": cv.get("frame_size", [0, 0]),
            "engine": cv.get("engine"),
            "state": "running",
            "message": f"{len(result)} detection(s)",
            "sequence": sequence,
            "generation": cv.get("generation"),
        }

    def _evaluate(
        self,
        graph: dict[str, Any],
        camera_id: str,
        cv: dict[str, Any],
        now: float,
        status: dict[str, Any] | None = None,
        *,
        preview_node_id: str | None = None,
    ) -> list[dict[str, Any]] | None:
        graph = self.compile_graph(graph)
        settings = self.history.settings()
        trace = (
            EvaluationTrace(
                graph,
                camera_id,
                cv,
                status,
                self.history,
                diagnostic=settings["mode"] == "diagnostic",
            )
            if preview_node_id is None and settings["enabled"]
            else None
        )
        try:
            return self._evaluate_graph(
                graph, camera_id, cv, now, status, preview_node_id=preview_node_id, trace=trace
            )
        except Exception:
            if trace is not None:
                trace.error = "Workflow evaluation failed"
            raise
        finally:
            if trace is not None:
                trace.finish()

    def _evaluate_graph(
        self,
        graph: dict[str, Any],
        camera_id: str,
        cv: dict[str, Any],
        now: float,
        status: dict[str, Any] | None = None,
        *,
        preview_node_id: str | None = None,
        trace: EvaluationTrace | None = None,
    ) -> list[dict[str, Any]] | None:
        nodes = {node["id"]: node for node in graph["nodes"]}
        incoming = {nid: [] for nid in nodes}
        outgoing = {nid: [] for nid in nodes}
        edge_inputs: dict[str, list[tuple[str, str]]] = {nid: [] for nid in nodes}
        for edge in graph["edges"]:
            incoming[edge["to"]].append(edge["from"])
            edge_inputs[edge["to"]].append((edge["from"], edge.get("input", "detections")))
            outgoing[edge["from"]].append(edge["to"])
        queue = [n for n in nodes if not incoming[n]]
        values: dict[str, list[dict[str, Any]]] = {}
        signal_values: dict[str, dict[str, Any]] = {}
        model_descriptors: dict[str, dict[str, Any] | None] = {}
        while queue:
            node_began = time.monotonic()
            action_summary = None
            nid = queue.pop(0)
            node = nodes[nid]
            kind = node["type"]
            p = node["params"]
            node_error = None
            previous_error = self._errors[-1] if self._errors else None
            action_ran = False
            upstream, upstream_keys = [], set()
            for parent, input_name in edge_inputs[nid]:
                if input_name != "detections":
                    continue
                for detection in values.get(parent, []):
                    try:
                        key = json.dumps(detection, sort_keys=True, separators=(",", ":"))
                    except (TypeError, ValueError):
                        key = repr(detection)
                    if key not in upstream_keys:
                        upstream_keys.add(key)
                        upstream.append(detection)
            runtime_params = dict(p)
            missing_binding = False
            for target, link in node.get("bindings", {}).items():
                raw_value = signal_values.get(link["node"], {}).get(link["signal"])
                if raw_value is None or raw_value == "" or raw_value == []:
                    missing_binding = True
                    continue
                match = re.fullmatch(r"rules\.(\d+)\.value", target)
                if match:
                    rules = copy.deepcopy(runtime_params["rules"])
                    rules[int(match.group(1))]["value"] = raw_value
                    runtime_params["rules"] = rules
                    continue
                if target in ("message", "title"):
                    if isinstance(raw_value, list):
                        raw_value = ", ".join(str(item) for item in raw_value if item is not None)
                    elif not isinstance(raw_value, str):
                        raw_value = str(raw_value)
                    limit = 128 if target == "title" else 500
                    runtime_params[target] = raw_value[:limit]
                    if not runtime_params[target].strip():
                        missing_binding = True
                else:
                    runtime_params[target] = raw_value
                if target == "confidence" and (not _finite(raw_value) or not 0 <= raw_value <= 1):
                    missing_binding = True
                elif target == "minimum" and (type(raw_value) is not int or raw_value < 1):
                    missing_binding = True
                elif target == "seconds" and (not _finite(raw_value) or not 1 <= raw_value <= 3600):
                    missing_binding = True
            if missing_binding:
                result = []
            elif kind in ("camera", "model", "classifier", "detections") and nid in getattr(
                self, "_replay_sources", {}
            ):
                # Retain the original source gate outcome. Replaying must not turn
                # a failed model binding into a valid detector result.
                result = copy.deepcopy(self._replay_sources[nid])
                if kind in ("model", "classifier"):
                    model_descriptors[nid] = self._model_descriptor(p["model_id"])
            elif kind == "camera":
                result = list(cv.get("detections", [])) if p["camera_id"] == camera_id else []
            elif kind == "subflow_input":
                paths = graph.get("_paths", {})
                root_inputs = [
                    ident
                    for ident, item in nodes.items()
                    if item["type"] == "subflow_input" and len(paths.get(ident, [ident])) == 1
                ]
                root_outputs = [
                    ident
                    for ident, item in nodes.items()
                    if item["type"] == "subflow_output" and len(paths.get(ident, [ident])) == 1
                ]

                def reachable(seeds, links):
                    reached, pending = set(), list(seeds)
                    while pending:
                        current = pending.pop()
                        if current in reached:
                            continue
                        reached.add(current)
                        pending.extend(links[current])
                    return reached

                input_descendants = reachable(root_inputs, outgoing)
                return_ancestors = reachable(root_outputs, incoming)
                root_bridge = len(paths.get(nid, [nid])) == 1
                source_nodes = {"camera", "model", "classifier", "detections"}
                independent_source = any(
                    item["type"] in source_nodes
                    and ident in return_ancestors
                    and ident not in input_descendants
                    for ident, item in nodes.items()
                )
                independent = graph.get("execution", {}).get("run_independently", False)
                result = (
                    list(cv.get("detections", []))
                    if root_bridge and independent and not independent_source
                    else upstream
                )
            elif kind in ("model", "classifier"):
                try:
                    descriptor = (
                        self._model_descriptor(p["model_id"])
                        if p["model_id"] and self.model_library
                        else None
                    )
                except (ValueError, KeyError, TypeError, RuntimeError):
                    descriptor = None
                model_descriptors[nid] = descriptor
                result = [
                    {
                        "__model_ok": bool(
                            descriptor
                            and (
                                self._classifier_matches(descriptor, p, camera_id, cv)
                                if kind == "classifier"
                                else self._model_matches(descriptor, camera_id, cv, status)
                            )
                        )
                    }
                ]
            elif kind == "detections":
                camera_edges = [parent for parent, port in edge_inputs[nid] if port == "camera"]
                model_edges = [
                    parent for parent, port in edge_inputs[nid] if port in ("model", "classifier")
                ]
                detection_edges = [
                    parent for parent, port in edge_inputs[nid] if port == "detections"
                ]
                camera_ok = not camera_edges or any(values.get(parent) for parent in camera_edges)
                model_ok = not model_edges or all(
                    values.get(parent, [{}])[0].get("__model_ok", False) for parent in model_edges
                )
                builtin_ok = True
                if (
                    p.get("engine", "any") == "insightface"
                    and (
                        "detector" in p or any(port == "classifier" for _, port in edge_inputs[nid])
                    )
                    and not any(port == "model" for _, port in edge_inputs[nid])
                ):
                    try:
                        builtin_ok = self._model_matches(
                            {
                                "engine": "insightface",
                                "path": self.detector_catalog.resolve(
                                    p.get("detector", "scrfd-500mf")
                                ),
                            },
                            camera_id,
                            cv,
                            status,
                        )
                    except ValueError:
                        builtin_ok = False
                if not camera_ok or not model_ok or not builtin_ok:
                    result = []
                elif detection_edges:
                    result = upstream
                else:
                    result = (
                        list(cv.get("detections", []))
                        if p["engine"] == "any" or cv.get("engine") == p["engine"]
                        else []
                    )
            elif kind == "filter":
                identity_source = p["identity_source"]
                if identity_source == "class" and any(
                    d.get("identity_confidence") is not None
                    for d in upstream
                    if isinstance(d, dict)
                ):
                    identity_source = "identity"
                result = [
                    d
                    for d in upstream
                    if isinstance(d, dict)
                    and self._bound_filter_match(
                        d,
                        p["label"],
                        runtime_params.get("label"),
                        "label",
                        "label" in node.get("bindings", {}),
                    )
                    and self._detection_confidence(d) >= runtime_params["confidence"]
                    and (
                        not runtime_params["identity"]
                        or self._bound_filter_match(
                            d,
                            p["identity"],
                            runtime_params.get("identity"),
                            "label" if identity_source == "class" else "identity",
                            "identity" in node.get("bindings", {}),
                        )
                    )
                    and self._matches_rules(
                        d, runtime_params["rules"], p["match"], identity_source=identity_source
                    )
                ]
            elif kind == "zone":
                x1, y1, x2, y2 = p["roi"]
                width, height = cv.get("frame_size", [0, 0])
                result = [d for d in upstream if self._in_zone(d, x1, y1, x2, y2, width, height)]
            elif kind == "count":
                result = upstream if len(upstream) >= runtime_params["minimum"] else []
            elif kind == "code":
                context = {"camera_id": camera_id}
                if cv.get("engine") in _ENGINES:
                    context["engine"] = cv["engine"]
                if isinstance(cv.get("frame_size"), list):
                    context["frame_size"] = cv["frame_size"]
                if type(cv.get("sequence")) is int and cv["sequence"] >= 0:
                    context["sequence"] = cv["sequence"]
                try:
                    result = run_code(p["source"], upstream, context, language=p["language"])
                except (ValueError, RuntimeError) as exc:
                    result = []
                    node_error = str(exc)[:200]
                    if preview_node_id is None:
                        with self._lock:
                            self._errors.append(
                                {
                                    "workflow_id": graph["id"],
                                    "camera_id": camera_id,
                                    "node_id": nid,
                                    "message": str(exc)[:200],
                                }
                            )
                            del self._errors[:-100]
            elif kind == "cooldown":
                key = (graph["id"], camera_id, nid)
                last = self._cooldowns.get(key, -math.inf)
                result = upstream if upstream and now - last >= runtime_params["seconds"] else []
                if result and preview_node_id is None:
                    self._cooldowns[key] = now
            elif kind == "preview":
                result, seen = [], set()
                for parent, input_name in edge_inputs[nid]:
                    source = values.get(parent, [])
                    if input_name == "camera" and nodes[parent]["params"]["camera_id"] != camera_id:
                        continue
                    for detection in source:
                        key = json.dumps(detection, sort_keys=True, separators=(",", ":"))
                        if key not in seen:
                            seen.add(key)
                            result.append(detection)
            else:
                result = upstream
            if missing_binding:
                result = []
            values[nid] = result
            signal_values[nid] = self._node_signals(
                kind,
                result,
                camera_id,
                cv,
                model_descriptors.get(nid),
                nodes,
                graph,
                nid,
                signal_values,
            )
            if (
                preview_node_id is None
                and kind in ("event", "notification", "capture", "record")
                and result
                and self._action_allowed(graph["id"], camera_id, nid, now)
            ):
                action_ran = True
                action_summary = self._act(
                    kind,
                    runtime_params,
                    graph["id"],
                    camera_id,
                    graph.get("name"),
                    node_id=nid,
                    camera_name=(status or {}).get("name") or camera_id,
                    detections=result,
                )
            if action_summary and action_summary.get("state") == "error":
                node_error = action_summary.get("error", "Action failed")
            if preview_node_id is None:
                latest_error = self._errors[-1] if self._errors else None
                if latest_error is not previous_error and latest_error.get("node_id") == nid:
                    node_error = latest_error.get("message", "Node execution failed")[:200]
                stamp = datetime.now().astimezone().isoformat()
                skipped = (
                    missing_binding
                    or (kind in ("event", "notification", "capture", "record") and not action_ran)
                    or (not result and kind not in ("camera", "model", "classifier", "detections"))
                )
                with self._lock:
                    entry = self._debug.setdefault(graph["id"], {"nodes": {}, "updated_at": stamp})
                    entry["updated_at"] = stamp
                    entry["nodes"][nid] = {
                        "state": "error" if node_error else "skipped" if skipped else "ok",
                        "last_run_at": stamp,
                        "input_count": len(upstream)
                        if incoming[nid]
                        else len(cv.get("detections", [])),
                        "output_count": len(result),
                        "error": node_error,
                        "camera_id": camera_id,
                    }
            if trace is not None:
                inputs = upstream
                if kind == "detections" and not any(
                    port == "detections" for _, port in edge_inputs[nid]
                ):
                    inputs = cv.get("detections", [])
                elif kind == "camera":
                    inputs = cv.get("detections", []) if p["camera_id"] == camera_id else []
                trace.node(
                    node,
                    inputs,
                    result,
                    time.monotonic() - node_began,
                    error=node_error,
                    missing=missing_binding,
                    action=action_summary if action_ran else None,
                    signals=signal_values[nid],
                    descriptor=model_descriptors.get(nid),
                )
            for target in outgoing[nid]:
                if all(parent in values for parent in incoming[target]) and target not in queue:
                    queue.append(target)
        return values.get(preview_node_id) if preview_node_id else None

    @staticmethod
    def _bound_filter_match(
        detection: dict[str, Any], literal: str, resolved: Any, field: str, bound: bool
    ) -> bool:
        if bound:
            if isinstance(resolved, list):
                return bool(resolved) and detection.get(field) in resolved
            return resolved != "" and detection.get(field) == resolved
        return not literal or detection.get(field) == literal

    @staticmethod
    def _node_signals(
        kind: str,
        result: list[dict[str, Any]],
        camera_id: str,
        cv: dict[str, Any],
        descriptor: dict[str, Any] | None,
        nodes: dict[str, dict[str, Any]],
        graph: dict[str, Any],
        nid: str,
        evaluated_signals: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        detections = [
            item for item in result if isinstance(item, dict) and not item.get("__model_ok")
        ]
        if kind in ("model", "classifier"):
            classes = descriptor.get("classes") if descriptor else None
            return {
                "model_id": descriptor.get("id") if descriptor else None,
                "engine": descriptor.get("engine") if descriptor else None,
                "classes": classes if isinstance(classes, list) and classes else None,
                "camera_id": camera_id,
                "labels": None,
                "identities": None,
                "confidence": None,
                "count": None,
            }
        if kind == "camera" and nodes[nid]["params"]["camera_id"] != camera_id:
            return {}
        ancestors, pending = (
            set(),
            [edge["from"] for edge in graph["edges"] if edge["to"] == nid],
        )
        while pending:
            parent = pending.pop()
            if parent in ancestors:
                continue
            ancestors.add(parent)
            pending.extend(edge["from"] for edge in graph["edges"] if edge["to"] == parent)
        classes = []
        has_model = False
        for parent in sorted(ancestors):
            if nodes[parent]["type"] in ("model", "classifier"):
                has_model = True
                model_classes = evaluated_signals.get(parent, {}).get("classes")
                if isinstance(model_classes, list):
                    classes.extend(label for label in model_classes if label not in classes)
        if not has_model:
            classes = cv.get("classes")
        confidences = [
            item["confidence"]
            for item in detections
            if _finite(item.get("confidence")) and 0 <= item["confidence"] <= 1
        ]
        return {
            "camera_id": camera_id,
            "engine": cv.get("engine") if cv.get("engine") in _ENGINES else None,
            "classes": classes if isinstance(classes, list) and classes else None,
            "labels": sorted(
                {item["label"] for item in detections if isinstance(item.get("label"), str)}
            )
            or None,
            "identities": sorted(
                {item["identity"] for item in detections if isinstance(item.get("identity"), str)}
            )
            or None,
            "confidence": max(confidences) if confidences else None,
            "count": len(detections),
        }

    @staticmethod
    def _matches_rules(
        detection: dict[str, Any],
        rules: list[dict[str, Any]],
        match: str,
        *,
        identity_source: str = "identity",
    ) -> bool:
        if not rules:
            return True
        checks = []
        for rule in rules:
            field = rule["field"]
            actual = detection.get(
                "label" if field == "identity" and identity_source == "class" else field
            )
            expected = rule["value"]
            op = rule["operator"]
            if field == "identity" and op in ("is_unknown", "is_known"):
                checks.append(
                    identity_source == "identity"
                    and (
                        detection.get("identity_status") == "unknown"
                        and detection.get("identity") is None
                        if op == "is_unknown"
                        else detection.get("identity_status") == "known"
                        and isinstance(detection.get("identity"), str)
                    )
                )
                continue
            if (
                field == "identity"
                and identity_source == "identity"
                and actual is None
                and detection.get("identity_confidence") is not None
            ):
                checks.append(False)
                continue
            if isinstance(expected, list):
                checks.append(
                    actual in expected if rule["operator"] == "eq" else actual not in expected
                )
                continue
            if rule["field"] == "confidence":
                actual = WorkflowService._detection_confidence(detection)
            checks.append(
                {
                    "eq": actual == expected,
                    "neq": actual != expected,
                    "gte": _finite(actual) and actual >= expected,
                    "lte": _finite(actual) and actual <= expected,
                }[op]
            )
        return all(checks) if match == "all" else any(checks)

    def _classifier_matches(self, descriptor: dict, params: dict, camera_id: str, cv: dict) -> bool:
        if cv.get("engine") != "insightface":
            return False
        try:
            worker = self._camera_worker(camera_id)
            settings = getattr(getattr(worker, "config", None), "vision", None)
            snapshot_fn = getattr(worker, "vision_snapshot", None)
            if callable(snapshot_fn):
                snapshot = snapshot_fn()
                runtime = snapshot.get("runtime") or {}
                if (
                    snapshot.get("pipeline") != "vision"
                    or snapshot.get("state") != "running"
                    or runtime.get("state") != "ready"
                    or runtime.get("sequence") != cv.get("sequence")
                    or runtime.get("generation") != cv.get("generation")
                ):
                    return False
                settings = snapshot.get("settings")
            if settings is not None and not isinstance(settings, dict):
                settings = vars(settings)
            if descriptor.get("metadata", {}).get("model_type") == "face_gallery":
                return bool(
                    settings
                    and settings.get("recognition_model") == descriptor["path"]
                    and settings.get("identity_gallery") == descriptor["identity_gallery"]
                    and settings.get("recognition_threshold", 0.5) == params["threshold"]
                    and settings.get("classifier_confirmation_frames", 3)
                    == params.get("confirmations", 3)
                    and settings.get("classifier_switch_frames", 5)
                    == params.get("switch_confirmations", 5)
                    and not settings.get("classifier_model")
                )
            return bool(
                settings
                and settings.get("classifier_model") == descriptor["path"]
                and tuple(settings.get("classifier_labels", ())) == tuple(descriptor["classes"])
                and settings.get("classifier_threshold", 0.5) == params["threshold"]
                and settings.get("classifier_confirmation_frames", 3)
                == params.get("confirmations", 3)
                and settings.get("classifier_switch_frames", 5)
                == params.get("switch_confirmations", 5)
                and settings.get("classifier_min_margin", 0.15) == params.get("margin", 0.15)
                and settings.get("classifier_output", "probabilities") == params["output"]
                and settings.get("classifier_preprocessing", "arcface") == params["preprocessing"]
            )
        except (ValueError, AttributeError, TypeError):
            return False

    def _model_matches(
        self,
        descriptor: dict[str, Any],
        camera_id: str,
        cv: dict[str, Any],
        status: dict[str, Any] | None,
    ) -> bool:
        if cv.get("engine") != descriptor["engine"]:
            return False
        metadata = (status or {}).get("metadata") or {}
        actual_path = cv.get("model") or metadata.get("model")
        actual_engine = cv.get("engine")
        try:
            worker = self._camera_worker(camera_id)
        except ValueError:
            worker = None
        snapshot_fn = getattr(worker, "vision_snapshot", None)
        if callable(snapshot_fn):
            snapshot = snapshot_fn()
            settings = snapshot.get("settings")
            runtime = snapshot.get("runtime") or {}
            if (
                snapshot.get("pipeline") != "vision"
                or snapshot.get("state") != "running"
                or not isinstance(settings, dict)
                or settings.get("engine") != descriptor["engine"]
                or str(settings.get("model") or "") != str(descriptor["path"] or "")
                or runtime.get("state") != "ready"
                or runtime.get("sequence") != cv.get("sequence")
                or runtime.get("generation") != cv.get("generation")
            ):
                return False
            actual_path = settings.get("model")
            actual_engine = settings.get("engine")
        else:
            worker = None
        config = getattr(worker, "config", None)
        vision = getattr(config, "vision", None)
        if actual_path is None and vision is not None:
            actual_path = getattr(vision, "model", None)
            actual_engine = getattr(vision, "engine", actual_engine)
        if actual_path is not None:
            return actual_engine == descriptor["engine"] and str(actual_path) == str(
                descriptor["path"]
            )
        return descriptor["engine"] == "opencv" and descriptor["path"] in (None, "")

    @staticmethod
    def _in_zone(
        detection: Any, x1: float, y1: float, x2: float, y2: float, width: int, height: int
    ) -> bool:
        bbox = detection.get("bbox") if isinstance(detection, dict) else None
        if not isinstance(bbox, list) or len(bbox) != 4 or not width or not height:
            return False
        cx, cy = (bbox[0] + bbox[2]) / (2 * width), (bbox[1] + bbox[3]) / (2 * height)
        return x1 <= cx <= x2 and y1 <= cy <= y2

    @staticmethod
    def _detection_confidence(detection: dict[str, Any]) -> float:
        value = detection.get("confidence")
        if value is None:
            return 0.0
        try:
            confidence = float(value)
        except (TypeError, ValueError, OverflowError):
            return 0.0
        return confidence if math.isfinite(confidence) else 0.0

    def _action_allowed(self, graph_id: str, camera_id: str, node_id: str, now: float) -> bool:
        key = (graph_id, camera_id, node_id)
        while self._global_actions and now - self._global_actions[0] >= 1:
            self._global_actions.popleft()
        if now - self._last_action.get(key, -math.inf) < 1 or len(self._global_actions) >= 20:
            return False
        self._last_action[key] = now
        self._global_actions.append(now)
        return True

    def _act(
        self,
        kind: str,
        params: dict[str, Any],
        graph_id: str,
        camera_id: str,
        workflow_name: str | None = None,
        *,
        node_id: str | None = None,
        camera_name: str | None = None,
        detections: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        try:
            if kind == "event":
                trigger_time = time.monotonic()
                now = datetime.now().astimezone()
                labels = sorted(
                    {
                        value[:80]
                        for detection in (detections or [])
                        if isinstance(detection, dict)
                        for value in (detection.get("label"), detection.get("identity"))
                        if isinstance(value, str) and value.strip()
                    }
                )
                tokens = {
                    "workflow": workflow_name or graph_id,
                    "camera": camera_name or camera_id,
                    "date": now.strftime("%Y-%m-%d"),
                    "time": now.strftime("%H:%M:%S"),
                    "node": node_id or "event",
                    "kind": "workflow",
                    "label": ", ".join(labels)[:80] or "event",
                }
                pattern = params.get("name_pattern", "{workflow} · {camera} · {date} {time}")
                name = re.sub(
                    r"\{([A-Za-z_][A-Za-z0-9_]*)\}",
                    lambda match: str(tokens.get(match.group(1), match.group(0))),
                    pattern,
                )[:200].strip()
                event = self.event_store.create(
                    name=name or "Workflow event",
                    kind="workflow",
                    camera_id=camera_id,
                    camera_name=tokens["camera"],
                    workflow_id=graph_id,
                    node_id=node_id,
                    message=params["message"],
                    media=[],
                )
                if params.get("attachment", "none") == "capture":
                    try:
                        self.event_store.attach_media(
                            event["id"], [self.recorder.capture([camera_id])]
                        )
                    except (OSError, RuntimeError, ValueError, KeyError):
                        self.event_store.set_attachment_status(
                            event["id"], "error", "Frame capture unavailable"
                        )
                with self._lock:
                    self._events.append(
                        {
                            "workflow_id": graph_id,
                            "camera_id": camera_id,
                            "message": params["message"],
                            "created_at": time.time(),
                        }
                    )
                    del self._events[:-100]
                if params.get("attachment") == "recording":
                    self.event_store.set_attachment_status(event["id"], "pending")
                    clip_thread = threading.Thread(
                        target=self._record_event_clip,
                        args=(
                            event["id"],
                            camera_id,
                            params.get("duration_seconds", 10),
                            params.get("pre_event_seconds", 0),
                            trigger_time,
                        ),
                        name="spyder-event-recording",
                        daemon=True,
                    )
                    with self._lock:
                        self._clip_threads.add(clip_thread)
                    clip_thread.start()
                return {"state": "saved", "event_id": event["id"]}
            elif kind == "notification":
                with self._lock:
                    self._events.append(
                        {
                            "kind": "notification",
                            "id": uuid.uuid4().hex,
                            "title": params["title"],
                            "message": params["message"],
                            "workflow_id": graph_id,
                            "workflow_name": workflow_name,
                            "camera_id": camera_id,
                            "created_at": time.time(),
                        }
                    )
                    del self._events[:-100]
                return {"state": "requested"}
            elif kind == "capture":
                media = self.recorder.capture([camera_id])
                return {
                    "state": "saved"
                    if isinstance(media, dict) and media.get("id")
                    else "requested",
                    "media": [media] if isinstance(media, dict) else [],
                }
            elif kind == "record":
                self._record(params["action"], graph_id, camera_id)
                return {"state": "requested", "operation": params["action"]}
        except Exception:
            with self._lock:
                self._errors.append(
                    {
                        "workflow_id": graph_id,
                        "camera_id": camera_id,
                        "action": kind,
                        "message": "Action failed",
                    }
                )
                del self._errors[:-100]
            return {"state": "error", "error": "Action failed"}

        return {"state": "requested"}

    def _record_event_clip(
        self,
        event_id: str,
        camera_id: str,
        duration: int,
        pre_event_seconds: int = 0,
        trigger_time: float | None = None,
    ) -> None:
        """Record bounded clip; stop only same, unmodified recorder session."""
        if not self._attachment_lock.acquire(blocking=False):
            try:
                self.event_store.set_attachment_status(
                    event_id, "error", "Another event recording is active"
                )
            finally:
                with self._lock:
                    self._clip_threads.discard(threading.current_thread())
            return
        try:
            with self._lock:
                initial = self.recorder.status()
                before = {item.get("id") for item in initial.get("items", [])}
                if initial.get("state") != "idle":
                    self.event_store.set_attachment_status(event_id, "error", "Recorder is busy")
                    return
                if pre_event_seconds:
                    started = self.recorder.start(
                        [camera_id],
                        pre_event_seconds=pre_event_seconds,
                        event_trigger_time=trigger_time,
                        post_event_seconds=duration,
                    )
                else:
                    started = self.recorder.start([camera_id])
                session_id = started.get("session_id") or self.recorder.status().get("session_id")
                if not isinstance(session_id, str):
                    self.event_store.set_attachment_status(
                        event_id, "error", "Recorder did not report session ownership"
                    )
                    return
                self._event_clip_sessions.add(session_id)
            if pre_event_seconds:
                # The writer finishes the encoded timeline, including catch-up frames.
                while not self._stop.wait(0.05):
                    with self._lock:
                        current = self.recorder.status()
                        if (
                            current.get("session_id") != session_id
                            or (
                                current.get("state") in ("idle", "error")
                                and not current.get("writer_active", False)
                            )
                            or session_id in self._event_clip_transferred
                        ):
                            break
            else:
                self._stop.wait(max(1, min(300, duration)))
            with self._lock:
                current = self.recorder.status()
                can_stop = (
                    current.get("session_id") == session_id
                    and current.get("state") == "recording"
                    and current.get("camera_ids") == [camera_id]
                    and session_id not in self._event_clip_transferred
                    and not self._record_owned.get(camera_id)
                )
                if can_stop:
                    self.recorder.stop()
                    current = self.recorder.status()
                still_ours = current.get("session_id") == session_id
                added = (
                    [item for item in current.get("items", []) if item.get("id") not in before]
                    if still_ours
                    else []
                )
            if added:
                clips = [
                    item
                    for item in added
                    if item.get("kind") == "recording"
                    and item.get("session_id", session_id) == session_id
                ]
                self.event_store.attach_media(event_id, clips)
            else:
                self.event_store.set_attachment_status(
                    event_id,
                    "error",
                    "Recording was handed to another action or did not finish",
                )
        except Exception:
            try:
                self.event_store.set_attachment_status(
                    event_id, "error", "Recording attachment failed"
                )
            except Exception:
                pass
        finally:
            if "session_id" in locals():
                self._event_clip_sessions.discard(session_id)
                self._event_clip_transferred.discard(session_id)
            with self._lock:
                self._clip_threads.discard(threading.current_thread())
            self._attachment_lock.release()

    def _record(self, action: str, graph_id: str, camera_id: str) -> None:
        with self._lock:
            self._record_locked(action, graph_id, camera_id)

    def _record_locked(self, action: str, graph_id: str, camera_id: str) -> None:
        state = self.recorder.status()
        members = list(state.get("camera_ids", []))
        if action == "start":
            if camera_id in members:
                if state.get("session_id") in self._event_clip_sessions:
                    self._transfer_event_clip(state["session_id"])
                owners = self._record_owned.get(camera_id)
                if owners:
                    owners.add(graph_id)
                return
            if state.get("state") == "recording":
                self.recorder.select(list(dict.fromkeys([*members, camera_id])))
            else:
                self.recorder.start([camera_id])
            if state.get("session_id") in self._event_clip_sessions:
                self._transfer_event_clip(state["session_id"])
            self._record_owned.setdefault(camera_id, set()).add(graph_id)
        elif graph_id in self._record_owned.get(camera_id, set()):
            owned = self._record_owned[camera_id]
            owned.remove(graph_id)
            if not owned and state.get("state") == "recording" and camera_id in members:
                self.recorder.select([member for member in members if member != camera_id])
            if not owned:
                self._record_owned.pop(camera_id, None)

    def _release_workflow_recordings(self, graph_id: str) -> None:
        for camera_id, owners in list(self._record_owned.items()):
            owners.discard(graph_id)
            if owners:
                continue
            state = self.recorder.status()
            members = list(state.get("camera_ids", []))
            if state.get("state") == "recording" and camera_id in members:
                try:
                    self.recorder.select([member for member in members if member != camera_id])
                except Exception:
                    pass
            self._record_owned.pop(camera_id, None)

    def _clear_graph_state(self, graph_id: str) -> None:
        self._last_action = {
            key: value for key, value in self._last_action.items() if key[0] != graph_id
        }
        self._cooldowns = {
            key: value for key, value in self._cooldowns.items() if key[0] != graph_id
        }
        self._runtime.pop(graph_id, None)
        self._compile_errors.pop(graph_id, None)

    def close(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(1.0)
        with self._lock:
            clip_threads = list(self._clip_threads)
        for thread in clip_threads:
            thread.join(6.0)
        with self._lock:
            publish = getattr(self.manager, "set_workflow_vision_cameras", None)
            if publish is not None:
                publish(set())
            history = getattr(self.manager, "pre_event_buffer", None)
            if history is not None:
                history.configure({})
        self.history.close()
