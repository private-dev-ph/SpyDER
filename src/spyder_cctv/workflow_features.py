"""Subflow portability and read-only execution inspection for local workflows."""

from __future__ import annotations

import copy
import threading
import time
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any


class EvaluationTrace:
    """Collect bounded execution facts without retaining camera frames."""

    def __init__(self, graph, camera_id, cv, status, history=None, *, diagnostic=False):
        self.history = history
        self.diagnostic = diagnostic
        self.graph = graph
        self.camera_id = camera_id
        self.cv = cv
        self.status = status or {}
        self.started = time.monotonic()
        self.started_at = datetime.now(UTC).isoformat()
        self.nodes: list[dict[str, Any]] = []
        self.actions: list[dict[str, Any]] = []
        self.models: dict[str, Any] = {}
        self.error = None
        self.source = "live"

    def node(
        self,
        node,
        inputs,
        outputs,
        elapsed,
        *,
        error=None,
        missing=False,
        action=None,
        signals=None,
        descriptor=None,
    ):
        kind = node["type"]
        if error:
            state = "error"
        elif missing:
            state = "skipped"
        elif action:
            state = action.get("state", "requested")
        elif (
            kind in ("cooldown", "event", "notification", "capture", "record")
            and inputs
            and not outputs
        ):
            state = "throttled"
        elif kind in ("event", "notification", "capture", "record"):
            state = "skipped"  # No action executed (empty input, rate limit, or dry run).
        elif not outputs:
            state = "filtered" if kind in ("filter", "zone", "count") else "empty"
        else:
            state = "completed"
        entry = {
            "id": node["id"],
            "type": kind,
            "state": state,
            "input_count": len(inputs),
            "output_count": len(outputs),
            "duration_ms": round(elapsed * 1000, 3),
            "error": error,
            "path": self.graph.get("_paths", {}).get(node["id"], [node["id"]]),
        }
        if self.diagnostic:
            entry.update(
                inputs=copy.deepcopy(inputs[:32]),
                outputs=copy.deepcopy(outputs[:32]),
                signals=copy.deepcopy(signals or {}),
            )
        if descriptor is not None:
            ident = node["params"].get("model_id")
            if ident:
                self.models[ident] = {
                    **(copy.deepcopy(descriptor) if self.diagnostic else {"id": ident}),
                    "matched": bool(outputs and outputs[0].get("__model_ok")),
                }
        if action:
            self.actions.append({"node_id": node["id"], "type": kind, **action})
        self.nodes.append(entry)

    def result(self):
        parents = {edge["from"] for edge in self.graph["edges"]}
        terminal_output = any(n["output_count"] for n in self.nodes if n["id"] not in parents)
        failed = self.error or any(n["state"] == "error" for n in self.nodes)
        run = {
            "id": uuid.uuid4().hex,
            "workflow_id": self.graph["id"],
            "name": self.graph["name"],
            "camera_id": self.camera_id,
            "started_at": self.started_at,
            "duration_ms": round((time.monotonic() - self.started) * 1000, 3),
            "state": "error"
            if failed
            else "completed"
            if terminal_output or self.actions
            else "filtered",
            "source": self.source,
            "sequence": self.cv.get("sequence"),
            "graph": self.graph,
            "nodes": self.nodes,
            "actions": self.actions,
            "model_refs": list(self.models),
            "error": self.error,
        }
        if self.diagnostic:
            # Detection metadata only. Images, frames and embeddings never belong here.
            keys = ("engine", "state", "sequence", "generation", "frame_size", "classes", "model")
            cv = {key: copy.deepcopy(self.cv[key]) for key in keys if key in self.cv}
            cv["detections"] = copy.deepcopy(self.cv.get("detections", [])[:32])
            run["context"] = {
                "cv": cv,
                "models": self.models,
                "camera_name": str(self.status.get("name") or self.camera_id)[:128],
                "inputs_truncated": len(self.cv.get("detections", [])) > 32,
            }
        return run

    def finish(self):
        run = self.result()
        if self.history is not None:
            self.history.record(run)
        return run


