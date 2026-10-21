"""Bounded, opt-in JPEG history for event pre-roll."""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class BufferedFrame:
    timestamp: float
    jpeg: bytes
    capture_session: str


@dataclass(slots=True)
class _CameraBuffer:
    seconds: int
    frames: deque[BufferedFrame]
    session: str | None = None
    last_timestamp: float | None = None
    last_accepted: float | None = None
    size: int = 0


class PreEventBuffer:
    """Keep bounded, rate-limited frame history for explicitly enabled cameras."""

    def __init__(
        self,
        max_bytes: int = 64 * 1024 * 1024,
        per_camera_bytes: int = 8 * 1024 * 1024,
        max_fps: float = 5,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_bytes < 0 or per_camera_bytes < 0 or not math.isfinite(max_fps) or max_fps <= 0:
            raise ValueError("buffer limits must be non-negative and max_fps must be positive")
        self._max_bytes = max_bytes
        self._per_camera_bytes = per_camera_bytes
        self._max_fps = max_fps
        self._clock = clock
        self._lock = threading.RLock()
        self._cameras: dict[str, _CameraBuffer] = {}
        self._order: deque[tuple[str, BufferedFrame]] = deque()
        self._bytes = 0

    def configure(self, requirements: dict[str, int]) -> None:
        if not isinstance(requirements, dict) or len(requirements) > 64:
            raise ValueError("requirements must be a dict with at most 64 cameras")
        for camera_id, seconds in requirements.items():
            if not isinstance(camera_id, str) or not camera_id:
                raise ValueError("camera IDs must be non-empty strings")
            if isinstance(seconds, bool) or not isinstance(seconds, int) or not 0 <= seconds <= 30:
                raise ValueError("pre-event seconds must be integers from 0 to 30")
        with self._lock:
            for camera_id in tuple(self._cameras):
                if camera_id not in requirements or requirements[camera_id] == 0:
                    self._remove_camera(camera_id)
            for camera_id, seconds in requirements.items():
                if seconds == 0:
                    continue
                camera = self._cameras.get(camera_id)
                if camera is None:
                    self._cameras[camera_id] = _CameraBuffer(seconds, deque())
                else:
                    camera.seconds = seconds
                    self._trim_camera(camera_id, self._clock())

    def push(self, camera_id: str, jpeg: bytes, timestamp: float, capture_session: str) -> bool:
        now = self._clock()
        timestamp = float(timestamp)
        if not math.isfinite(timestamp) or timestamp > now:
            raise ValueError("timestamp must be finite and no later than the current clock")
        if not isinstance(jpeg, bytes):
            raise TypeError("jpeg must be bytes")
        if not isinstance(capture_session, str):
            raise TypeError("capture_session must be a string")
        with self._lock:
            camera = self._cameras.get(camera_id)
            if camera is None:
                return False
            if camera.session != capture_session:
                self._remove_frames(camera_id)
                camera.session = capture_session
                camera.last_timestamp = None
                camera.last_accepted = None
            if camera.last_timestamp is not None and timestamp < camera.last_timestamp:
                raise ValueError("timestamps must be monotonic within a capture session")
            camera.last_timestamp = timestamp
            self._prune(now)
            if (
                camera.last_accepted is not None
                and timestamp - camera.last_accepted < 1 / self._max_fps
            ):
                return False
            size = len(jpeg)
            if size > self._per_camera_bytes or size > self._max_bytes:
                return False
            frame = BufferedFrame(timestamp, jpeg, capture_session)
            camera.frames.append(frame)
            camera.size += size
            self._bytes += size
            self._order.append((camera_id, frame))
            camera.last_accepted = timestamp
            self._trim_camera(camera_id, now)
            while self._bytes > self._max_bytes and self._order:
                self._evict_oldest()
            return any(stored is frame for stored in camera.frames)

    def snapshot(
        self, camera_id: str, seconds: int | float, *, before: float | None = None
    ) -> tuple[BufferedFrame, ...]:
        if not math.isfinite(float(seconds)) or seconds < 0:
            raise ValueError("seconds must be a finite non-negative number")
        now = self._clock()
        cutoff = now if before is None else float(before)
        if not math.isfinite(cutoff) or cutoff > now:
            raise ValueError("before must be finite and no later than the current clock")
        start = cutoff - float(seconds)
        with self._lock:
            self._prune(now)
            camera = self._cameras.get(camera_id)
            if camera is None:
                return ()
            return tuple(frame for frame in camera.frames if start <= frame.timestamp <= cutoff)

    def clear(self, camera_id: str) -> None:
        with self._lock:
            camera = self._cameras.get(camera_id)
            if camera is not None:
                self._remove_frames(camera_id)
                camera.session = None
                camera.last_timestamp = None
                camera.last_accepted = None

    def status(self) -> dict[str, object]:
        with self._lock:
            self._prune(self._clock())
            cameras = {
                camera_id: {
                    "seconds_available": self._available(camera, self._clock()),
                    "frames": len(camera.frames),
                    "bytes": camera.size,
                }
                for camera_id, camera in self._cameras.items()
            }
            return {
                "cameras": cameras,
                "total_bytes": self._bytes,
                "max_bytes": self._max_bytes,
                "per_camera_bytes": self._per_camera_bytes,
                "max_fps": self._max_fps,
            }

    def _available(self, camera: _CameraBuffer, now: float) -> float:
        if not camera.frames:
            return 0.0
        return min(float(camera.seconds), max(0.0, now - camera.frames[0].timestamp))

    def _prune(self, now: float) -> None:
        for camera_id in tuple(self._cameras):
            self._trim_camera(camera_id, now)

    def _trim_camera(self, camera_id: str, now: float) -> None:
        camera = self._cameras[camera_id]
        while camera.frames and now - camera.frames[0].timestamp > camera.seconds:
            self._drop_frame(camera_id, camera.frames[0])
        while camera.size > self._per_camera_bytes and camera.frames:
            self._drop_frame(camera_id, camera.frames[0])

    def _drop_frame(self, camera_id: str, frame: BufferedFrame) -> None:
        camera = self._cameras[camera_id]
        if camera.frames and camera.frames[0] is frame:
            camera.frames.popleft()
        else:
            camera.frames.remove(frame)
        camera.size -= len(frame.jpeg)
        self._bytes -= len(frame.jpeg)
        self._order = deque(
            (cid, stored) for cid, stored in self._order
            if cid != camera_id or stored is not frame
        )

    def _remove_frames(self, camera_id: str) -> None:
        camera = self._cameras[camera_id]
        while camera.frames:
            self._drop_frame(camera_id, camera.frames[0])
        self._order = deque((cid, frame) for cid, frame in self._order if cid != camera_id)

    def _remove_camera(self, camera_id: str) -> None:
        self._remove_frames(camera_id)
        del self._cameras[camera_id]

    def _evict_oldest(self) -> None:
        camera_id, frame = self._order.popleft()
        camera = self._cameras.get(camera_id)
        if camera is None:
            return
        if camera.frames and camera.frames[0] is frame:
            self._drop_frame(camera_id, frame)

