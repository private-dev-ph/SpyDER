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
from pathlib import Path
from typing import Any

from .cv.contracts import VisionConfig
from .cv.detectors import DetectorCatalog
from .workflow_code import run_code, validate_code

_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
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
    "event": {"message"},
    "notification": {"title", "message"},
    "capture": set(),
    "record": {"action"},
    "code": {"language", "source"},
    "preview": set(),
}


def _finite(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _validate_graph(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) != {
        "id",
        "name",
        "enabled",
        "camera_ids",
        "nodes",
        "edges",
    }:
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
    nodes, edges = raw["nodes"], raw["edges"]
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
        if kind == "camera":
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
                    or not 0 <= p["threshold"] <= 1
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
                    "identity": {"eq", "neq"},
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
        if not isinstance(edge, dict) or set(edge) not in ({"from", "to"}, {"from", "to", "input"}):
            raise ValueError("Invalid workflow edge")
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
            {"from": source, "to": target, **({"input": input_name} if "input" in edge else {})}
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
    return {
        "id": raw["id"],
        "name": raw["name"],
        "enabled": raw["enabled"],
        "camera_ids": list(cams),
        "nodes": clean_nodes,
        "edges": clean_edges,
    }


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
    ) -> None:
        self.manager, self.recorder = manager, recorder
        self.model_library = model_library
        self.detector_catalog = detector_catalog or DetectorCatalog()
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self._path = self.storage_dir / "workflows.json"
        self._lock = threading.RLock()
        self._storage_error: str | None = None
        try:
            self._graphs = self._load()
        except (OSError, ValueError) as exc:
            self._graphs = {}
            self._storage_error = str(exc)[:200] or "Cannot load workflow storage"
        self._events: list[dict[str, Any]] = []
        self._session_id = uuid.uuid4().hex
        self._errors: list[dict[str, Any]] = []
        self._runtime: dict[str, Any] = {}
        self._seen: dict[str, tuple[Any, int]] = {}
        self._last_action: dict[tuple[str, str, str], float] = {}
        self._global_actions: deque[float] = deque()
        self._cooldowns: dict[tuple[str, str, str], float] = {}
        self._record_owned: dict[str, set[str]] = {}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="spyder-workflows", daemon=True)
        self._thread.start()

    def list(self) -> dict[str, Any]:
        with self._lock:
            return {
                "workflows": copy.deepcopy(list(self._graphs.values())),
                "catalog": self.catalog(),
                "events": copy.deepcopy(self._events[-100:]),
                "runtime": copy.deepcopy(self._runtime),
                "errors": copy.deepcopy(self._errors[-100:]),
                "storage_error": self._storage_error,
            }

    def notifications(self) -> dict[str, Any]:
        """Return current-process notifications and session identity for client deduplication."""
        with self._lock:
            return {
                "session_id": self._session_id,
                "notifications": copy.deepcopy(
                    [event for event in self._events if event.get("kind") == "notification"][-100:]
                ),
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
            {"type": "event", "params": {"message": {"type": "string", "maximum": 500}}},
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
        normalized = _validate_graph(graph)
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

    def save(self, graph: dict[str, Any], *, disable_motion: bool = False) -> dict[str, Any]:
        if type(disable_motion) is not bool:
            raise ValueError("disable_motion must be boolean")
        normalized = _validate_graph(graph)
        with self._lock:
            if self._storage_error:
                raise RuntimeError("Workflow storage is unavailable")
            if normalized["id"] not in self._graphs and len(self._graphs) >= 32:
                raise ValueError("Workflow limit exceeded")
            snapshot = self._graphs.copy()
            previous = self._graphs.get(normalized["id"])
            old_settings: dict[str, dict[str, Any] | None] = {}
            options: dict[str, dict[str, Any]] = {}
            old_analysis: dict[str, dict[str, Any]] = {}
            preview = self.activation_preview(normalized)
            affected = [item for item in preview["cameras"] if item["disable_motion"]]
            if affected and not disable_motion:
                names = ", ".join(item["name"] for item in affected)
                raise ValueError(f"Enabling InsightFace will disable motion analysis on: {names}")
            if normalized["enabled"]:
                self._validate_complete_sources(normalized)
                options = self._prepare_model_bindings(normalized)
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
            for camera_id in options:
                self._seen.pop(camera_id, None)
            if previous and previous["enabled"] and not normalized["enabled"]:
                self._release_workflow_recordings(normalized["id"])
                self._clear_graph_state(normalized["id"])
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
        self._node_pipeline_signatures(graph)
        bindings = self._node_model_bindings(graph)
        for other in self._graphs.values():
            if not other["enabled"] or other["id"] == graph["id"]:
                continue
            for camera, model in self._node_model_bindings(other).items():
                if camera in bindings and bindings[camera] != model:
                    raise ValueError(f"Conflicting models target camera {camera}")
        options_by_camera: dict[str, dict[str, Any]] = {}
        for camera_id, model_id in bindings.items():
            descriptor = self._model_descriptor(model_id)
            if descriptor.get("metadata", {}).get("model_type") == "face_classifier":
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
            if node["type"] != "detections" or node["params"]["engine"] != "insightface":
                continue
            incoming = [edge for edge in graph["edges"] if edge["to"] == node["id"]]
            model_edges = [edge for edge in incoming if edge.get("input") == "model"]
            classifier_edges = [edge for edge in incoming if edge.get("input") == "classifier"]
            camera_edges = [edge for edge in incoming if edge.get("input") == "camera"]
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
                if (
                    descriptor["engine"] != "insightface"
                    or descriptor.get("metadata", {}).get("model_type") != "face_classifier"
                    or not descriptor["classes"]
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
                if classifier:
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
                for camera_id, signature in self._node_pipeline_signatures(other).items():
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
                node["params"]["engine"] != "insightface"
                or ("detector" not in node["params"] and not classifiers)
            ):
                continue
            builtin = node["params"].get("detector", "scrfd-500mf") if not models else None
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
            snapshot = self._graphs.copy()
            self._graphs.pop(workflow_id, None)
            try:
                self._persist()
            except Exception:
                self._graphs = snapshot
                raise
            self._release_workflow_recordings(workflow_id)
            self._clear_graph_state(workflow_id)

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
                memberships = list(self.recorder.status().get("camera_ids", []))
                result = self.recorder.stop()
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
            previous = list(self.recorder.status().get("camera_ids", []))
            result = (
                self.recorder.start(camera_ids)
                if action == "start"
                else self.recorder.select(camera_ids)
            )
            transferred = camera_ids if action == "start" else [*previous, *camera_ids]
            self.relinquish_recording(transferred)
            return result

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self._path.exists():
            return {}
        if self._path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("Workflow file exceeds 2 MiB")
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if (
                not isinstance(data, dict)
                or set(data) != {"workflows"}
                or not isinstance(data["workflows"], list)
                or len(data["workflows"]) > 32
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
        if len(payload) > 2 * 1024 * 1024:
            raise ValueError("Workflow file exceeds 2 MiB")
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
        with self._lock:
            graphs = copy.deepcopy(list(self._graphs.values()))
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
        graph = _validate_graph(raw_graph)
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
            nid = queue.pop(0)
            node = nodes[nid]
            kind = node["type"]
            p = node["params"]
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
            elif kind == "camera":
                result = list(cv.get("detections", [])) if p["camera_id"] == camera_id else []
            elif kind in ("model", "classifier"):
                try:
                    descriptor = (
                        self._model_descriptor(p["model_id"])
                        if p["model_id"] and self.model_library
                        else None
                    )
                except (ValueError, KeyError, TypeError):
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
                self._act(kind, runtime_params, graph["id"], camera_id, graph.get("name"))
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
            op = rule["operator"]
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
    ) -> None:
        try:
            if kind == "event":
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
            elif kind == "capture":
                self.recorder.capture([camera_id])
            elif kind == "record":
                self._record(params["action"], graph_id, camera_id)
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

    def _record(self, action: str, graph_id: str, camera_id: str) -> None:
        with self._lock:
            self._record_locked(action, graph_id, camera_id)

    def _record_locked(self, action: str, graph_id: str, camera_id: str) -> None:
        state = self.recorder.status()
        members = list(state.get("camera_ids", []))
        if action == "start":
            if camera_id in members:
                owners = self._record_owned.get(camera_id)
                if owners:
                    owners.add(graph_id)
                return
            if state.get("state") == "recording":
                self.recorder.select(list(dict.fromkeys([*members, camera_id])))
            else:
                self.recorder.start([camera_id])
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

    def close(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(1.0)
