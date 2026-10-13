"""Concurrent camera lifecycle with bounded latest-frame storage."""

import copy
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

from spyder_cctv.capture import Capture, OpenCVCapture, encode_jpeg
from spyder_cctv.config import CameraConfig, save_config
from spyder_cctv.vision import Pipeline, create_pipeline

logger = logging.getLogger(__name__)


class CameraWorker:
    def __init__(
        self,
        config: CameraConfig,
        capture_factory: Callable[[int | str], Capture] = OpenCVCapture,
        pipeline_factory: Callable[[str], Pipeline] = create_pipeline,
        encoder: Callable[[Any], bytes] = encode_jpeg,
    ) -> None:
        self.config = config
        self._capture_factory = capture_factory
        self._pipeline_factory = pipeline_factory
        self._encoder = encoder
        self._lock = threading.Lock()
        self._lifecycle = threading.Lock()
        self._closed = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._state = "stopped"
        self._error: str | None = None
        self._jpeg: bytes | None = None
        self._updated: float | None = None
        self._metadata: dict[str, Any] = {}
        self._frames = 0

    def start(self) -> None:
        with self._lifecycle, self._lock:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            if self._thread is not None and self._thread.is_alive():
                if self._stop.is_set():
                    raise RuntimeError("Camera is still stopping")
                return
            self._stop.clear()
            self._state, self._error = "starting", None
            self._jpeg, self._updated = None, None
            self._metadata, self._frames = {}, 0
            self._thread = threading.Thread(
                target=self._run,
                name=f"camera-{self.config.id}",
                daemon=True,
            )
            self._thread.start()

    def request_stop(self, *, final: bool = False) -> None:
        with self._lock:
            if final:
                self._closed = True
            self._stop.set()
            if self._thread is not None and self._thread.is_alive():
                self._state = "stopping"
            self._jpeg = None

    def stop(self, timeout: float = 2.0) -> None:
        # Serialize control calls without holding the state lock during join.
        deadline = time.monotonic() + max(0, timeout)
        self.request_stop()
        if not self._lifecycle.acquire(timeout=max(0, deadline - time.monotonic())):
            raise RuntimeError("Camera backend did not stop within timeout")
        try:
            self.request_stop()
            with self._lock:
                thread = self._thread
            if thread is not None:
                thread.join(max(0, deadline - time.monotonic()))
                if thread.is_alive():
                    raise RuntimeError("Camera backend did not stop within timeout")
        finally:
            self._lifecycle.release()

    def status(self) -> dict[str, Any]:
        with self._lock:
            age = None if self._updated is None else round(time.monotonic() - self._updated, 3)
            return {
                "id": self.config.id,
                "name": self.config.name or self.config.id,
                "source_label": (
                    f"Webcam {self.config.source}"
                    if isinstance(self.config.source, int)
                    else "Network stream"
                    if "://" in self.config.source
                    else "Video file"
                ),
                "fps": self.config.fps,
                "pipeline": self.config.pipeline,
                "state": self._state,
                "error": self._error,
                "frames": self._frames,
                "frame_age_seconds": age,
                "metadata": copy.deepcopy(self._metadata),
            }

    def jpeg(self) -> bytes | None:
        with self._lock:
            if self._state != "running" or self._updated is None:
                return None
            if time.monotonic() - self._updated > max(2.0, 2.0 / self.config.fps):
                return None
            return self._jpeg

    def _run(self) -> None:
        capture = None
        try:
            capture = self._capture_factory(self.config.source)
            pipeline = self._pipeline_factory(self.config.pipeline)
            while not self._stop.is_set():
                began = time.monotonic()
                ok, frame = capture.read()
                if not ok:
                    raise RuntimeError("Camera read failed or video ended")
                frame, metadata = pipeline.process(frame)
                jpeg = self._encoder(frame)
                with self._lock:
                    if self._stop.is_set():
                        break
                    self._jpeg, self._metadata = jpeg, copy.deepcopy(metadata)
                    self._updated = time.monotonic()
                    self._frames += 1
                    self._state = "running"
                self._stop.wait(max(0.0, 1.0 / self.config.fps - (time.monotonic() - began)))
        except Exception:
            # Backend exceptions may contain camera credentials. Do not expose their text.
            logger.warning("Capture or processing failed for camera %s", self.config.id)
            with self._lock:
                self._state, self._error = "error", "Capture or processing failed"
        finally:
            if capture is not None:
                try:
                    capture.close()
                except Exception:
                    logger.warning("Capture release failed for camera %s", self.config.id)
            with self._lock:
                self._jpeg = None
                if self._state != "error":
                    self._state = "stopped"


