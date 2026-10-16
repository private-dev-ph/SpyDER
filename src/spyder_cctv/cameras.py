"""Concurrent camera lifecycle with bounded latest-frame storage."""

import copy
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, replace
from pathlib import Path
from typing import Any
from uuid import uuid4

import cv2
from platformdirs import user_data_path

from spyder_cctv.analysis_runtime import AnalysisRuntime
from spyder_cctv.capture import Capture, OpenCVCapture, encode_jpeg
from spyder_cctv.config import CameraConfig, SettingsProfile, save_config
from spyder_cctv.controls import unavailable_controls, validate_settings
from spyder_cctv.cv.contracts import VisionConfig
from spyder_cctv.motion_config import AnalysisConfig
from spyder_cctv.preferences import Preferences
from spyder_cctv.presence import PresenceLeases
from spyder_cctv.storage import StorageSettings
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
        self._uses_default_pipeline = pipeline_factory is None
        self._pipeline_factory = pipeline_factory or (
            lambda name: create_pipeline(name, self.config.vision)
        )
        self._encoder = encoder
        self._lock = threading.Lock()
        self._lifecycle = threading.Lock()
        self._closed = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._retiring_pipeline: Any = None
        self._retiring_analysis: Any = None
        self._analysis_runtime: Any = None
        self._analysis_revision = 0
        self._analysis_applied = -1
        self._vision_revision = 0
        self._capture_session = ""
        self._state = "stopped"
        self._error: str | None = None
        self._jpeg: bytes | None = None
        self._preview_raw: Any = None
        self._preview_updated = 0.0
        self._preview_requested_until = 0.0
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

    def update_analysis(self, config: CameraConfig) -> None:
        with self._lock:
            self.config = config
            self._analysis_revision += 1
            self._metadata["analysis"] = {"state": "scheduled", "regions": [], "tracks": []}

    def update_vision(self, config: CameraConfig) -> None:
        with self._lock:
            self.config = config
            self._vision_revision += 1
            self._metadata["cv"] = {"state": "scheduled", "detections": []}

    def vision_snapshot(self) -> dict[str, Any]:
        with self._lock:
            runtime = copy.deepcopy(self._metadata.get("cv", {"state": "loading"}))
            if self.config.vision is None:
                runtime = {"state": "disabled"}
            elif self._state not in ("starting", "running"):
                runtime = {"state": "paused", "message": "Start the camera to run its model"}
            return {
                "id": self.config.id,
                "pipeline": self.config.pipeline,
                "settings": asdict(self.config.vision) if self.config.vision else None,
                "runtime": runtime,
                "state": self._state,
            }

    def analysis_snapshot(self) -> dict[str, Any]:
        with self._lock:
            result = copy.deepcopy(self._metadata.get("analysis", {}))
            if not self.config.analysis.enabled:
                result = {"state": "disabled"}
            elif self._state not in ("running", "starting"):
                result = {"state": "paused", "message": "Start this camera to run analysis"}
            elif not result:
                result = {"state": "scheduled"}
            return {
                "id": self.config.id,
                "settings": asdict(self.config.analysis),
                "runtime": result,
                "pipeline": self.config.pipeline,
                "state": self._state,
            }

    def analysis_mask(self) -> bytes | None:
        with self._lock:
            runtime = (
                self._analysis_runtime
                if self._analysis_revision == self._analysis_applied
                else None
            )
        return runtime.mask() if runtime is not None else None

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
            if self._retiring_analysis is not None:
                if self._retiring_analysis.is_alive:
                    raise RuntimeError("Motion analysis is still stopping")
                self._retiring_analysis = None
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
            self._capture_session = uuid4().hex
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
            if self._retiring_analysis is not None and self._retiring_analysis.is_alive:
                raise RuntimeError("Motion analysis is still stopping")
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
                "analysis_enabled": self.config.analysis.enabled,
                "analysis_settings": asdict(self.config.analysis),
                "vision_inference_fps": self.config.vision.inference_fps
                if self.config.vision is not None
                else None,
                "capture_session": self._capture_session,
            }

    def raw_frame(self) -> Any:
        """Lease a bounded raw preview buffer without opening another capture."""
        with self._lock:
            self._preview_requested_until = time.monotonic() + 5
            if self._state != "running" or time.monotonic() - self._preview_updated > 1:
                return None
            return None if self._preview_raw is None else self._preview_raw.copy()

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
        analysis = None
        analysis_error = False
        analysis_revision = -1
        vision_revision = -1
        vision_error = False
        try:
            capture = self._capture_factory(self.config.source)
            while not self._stop.is_set():
                began = time.monotonic()
                self._apply_desired(capture)
                ok, frame = capture.read()
                if not ok:
                    raise RuntimeError("Camera read failed or video ended")
                with self._lock:
                    desired_vision, pipeline_name = self._vision_revision, self.config.pipeline
                    vision_options = self.config.vision
                if self._retiring_pipeline is not None and not self._retiring_pipeline.is_alive:
                    self._retiring_pipeline = None
                if desired_vision != vision_revision and self._retiring_pipeline is None:
                    if pipeline is not None and hasattr(pipeline, "close"):
                        try:
                            if hasattr(pipeline, "is_alive"):
                                pipeline.close(timeout=0.05)
                            else:
                                pipeline.close()
                        except Exception:
                            if getattr(pipeline, "is_alive", False):
                                self._retiring_pipeline = pipeline
                    pipeline = None
                    if self._retiring_pipeline is None:
                        vision_error = False
                        try:
                            pipeline = (
                                create_pipeline(pipeline_name, vision_options)
                                if self._uses_default_pipeline
                                else self._pipeline_factory(pipeline_name)
                            )
                        except Exception:
                            vision_error = True
                        vision_revision = desired_vision
                with self._lock:
                    preview_requested = time.monotonic() < self._preview_requested_until
                raw = None
                if preview_requested:
                    raw = (
                        frame.copy()
                        if frame.shape[1] <= 960
                        else cv2.resize(
                            frame, (960, max(1, round(frame.shape[0] * 960 / frame.shape[1])))
                        )
                    )
                with self._lock:
                    self._preview_raw = raw
                    self._preview_updated = time.monotonic()
                with self._lock:
                    revision, analysis_config = self._analysis_revision, self.config.analysis
                if self._retiring_analysis is not None and not self._retiring_analysis.is_alive:
                    self._retiring_analysis = None
                    analysis_revision = -1
                if revision != analysis_revision and self._retiring_analysis is None:
                    analysis_error = False
                    if analysis is not None:
                        try:
                            analysis.close()
                        except RuntimeError:
                            self._retiring_analysis = analysis
                        analysis = None
                    if self._retiring_analysis is None and analysis_config.enabled:
                        try:
                            analysis = AnalysisRuntime(analysis_config)
                        except Exception:
                            analysis_error = True
                    analysis_revision = revision
                    with self._lock:
                        self._analysis_runtime = analysis
                        self._analysis_applied = revision
                analysis_result = (
                    analysis.process(frame)
                    if analysis is not None
                    else {
                        "state": "error"
                        if analysis_error
                        else ("stopping" if self._retiring_analysis is not None else "disabled"),
                        "message": "Motion analysis could not start" if analysis_error else "",
                    }
                )
                if pipeline is not None:
                    frame, metadata = pipeline.process(frame)
                    if "cv" in metadata:
                        metadata["cv"]["generation"] = vision_revision
                else:
                    metadata = {
                        "cv": {
                            "state": "error" if vision_error else "stopping",
                            "detections": [],
                            "message": "Model pipeline unavailable",
                        }
                    }
                if analysis is not None:
                    frame = analysis.annotate(frame, analysis_result)
                    metadata["motion_fraction"] = analysis_result.get("motion_fraction", 0)
                if analysis_config.enabled or self._retiring_analysis is not None:
                    metadata["analysis"] = analysis_result
                jpeg = self._encoder(frame)
                with self._lock:
                    if self._stop.is_set():
                        break
                    if vision_revision != self._vision_revision:
                        metadata["cv"] = {"state": "scheduled", "detections": []}
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
            if analysis is not None:
                try:
                    analysis.close()
                except RuntimeError:
                    self._retiring_analysis = analysis
            with self._lock:
                self._analysis_runtime = None
                self._preview_raw = None
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
        idle_policy: bool = False,
        media_dir: Path | None = None,
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
        self._preferences = Preferences(
            config_path.with_name("preferences.json") if config_path is not None else None
        )
        self.app_data_dir = (
            config_path.parent
            if config_path
            else (
                Path(media_dir).parent if media_dir else user_data_path("SpyDER", appauthor=False)
            )
        ).resolve()
        self.storage_settings = StorageSettings(
            self.app_data_dir / "storage.json", self.app_data_dir / "media"
        )
        self.media_dir_overridden = media_dir is not None
        self.media_dir = (
            Path(media_dir) if media_dir else self.storage_settings.directory
        ).resolve()
        self._worker_options = worker_options
        self._idle_policy = idle_policy
        self._leases = PresenceLeases()
        self._intent: set[str] = set()
        self._policy_paused: set[str] = set()
        self._recording: set[str] = set()
        self._keepalive = threading.Event()
        self._monitor: threading.Thread | None = None
        if idle_policy:
            self._monitor = threading.Thread(
                target=self._presence_loop, name="camera-presence", daemon=True
            )
            self._monitor.start()

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

    def set_vision(self, camera_id: str, settings: object) -> dict[str, Any]:
        if settings is not None and not isinstance(settings, dict):
            raise ValueError("Send a model settings object or null")
        try:
            options = VisionConfig(**settings) if settings is not None else None
        except TypeError as error:
            raise ValueError("Unknown model configuration fields") from error
        with self._mutations, self._registry:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            worker = self.get_worker(camera_id)
            options = (
                options.resolve(self._config_path.parent if self._config_path else None)
                if options
                else None
            )
            config = replace(
                worker.config, pipeline="vision" if options else "none", vision=options
            )
            if config == worker.config:
                # Saving an unchanged workflow must not restart inference or clear overlays.
                return worker.vision_snapshot()
            self._persist(self.workers, overrides={camera_id: config})
            worker.update_vision(config)
            return worker.vision_snapshot()

    def restore_vision(self, camera_id: str, previous: CameraConfig) -> dict[str, Any]:
        """Restore model configuration after a failed workflow save.

        Keep tuning, recording, and other current camera configuration intact.
        """
        if not isinstance(previous, CameraConfig) or previous.id != camera_id:
            raise ValueError("Previous configuration must belong to this camera")
        with self._mutations, self._registry:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            worker = self.get_worker(camera_id)
            config = replace(worker.config, pipeline=previous.pipeline, vision=previous.vision)
            if config == worker.config:
                return worker.vision_snapshot()
            self._persist(self.workers, overrides={camera_id: config})
            worker.update_vision(config)
            return worker.vision_snapshot()

    def set_analysis(self, camera_id: str, settings: object) -> dict[str, Any]:
        if not isinstance(settings, dict):
            raise ValueError("Send a motion analysis settings object")
        try:
            options = AnalysisConfig(**settings)
        except TypeError as error:
            raise ValueError("Unknown motion analysis options") from error
        with self._mutations, self._registry:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            worker = self.get_worker(camera_id)
            config = replace(worker.config, analysis=options)
            self._persist(self.workers, overrides={camera_id: config})
            worker.update_analysis(config)
            return worker.analysis_snapshot()

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
                self._intent.add(camera.id)
                if self._should_suspend():
                    self._policy_paused.add(camera.id)
                else:
                    worker.start()
            status = worker.status()
            status["idle_suspended"] = camera.id in self._policy_paused
            return status

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
                self._intent.discard(camera_id)
                self._policy_paused.discard(camera_id)
                self._recording.discard(camera_id)

    def control(self, camera_id: str, action: str) -> dict[str, Any]:
        with self._mutations:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            worker = self.get_worker(camera_id)
            if action == "start":
                self._intent.add(camera_id)
                if self._should_suspend() and camera_id not in self._recording:
                    self._policy_paused.add(camera_id)
                else:
                    worker.start()
            elif action == "stop":
                if camera_id in self._recording:
                    raise RuntimeError("Remove this camera from recording before pausing it")
                self._intent.discard(camera_id)
                self._policy_paused.discard(camera_id)
                worker.stop()
            else:
                raise ValueError("Unknown camera action")
            status = worker.status()
            status["idle_suspended"] = camera_id in self._policy_paused
            return status

    def start_configured(self) -> None:
        with self._mutations:
            for worker in self._snapshot():
                if worker.config.autostart:
                    self._intent.add(worker.config.id)
                    if self._should_suspend() and worker.config.id not in self._recording:
                        self._policy_paused.add(worker.config.id)
                    else:
                        worker.start()

    def statuses(self) -> list[dict[str, Any]]:
        with self._registry:
            result = []
            for worker in self.workers.values():
                status = worker.status()
                status["idle_suspended"] = worker.config.id in self._policy_paused
                status["recording"] = worker.config.id in self._recording
                profile = self._profiles.get(status["profile_id"])
                status["profile_name"] = profile.name if profile else None
                result.append(status)
            return result

    def close(self, timeout: float = 2.0) -> None:
        # Signal all workers first; total shutdown wait is bounded, not per-camera.
        deadline = time.monotonic() + timeout
        with self._mutations:
            self._closed = True
            self._keepalive.set()
            workers = self._snapshot()
            for worker in workers:
                worker.request_stop(final=True)
        if self._monitor is not None:
            self._monitor.join(max(0, timeout))
        failed = []
        for worker in workers:
            try:
                worker.stop(max(0, deadline - time.monotonic()))
            except RuntimeError:
                try:
                    worker.stop(max(0, deadline - time.monotonic()))
                except RuntimeError:
                    failed.append(worker.config.id)
        if failed:
            raise RuntimeError(f"Camera shutdown timed out: {', '.join(failed)}")

    def set_presence(self, client_id: str, active: bool, release_when_idle: bool) -> bool:
        if not self._idle_policy:
            return False
        preference = self._preferences.snapshot()
        if preference["configured"] and preference["pause_when_unfocused"]:
            # Configured preference supersedes stale tabs using the legacy lease flag.
            release_when_idle = True
        self._leases.heartbeat(client_id, active, release_when_idle)
        return True

    def preferences(self) -> dict[str, Any]:
        return self._preferences.snapshot()

    def set_pause_when_unfocused(self, value: bool) -> dict[str, Any]:
        with self._mutations:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            snapshot = self._preferences.set_pause_when_unfocused(value)
        self._reconcile_presence()
        return snapshot

    def set_recording(self, camera_id: str, active: bool) -> None:
        """Retain one camera while a local recording uses its frames."""
        if type(active) is not bool:
            raise ValueError("Recording state must be boolean")
        with self._mutations:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            worker = self.get_worker(camera_id)
            if active:
                worker.start()
                self._recording.add(camera_id)
                self._intent.add(camera_id)
                self._policy_paused.discard(camera_id)
            else:
                self._recording.discard(camera_id)
        if not active:
            self._reconcile_presence()

    def _should_suspend(self) -> bool:
        preference = self._preferences.snapshot()
        return (
            self._idle_policy
            and preference["pause_when_unfocused"]
            and not self._leases.keeps_cameras(allow_opt_out=not preference["configured"])
        )

    def _presence_loop(self) -> None:
        while not self._keepalive.wait(0.25):
            try:
                self._reconcile_presence()
            except RuntimeError:
                logger.warning("Camera idle transition failed; will retry")

    def _reconcile_presence(self) -> None:
        if not self._idle_policy:
            return
        with self._mutations:
            if self._closed:
                return
            suspend = self._should_suspend()
            if suspend:
                stopping = []
                for camera_id in tuple(self._intent):
                    if camera_id in self._recording or camera_id not in self.workers:
                        continue
                    worker = self.workers[camera_id]
                    self._policy_paused.add(camera_id)
                    worker.request_stop()
                    stopping.append(worker)
                for worker in stopping:
                    try:
                        worker.stop()
                    except RuntimeError:
                        logger.warning("Camera %s did not stop; will retry", worker.config.id)
            else:
                for camera_id in tuple(self._policy_paused):
                    if camera_id in self._intent and camera_id in self.workers:
                        self.workers[camera_id].start()
                    self._policy_paused.discard(camera_id)