class WorkflowFeatures:
    """Keep persistence and portability outside the camera evaluation loop."""

    def __init__(self, service):
        self.service = service

    def export_bundle(self, graph):
        from .workflow import _validate_graph

        with self.service._lock:
            graph = _validate_graph(graph)
            self.service.compile_graph(graph)
            found = {}

            def collect(current):
                for node in current["nodes"]:
                    if node["type"] != "subflow":
                        continue
                    params = node["params"]
                    key = (params["subflow_id"], params["version"])
                    if key in found:
                        continue
                    definition = self.service.subflows.get(*key)
                    found[key] = definition
                    collect(definition["graph"])

            collect(graph)
            return {
                "format": "spyder-workflow-bundle",
                "version": 1,
                "workflow": graph,
                "subflows": list(found.values()),
            }

    def import_bundle(self, raw):
        from .workflow import _validate_graph

        if not isinstance(raw, dict) or set(raw) != {"format", "version", "workflow", "subflows"}:
            raise ValueError("Invalid workflow bundle")
        if (
            raw["format"] != "spyder-workflow-bundle"
            or type(raw["version"]) is not int
            or raw["version"] != 1
        ):
            raise ValueError("Unsupported workflow bundle version")
        graph = _validate_graph(raw["workflow"])
        graph["enabled"] = False
        if not isinstance(raw["subflows"], list) or len(raw["subflows"]) > 50_000:
            raise ValueError("Invalid subflow dependencies")
        with self.service._lock:
            # Catalog validates the whole candidate before its single atomic write.
            self.service.subflows.import_definitions(raw["subflows"], graph=graph)
            self.service.compile_graph(graph)
        return {"workflow": graph, "subflows": raw["subflows"]}

    def history_detail(self, ident):
        run = self.service.history.get(ident)
        if run is None:
            raise KeyError("Unknown execution")
        events = {item["id"]: item for item in self.service.event_store.list()["events"]}
        for action in run.get("actions", []):
            event_id = action.get("event_id")
            if not event_id:
                continue
            event = events.get(event_id)
            if event is None:
                action["attachment_state"] = "event_removed"
                continue
            action["media"] = event.get("media", [])
            action["attachment_state"] = event.get(
                "attachment_status", "saved" if event.get("media") else "none"
            )
            if event.get("attachment_error"):
                action["attachment_error"] = event["attachment_error"]
        return run

    def replay_history(self, ident):
        run = self.history_detail(ident)
        if run.get("graph_complete") is False:
            raise ValueError("Configuration snapshot is incomplete; replay is unavailable")
        context = run.get("context")
        if not isinstance(context, dict) or not isinstance(context.get("cv"), dict):
            raise ValueError("Replay requires a diagnostic run with retained detection inputs")
        graph = run["graph"]
        cv = context["cv"]
        # Copy execution state only. No capture, inference, event or recording operation is used.
        sandbox = copy.copy(self.service)
        sandbox._lock = threading.RLock()
        for key in ("_runtime", "_debug", "_cooldowns", "_last_action", "_record_owned"):
            setattr(sandbox, key, {})
        sandbox._errors = []
        models = context.get("models", {})
        sandbox._model_descriptor = lambda model_id: copy.deepcopy(models.get(model_id))
        sandbox._model_matches = lambda descriptor, *_args: bool(descriptor.get("matched", True))
        sandbox._classifier_matches = lambda descriptor, *_args: bool(
            descriptor.get("matched", True)
        )
        sandbox.detector_catalog = SimpleNamespace(resolve=lambda _ident: None)
        status = {
            "id": run["camera_id"],
            "name": context.get("camera_name"),
            "state": "running",
            "metadata": {"cv": cv},
        }
        trace = EvaluationTrace(graph, run["camera_id"], cv, status, diagnostic=True)
        trace.source = "replay"
        # Non-None preview target suppresses every action and cooldown mutation.
        sandbox._evaluate_graph(
            graph,
            run["camera_id"],
            cv,
            time.monotonic(),
            status,
            preview_node_id="__history_replay__",
            trace=trace,
        )
        result = trace.finish()
        notice = (
            " Some diagnostic inputs were truncated; this dry run uses the retained subset."
            if context.get("inputs_truncated")
            else ""
        )
        return {
            "run": result,
            "original_run_id": ident,
            "actions_enabled": False,
            "message": (
                "Dry run over archived detections. Models and actions are not executed; "
                "cooldown state starts empty."
            )
            + notice,
        }