class CameraManager:
    def __init__(
        self,
        cameras: list[CameraConfig],
        config_path: Path | None = None,
        **worker_options: Any,
    ) -> None:
        if len({camera.id for camera in cameras}) != len(cameras):
            raise ValueError("Camera ids must be unique")
        self.workers = {camera.id: CameraWorker(camera, **worker_options) for camera in cameras}
        self._registry = threading.RLock()
        self._mutations = threading.Lock()
        self._closed = False
        self._config_path = config_path
        self._worker_options = worker_options

    def _snapshot(self) -> list[CameraWorker]:
        with self._registry:
            return list(self.workers.values())

    def get_worker(self, camera_id: str) -> CameraWorker:
        with self._registry:
            return self.workers[camera_id]

    def _persist(self, workers: dict[str, CameraWorker]) -> None:
        if self._config_path is not None:
            save_config(self._config_path, [worker.config for worker in workers.values()])

    def add(self, camera: CameraConfig) -> dict[str, Any]:
        with self._mutations:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            if isinstance(camera.source, str) and "://" not in camera.source:
                if self._config_path is None:
                    raise ValueError("Video files require a configured config path")
                camera = replace(
                    camera,
                    source=str((self._config_path.parent / camera.source).resolve()),
                )
            with self._registry:
                if camera.id in self.workers:
                    raise RuntimeError("A camera with that id already exists")
                if any(worker.config.source == camera.source for worker in self.workers.values()):
                    raise RuntimeError("This camera source is already connected")
                worker = CameraWorker(camera, **self._worker_options)
                updated = self.workers | {camera.id: worker}
                self._persist(updated)
                self.workers = updated
            if camera.autostart:
                worker.start()
            return worker.status()

    def remove(self, camera_id: str) -> None:
        with self._mutations:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            worker = self.get_worker(camera_id)
            worker.stop()
            with self._registry:
                updated = {key: value for key, value in self.workers.items() if key != camera_id}
                self._persist(updated)
                worker.request_stop(final=True)
                self.workers = updated

    def control(self, camera_id: str, action: str) -> dict[str, Any]:
        with self._mutations:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            worker = self.get_worker(camera_id)
            if action == "start":
                worker.start()
            elif action == "stop":
                worker.stop()
            else:
                raise ValueError("Unknown camera action")
            return worker.status()

    def start_configured(self) -> None:
        for worker in self._snapshot():
            if worker.config.autostart:
                worker.start()

    def statuses(self) -> list[dict[str, Any]]:
        return [worker.status() for worker in self._snapshot()]

    def close(self, timeout: float = 2.0) -> None:
        # Signal all workers first; total shutdown wait is bounded, not per-camera.
        deadline = time.monotonic() + timeout
        with self._mutations:
            self._closed = True
            workers = self._snapshot()
            for worker in workers:
                worker.request_stop(final=True)
        failed = []
        for worker in workers:
            try:
                worker.stop(max(0, deadline - time.monotonic()))
            except RuntimeError:
                failed.append(worker.config.id)
        if failed:
            raise RuntimeError(f"Camera shutdown timed out: {', '.join(failed)}")
