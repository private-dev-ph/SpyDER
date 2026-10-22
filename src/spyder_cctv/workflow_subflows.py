"""Versioned, bounded reusable workflow subflows."""

from __future__ import annotations

import copy
import json
import math
import os
import re
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MAX_FILE_BYTES = 8 * 1024 * 1024
_MAX_DEFINITIONS = 500
_MAX_VERSIONS = 100
_MAX_DEPTH = 4
_MAX_NODES = 256
_MAX_EDGES = 512
_TYPES = {"string", "number", "integer", "boolean"}


class SubflowCatalog:
    """Persist immutable subflow versions in one bounded JSON catalog."""

    def __init__(self, path: Path, validate_graph: Callable[[Any], dict[str, Any]]) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.validate_graph = validate_graph
        self._items: dict[str, list[dict[str, Any]]] = {}
        self.storage_error: str | None = None
        try:
            self._load()
        except (OSError, ValueError, TypeError, KeyError) as exc:
            self._items = {}
            self.storage_error = str(exc)[:200] or "Cannot load subflow catalog"

    def _ensure_available(self) -> None:
        if self.storage_error:
            raise RuntimeError("Subflow catalog storage is unavailable")

    def _load(self) -> None:
        if not self.path.exists():
            return
        if self.path.stat().st_size > _MAX_FILE_BYTES:
            raise ValueError("Subflow catalog exceeds 8 MiB")
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if (
                not isinstance(data, dict)
                or set(data) != {"subflows"}
                or not isinstance(data["subflows"], list)
            ):
                raise ValueError("Invalid subflow catalog")
            for definition in data["subflows"]:
                clean = self._validate_definition(definition)
                versions = self._items.setdefault(clean["id"], [])
                if clean["version"] > len(versions):
                    versions.extend([None] * (clean["version"] - len(versions)))
                if versions[clean["version"] - 1] is not None:
                    raise ValueError("Duplicate subflow version")
                versions[clean["version"] - 1] = clean
            if len(self._items) > _MAX_DEFINITIONS or any(
                len(v) > _MAX_VERSIONS for v in self._items.values()
            ):
                raise ValueError("Subflow catalog limit exceeded")
            for subflow_id, versions in self._items.items():
                for definition in versions:
                    if definition is None:
                        continue
                    self.compile(
                        {
                            "id": "load",
                            "name": "load",
                            "enabled": False,
                            "camera_ids": [],
                            "nodes": [
                                {
                                    "id": "call",
                                    "type": "subflow",
                                    "x": 0,
                                    "y": 0,
                                    "params": {
                                        "subflow_id": subflow_id,
                                        "version": definition["version"],
                                        "arguments": {},
                                    },
                                }
                            ],
                            "edges": [],
                        }
                    )
        except (OSError, json.JSONDecodeError, TypeError, KeyError) as exc:
            raise ValueError("Cannot load subflow catalog") from exc

    @staticmethod
    def _type_ok(value: Any, kind: str) -> bool:
        return {
            "string": lambda: isinstance(value, str),
            "number": lambda: type(value) in (int, float) and math.isfinite(value),
            "integer": lambda: type(value) is int,
            "boolean": lambda: type(value) is bool,
        }[kind]()

    def _validate_definition(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict) or set(raw) != {
            "id",
            "name",
            "description",
            "version",
            "graph",
            "parameters",
        }:
            raise ValueError(
                "Subflow must contain id, name, description, version, graph and parameters"
            )
        if not isinstance(raw["id"], str) or not _ID.fullmatch(raw["id"]):
            raise ValueError("Invalid subflow id")
        if not isinstance(raw["name"], str) or not raw["name"].strip() or len(raw["name"]) > 128:
            raise ValueError("Invalid subflow name")
        if not isinstance(raw["description"], str) or len(raw["description"]) > 1000:
            raise ValueError("Invalid subflow description")
        if type(raw["version"]) is not int or not 1 <= raw["version"] <= _MAX_VERSIONS:
            raise ValueError("Invalid subflow version")
        graph = self.validate_graph(raw["graph"])
        if graph["enabled"] or graph["camera_ids"]:
            raise ValueError("Subflow graph must be disabled and have no camera_ids")
        nodes = {n["id"]: n for n in graph["nodes"]}
        ins = [n for n in graph["nodes"] if n["type"] == "subflow_input"]
        outs = [n for n in graph["nodes"] if n["type"] == "subflow_output"]
        if len(ins) != 1 or len(outs) != 1 or ins[0]["params"] or outs[0]["params"]:
            raise ValueError("Subflow requires one parameterless input and output bridge")
        if ins[0].get("bindings") or outs[0].get("bindings"):
            raise ValueError("Subflow bridge nodes cannot have bindings")
        ancestors = {outs[0]["id"]}
        changed = True
        while changed:
            changed = False
            for edge in graph["edges"]:
                if edge["to"] in ancestors and edge["from"] not in ancestors:
                    ancestors.add(edge["from"])
                    changed = True
        if ins[0]["id"] not in ancestors or ancestors != set(nodes):
            raise ValueError("Every subflow node must connect from input to output")
        if sum(edge["to"] == outs[0]["id"] for edge in graph["edges"]) != 1:
            raise ValueError("Subflow output bridge must have exactly one input")
        if not isinstance(raw["parameters"], list) or len(raw["parameters"]) > 64:
            raise ValueError("Invalid subflow parameters")
        names, mapped = set(), set()
        parameters = []
        for parameter in raw["parameters"]:
            if not isinstance(parameter, dict) or set(parameter) != {
                "name",
                "type",
                "default",
                "node_id",
                "field",
            }:
                raise ValueError("Invalid exposed subflow parameter")
            name, kind, default, node_id, field = (
                parameter[k] for k in ("name", "type", "default", "node_id", "field")
            )
            if (
                not isinstance(name, str)
                or not _ID.fullmatch(name)
                or name in names
                or not isinstance(kind, str)
                or kind not in _TYPES
            ):
                raise ValueError("Invalid or duplicate subflow parameter")
            node = nodes.get(node_id)
            if (
                node is None
                or node["type"] not in ("camera", "model")
                or field not in ("camera_id", "model_id")
            ):
                raise ValueError(
                    "Exposed parameter must map to camera_id or model_id on camera/model node"
                )
            if (node["type"], field) not in (("camera", "camera_id"), ("model", "model_id")):
                raise ValueError("Exposed field does not match node type")
            if kind != "string" or (node_id, field) in mapped or not self._type_ok(default, kind):
                raise ValueError("Invalid parameter default or duplicate field mapping")
            names.add(name)
            mapped.add((node_id, field))
            parameters.append(copy.deepcopy(parameter))
        return {
            "id": raw["id"],
            "name": raw["name"].strip(),
            "description": raw["description"],
            "version": raw["version"],
            "graph": graph,
            "parameters": parameters,
        }

    def list(self) -> dict[str, Any]:
        rows = []
        for versions in self._items.values():
            present = [(index, item) for index, item in enumerate(versions, 1) if item is not None]
            if not present:
                continue
            latest = present[-1][1]
            rows.append({**copy.deepcopy(latest), "versions": [index for index, _ in present]})
        rows.sort(key=lambda row: (row["name"].casefold(), row["id"]))
        return {"subflows": rows, "storage_error": self.storage_error}

    def get(self, subflow_id: str, version: int | None = None) -> dict[str, Any]:
        self._ensure_available()
        versions = self._items.get(subflow_id)
        if not versions:
            raise KeyError(subflow_id)
        if version is None:
            version = len(versions)
        if (
            type(version) is not int
            or version < 1
            or version > len(versions)
            or versions[version - 1] is None
        ):
            raise KeyError(f"{subflow_id}@{version}")
        return copy.deepcopy(versions[version - 1])

    def dependencies(self, graph: dict[str, Any]) -> list[dict[str, Any]]:
        """Return pinned transitive definitions required by graph, once each."""
        self._ensure_available()
        found: dict[tuple[str, int], dict[str, Any]] = {}
        pending = [
            node["params"] for node in graph.get("nodes", []) if node.get("type") == "subflow"
        ]
        while pending:
            params = pending.pop()
            definition = self.get(params.get("subflow_id"), params.get("version"))
            key = (definition["id"], definition["version"])
            if key in found:
                continue
            found[key] = definition
            pending.extend(
                node["params"] for node in definition["graph"]["nodes"] if node["type"] == "subflow"
            )
        return [found[key] for key in sorted(found)]

    def publish(self, raw: Any) -> dict[str, Any]:
        self._ensure_available()
        if not isinstance(raw, dict):
            raise ValueError("Invalid subflow definition")
        prior = self._items.get(raw.get("id"), [])
        if len(prior) >= _MAX_VERSIONS or (not prior and len(self._items) >= _MAX_DEFINITIONS):
            raise ValueError("Subflow catalog limit exceeded")
        definition = self._validate_definition({**raw, "version": len(prior) + 1})
        updated = {key: list(value) for key, value in self._items.items()}
        updated.setdefault(definition["id"], []).append(definition)
        prior_items = self._items
        self._items = updated
        try:
            self.compile(
                {
                    "id": "publish",
                    "name": "publish",
                    "enabled": False,
                    "camera_ids": [],
                    "nodes": [
                        {
                            "id": "call",
                            "type": "subflow",
                            "x": 0,
                            "y": 0,
                            "params": {
                                "subflow_id": definition["id"],
                                "version": definition["version"],
                                "arguments": {},
                            },
                        }
                    ],
                    "edges": [],
                }
            )
        except Exception:
            self._items = prior_items
            raise
        self._items = prior_items
        self._write(updated)
        self._items = updated
        return copy.deepcopy(definition)

    def delete(self, subflow_id: str, *, referenced: bool = False) -> dict[str, Any]:
        self._ensure_available()
        referenced = referenced or any(
            node["type"] == "subflow" and node["params"].get("subflow_id") == subflow_id
            for versions in self._items.values()
            for definition in versions
            if definition is not None
            for node in definition["graph"]["nodes"]
        )
        if referenced:
            raise ValueError("Subflow is referenced by a saved workflow or subflow")
        if subflow_id not in self._items:
            raise KeyError(subflow_id)
        updated = {key: value for key, value in self._items.items() if key != subflow_id}
        self._write(updated)
        self._items = updated
        return {"deleted": subflow_id}

    def _write(self, items: dict[str, list[dict[str, Any]]]) -> None:
        payload = json.dumps(
            {
                "subflows": [
                    item for versions in items.values() for item in versions if item is not None
                ]
            },
            ensure_ascii=False,
            indent=2,
        ).encode()
        if len(payload) > _MAX_FILE_BYTES:
            raise ValueError("Subflow catalog exceeds 8 MiB")
        fd, name = tempfile.mkstemp(prefix=".subflows-", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
        finally:
            try:
                os.unlink(name)
            except FileNotFoundError:
                pass

    def compile(self, graph: dict[str, Any]) -> dict[str, Any]:
        """Expand calls into deterministic internal IDs while preserving outer graph."""
        if graph.get("_compiled") is True:
            return copy.deepcopy(graph)
        nodes = copy.deepcopy(graph["nodes"])
        edges = copy.deepcopy(graph["edges"])
        root = {**graph, "nodes": nodes, "edges": edges}
        paths = {node["id"]: [node["id"]] for node in nodes}

        def expand(
            current: dict[str, Any],
            path: tuple[str, ...],
            stack: tuple[tuple[str, int], ...],
            depth: int,
        ) -> dict[str, Any]:
            if depth > _MAX_DEPTH:
                raise ValueError("Subflow nesting depth exceeds 4")
            existing = {node["id"] for node in current["nodes"]}
            for call in list(current["nodes"]):
                if call["type"] != "subflow":
                    continue
                params = call["params"]
                subflow_id, version = params.get("subflow_id"), params.get("version")
                if (
                    not isinstance(subflow_id, str)
                    or not _ID.fullmatch(subflow_id)
                    or type(version) is not int
                ):
                    raise ValueError("Invalid subflow call reference")
                definition = self.get(subflow_id, version)
                ref = (subflow_id, definition["version"])
                if ref in stack:
                    raise ValueError("Recursive subflow reference")
                args = params.get("arguments", {})
                expected = {p["name"] for p in definition["parameters"]}
                if not isinstance(args, dict) or len(args) > 64 or set(args) - expected:
                    raise ValueError("Unknown subflow argument")
                child = copy.deepcopy(definition["graph"])
                child_nodes = {n["id"]: n for n in child["nodes"]}
                for parameter in definition["parameters"]:
                    value = args.get(parameter["name"], parameter["default"])
                    if not self._type_ok(value, parameter["type"]):
                        raise ValueError(f"Invalid value for subflow parameter {parameter['name']}")
                    if value and not _ID.fullmatch(value):
                        raise ValueError(
                            f"Invalid identifier for subflow parameter {parameter['name']}"
                        )
                    child_nodes[parameter["node_id"]]["params"][parameter["field"]] = value
                child = expand(child, (*path, call["id"]), (*stack, ref), depth + 1)
                inp = next(n["id"] for n in child["nodes"] if n["type"] == "subflow_input")
                out = next(n["id"] for n in child["nodes"] if n["type"] == "subflow_output")
                output_sources = [edge["from"] for edge in child["edges"] if edge["to"] == out]
                if len(output_sources) != 1:
                    raise ValueError("Subflow output bridge must have exactly one input")
                import hashlib

                mapping = {
                    n["id"]: "sf_"
                    + hashlib.sha256("/".join((*path, call["id"], n["id"])).encode()).hexdigest()[
                        :32
                    ]
                    for n in child["nodes"]
                }
                if any(
                    not _ID.fullmatch(mapped) or mapped in existing for mapped in mapping.values()
                ):
                    raise ValueError("Expanded subflow node ID collision")
                inbound = [e for e in current["edges"] if e["to"] == call["id"]]
                outbound = [e for e in current["edges"] if e["from"] == call["id"]]
                current["edges"] = [
                    e for e in current["edges"] if e not in inbound and e not in outbound
                ]
                for edge in inbound:
                    for child_edge in child["edges"]:
                        if child_edge["from"] == inp and child_edge["to"] != out:
                            current["edges"].append({**edge, "to": mapping[child_edge["to"]]})
                for edge in outbound:
                    for child_edge in child["edges"]:
                        if child_edge["to"] == out:
                            if child_edge["from"] == inp:
                                for source in inbound:
                                    current["edges"].append({**source, "to": edge["to"]})
                            else:
                                current["edges"].append(
                                    {**edge, "from": mapping[child_edge["from"]]}
                                )
                output_source = mapping[output_sources[0]]
                for target in current["nodes"]:
                    if target["id"] == call["id"]:
                        continue
                    for binding in target.get("bindings", {}).values():
                        if binding["node"] == call["id"]:
                            binding["node"] = output_source
                current["edges"].extend(
                    {**e, "from": mapping[e["from"]], "to": mapping[e["to"]]}
                    for e in child["edges"]
                    if e["from"] != inp and e["to"] != out
                )
                current["nodes"] = [n for n in current["nodes"] if n["id"] != call["id"]]
                paths.pop(call["id"], None)
                current["nodes"].extend(
                    {**n, "id": mapping[n["id"]]}
                    for n in child["nodes"]
                    if n["id"] not in (inp, out)
                )
                for original, mapped in mapping.items():
                    if original not in (inp, out):
                        paths[mapped] = [*path, call["id"], *paths.get(original, [original])]
                existing.update(mapping.values())
            if len(current["nodes"]) > _MAX_NODES:
                raise ValueError("Expanded workflow exceeds 256 nodes")
            if len(current["edges"]) > _MAX_EDGES:
                raise ValueError("Expanded workflow exceeds 512 edges")
            return current

        compiled = expand(root, (), (), 0)
        compiled["nodes"].sort(key=lambda n: n["id"])
        compiled["_compiled"] = True
        compiled["_paths"] = paths
        return compiled

    def import_definitions(self, definitions: Any, *, graph: Any = None) -> list[dict[str, Any]]:
        """Atomically add pinned definitions without replacing existing versions."""
        self._ensure_available()
        if not isinstance(definitions, list) or len(definitions) > _MAX_DEFINITIONS * 2:
            raise ValueError("Invalid subflow dependency bundle")
        candidate = {key: list(value) for key, value in self._items.items()}
        imported = []
        clean_definitions = [self._validate_definition(raw) for raw in definitions]
        clean_definitions.sort(key=lambda item: (item["id"], item["version"]))
        for clean in clean_definitions:
            versions = candidate.setdefault(clean["id"], [])
            if clean["version"] <= len(versions):
                existing = versions[clean["version"] - 1]
                if existing is not None and existing != clean:
                    raise ValueError("Conflicting imported subflow version")
                if existing is None:
                    versions[clean["version"] - 1] = clean
                    imported.append(clean)
                continue
            versions.extend([None] * (clean["version"] - len(versions) - 1))
            versions.append(clean)
            imported.append(clean)
        if len(candidate) > _MAX_DEFINITIONS or any(
            len(v) > _MAX_VERSIONS for v in candidate.values()
        ):
            raise ValueError("Subflow catalog limit exceeded")
        previous = self._items
        self._items = candidate
        try:
            for definition in imported:
                self.compile(
                    {
                        "id": "import",
                        "name": "import",
                        "enabled": False,
                        "camera_ids": [],
                        "nodes": [
                            {
                                "id": "call",
                                "type": "subflow",
                                "x": 0,
                                "y": 0,
                                "params": {
                                    "subflow_id": definition["id"],
                                    "version": definition["version"],
                                    "arguments": {},
                                },
                            }
                        ],
                        "edges": [],
                    }
                )
            if graph is not None:
                clean_graph = self.validate_graph(graph)
                self.compile(clean_graph)
            payload = json.dumps(
                {
                    "subflows": [
                        item
                        for versions in candidate.values()
                        for item in versions
                        if item is not None
                    ]
                },
                ensure_ascii=False,
            ).encode()
            if len(payload) > _MAX_FILE_BYTES:
                raise ValueError("Subflow catalog exceeds 8 MiB")
            self._write(candidate)
        except Exception:
            self._items = previous
            raise
        return copy.deepcopy(imported)
