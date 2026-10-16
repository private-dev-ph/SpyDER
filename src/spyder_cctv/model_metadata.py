"""Bounded inspection of descriptive metadata embedded in ONNX models."""

from __future__ import annotations

import ast
import csv
import io
import json
import re
from collections.abc import Mapping
from typing import Any

MAX_DEPTH = 6
MAX_NODES = 2048
MAX_PARSE_BYTES = 2 * 1024 * 1024
MAX_VALUE_BYTES = 131072
MAX_LABELS = 1000
MAX_LABEL_LENGTH = 128
MAX_CANDIDATES = 32

_ALIASES = {
    "names",
    "classnames",
    "classes",
    "labels",
    "labelnames",
    "categories",
    "categorynames",
    "identities",
    "identitynames",
    "id2label",
    "label2id",
    "classlabels",
    "classmapping",
    "classtoidx",
    "idxtoclass",
    "classestoidx",
    "idx2class",
    "classidtoname",
    "labelidtoname",
}
_COUNT_KEYS = {"classcount", "numclasses", "nclasses", "numberofclasses"}
_NON_LABEL_KEYS = {
    "author",
    "authors",
    "provider",
    "providers",
    "outputname",
    "outputnames",
    "outputs",
    "inputsize",
    "dimensions",
    "dimension",
    "shape",
    "shapes",
    "backbone",
    "detectorname",
}
_NORMALIZED_FIELDS = {
    "schemaversion": "schema_version",
    "modeltype": "model_type",
    "backbone": "backbone",
    "embeddingsize": "embedding_size",
    "inputcolor": "input_color",
    "inputlayout": "input_layout",
    "inputdtype": "input_dtype",
    "inputsize": "input_size",
    "normalization": "normalization",
    "preprocessing": "preprocessing",
    "detectorname": "detector_name",
    "numclasses": "num_classes",
    "classcount": "num_classes",
    "scoretype": "score_type",
    "probabilitytype": "probability_type",
    "unknownrejection": "unknown_rejection",
}


def _norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def _pointer_part(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def _decode(raw: str, budget: list[int]) -> Any:
    try:
        encoded_size = len(raw.encode("utf-8", "replace"))
    except (MemoryError, RecursionError):
        return None
    if encoded_size > MAX_VALUE_BYTES:
        return None
    budget[0] += encoded_size
    if budget[0] > MAX_PARSE_BYTES:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError, MemoryError, RecursionError):
        try:
            value = ast.literal_eval(raw)
        except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
            return None
        return value


def _label_sequence(value: Any) -> list[str] | None:
    if isinstance(value, (list, tuple)):
        if len(value) > MAX_LABELS:
            return None
        labels = list(value)
    elif isinstance(value, Mapping):
        if len(value) > MAX_LABELS:
            return None
        pairs = list(value.items())
        if not pairs:
            return None
        # ID-to-name map.
        if all(_integer_key(key) and isinstance(item, str) for key, item in pairs):
            indexed = sorted(((int(key), item) for key, item in pairs), key=lambda row: row[0])
            if [key for key, _ in indexed] != list(range(len(indexed))):
                return None
            labels = [item for _, item in indexed]
        # Name-to-ID map.
        elif all(isinstance(key, str) and _integer_key(item) for key, item in pairs):
            indexed = sorted(((int(item), key) for key, item in pairs), key=lambda row: row[0])
            if [key for key, _ in indexed] != list(range(len(indexed))):
                return None
            labels = [item for _, item in indexed]
        else:
            return None
    else:
        return None
    if not 1 <= len(labels) <= MAX_LABELS:
        return None
    if any(
        not isinstance(label, str) or not label.strip() or len(label) > MAX_LABEL_LENGTH
        for label in labels
    ):
        return None
    return labels


def _integer_key(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        or (isinstance(value, str) and value.isdecimal())
    )


def _record_labels(value: Any) -> list[str] | None:
    if not isinstance(value, (list, tuple)) or not value or len(value) > MAX_LABELS:
        return None
    id_names = {"id", "classid", "labelid", "index", "classindex", "labelindex"}
    name_names = {"name", "classname", "label", "category", "identity"}
    rows: list[tuple[int, str]] = []
    for item in value:
        if not isinstance(item, Mapping):
            return None
        fields = {_norm(str(key)): key for key in item}
        id_key = next((fields[key] for key in id_names if key in fields), None)
        name_key = next((fields[key] for key in name_names if key in fields), None)
        if (
            id_key is None
            or name_key is None
            or not _integer_key(item[id_key])
            or not isinstance(item[name_key], str)
        ):
            return None
        rows.append((int(item[id_key]), item[name_key]))
    rows.sort(key=lambda row: row[0])
    if [index for index, _ in rows] != list(range(len(rows))):
        return None
    return _label_sequence([name for _, name in rows])


