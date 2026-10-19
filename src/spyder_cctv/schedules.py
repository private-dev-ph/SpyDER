"""Bounded, local-time recording schedules for the composite recorder."""

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import threading
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from datetime import time as clock_time
from pathlib import Path
from typing import Any

MAX_RULES = 64
MAX_FILE_BYTES = 256 * 1024
_TIME = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
_RULE_FIELDS = {"id", "name", "enabled", "camera_ids", "days", "start", "end"}


def _validate_rule(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("Each schedule must be an object")
    if set(raw) != _RULE_FIELDS:
        raise ValueError("Schedule fields are invalid")
    ident = raw.get("id")
    name = raw.get("name")
    enabled = raw.get("enabled")
    cameras = raw.get("camera_ids")
    days = raw.get("days")
    start, end = raw.get("start"), raw.get("end")
    if not isinstance(ident, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", ident):
        raise ValueError("Schedule id is invalid")
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise ValueError("Schedule name is invalid")
    if type(enabled) is not bool:
        raise ValueError("Schedule enabled must be boolean")
    if (
        not isinstance(cameras, list)
        or not cameras
        or len(cameras) > 64
        or any(not isinstance(camera, str) or not camera or len(camera) > 128 for camera in cameras)
    ):
        raise ValueError("Schedule camera_ids must be a non-empty list")
    if len(set(cameras)) != len(cameras):
        raise ValueError("Schedule camera_ids must be unique")
    if (
        not isinstance(days, list)
        or not days
        or len(days) > 7
        or any(type(day) is not int or day < 0 or day > 6 for day in days)
        or len(set(days)) != len(days)
    ):
        raise ValueError("Schedule days must contain unique weekdays from 0 to 6")
    if not isinstance(start, str) or not _TIME.fullmatch(start):
        raise ValueError("Schedule start must use HH:MM")
    if not isinstance(end, str) or not _TIME.fullmatch(end) or start == end:
        raise ValueError("Schedule end must use HH:MM and differ from start")
    return {
        "id": ident,
        "name": name.strip(),
        "enabled": enabled,
        "camera_ids": list(cameras),
        "days": sorted(days),
        "start": start,
        "end": end,
    }


class RecordingSchedules:
    """Coordinate schedule-owned sessions without taking over other sessions."""

    def __init__(
        self,
        manager: Any,
        recorder: Any,
        path: Path,
        autostart: bool = True,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.manager = manager
        self.recorder = recorder
        self.path = Path(path)
        self._clock = clock or datetime.now
        self._lock = threading.RLock()
        self._rules: list[dict[str, Any]] = []
        self._warnings: list[str] = []
        self._state = "idle"
        self._owned_session: str | None = None
        self._owned_cameras: tuple[str, ...] = ()
        self._owned_revision: Any = None
        self._relinquished_until: datetime | None = None
        self._last_start_attempt = float("-inf")
        self._retry_delay = 60.0
        self._closed = False
        self._load_error: str | None = None
        try:
            with self.path.open("rb") as stream:
                raw = stream.read(MAX_FILE_BYTES + 1)
            if len(raw) > MAX_FILE_BYTES:
                raise ValueError("Saved schedules exceed the 256 KiB limit")
            value = json.loads(raw.decode("utf-8"))
            self._rules = self._decode(value)
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError) as error:
            self._load_error = f"Saved schedules could not be read: {error}"
            self._warnings.append(self._load_error)
        if autostart and self._load_error is None and not self._closed:
            self.tick()

    @staticmethod
    def _decode(value: Any) -> list[dict[str, Any]]:
        if (
            not isinstance(value, dict)
            or set(value) != {"version", "schedules"}
            or type(value.get("version")) is not int
            or value["version"] != 1
            or not isinstance(value.get("schedules"), list)
        ):
            raise ValueError("Saved schedules have an unsupported format")
        if len(value["schedules"]) > MAX_RULES:
            raise ValueError(f"At most {MAX_RULES} schedules are allowed")
        rules = [_validate_rule(rule) for rule in value["schedules"]]
        if len({rule["id"] for rule in rules}) != len(rules):
            raise ValueError("Schedule ids must be unique")
        return rules

    @staticmethod
    def _window_key(now: datetime, rules: list[dict[str, Any]]) -> str | None:
        occurrences = _active_occurrences(now, rules)
        return (
            ",".join(
                sorted(f"{rule['id']}@{start.date().isoformat()}" for rule, start, _ in occurrences)
            )
            or None
        )

    @staticmethod
    def _window_end(now: datetime, rules: list[dict[str, Any]]) -> datetime | None:
        occurrences = _active_occurrences(now, rules)
        if not occurrences:
            return None
        end = max(item[2] for item in occurrences)
        changed = True
        while changed:
            changed = False
            for _, start, candidate_end in _nearby_occurrences(now, rules):
                if start <= end and candidate_end > end:
                    end = candidate_end
                    changed = True
        return end

    def _relinquish_current_window(self, now: datetime) -> None:
        self._relinquished_until = self._window_end(now, self._rules)
        self._clear_ownership()

    def _current_status(self) -> dict[str, Any]:
        return self.recorder.status()

    def _command(self, action: str, *args, revision=None):
        method = getattr(self.recorder, action)
        if getattr(self.recorder, "supports_expected_revision", False):
            return method(*args, expected_revision=revision)
        return method(*args)

    def _revision(self, status: dict[str, Any]) -> Any:
        return status.get("control_revision", status.get("revision"))

    def release_ownership(self) -> None:
        """Relinquish current schedule session after manual or workflow control."""
        with self._lock:
            if self._owned_session:
                now = self._clock()
                self._relinquish_current_window(now)
                self._clear_ownership()

    def _clear_ownership(self) -> None:
        self._owned_session = None
        self._owned_cameras = ()
        self._owned_revision = None

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            now = self._clock()
            active = [rule["id"] for rule in self._rules if _is_active(rule, now)]
            return {
                "schedules": copy.deepcopy(self._rules),
                "active_ids": active,
                "state": "error" if self._load_error else self._state,
                "warnings": list(self._warnings),
                "timezone": str(now.astimezone().tzinfo),
            }

    def save(self, raw: Any) -> dict[str, Any]:
        if isinstance(raw, dict):
            if set(raw) != {"schedules"}:
                raise ValueError("Schedule document fields are invalid")
            raw = raw.get("schedules")
        if not isinstance(raw, list) or len(raw) > MAX_RULES:
            raise ValueError(f"Schedules must be a list of at most {MAX_RULES} rules")
        rules = [_validate_rule(rule) for rule in raw]
        if len({rule["id"] for rule in rules}) != len(rules):
            raise ValueError("Schedule ids must be unique")
        workers = getattr(self.manager, "workers", {})
        warnings = []
        for rule in rules:
            missing = [camera for camera in rule["camera_ids"] if camera not in workers]
            if missing:
                warnings.append(f"Schedule {rule['id']} references missing camera {missing[0]}")
        with self._lock:
            if self._closed:
                raise RuntimeError("Recording schedules are closed")
            if self._load_error:
                raise RuntimeError("Saved schedules are corrupt; refusing to overwrite them")
            self._atomic_write({"version": 1, "schedules": rules})
            self._rules = rules
            self._warnings = list(dict.fromkeys(item[:500] for item in warnings))[-20:]
            self._state = "idle"
            self._relinquished_until = None
        self.tick()
        return self.snapshot()

    def remove(self, ident: str) -> dict[str, Any]:
        with self._lock:
            if self._closed:
                raise RuntimeError("Recording schedules are closed")
            if self._load_error:
                raise RuntimeError("Saved schedules are corrupt; refusing to overwrite them")
            rules = [rule for rule in self._rules if rule["id"] != ident]
            if len(rules) == len(self._rules):
                raise KeyError(ident)
            return self.save(rules)

    def _atomic_write(self, value: dict[str, Any]) -> None:
        payload = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
        if len(payload) > MAX_FILE_BYTES:
            raise ValueError("Saved schedules exceed 256 KiB; reduce rules or camera selections")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(
            prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
        except Exception:
            try:
                os.unlink(name)
            except OSError:
                pass
            raise

    def tick(self, now: datetime | None = None) -> dict[str, Any]:
        with self._lock:
            if self._closed:
                self._state = "closed"
                return self.snapshot()
            if self._load_error:
                self._state = "error"
                return self.snapshot()
            now = now or self._clock()
            active = [rule for rule in self._rules if _is_active(rule, now)]
            needed = tuple(sorted({camera for rule in active for camera in rule["camera_ids"]}))
            workers = getattr(self.manager, "workers", {})
            missing = [camera for camera in needed if camera not in workers]
            current = self._current_status()
            state = current.get("state")
            session = current.get("session_id")
            cameras = tuple(sorted(current.get("camera_ids") or []))
            if self._owned_session:
                if state != "recording":
                    self._relinquish_current_window(now)
                    self._set_status(
                        "waiting" if needed else "idle",
                        "Scheduled recording stopped before its window ended",
                    )
                    return self.snapshot()
                if (
                    session != self._owned_session
                    or cameras != self._owned_cameras
                    or self._revision(current) != self._owned_revision
                ):
                    self._relinquish_current_window(now)
                    self._set_status(
                        "waiting" if needed else "idle",
                        "Schedule control was released for this window",
                    )
                    return self.snapshot()
                if not needed:
                    self._command("stop", revision=self._owned_revision)
                    self._clear_ownership()
                    self._set_status("idle")
                    return self.snapshot()
                if missing:
                    self._set_status(
                        "waiting", f"Scheduled recording is waiting for missing camera {missing[0]}"
                    )
                    return self.snapshot()
                if needed != self._owned_cameras:
                    try:
                        updated = self._command(
                            "select", list(needed), revision=self._owned_revision
                        )
                        self._owned_cameras = needed
                        self._owned_revision = self._revision(updated)
                        self._set_status("recording")
                    except Exception as error:
                        self._set_status("waiting", f"Schedule update failed: {error}")
                    return self.snapshot()
                self._set_status("recording")
                return self.snapshot()
            if self._relinquished_until is not None:
                if now < self._relinquished_until:
                    self._set_status("waiting", "Schedule control was released for this window")
                    return self.snapshot()
                self._relinquished_until = None
            if missing:
                self._set_status(
                    "waiting", f"Scheduled recording is waiting for missing camera {missing[0]}"
                )
                return self.snapshot()
            if not needed:
                self._set_status("idle")
                return self.snapshot()
            if state in ("recording", "stopping"):
                self._set_status("waiting", "Another recording session is active")
                return self.snapshot()
            monotonic = time.monotonic()
            if monotonic - self._last_start_attempt < self._retry_delay:
                self._set_status("blocked", "Scheduled recording is waiting to retry")
                return self.snapshot()
            try:
                started = self._command("start", list(needed), revision=self._revision(current))
                self._owned_session = started.get("session_id")
                self._owned_cameras = tuple(sorted(started.get("camera_ids") or []))
                self._owned_revision = self._revision(started)
                self._set_status("recording")
            except Exception as error:
                self._last_start_attempt = monotonic
                self._set_status("blocked", f"Scheduled recording could not start: {error}")
            return self.snapshot()

    def _set_status(self, state: str, *warnings: str) -> None:
        self._state = state
        self._warnings = list(dict.fromkeys(item[:500] for item in warnings))[-20:]

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._state = "closed"


def _is_active(rule: dict[str, Any], now: datetime) -> bool:
    if not rule["enabled"]:
        return False
    start = clock_time.fromisoformat(rule["start"])
    end = clock_time.fromisoformat(rule["end"])
    current = now.time().replace(tzinfo=None)
    if start < end:
        return now.weekday() in rule["days"] and start <= current < end
    if current >= start:
        return now.weekday() in rule["days"]
    if current < end:
        return (now.weekday() - 1) % 7 in rule["days"]
    return False


def _occurrences_for_dates(
    now: datetime, rules: list[dict[str, Any]], days: int
) -> list[tuple[dict[str, Any], datetime, datetime]]:
    occurrences = []
    start_day = now.date() - timedelta(days=days)
    for offset in range(days * 2 + 1):
        day = start_day + timedelta(days=offset)
        for rule in rules:
            if not rule["enabled"] or day.weekday() not in rule["days"]:
                continue
            start = datetime.combine(
                day, clock_time.fromisoformat(rule["start"]), tzinfo=now.tzinfo
            )
            end = datetime.combine(day, clock_time.fromisoformat(rule["end"]), tzinfo=now.tzinfo)
            if end <= start:
                end += timedelta(days=1)
            occurrences.append((rule, start, end))
    return occurrences


def _active_occurrences(
    now: datetime, rules: list[dict[str, Any]]
) -> list[tuple[dict[str, Any], datetime, datetime]]:
    return [item for item in _occurrences_for_dates(now, rules, 1) if item[1] <= now < item[2]]


def _nearby_occurrences(
    now: datetime, rules: list[dict[str, Any]]
) -> list[tuple[dict[str, Any], datetime, datetime]]:
    return _occurrences_for_dates(now, rules, 8)
