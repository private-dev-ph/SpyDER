"""Conservative local CPU capacity estimate for lightweight CV analysis."""

from __future__ import annotations

import copy
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
_MEMORY_PER_INSTANCE = {"MOG2": 64 << 20, "Motion regions": 96 << 20, "MIL tracking": 256 << 20}


def _memory() -> tuple[int | None, int | None]:
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
            return int(status.ullTotalPhys), int(status.ullAvailPhys)
    if sys.platform.startswith("linux"):
        try:
            page_size = os.sysconf("SC_PAGE_SIZE")
            total = os.sysconf("SC_PHYS_PAGES") * page_size
            available = os.sysconf("SC_AVPHYS_PAGES") * page_size
            return int(total), int(available)
        except (OSError, ValueError, TypeError):
            pass
    return None, None


def _hardware() -> dict[str, int | None]:
    total, available = _memory()
    return {
        "logical_cpus": os.cpu_count(),
        "memory_bytes": total,
        "available_memory_bytes": available,
    }


def _frame(index: int) -> np.ndarray:
    image = np.zeros((INPUT_HEIGHT, INPUT_WIDTH, 3), dtype=np.uint8)
    left = (index * 7) % (INPUT_WIDTH - 64)
    cv2.rectangle(image, (left, 80), (left + 48, 144), (220, 220, 220), -1)
    cv2.rectangle(image, (220 - index * 2, 160), (260 - index * 2, 210), (180, 180, 180), -1)
    return image


def _time_profile(operation: Callable[[], None], deadline: float, frames: int = 8) -> float:
    if time.monotonic() >= deadline:
        raise TimeoutError("Capacity benchmark deadline expired")
    operation()  # Warm up OpenCV and initialize lazy buffers.
    if time.monotonic() >= deadline:
        raise TimeoutError("Capacity benchmark deadline expired")
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

    try:
        results.append({"name": "MOG2", "cost_ms": _time_profile(mog2, deadline)})
    except TimeoutError:
        return results

    index = 1
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))

    def regions() -> None:
        nonlocal index
        frame = frames[index % len(frames)]
        foreground = subtractor.apply(frame)
        _, mask = cv2.threshold(foreground, 200, 255, cv2.THRESH_BINARY)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        cv2.connectedComponentsWithStats(mask, 8)
        cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        index += 1

    def append_whole_stack(name: str, operation: Callable[[], None]) -> bool:
        try:
            measured = _time_profile(operation, deadline)
        except TimeoutError:
            return False
        if results:
            measured = max(measured, results[-1]["cost_ms"] + 0.01)
        results.append({"name": name, "cost_ms": measured})
        return True

    if not append_whole_stack("Motion regions", regions):
        return results

    tracker_factory = getattr(cv2, "TrackerMIL_create", None)
    if tracker_factory is None and hasattr(cv2, "legacy"):
        tracker_factory = getattr(cv2.legacy, "TrackerMIL_create", None)
    if tracker_factory is not None and time.monotonic() < deadline:
        trackers = [tracker_factory(), tracker_factory()]
        trackers[0].init(frames[0], (8, 80, 48, 64))
        trackers[1].init(frames[0], (220, 160, 40, 50))
        index = 1

        def mil() -> None:
            nonlocal index
            frame = frames[index % len(frames)]
            regions()
            for tracker in trackers:
                tracker.update(frame)
            index += 1

        append_whole_stack("MIL tracking", mil)
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
        if status.get("state") not in ("running", "starting"):
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
        analysis_settings = status.get("analysis_settings") or {}
        if not isinstance(analysis_settings, dict):
            analysis_settings = {}
        enabled = status.get(
            "analysis_enabled", analysis_settings.get("enabled", analysis.get("enabled", False))
        )
        active += int(bool(enabled))
        for cost, fps in (
            (
                analysis.get("processing_ms"),
                analysis.get(
                    "effective_fps",
                    analysis_settings.get("inference_fps", analysis.get("inference_fps")),
                ),
            ),
            (
                cv.get("inference_ms"),
                status.get("vision_inference_fps", cv.get("inference_fps")),
            ),
        ):
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
            if not self._closed and (self._thread is None or not self._thread.is_alive()):
                self._state, self._report, self._error = "running", None, None
                self._thread = threading.Thread(
                    target=self._run, name="cv-capacity-assessment", daemon=True
                )
                self._thread.start()
        return self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            result = self._snapshot_locked()
        if result["report"] is not None:
            try:
                active, load = _active_work(self._manager.statuses())
            except Exception:
                active, load = 0, None
            result["report"]["active_analysis"] = active
            result["report"]["observed_load"] = load
        return result

    def _snapshot_locked(self) -> dict[str, Any]:
        return {
            "state": self._state,
            "report": None if self._report is None else copy.deepcopy(self._report),
            "error": self._error,
        }

    def _run(self) -> None:
        try:
            hardware = copy.deepcopy(self._hardware_provider())
            profiles = copy.deepcopy(self._benchmark())
            if not profiles:
                raise ValueError("No CV profiles completed")
            memory = hardware.get("available_memory_bytes")
            if not isinstance(memory, int) or memory <= 0:
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
            report = {
                "hardware": hardware,
                "profiles": profiles,
                "active_analysis": 0,
                "observed_load": None,
            }
            report["message"] = (
                "Synthetic CPU estimates use 480x270 input, 5 FPS, 60% of one CPU lane "
                "and half of available RAM. Values are not CPU percentages or GPU "
                "guarantees. Model inference cost depends on model and is not predicted; "
                "observed_load estimates measured processing-seconds per second and may "
                "exceed 1. Live camera timings update on each status read. Camera settings, "
                "scene, OpenCV threading and other work affect capacity. Logical CPU count "
                "is informational."
            )
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
