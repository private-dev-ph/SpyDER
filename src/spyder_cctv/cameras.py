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
from spyder_cctv.config import CameraConfig, SettingsProfile, save_config
from spyder_cctv.controls import unavailable_controls, validate_settings
from spyder_cctv.vision import Pipeline, create_pipeline

logger = logging.getLogger(__name__)


class CameraWorker:
    def __init__(
        self,
        config: CameraConfig,
        capture_factory: Callable[[int | str], Capture] = OpenCVCapture,
        pipeline_factory: Callable[[str], Pipeline] | None = None,
        encoder: Callable[[Any], bytes] = encode_jpeg,
        desired_settings: dict[str, float] | None = None,
    ) -> None:
        self.config = config
        self._capture_factory = capture_factory
        self._pipeline_factory = pipeline_factory or (
            lambda name: create_pipeline(name, config.vision)
        )
        self._encoder = encoder
        self._lock = threading.Lock()
        self._lifecycle = threading.Lock()
        self._closed = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._retiring_pipeline: Any = None
        self._state = "stopped"
        self._error: str | None = None
        self._jpeg: bytes | None = None
        self._updated: float | None = None
        self._metadata: dict[str, Any] = {}
        self._frames = 0
        self._desired_settings = copy.deepcopy(
            config.settings if desired_settings is None else desired_settings,
        )
        self._settings_revision = 0
        self._applied_revision = -1
        self._capabilities = unavailable_controls("Start the camera to discover its controls")
        self._settings_results: dict[str, Any] = {}

    def update_settings(self, config: CameraConfig, desired: dict[str, float]) -> None:
        # Publish persisted intent; only the capture thread applies hardware changes.
        with self._lock:
            self.config = config
            self._desired_settings = copy.deepcopy(desired)
            self._settings_revision += 1

    def settings_snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "id": self.config.id,
                "name": self.config.name or self.config.id,
                "state": self._state,
                "available": self._state == "running",
                "profile_id": self.config.profile_id,
                "capabilities": copy.deepcopy(self._capabilities),
                "desired": copy.deepcopy(self._desired_settings),
                "results": copy.deepcopy(self._settings_results),
                "settings_state": self._settings_state(),
            }

    def _settings_state(self) -> str:
        if not self._desired_settings:
            return "applied"
        if self._settings_revision != self._applied_revision:
            return "pending" if self._state in ("running", "starting") else "scheduled"
        if any(
            result["status"] in ("unsupported", "rejected", "failed", "adjusted")
            for result in self._settings_results.values()
        ):
            return "partial"
        return "applied"

    def _apply_desired(self, capture: Capture) -> None:
        with self._lock:
            revision = self._settings_revision
            if revision == self._applied_revision:
                return
            desired = copy.deepcopy(self._desired_settings)
        try:
            if desired and hasattr(capture, "apply_controls"):
                outcome = capture.apply_controls(desired)
            else:
                capabilities = (
                    capture.get_controls()
                    if hasattr(capture, "get_controls")
                    else unavailable_controls()
                )
                outcome = {
                    "capabilities": capabilities,
                    "results": {
                        name: {"status": "unsupported", "requested": value}
                        for name, value in desired.items()
                    },
                }
        except Exception:
            outcome = {
                "capabilities": unavailable_controls("Control query failed"),
                "results": {
                    name: {"status": "failed", "requested": value}
                    for name, value in desired.items()
                },
            }
        with self._lock:
            self._capabilities = copy.deepcopy(outcome["capabilities"])
            self._settings_results = copy.deepcopy(outcome["results"])
            self._applied_revision = revision

    def start(self) -> None:
        with self._lifecycle, self._lock:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            if self._retiring_pipeline is not None:
                if self._retiring_pipeline.is_alive:
                    raise RuntimeError("CV engine is still stopping")
                self._retiring_pipeline = None
            if self._thread is not None and self._thread.is_alive():
                if self._stop.is_set():
                    raise RuntimeError("Camera is still stopping")
                return
            self._stop.clear()
            self._state, self._error = "starting", None
            self._jpeg, self._updated = None, None
            self._metadata, self._frames = {}, 0
            self._applied_revision = -1
            self._settings_results = {}
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
            if self._retiring_pipeline is not None and self._retiring_pipeline.is_alive:
                raise RuntimeError("CV engine is still stopping")
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
                "profile_id": self.config.profile_id,
                "settings_state": self._settings_state(),
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
        pipeline = None
        try:
            capture = self._capture_factory(self.config.source)
            pipeline = self._pipeline_factory(self.config.pipeline)
            while not self._stop.is_set():
                began = time.monotonic()
                self._apply_desired(capture)
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
            if pipeline is not None and hasattr(pipeline, "close"):
                try:
                    pipeline.close()
                except Exception:
                    logger.warning("Pipeline release failed for camera %s", self.config.id)
                    if getattr(pipeline, "is_alive", False):
                        with self._lock:
                            self._retiring_pipeline = pipeline
                            self._state, self._error = "error", "CV engine is still stopping"
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
        profiles: list[SettingsProfile] | None = None,
        **worker_options: Any,
    ) -> None:
        cameras = [
            replace(
                camera, vision=camera.vision.resolve(config_path.parent if config_path else None)
            )
            if camera.vision is not None
            else camera
            for camera in cameras
        ]
        if len({camera.id for camera in cameras}) != len(cameras):
            raise ValueError("Camera ids must be unique")
        profiles = profiles or []
        if len({profile.id for profile in profiles}) != len(profiles):
            raise ValueError("Profile ids must be unique")
        if len({profile.name.casefold() for profile in profiles}) != len(profiles):
            raise ValueError("Profile names must be unique")
        self._profiles = {profile.id: profile for profile in profiles}
        for camera in cameras:
            self._desired(camera)  # Validate assignments before constructing any workers.
        self.workers = {
            camera.id: CameraWorker(
                camera,
                desired_settings=self._desired(camera),
                **worker_options,
            )
            for camera in cameras
        }
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

    def _desired(self, camera: CameraConfig) -> dict[str, float]:
        if camera.profile_id is None:
            return copy.deepcopy(camera.settings)
        if camera.profile_id not in self._profiles:
            raise ValueError("Unknown profile")
        return copy.deepcopy(self._profiles[camera.profile_id].settings)

    def _persist(
        self,
        workers: dict[str, CameraWorker],
        profiles: dict[str, SettingsProfile] | None = None,
        overrides: dict[str, CameraConfig] | None = None,
    ) -> None:
        if self._config_path is not None:
            overrides = overrides or {}
            profiles = self._profiles if profiles is None else profiles
            save_config(
                self._config_path,
                [overrides.get(key, worker.config) for key, worker in workers.items()],
                list(profiles.values()),
            )

    def profiles(self) -> list[dict[str, Any]]:
        with self._registry:
            return [
                {
                    "id": profile.id,
                    "name": profile.name,
                    "settings": copy.deepcopy(profile.settings),
                    "assigned_to": [
                        worker.config.id
                        for worker in self.workers.values()
                        if worker.config.profile_id == profile.id
                    ],
                }
                for profile in self._profiles.values()
            ]

    def create_profile(self, profile: SettingsProfile) -> dict[str, Any]:
        with self._mutations, self._registry:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            if profile.id in self._profiles or any(
                existing.name.casefold() == profile.name.casefold()
                for existing in self._profiles.values()
            ):
                raise RuntimeError("A profile with that name or id already exists")
            updated = self._profiles | {profile.id: profile}
            self._persist(self.workers, profiles=updated)
            self._profiles = updated
            return next(item for item in self.profiles() if item["id"] == profile.id)

    def remove_profile(self, profile_id: str) -> None:
        with self._mutations, self._registry:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            if profile_id not in self._profiles:
                raise KeyError(profile_id)
            if any(worker.config.profile_id == profile_id for worker in self.workers.values()):
                raise RuntimeError("Unassign this profile from its cameras before deleting it")
            updated = {key: value for key, value in self._profiles.items() if key != profile_id}
            self._persist(self.workers, profiles=updated)
            self._profiles = updated

    def set_settings(self, camera_id: str, settings: object) -> dict[str, Any]:
        desired = validate_settings(settings)
        with self._mutations, self._registry:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            worker = self.get_worker(camera_id)
            config = replace(worker.config, settings=desired, profile_id=None)
            self._persist(self.workers, overrides={camera_id: config})
            worker.update_settings(config, desired)
            return worker.settings_snapshot()

    def assign_profile(self, camera_id: str, profile_id: str | None) -> dict[str, Any]:
        if profile_id is not None and not isinstance(profile_id, str):
            raise ValueError("Profile id must be text or null")
        with self._mutations, self._registry:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            if profile_id is not None and profile_id not in self._profiles:
                raise KeyError(profile_id)
            worker = self.get_worker(camera_id)
            desired = (
                worker.settings_snapshot()["desired"]
                if profile_id is None
                else copy.deepcopy(self._profiles[profile_id].settings)
            )
            config = replace(
                worker.config, profile_id=profile_id, settings=desired if profile_id is None else {}
            )
            self._persist(self.workers, overrides={camera_id: config})
            worker.update_settings(config, desired)
            return worker.settings_snapshot()

    def add(self, camera: CameraConfig) -> dict[str, Any]:
        with self._mutations:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            if camera.vision is not None:
                camera = replace(
                    camera,
                    vision=camera.vision.resolve(
                        self._config_path.parent if self._config_path else None
                    ),
                )
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
                worker = CameraWorker(
                    camera, desired_settings=self._desired(camera), **self._worker_options
                )
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
        with self._registry:
            result = []
            for worker in self.workers.values():
                status = worker.status()
                profile = self._profiles.get(status["profile_id"])
                status["profile_name"] = profile.name if profile else None
                result.append(status)
            return result

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