def _output_dims(model: Any) -> list[int]:
    dims: list[int] = []
    graph = getattr(model, "graph", None)
    for output in getattr(graph, "output", ()) if graph is not None else ():
        try:
            name = _norm(output.name)
            if not any(token in name for token in ("logit", "prob", "score", "class")):
                continue
            tensor = output.type.tensor_type
            shape = tensor.shape.dim
            if len(shape) == 2:
                dim = shape[-1].dim_value
                if dim > 0:
                    dims.append(int(dim))
        except (AttributeError, TypeError):
            continue
    return dims


def _delimited_labels(value: str) -> list[str] | None:
    if not any(separator in value for separator in (",", "\n", "\r")):
        return None
    if re.search(r"__|[{}\[\];]|\b(?:lambda|import|eval|exec)\b", value):
        return None
    try:
        rows = list(csv.reader(io.StringIO(value), strict=True))
    except (csv.Error, MemoryError, RecursionError):
        return None
    rows = [[part.strip() for part in row] for row in rows if row]
    if not rows or any(not row for row in rows):
        return None
    if len(rows) > 1 and any(len(row) != 1 for row in rows):
        return None
    labels = [part for row in rows for part in row]
    return _label_sequence(labels)


def inspect_metadata(
    model: Any, *, label_source: str | None = None
) -> tuple[list[str], dict[str, Any]]:
    """Inspect ONNX metadata with strict traversal and parsing limits.

    `label_source` selects a discovered JSON Pointer candidate. Automatic label
    selection requires a known label key or count plus a classifier-like output.
    """
    props: dict[str, str] = {}
    for index, prop in enumerate(getattr(model, "metadata_props", ())):
        if index >= MAX_NODES:
            break
        key, value = getattr(prop, "key", None), getattr(prop, "value", None)
        if (
            isinstance(key, str)
            and len(key) <= 4096
            and isinstance(value, str)
            and len(value) <= MAX_VALUE_BYTES
            and key not in props
        ):
            props[key] = value

    metadata: dict[str, Any] = {
        "inspection": "unverified",
        "classes": "manual labels required",
        "resolution": "none",
        "explanation": "No usable label metadata was found.",
        "label_candidates": [],
    }
    budget = [0]
    roots: list[tuple[str, Any]] = []
    for key, raw in props.items():
        roots.append(("/" + _pointer_part(key), raw))

    observed_fields: dict[str, set[str]] = {}
    observed_counts: set[int] = set()
    field_conflicts: set[str] = set()

    def record_fields(key: str, value: Any) -> None:
        normalized = _norm(key)
        field = _NORMALIZED_FIELDS.get(normalized)
        if field and isinstance(value, (str, int, float, bool)):
            text_value = str(value).strip()
            if field == "model_type" and _norm(text_value) in {
                "faceclassifier",
                "faceidentityclassifier",
            }:
                text_value = "face_classifier"
            if text_value:
                observed_fields.setdefault(field, set()).add(text_value[:512])
        if normalized in _COUNT_KEYS:
            try:
                count = int(value)
                if count > 0:
                    observed_counts.add(count)
            except (ValueError, TypeError, OverflowError):
                pass

    for key, raw in props.items():
        record_fields(key, raw)

    found: list[dict[str, Any]] = []
    visited = 0

    def walk(value: Any, path: str, depth: int, semantic: bool = False) -> None:
        nonlocal visited
        if visited >= MAX_NODES or depth > MAX_DEPTH or len(found) >= MAX_CANDIDATES:
            return
        visited += 1
        if isinstance(value, str):
            if budget[0] >= MAX_PARSE_BYTES:
                return
            parsed = _decode(value, budget)
            if parsed is not None and parsed != value:
                walk(parsed, path, depth + 1, semantic)
            elif semantic and budget[0] <= MAX_PARSE_BYTES:
                labels = _delimited_labels(value)
                if labels is not None:
                    found.append({"path": path, "labels": labels, "known": True})
            return
        if isinstance(value, Mapping):
            for index, (key, item) in enumerate(value.items()):
                if index >= MAX_NODES:
                    break
                record_fields(str(key), item)
        labels = _label_sequence(value)
        if labels is None:
            labels = _record_labels(value)
        if labels is not None:
            if not any(candidate["path"] == path for candidate in found):
                key_norm = _norm(path.rsplit("/", 1)[-1])
                alias = semantic or key_norm in _ALIASES
                found.append(
                    {
                        "path": path,
                        "labels": labels,
                        "known": alias,
                        "eligible": key_norm not in _NON_LABEL_KEYS,
                    }
                )
            return
        if isinstance(value, Mapping):
            for index, (key, item) in enumerate(value.items()):
                if visited >= MAX_NODES or index >= MAX_NODES:
                    break
                part = _pointer_part(str(key))
                walk(
                    item,
                    path + "/" + part,
                    depth + 1,
                    _norm(str(key)) in _ALIASES and _norm(str(key)) not in _NON_LABEL_KEYS,
                )
        elif isinstance(value, (list, tuple)):
            for index, item in enumerate(value):
                if visited >= MAX_NODES:
                    break
                walk(item, path + "/" + str(index), depth + 1, semantic)

    for path, value in roots:
        # Direct raw label strings may use Python literals; ordinary prose is ignored.
        walk(value, path, 0, _norm(path.rsplit("/", 1)[-1]) in _ALIASES)

    for field, values in observed_fields.items():
        if len(values) > 1:
            field_conflicts.add(field)
        else:
            metadata[field] = next(iter(values))
    model_type = metadata.get("model_type", "")
    model_type = (
        "face_classifier"
        if _norm(model_type) in {"faceclassifier", "faceidentityclassifier"}
        else model_type
    )
    expected_count = next(iter(observed_counts)) if len(observed_counts) == 1 else None
    if len(observed_counts) > 1:
        field_conflicts.add("num_classes")

    dims = _output_dims(model)
    candidates: list[dict[str, Any]] = []
    for item in found:
        count = len(item["labels"])
        confidence = "high" if item["known"] else "review"
        reason = (
            "Recognized label metadata key."
            if item["known"]
            else "Label-shaped data under an unrecognized key."
        )
        if expected_count is not None and count != expected_count:
            confidence = "review"
            reason += f" Count differs from declared class count ({expected_count})."
        candidates.append(
            {
                "path": item["path"],
                "count": count,
                "preview": item["labels"][:5],
                "confidence": confidence,
                "reason": reason,
            }
        )
    if field_conflicts:
        metadata["metadata_conflicts"] = sorted(field_conflicts)
    metadata["label_candidates"] = candidates

    chosen: dict[str, Any] | None = None
    if label_source is not None:
        chosen = next((item for item in found if item["path"] == label_source), None)
        if chosen is None:
            raise ValueError(f"Unknown label source: {label_source}")
        metadata["resolution"] = "selected"
        metadata["explanation"] = f"Labels selected from {label_source}."
    else:
        known = [item for item in found if item["known"]]
        unique = {tuple(item["labels"]) for item in known}
        mismatched = [
            item for item in known if expected_count and len(item["labels"]) != expected_count
        ]
        if field_conflicts:
            metadata["resolution"] = "ambiguous"
            metadata["explanation"] = "Metadata fields conflict; review model metadata."
        elif mismatched:
            metadata["resolution"] = "ambiguous"
            metadata["explanation"] = "Candidate label count conflicts with declared class count."
        elif len(unique) == 1 and known:
            chosen = known[0]
            metadata["resolution"] = "automatic"
            metadata["explanation"] = "Recognized label metadata was selected automatically."
        elif known:
            metadata["resolution"] = "ambiguous"
            metadata["explanation"] = (
                "Recognized label sources conflict; choose a source for review."
            )
        else:
            corroborated = [
                item
                for item in found
                if item.get("eligible", True)
                and expected_count == len(item["labels"])
                and len(item["labels"]) in dims
            ]
            if len(corroborated) == 1:
                chosen = corroborated[0]
                metadata["resolution"] = "automatic"
                metadata["explanation"] = (
                    "Unique label candidate matches declared count and output dimension."
                )
            elif found:
                metadata["resolution"] = "ambiguous" if len(found) > 1 else "unrecognized"
                metadata["explanation"] = "Candidate labels need source review."
    labels = chosen["labels"] if chosen else []
    if labels:
        metadata.update(
            inspection="metadata inspected", classes="available", label_source=chosen["path"]
        )
        if chosen["path"].count("/") == 1:
            metadata["class_source"] = chosen["path"][1:]
    elif found:
        metadata["inspection"] = "review required"
        metadata["classes"] = "candidate labels require review"
    if model_type == "face_classifier":
        metadata["label_semantics"] = "identity"
        metadata["compatibility"] = (
            "Face identity classifier: labels are readable, but inference needs a face detector "
            "and a classifier adapter. Current InsightFace detection and embedding-recognition "
            "slots do not support this output format."
        )
    elif chosen and _norm(chosen["path"].rsplit("/", 1)[-1]) in {"identities", "identitynames"}:
        metadata["label_semantics"] = "identity"
    return labels, metadata
