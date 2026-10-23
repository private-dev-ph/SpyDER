"""Bounded, compressed detection overlays for recorded clips."""

from __future__ import annotations

import gzip
import itertools
import json
import math
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any

CHUNK_SECONDS = 30
MAX_DECODED_CHUNK_BYTES = 2 * 1024 * 1024
MAX_BOXES = 128
MAX_RECORDS = 1800
MAX_CHUNK_INDEX = 2880
_MEDIA_ID = re.compile(r"[0-9a-fA-F]{32}\Z")
_CHUNK_NAME = re.compile(r"([0-9a-fA-F]{32})\.overlays-(\d{6})\.json\.gz\Z")
_TEMP_NAME = re.compile(r"\.([0-9a-fA-F]{32})\.overlays-\d{6}\.json\.gz\.[^/\\]+\.tmp\Z")


def _valid_id(media_id: str) -> str:
    if not isinstance(media_id, str) or _MEDIA_ID.fullmatch(media_id) is None:
        raise ValueError("Invalid media ID")
    return media_id.lower()


def _has_symlink_component(path: Path) -> bool:
    absolute = path.absolute()
    return any(part.is_symlink() for part in (absolute, *absolute.parents))


def _finite_number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _clean_boxes(boxes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(boxes, list):
        raise ValueError("Boxes must be a list")
    if len(boxes) > MAX_BOXES:
        raise OverflowError("Too many boxes")
    cleaned: list[dict[str, Any]] = []
    for box in boxes:
        if not isinstance(box, dict):
            raise ValueError("Invalid box")
        bbox = box.get("bbox")
        if (
            not isinstance(bbox, (list, tuple))
            or len(bbox) != 4
            or not all(_finite_number(value) for value in bbox)
        ):
            raise ValueError("Invalid normalized bounding box")
        x, y, width, height = (float(value) for value in bbox)
        if x < 0 or y < 0 or width < 0 or height < 0 or x + width > 1 or y + height > 1:
            raise ValueError("Bounding box must be normalized xywh")
        result: dict[str, Any] = {"bbox": [x, y, width, height]}
        for key in ("camera_id", "kind", "label", "identity", "track_id"):
            value = box.get(key)
            if value is not None:
                if key in {"camera_id", "kind", "label", "identity"} and not isinstance(value, str):
                    raise ValueError(f"Invalid {key}")
                if not isinstance(value, (str, int, float, bool)):
                    raise ValueError(f"Invalid {key}")
                if isinstance(value, str) and "\0" in value:
                    raise ValueError(f"Invalid {key}")
                if key == "label" and isinstance(value, str):
                    value = value[:96]
                elif isinstance(value, str) and len(value) > 128:
                    raise ValueError(f"Invalid {key}")
                if isinstance(value, float) and not math.isfinite(value):
                    raise ValueError(f"Invalid {key}")
                result[key] = value
        if "label" in result and len(str(result["label"])) > 96:
            raise ValueError("Label too long")
        confidence = box.get("confidence")
        if confidence is not None:
            if not _finite_number(confidence):
                raise ValueError("Invalid confidence")
            result["confidence"] = float(confidence)
        cleaned.append(result)
    return cleaned


def _validate_chunk(document: Any, expected_index: int) -> dict[str, Any] | None:
    if not isinstance(document, dict):
        raise ValueError("Invalid overlay chunk")
    required = {"version", "media_id", "chunk_seconds", "index", "width", "height", "fps", "samples", "truncated"}
    if set(document) != required:
        raise ValueError("Invalid overlay chunk")
    if (
        type(document["version"]) is not int or document["version"] != 1
        or not isinstance(document["media_id"], str) or _MEDIA_ID.fullmatch(document["media_id"]) is None
        or type(document["chunk_seconds"]) is not int or document["chunk_seconds"] != CHUNK_SECONDS
        or type(document["index"]) is not int or document["index"] != expected_index
        or type(document["width"]) is not int or document["width"] <= 0
        or type(document["height"]) is not int or document["height"] <= 0
        or not _finite_number(document["fps"]) or document["fps"] < 0
        or type(document["truncated"]) is not bool
        or not isinstance(document["samples"], list) or len(document["samples"]) > MAX_RECORDS
    ):
        raise ValueError("Invalid overlay chunk")
    previous = -1.0
    samples: list[dict[str, Any]] = []
    try:
        for sample in document["samples"]:
            if not isinstance(sample, dict) or set(sample) != {"time", "boxes"}:
                raise ValueError("Invalid overlay sample")
            timestamp = sample["time"]
            start = expected_index * CHUNK_SECONDS
            end = start + CHUNK_SECONDS
            if not _finite_number(timestamp) or timestamp < start or timestamp >= end or timestamp < previous:
                raise ValueError("Invalid overlay timestamp")
            boxes = _clean_boxes(sample["boxes"])
            previous = float(timestamp)
            samples.append({"time": previous, "boxes": boxes})
    except (ValueError, OverflowError, TypeError):
        raise ValueError("Invalid overlay chunk") from None
    return {
        "version": 1, "media_id": document["media_id"].lower(),
        "chunk_seconds": CHUNK_SECONDS, "index": expected_index,
        "width": document["width"], "height": document["height"], "fps": float(document["fps"]),
        "samples": samples, "truncated": document["truncated"],
    }


def read_chunk(directory: Path, media_id: str, index: int) -> dict[str, Any] | None:
    """Read one validated chunk, returning None for missing or corrupt data."""
    media_id = _valid_id(media_id)
    if type(index) is not int or not 0 <= index <= MAX_CHUNK_INDEX:
        raise ValueError("Invalid chunk index")
    path = Path(directory) / f"{media_id}.overlays-{index:06d}.json.gz"
    try:
        if _has_symlink_component(path):
            raise ValueError("Overlay path contains a symbolic link")
        if path.stat().st_size > MAX_DECODED_CHUNK_BYTES + 65536:
            raise ValueError("Overlay chunk is too large")
        with gzip.open(path, "rb") as stream:
            raw = stream.read(MAX_DECODED_CHUNK_BYTES + 1)
        if len(raw) > MAX_DECODED_CHUNK_BYTES:
            raise ValueError("Overlay chunk is too large")
        document = json.loads(raw.decode("utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, EOFError, UnicodeDecodeError, json.JSONDecodeError, gzip.BadGzipFile, ValueError):
        raise ValueError("Invalid overlay chunk") from None
    validated = _validate_chunk(document, index)
    if validated is None:
        raise ValueError("Invalid overlay chunk")
    if validated["media_id"] != media_id:
        raise ValueError("Overlay media ID does not match filename")
    return validated


def sidecar_paths(directory: Path, media_id: str) -> list[Path]:
    """List recognized chunk files for one media ID, bounded by the index range."""
    media_id = _valid_id(media_id)
    root = Path(directory)
    result: list[Path] = []
    try:
        if _has_symlink_component(root):
            return []
        for path in itertools.islice(root.iterdir(), (MAX_CHUNK_INDEX + 1) * 2):
            match = _CHUNK_NAME.fullmatch(path.name)
            if match and match.group(1).lower() == media_id and int(match.group(2)) <= MAX_CHUNK_INDEX:
                result.append(path)
                if len(result) >= MAX_CHUNK_INDEX + 1:
                    break
    except OSError:
        return []
    return sorted(result, key=lambda path: path.name)


def remove_sidecars(directory: Path, media_id: str) -> None:
    """Remove only recognized sidecars and their temporary files for one media ID."""
    media_id = _valid_id(media_id)
    root = Path(directory)
    try:
        if _has_symlink_component(root):
            return
        paths = list(itertools.islice(root.iterdir(), (MAX_CHUNK_INDEX + 1) * 2))
    except OSError:
        return
    for path in paths[: MAX_CHUNK_INDEX * 2 + 2]:
        match = _CHUNK_NAME.fullmatch(path.name)
        temporary = _TEMP_NAME.fullmatch(path.name)
        if (match and match.group(1).lower() == media_id and int(match.group(2)) <= MAX_CHUNK_INDEX) or (
            temporary and temporary.group(1).lower() == media_id
        ):
            try:
                path.unlink()
            except OSError:
                pass


def used_sidecar_bytes(directory: Path) -> int:
    """Count actual size of recognized chunks and writer temporary files."""
    total = 0
    try:
        root = Path(directory)
        if _has_symlink_component(root):
            return 0
        paths = itertools.islice(root.iterdir(), (MAX_CHUNK_INDEX + 1) * 2)
    except OSError:
        return 0
    for path in paths:
        if not (_CHUNK_NAME.fullmatch(path.name) or _TEMP_NAME.fullmatch(path.name)):
            continue
        try:
            if not path.is_symlink() and path.is_file():
                total += path.stat().st_size
        except OSError:
            continue
    return total


class OverlayWriter:
    """Write bounded 30-second overlay chunks with atomic checkpoints."""

    def __init__(self, directory: Path, media_id: str, width: int, height: int, fps: float) -> None:
        self.directory = Path(directory)
        self.media_id = _valid_id(media_id)
        if type(width) is not int or width <= 0 or type(height) is not int or height <= 0:
            raise ValueError("Invalid media dimensions")
        if not _finite_number(fps) or fps <= 0:
            raise ValueError("Invalid frame rate")
        self.width, self.height, self.fps = width, height, float(fps)
        self._lock = threading.RLock()
        self._index: int | None = None
        self._samples: list[dict[str, Any]] = []
        self._encoded_samples_size = 0
        self._current_boxes: list[dict[str, Any]] = []
        self._truncated = False
        self._last_checkpoint = 0.0
        self._closed = False

    def append(self, time_seconds: float, boxes: list[dict[str, Any]]) -> None:
        if not _finite_number(time_seconds) or time_seconds < 0:
            raise ValueError("Invalid overlay timestamp")
        index = int(time_seconds // CHUNK_SECONDS)
        if index > MAX_CHUNK_INDEX:
            raise ValueError("Overlay timestamp exceeds supported duration")
        with self._lock:
            self._ensure_open()
            rotated = False
            if self._index is None:
                self._start_chunk(index)
            elif index < self._index:
                raise ValueError("Overlay timestamps must be chronological")
            elif index > self._index:
                self.checkpoint()
                self._start_chunk(index)
                rotated = True
            if self._truncated:
                return
            try:
                cleaned = _clean_boxes(boxes)
            except OverflowError:
                self._truncate(float(time_seconds))
                return
            self._append_sample(float(time_seconds), cleaned)
            if rotated:
                self.checkpoint()
                self._last_checkpoint = time_seconds
            elif time_seconds - self._last_checkpoint >= 5.0:
                self.checkpoint()
                self._last_checkpoint = time_seconds

    def _start_chunk(self, index: int) -> None:
        self._index = index
        self._samples = []
        self._encoded_samples_size = 0
        self._current_boxes = []
        self._truncated = False
        self._append_sample(float(index * CHUNK_SECONDS), [])

    def _append_sample(self, timestamp: float, boxes: list[dict[str, Any]]) -> None:
        sample = {"time": timestamp, "boxes": boxes}
        if self._samples and timestamp == self._samples[-1]["time"]:
            self._replace_last_sample(sample)
        elif self._samples and boxes == self._samples[-1]["boxes"]:
            self._current_boxes = boxes
            return
        elif len(self._samples) >= MAX_RECORDS - 1:
            self._truncate(timestamp)
            return
        else:
            self._append_new_sample(sample)
        self._current_boxes = boxes
        if not self._within_budget():
            self._truncate(timestamp)

    def _sample_size(self, sample: dict[str, Any]) -> int:
        return len(json.dumps(sample, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))

    def _append_new_sample(self, sample: dict[str, Any]) -> None:
        self._encoded_samples_size += self._sample_size(sample) + (1 if self._samples else 0)
        self._samples.append(sample)

    def _replace_last_sample(self, sample: dict[str, Any]) -> None:
        self._encoded_samples_size += self._sample_size(sample) - self._sample_size(self._samples[-1])
        self._samples[-1] = sample

    def _within_budget(self) -> bool:
        header = {
            "version": 1, "media_id": self.media_id, "chunk_seconds": CHUNK_SECONDS,
            "index": self._index or 0, "width": self.width, "height": self.height,
            "fps": self.fps, "samples": [], "truncated": self._truncated,
        }
        overhead = len(json.dumps(header, separators=(",", ":")).encode("utf-8"))
        return overhead + self._encoded_samples_size <= MAX_DECODED_CHUNK_BYTES

    def _truncate(self, timestamp: float) -> None:
        self._truncated = True
        chunk_start = (self._index or 0) * CHUNK_SECONDS
        clear_time = min(max(float(timestamp), float(chunk_start)), chunk_start + CHUNK_SECONDS - 1e-9)
        if self._samples and clear_time < self._samples[-1]["time"]:
            clear_time = self._samples[-1]["time"]
        clear = {"time": clear_time, "boxes": []}
        if self._samples and clear_time == self._samples[-1]["time"]:
            self._replace_last_sample(clear)
        elif len(self._samples) < MAX_RECORDS:
            self._append_new_sample(clear)
        else:
            self._replace_last_sample(clear)
        self._current_boxes = []

    def _document(self) -> dict[str, Any]:
        return {
            "version": 1, "media_id": self.media_id,
            "chunk_seconds": CHUNK_SECONDS, "index": self._index or 0,
            "width": self.width, "height": self.height, "fps": self.fps,
            "samples": self._samples, "truncated": self._truncated,
        }

    def checkpoint(self) -> None:
        with self._lock:
            self._ensure_open()
            if self._index is None:
                return
            document = self._document()
            raw = json.dumps(document, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
            if len(raw) > MAX_DECODED_CHUNK_BYTES:
                self._truncate(self._samples[-1]["time"] if self._samples else 0.0)
                raw = json.dumps(self._document(), ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
            self.directory.mkdir(parents=True, exist_ok=True)
            if _has_symlink_component(self.directory):
                raise OSError("Overlay directory contains a symbolic link")
            destination = self.directory / f"{self.media_id}.overlays-{self._index:06d}.json.gz"
            if destination.is_symlink():
                raise OSError("Overlay destination is a symbolic link")
            fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=self.directory)
            try:
                with os.fdopen(fd, "wb") as raw_stream:
                    with gzip.GzipFile(fileobj=raw_stream, mode="wb", compresslevel=3, mtime=0) as compressed:
                        compressed.write(raw)
                    raw_stream.flush()
                    os.fsync(raw_stream.fileno())
                os.replace(temporary, destination)
            finally:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self.checkpoint()
            self._closed = True

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("Overlay writer is closed")
