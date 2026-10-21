"""Persistent camera-to-device bindings."""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

_MAX_FILE_BYTES = 512 * 1024
_MAX_BINDINGS = 64
_MAX_DEVICE_ID_LENGTH = 4096
_CAMERA_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_WRITE_ATTEMPTS = 5
_SHARING_ERRORS = {32, 33}


class CameraBindings:
    """Store camera device bindings locally, with atomic durable updates."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path) if path is not None else None
        self._lock = threading.RLock()
        self._bindings: dict[str, dict[str, Any]] = {}
        if self.path is not None:
            try:
                with self.path.open("rb") as stream:
                    raw = stream.read(_MAX_FILE_BYTES + 1)
            except FileNotFoundError:
                return
            except OSError:
                raise RuntimeError("Cannot read camera bindings") from None
            self._bindings = self._decode(raw)

    def get(self, camera_id: str, source: int) -> str | None:
        self._validate_camera_id(camera_id)
        self._validate_source(source)
        with self._lock:
            binding = self._bindings.get(camera_id)
            if binding is None or binding["source"] != source:
                return None
            return binding["device_id"]

    def bind(self, camera_id: str, source: int, device_id: str) -> None:
        self._validate_camera_id(camera_id)
        self._validate_source(source)
        self._validate_device_id(device_id)
        with self._lock:
            current = self._bindings.get(camera_id)
            if current is not None and current["source"] == source:
                if current["device_id"].casefold() != device_id.casefold():
                    raise RuntimeError("Camera already has a different device binding")
                return
            if any(
                other_camera != camera_id
                and binding["device_id"].casefold() == device_id.casefold()
                for other_camera, binding in self._bindings.items()
            ):
                raise RuntimeError("Device already has a camera binding")
            updated = dict(self._bindings)
            updated[camera_id] = {"source": source, "device_id": device_id}
            if len(updated) > _MAX_BINDINGS:
                raise RuntimeError("Too many camera bindings")
            self._save(updated)
            self._bindings = updated

    def remove(self, camera_id: str) -> None:
        self._validate_camera_id(camera_id)
        with self._lock:
            if camera_id not in self._bindings:
                return
            updated = dict(self._bindings)
            del updated[camera_id]
            self._save(updated)
            self._bindings = updated

    @staticmethod
    def _validate_camera_id(camera_id: str) -> None:
        if not isinstance(camera_id, str) or _CAMERA_ID.fullmatch(camera_id) is None:
            raise ValueError("Invalid camera ID")

    @staticmethod
    def _validate_source(source: int) -> None:
        if type(source) is not int or source < 0:
            raise ValueError("Source must be a nonnegative integer")

    @staticmethod
    def _validate_device_id(device_id: str) -> None:
        if (
            not isinstance(device_id, str)
            or not device_id
            or len(device_id) > _MAX_DEVICE_ID_LENGTH
            or "\0" in device_id
        ):
            raise ValueError("Invalid device ID")

    @classmethod
    def _decode(cls, raw: bytes) -> dict[str, dict[str, Any]]:
        try:
            if len(raw) > _MAX_FILE_BYTES:
                raise ValueError
            document = json.loads(raw.decode("utf-8"))
            if (
                not isinstance(document, dict)
                or set(document) != {"version", "bindings"}
                or type(document["version"]) is not int
                or document["version"] != 1
                or not isinstance(document["bindings"], dict)
                or len(document["bindings"]) > _MAX_BINDINGS
            ):
                raise ValueError
            bindings: dict[str, dict[str, Any]] = {}
            for camera_id, binding in document["bindings"].items():
                cls._validate_camera_id(camera_id)
                if not isinstance(binding, dict) or set(binding) != {"source", "device_id"}:
                    raise ValueError
                cls._validate_source(binding["source"])
                cls._validate_device_id(binding["device_id"])
                normalized_id = binding["device_id"].casefold()
                if any(
                    existing["device_id"].casefold() == normalized_id
                    for existing in bindings.values()
                ):
                    raise ValueError
                bindings[camera_id] = {
                    "source": binding["source"],
                    "device_id": binding["device_id"],
                }
            return bindings
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError, TypeError):
            raise RuntimeError("Camera bindings store is invalid") from None

    def _save(self, bindings: dict[str, dict[str, Any]]) -> None:
        document = json.dumps(
            {"version": 1, "bindings": bindings},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(document) > _MAX_FILE_BYTES:
            raise RuntimeError("Cannot save camera bindings")
        if self.path is None:
            return

        temp_path: str | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_path = tempfile.mkstemp(
                prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
            )
            with os.fdopen(fd, "wb") as stream:
                stream.write(document)
                stream.flush()
                os.fsync(stream.fileno())
            for attempt in range(_WRITE_ATTEMPTS):
                try:
                    os.replace(temp_path, self.path)
                    temp_path = None
                    break
                except OSError as error:
                    if getattr(error, "winerror", None) not in _SHARING_ERRORS:
                        raise
                    if attempt + 1 == _WRITE_ATTEMPTS:
                        raise
                    time.sleep(0.05 * (attempt + 1))
        except OSError:
            raise RuntimeError("Cannot save camera bindings") from None
        finally:
            if temp_path is not None:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
