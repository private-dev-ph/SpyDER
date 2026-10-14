"""Conservative local CPU capacity estimate for lightweight CV analysis."""

from __future__ import annotations

import ctypes
import math
import os
import sys
import threading
import time
from collections.abc import Callable
from typing import Any

import cv2
import numpy as np

PROFILES = ("MOG2", "Motion regions", "MIL tracking")
INPUT_WIDTH = 480
INPUT_HEIGHT = 270
INFERENCE_FPS = 5
CPU_BUDGET = 0.60
MAX_INSTANCES = 64
_MEMORY_PER_INSTANCE = {"MOG2": 64 << 20, "Motion regions": 16 << 20, "MIL tracking": 32 << 20}


def _memory_bytes() -> int | None:
    if sys.platform == "win32":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.ullTotalPhys)
    if sys.platform.startswith("linux"):
        try:
            return int(os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE"))
        except (OSError, ValueError, TypeError):
            return None
    return None


def _hardware() -> dict[str, int | None]:
    return {"logical_cpus": os.cpu_count(), "memory_bytes": _memory_bytes()}


def _frame(index: int) -> np.ndarray:
    image = np.zeros((INPUT_HEIGHT, INPUT_WIDTH, 3), dtype=np.uint8)
    left = (index * 7) % (INPUT_WIDTH - 64)
    cv2.rectangle(image, (left, 80), (left + 48, 144), (220, 220, 220), -1)
    return image


def _time_profile(
    operation: Callable[[], None], deadline: float, frames: int = 8
) -> float:
    warmup = time.perf_counter()
    operation()  # Warm up OpenCV and initialize lazy buffers.
    warmup_ms = (time.perf_counter() - warmup) * 1000
    if time.monotonic() >= deadline:
        return max(0.01, warmup_ms)
    began = time.perf_counter()
    completed = 0
    for _ in range(frames):
        if time.monotonic() >= deadline:
            break
        operation()
        completed += 1
    if completed == 0:
        raise TimeoutError("Capacity benchmark deadline expired")
    return max(0.01, (time.perf_counter() - began) * 1000 / completed)


def _benchmark() -> list[dict[str, Any]]:
    deadline = time.monotonic() + 3.0
    frames = [_frame(i) for i in range(10)]
    results: list[dict[str, Any]] = []

    subtractor = cv2.createBackgroundSubtractorMOG2()
    index = 0

    def mog2() -> None:
        nonlocal index
        subtractor.apply(frames[index % len(frames)])
        index += 1

    results.append({"name": "MOG2", "cost_ms": _time_profile(mog2, deadline)})

    previous = cv2.cvtColor(frames[0], cv2.COLOR_BGR2GRAY)
    index = 1

    def regions() -> None:
        nonlocal previous, index
        current = cv2.cvtColor(frames[index % len(frames)], cv2.COLOR_BGR2GRAY)
        delta = cv2.absdiff(previous, current)
        _, mask = cv2.threshold(delta, 20, 255, cv2.THRESH_BINARY)
        mask = cv2.dilate(mask, None, iterations=2)
        cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        previous, index = current, index + 1

    if time.monotonic() < deadline:
        results.append({"name": "Motion regions", "cost_ms": _time_profile(regions, deadline)})

    tracker_factory = getattr(cv2, "TrackerMIL_create", None)
    if tracker_factory is None and hasattr(cv2, "legacy"):
        tracker_factory = getattr(cv2.legacy, "TrackerMIL_create", None)
    if tracker_factory is not None and time.monotonic() < deadline:
        tracker = tracker_factory()
        tracker.init(frames[0], (8, 80, 48, 64))
        index = 1

        def mil() -> None:
            nonlocal index
            tracker.update(frames[index % len(frames)])
            index += 1

        results.append({"name": "MIL tracking", "cost_ms": _time_profile(mil, deadline)})
    return results


def _active_work(statuses: object) -> tuple[int, float | None]:
    if not isinstance(statuses, list):
        return 0, None
    active = 0
    load = 0.0
    measured = False
    for status in statuses:
        if not isinstance(status, dict):
            continue
        metadata = status.get("metadata") or {}
        if not isinstance(metadata, dict):
            metadata = {}
        analysis = metadata.get("analysis") or {}
        if not isinstance(analysis, dict):
            analysis = {}
        cv = metadata.get("cv") or {}
        if not isinstance(cv, dict):
            cv = {}
        enabled = status.get("analysis_enabled", analysis.get("enabled", False))
        active += int(bool(enabled))
        cost = analysis.get("processing_ms", cv.get("inference_ms"))
        fps = analysis.get("inference_fps", status.get("inference_fps"))
        if (
            isinstance(cost, (int, float))
            and not isinstance(cost, bool)
            and math.isfinite(cost)
            and cost >= 0
            and isinstance(fps, (int, float))
            and not isinstance(fps, bool)
            and math.isfinite(fps)
            and fps >= 0
        ):
            load += cost * fps / 1000
            measured = True
    return active, round(load, 3) if measured else None


class CapacityAssessment:
    """Run one bounded background benchmark and report conservative estimates."""

    def __init__(
        self,
        manager: Any,
        *,
        hardware_provider: Callable[[], dict[str, int | None]] = _hardware,
        benchmark: Callable[[], list[dict[str, Any]]] = _benchmark,
    ) -> None:
        self._manager = manager
        self._hardware_provider = hardware_provider
        self._benchmark = benchmark
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._state = "idle"
        self._report: dict[str, Any] | None = None
        self._error: str | None = None
        self._closed = False

    def start(self) -> dict[str, Any]:
        with self._lock:
            if self._closed:
                return self._snapshot_locked()
            if self._thread is not None and self._thread.is_alive():
                return self._snapshot_locked()
            self._state, self._report, self._error = "running", None, None
            self._thread = threading.Thread(
                target=self._run, name="cv-capacity-assessment", daemon=True
            )
            self._thread.start()
            return self._snapshot_locked()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return self._snapshot_locked()

    def _snapshot_locked(self) -> dict[str, Any]:
        return {"state": self._state, "report": self._report, "error": self._error}

    def _run(self) -> None:
        try:
            hardware = self._hardware_provider()
            profiles = self._benchmark()
            memory = hardware.get("memory_bytes")
            for profile in profiles:
                cost_ms = float(profile["cost_ms"])
                if not math.isfinite(cost_ms) or cost_ms <= 0:
                    raise ValueError("Benchmark returned invalid cost")
                cpu_limit = math.floor(CPU_BUDGET * 1000 / (cost_ms * INFERENCE_FPS))
                memory_limit = (
                    MAX_INSTANCES
                    if not isinstance(memory, int) or memory <= 0
                    else max(0, (memory // 2) // _MEMORY_PER_INSTANCE[profile["name"]])
                )
                profile["cost_ms"] = round(cost_ms, 2)
                profile["suggested_instances"] = min(MAX_INSTANCES, cpu_limit, memory_limit)
                profile["inference_fps"] = INFERENCE_FPS
                profile["input_width"] = INPUT_WIDTH
            statuses = self._manager.statuses()
            active, observed_load = _active_work(statuses)
            report = {
                "hardware": hardware,
                "profiles": profiles,
                "active_analysis": active,
                "observed_load": observed_load,
                "message": (
                    "Local synthetic CPU benchmark at 480×270 and 5 FPS. Estimates use 60% "
                    "of one CPU lane and half of total RAM. Actual camera load depends on "
                    "settings, scene, OpenCV threading and other work. Logical CPUs are "
                    "informational."
                ),
            }
            with self._lock:
                self._report, self._state = report, "ready"
        except Exception:
            with self._lock:
                self._error, self._state = "Capacity assessment failed", "error"

    def close(self, timeout: float = 1.0) -> None:
        with self._lock:
            self._closed = True
            thread = self._thread
        if thread is not None:
            thread.join(max(0.0, timeout))
