"""Persistent, bounded local event catalog."""

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

MAX_EVENTS = 10000
MAX_NAME = 200
MAX_MESSAGE = 500
_ID = re.compile(r"^[0-9a-f]{32}$")


class EventService:
    """Store event metadata and recorder-owned media references atomically."""

    def __init__(self, storage_dir: Path, recorder: Any) -> None:
        self.root = Path(storage_dir).resolve() / "events"
        self.root.mkdir(parents=True, exist_ok=True)
        self._path = self.root / "events.json"
        self.recorder = recorder
        self._lock = threading.RLock()
        self.storage_error: str | None = None
        try:
            self._events = self._load()
        except (OSError, ValueError) as error:
            self._events = []
            self.storage_error = str(error)[:200] or "Cannot load event storage"

    def list(self) -> dict[str, Any]:
        with self._lock:
            return {
                "events": copy.deepcopy(self._events),
                "storage_error": self.storage_error,
                "retention_limit": MAX_EVENTS,
            }

    def create(
        self,
        *,
        name: str,
        kind: str,
        camera_id: str,
        camera_name: str,
        workflow_id: str | None = None,
        node_id: str | None = None,
        message: str = "",
        media: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        item = {
            "id": uuid.uuid4().hex,
            "name": self._name(name),
            "kind": kind if kind in ("workflow", "motion") else "workflow",
            "camera_id": str(camera_id)[:128],
            "camera_name": str(camera_name)[:128],
            "workflow_id": workflow_id,
            "node_id": node_id,
            "created_at": datetime.now(UTC).isoformat(timespec="milliseconds"),
            "message": str(message)[:MAX_MESSAGE],
            "media": self._media(media or []),
        }
        with self._lock:
            self._ensure_writable()
            previous = self._events
            self._events = copy.deepcopy(self._events)
            self._events.insert(0, item)
            del self._events[MAX_EVENTS:]
            try:
                self._save()
            except OSError:
                self._events = previous
                raise
            return copy.deepcopy(item)

    def attach_media(self, event_id: str, media: list[dict[str, Any]]) -> dict[str, Any]:
        self._validate_id(event_id)
        with self._lock:
            self._ensure_writable()
            item = self._find(event_id)
            previous = item["media"]
            item["media"] = self._media(media)
            item.pop("attachment_status", None)
            try:
                self._save()
            except OSError:
                item["media"] = previous
                raise
            return copy.deepcopy(item)

    def set_attachment_status(self, event_id: str, status: str, error: str | None = None) -> None:
        self._validate_id(event_id)
        if status not in ("pending", "error"):
            raise ValueError("Invalid attachment status")
        if error is not None and (not isinstance(error, str) or len(error) > 200):
            raise ValueError("Invalid attachment error")
        with self._lock:
            self._ensure_writable()
            item = self._find(event_id)
            previous = item.get("attachment_status")
            previous_error = item.get("attachment_error")
            item["attachment_status"] = status
            if error:
                item["attachment_error"] = error
            else:
                item.pop("attachment_error", None)
            try:
                self._save()
            except OSError:
                if previous is None:
                    item.pop("attachment_status", None)
                else:
                    item["attachment_status"] = previous
                if previous_error is not None:
                    item["attachment_error"] = previous_error
                else:
                    item.pop("attachment_error", None)
                raise

    def rename(self, event_id: str, name: Any) -> dict[str, Any]:
        self._validate_id(event_id)
        value = self._name(name)
        with self._lock:
            self._ensure_writable()
            item = self._find(event_id)
            previous = item["name"]
            item["name"] = value
            try:
                self._save()
            except OSError:
                item["name"] = previous
                raise
            return copy.deepcopy(item)

    def delete(self, ids: Any) -> list[str]:
        if (
            not isinstance(ids, list)
            or not ids
            or len(ids) > 100
            or any(not isinstance(value, str) for value in ids)
        ):
            raise ValueError("Send 1 to 100 event ids")
        unique = list(dict.fromkeys(ids))
        for event_id in unique:
            self._validate_id(event_id)
        with self._lock:
            self._ensure_writable()
            found = {item["id"] for item in self._events}
            if any(event_id not in found for event_id in unique):
                raise KeyError("Unknown event")
            selected = set(unique)
            previous = self._events
            self._events = [item for item in self._events if item["id"] not in selected]
            try:
                self._save()
            except OSError:
                self._events = previous
                raise
            return unique

    def selected(self, ids: list[str]) -> list[dict[str, Any]]:
        if not ids or len(ids) > 100:
            raise ValueError("Select 1 to 100 events")
        for event_id in ids:
            self._validate_id(event_id)
        with self._lock:
            by_id = {item["id"]: item for item in self._events}
            if any(event_id not in by_id for event_id in ids):
                raise KeyError("Unknown event")
            return [copy.deepcopy(by_id[event_id]) for event_id in dict.fromkeys(ids)]

    def media_path(self, media_id: str) -> Path:
        self._validate_id(media_id)
        path = Path(self.recorder.media_path(media_id)).resolve()
        if not path.is_file():
            raise KeyError(media_id)
        with self._lock:
            associated = any(
                media_id == media.get("id") for event in self._events for media in event["media"]
            )
            if not associated:
                raise KeyError(media_id)
        return path

    def _load(self) -> list[dict[str, Any]]:
        if not self._path.exists():
            return []
        raw = json.loads(self._path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or set(raw) != {"events"}:
            raise ValueError("Invalid event file")
        if not isinstance(raw["events"], list):
            raise ValueError("Invalid event file")
        events = []
        seen = set()
        for event in raw["events"][:MAX_EVENTS]:
            if not isinstance(event, dict):
                continue
            if not _ID.fullmatch(str(event.get("id", ""))) or event["id"] in seen:
                continue
            try:
                datetime.fromisoformat(event["created_at"])
                media = self._media(event.get("media", []))
                cleaned = {
                    "id": event["id"],
                    "name": self._name(event.get("name", "Event")),
                    "kind": (
                        event.get("kind")
                        if event.get("kind") in ("workflow", "motion")
                        else "workflow"
                    ),
                    "camera_id": str(event.get("camera_id", ""))[:128],
                    "camera_name": str(event.get("camera_name", ""))[:128],
                    "workflow_id": event.get("workflow_id"),
                    "node_id": event.get("node_id"),
                    "created_at": event["created_at"],
                    "message": str(event.get("message", ""))[:MAX_MESSAGE],
                    "media": media,
                }
                if event.get("attachment_status") in ("pending", "error"):
                    cleaned["attachment_status"] = event["attachment_status"]
                if event.get("attachment_status") == "pending":
                    cleaned["attachment_status"] = "error"
                    cleaned["attachment_error"] = "Recording interrupted by app restart"
                elif isinstance(event.get("attachment_error"), str):
                    cleaned["attachment_error"] = event["attachment_error"][:200]
                events.append(cleaned)
                seen.add(event["id"])
            except (KeyError, TypeError, ValueError):
                continue
        return events

    @staticmethod
    def _name(value: Any) -> str:
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > MAX_NAME:
            raise ValueError("Event name must be nonempty and at most 200 characters")
        return value.strip()

    @staticmethod
    def _validate_id(value: str) -> None:
        if not isinstance(value, str) or not _ID.fullmatch(value):
            raise ValueError("Invalid event or media id")

    def _find(self, event_id: str) -> dict[str, Any]:
        item = next((event for event in self._events if event["id"] == event_id), None)
        if item is None:
            raise KeyError("Unknown event")
        return item

    def _ensure_writable(self) -> None:
        if self.storage_error is not None:
            raise RuntimeError("Event storage is unreadable; events cannot be changed")

    def _media(self, values: Any) -> list[dict[str, Any]]:
        if not isinstance(values, list) or len(values) > 16:
            raise ValueError("Invalid event media list")
        result = []
        for media in values:
            if not isinstance(media, dict):
                continue
            ident = media.get("id")
            try:
                self._validate_id(ident)
                path = Path(self.recorder.media_path(ident)).resolve()
                if not path.is_file():
                    continue
                catalog = next(
                    (
                        item
                        for item in self.recorder.status().get("items", [])
                        if item.get("id") == ident
                    ),
                    None,
                )
                if catalog is None:
                    continue
                result.append(
                    {
                        key: catalog[key]
                        for key in (
                            "id",
                            "kind",
                            "filename",
                            "created_at",
                            "size_bytes",
                            "url",
                            "duration_seconds",
                        )
                        if key in catalog
                    }
                )
            except (KeyError, ValueError, OSError, TypeError, AttributeError):
                continue
        return result

    def _save(self) -> None:
        data = json.dumps({"events": self._events}, ensure_ascii=False, indent=2).encode("utf-8")
        fd, name = tempfile.mkstemp(prefix=".events-", suffix=".tmp", dir=self.root)
        try:
            with os.fdopen(fd, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            for attempt in range(6):
                try:
                    os.replace(name, self._path)
                    break
                except PermissionError as error:
                    if getattr(error, "winerror", None) not in (32, 33, 5) or attempt == 5:
                        raise
                    time.sleep(0.02 * 2**attempt)
            self.storage_error = None
        except OSError as error:
            self.storage_error = str(error)[:200] or "Cannot save event storage"
            raise
        finally:
            try:
                os.unlink(name)
            except FileNotFoundError:
                pass
