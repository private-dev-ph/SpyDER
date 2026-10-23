"""Normalize bounded camera-local metadata for recorded frames."""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

MAX_ANNOTATIONS = 128
MAX_LABELS = 96
MAX_TEXT_LENGTH = 128


def _frame_size(frame: Any) -> tuple[int, int] | None:
    try:
        shape = frame.shape
        width, height = int(shape[1]), int(shape[0])
    except (AttributeError, IndexError, TypeError, ValueError):
        return None
    return (width, height) if width > 0 and height > 0 else None


def _matches_size(value: Any, size: tuple[int, int]) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) == 2
        and all(type(part) is int for part in value)
        and tuple(value) == size
    )


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _fresh(result: Mapping[str, Any]) -> bool:
    raw_age = result.get("result_age_seconds")
    if raw_age is None:
        return True
    age = _number(raw_age)
    return age is not None and 0 <= age <= 2


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:MAX_TEXT_LENGTH] if value else None


def _annotation(
    item: Any,
    *,
    kind: str,
    size: tuple[int, int],
    xyxy: bool = False,
) -> dict[str, Any] | None:
    if not isinstance(item, Mapping):
        return None
    label = _text(item.get("label")) or {"motion": "motion", "track": "track"}.get(kind)
    box = item.get("bbox")
    if label is None or not isinstance(box, (list, tuple)) or len(box) != 4:
        return None
    values = [_number(value) for value in box]
    if any(value is None for value in values):
        return None
    a, b, c, d = values
    if xyxy:
        x, y, width, height = a, b, c - a, d - b
    else:
        x, y, width, height = a, b, c, d
    if width <= 0 or height <= 0:
        return None
    frame_width, frame_height = size
    left, top = max(0.0, min(x, frame_width)), max(0.0, min(y, frame_height))
    right = max(0.0, min(x + width, frame_width))
    bottom = max(0.0, min(y + height, frame_height))
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0:
        return None
    result: dict[str, Any] = {
        "bbox": [
            left / frame_width,
            top / frame_height,
            width / frame_width,
            height / frame_height,
        ],
        "label": label,
        "kind": kind,
    }
    confidence = _number(item.get("confidence"))
    if confidence is not None and 0 <= confidence <= 1:
        result["confidence"] = confidence
    identity = _text(item.get("identity"))
    if identity is not None:
        result["identity"] = identity
    track_id = item.get("track_id", item.get("id")) if kind == "track" else item.get("track_id")
    if type(track_id) is int or (isinstance(track_id, str) and track_id and len(track_id) <= 128):
        result["track_id"] = track_id
    return result


def normalize_detection_metadata(metadata: Any, frame: Any) -> tuple[dict[str, Any], ...]:
    """Extract current, size-matched detections and motion boxes from one frame result."""
    size = _frame_size(frame)
    if size is None or not isinstance(metadata, Mapping):
        return ()
    output: list[dict[str, Any]] = []
    labels: set[str] = set()

    def add(item: Any, kind: str, *, xyxy: bool = False) -> None:
        if len(output) >= MAX_ANNOTATIONS:
            return
        annotation = _annotation(item, kind=kind, size=size, xyxy=xyxy)
        if annotation is None:
            return
        label = annotation["label"]
        if label not in labels and len(labels) >= MAX_LABELS:
            return
        labels.add(label)
        output.append(annotation)

    cv = metadata.get("cv")
    if (
        isinstance(cv, Mapping)
        and cv.get("state") == "ready"
        and _matches_size(cv.get("frame_size"), size)
    ):
        if _fresh(cv):
            detections = cv.get("detections", ())
            if isinstance(detections, (list, tuple)):
                for item in detections:
                    add(item, "detection", xyxy=True)

    analysis = metadata.get("analysis")
    if (
        isinstance(analysis, Mapping)
        and analysis.get("state") == "ready"
        and _matches_size(analysis.get("frame_size"), size)
    ):
        if _fresh(analysis):
            for key, kind in (("regions", "motion"), ("tracks", "track")):
                items = analysis.get(key, ())
                if isinstance(items, (list, tuple)):
                    for item in items:
                        add(item, kind)
    return tuple(output)
