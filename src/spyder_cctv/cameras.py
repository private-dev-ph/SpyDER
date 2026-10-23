"""Concurrent camera lifecycle with bounded latest-frame storage."""

import copy
import hashlib
import logging
import math
import sys
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
from spyder_cctv.camera_bindings import CameraBindings
from spyder_cctv.capture import CameraIdentityError, Capture, OpenCVCapture, encode_jpeg
from spyder_cctv.config import CameraConfig, SettingsProfile, save_config
from spyder_cctv.controls import unavailable_controls, validate_settings
from spyder_cctv.cv.contracts import VisionConfig
from spyder_cctv.motion_config import AnalysisConfig
from spyder_cctv.pre_event import BufferedFrame, PreEventBuffer
from spyder_cctv.preferences import Preferences
from spyder_cctv.presence import PresenceLeases
from spyder_cctv.recording_detection_metadata import normalize_detection_metadata
from spyder_cctv.storage import StorageSettings
from spyder_cctv.vision import Pipeline, create_pipeline

logger = logging.getLogger(__name__)


class _CaptureDisconnected(Exception):
    """Only capture open/read failures qualify for automatic reconnection."""


class CameraWorker:
    def __init__(
        self,
        config: CameraConfig,
        capture_factory: Callable[[int | str], Capture] = OpenCVCapture,
        pipeline_factory: Callable[[str], Pipeline] | None = None,
        encoder: Callable[[Any], bytes] = encode_jpeg,
        desired_settings: dict[str, float] | None = None,
        device_bindings: CameraBindings | None = None,
        pre_event_buffer: PreEventBuffer | None = None,
    ) -> None:
        self.config = config
        self._capture_factory = capture_factory
        self._device_bindings = device_bindings
        self._device_id: str | None = None
        self._device_index: int | None = None
        self._connection_notice: str | None = None
        self._uses_default_pipeline = pipeline_factory is None
        self._pipeline_factory = pipeline_factory or (
            lambda name: create_pipeline(name, self.config.vision)
        )
        self._encoder = encoder
        self._pre_event_buffer = pre_event_buffer
        self._lock = threading.Lock()
        self._preview_ready = threading.Condition(self._lock)
        self._lifecycle = threading.Lock()
        self._closed = False
        self._capture_release_failed = False
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
        self._recording_jpeg: bytes | None = None
        self._recording_annotations: tuple[dict[str, Any], ...] = ()
        self._preview_raw: Any = None
        self._preview_updated = 0.0
        self._vision_preview_requested_until = 0.0
        self._raw_preview_requested_until = 0.0
        self._pipeline_activity_lock = threading.Lock()
        self._workflow_vision_required: bool | None = None
        self._vision_active: bool | None = None
        self._vision_generation = 0
        self._pipeline: Any = None
        self._pipeline_activity_applied: bool | None = None
        self._updated: float | None = None
        self._metadata: dict[str, Any] = {}
        self._frames = 0
        self._reconnect_attempts = 0
        self._reconnect_at: float | None = None
        self._recoveries = 0
        self._connected_since: float | None = None
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
            self._vision_generation += 1
            self._vision_active = None
            self._metadata["cv"] = {"state": "scheduled", "detections": []}

    @staticmethod
    def _idle_cv() -> dict[str, Any]:
        return {
            "state": "idle",
            "detections": [],
            "result_age_seconds": None,
            "message": "Waiting for an active workflow or preview",
        }

    def _vision_demanded_locked(self, now: float | None = None) -> bool:
        if self._workflow_vision_required is None:
            return True
        now = time.monotonic() if now is None else now
        return self._workflow_vision_required or now < self._vision_preview_requested_until

    def _managed_vision_idle_locked(self) -> bool:
        return (
            self.config.pipeline == "vision"
            and self._workflow_vision_required is not None
            and not self._vision_demanded_locked()
        )

    def _apply_pipeline_active_locked(self, pipeline: Any, active: bool) -> None:
        setter = getattr(pipeline, "set_active", None)
        if setter is None:
            return
        with self._lock:
            if self._pipeline is not pipeline or self._pipeline_activity_applied == active:
                return
        try:
            setter(active)
        except Exception:
            logger.warning("Pipeline activity update failed for camera %s", self.config.id)
        else:
            with self._lock:
                if self._pipeline is pipeline:
                    self._pipeline_activity_applied = active

    def _set_pipeline_active(
        self, pipeline: Any, active: bool, generation: int | None = None
    ) -> None:
        with self._pipeline_activity_lock:
            with self._lock:
                if self._pipeline is not pipeline:
                    return
                if generation is not None:
                    if generation != self._vision_generation:
                        return
                    active = self._vision_demanded_locked()
            self._apply_pipeline_active_locked(pipeline, active)

    def _sync_pipeline_activity(self, pipeline: Any) -> bool:
        with self._pipeline_activity_lock:
            with self._lock:
                active = self._vision_demanded_locked()
            self._apply_pipeline_active_locked(pipeline, active)
            return active

    def set_workflow_vision_required(self, required: bool) -> None:
        if type(required) is not bool:
            raise ValueError("Workflow vision demand must be boolean")
        with self._pipeline_activity_lock:
            with self._lock:
                self._workflow_vision_required = required
                demanded = self._vision_demanded_locked()
                changed = demanded != self._vision_active
                if changed:
                    self._vision_generation += 1
                    self._vision_active = demanded
                    self._metadata["cv"] = (
                        {"state": "scheduled", "detections": []} if demanded else self._idle_cv()
                    )
                pipeline = self._pipeline
            if changed and pipeline is not None and self.config.pipeline == "vision":
                self._apply_pipeline_active_locked(pipeline, demanded)

    def request_vision_preview(self, ttl: float = 5) -> None:
        if (
            not isinstance(ttl, (int, float))
            or isinstance(ttl, bool)
            or not math.isfinite(ttl)
            or ttl <= 0
        ):
            raise ValueError("Preview TTL must be a finite positive number")
        with self._pipeline_activity_lock:
            with self._lock:
                expires = time.monotonic() + float(ttl)
                self._vision_preview_requested_until = max(
                    self._vision_preview_requested_until, expires
                )
                self._raw_preview_requested_until = max(self._raw_preview_requested_until, expires)
                demanded = self._vision_demanded_locked()
                changed = demanded != self._vision_active
                if changed:
                    self._vision_generation += 1
                    self._vision_active = demanded
                    self._metadata["cv"] = {"state": "scheduled", "detections": []}
                pipeline = self._pipeline
            if changed and pipeline is not None and self.config.pipeline == "vision":
                self._apply_pipeline_active_locked(pipeline, demanded)

    def vision_snapshot(self) -> dict[str, Any]:
        with self._lock:
            runtime = copy.deepcopy(self._metadata.get("cv", {"state": "loading"}))
            if self.config.vision is None:
                runtime = {"state": "disabled"}
            elif self._managed_vision_idle_locked():
                runtime = self._idle_cv()
            elif self._state not in ("starting", "running"):
                runtime = {
                    "state": "paused",
                    "message": (
                        "Camera reconnecting; model resumes automatically"
                        if self._state == "reconnecting"
                        else "Start the camera to run its model"
                    ),
                }
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
                result = {
                    "state": "paused",
                    "message": (
                        "Camera reconnecting; analysis resumes automatically"
                        if self._state == "reconnecting"
                        else "Start this camera to run analysis"
                    ),
                }
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
            if self._capture_release_failed:
                raise RuntimeError("Camera backend could not be released; restart the application")
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
            if self._pre_event_buffer is not None:
                self._pre_event_buffer.clear(self.config.id)
            self._state, self._error = "starting", None
            self._jpeg, self._updated = None, None
            self._recording_jpeg = None
            self._recording_annotations = ()
            self._metadata, self._frames = {}, 0
            if self._workflow_vision_required is not None:
                self._vision_active = self._vision_demanded_locked()
                if not self._vision_active:
                    self._metadata["cv"] = self._idle_cv()
            self._reconnect_attempts = self._recoveries = 0
            self._reconnect_at = self._connected_since = None
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
            self._preview_ready.notify_all()
            if self._pre_event_buffer is not None:
                self._pre_event_buffer.clear(self.config.id)
            if self._thread is not None and self._thread.is_alive():
                self._state = "stopping"
            self._jpeg, self._updated = None, None
            self._recording_jpeg = None
            self._recording_annotations = ()
            self._metadata = {}
            self._preview_raw = None
            self._analysis_runtime = None

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
            metadata = copy.deepcopy(self._metadata)
            if self._managed_vision_idle_locked():
                metadata["cv"] = self._idle_cv()
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
                "metadata": metadata,
                "analysis_enabled": self.config.analysis.enabled,
                "analysis_settings": asdict(self.config.analysis),
                "vision_inference_fps": self.config.vision.inference_fps
                if self.config.vision is not None
                else None,
                "capture_session": self._capture_session,
                "device_binding": {
                    "bound": self._device_id is not None,
                    "fingerprint": hashlib.sha256(self._device_id.encode()).hexdigest()[:12]
                    if self._device_id is not None
                    else None,
                    "current_index": self._device_index,
                },
                "reconnection": {
                    "enabled": self._can_reconnect(),
                    "attempt": self._reconnect_attempts,
                    "retry_in_seconds": (
                        round(max(0, self._reconnect_at - time.monotonic()), 1)
                        if self._reconnect_at is not None
                        else None
                    ),
                    "recoveries": self._recoveries,
                },
            }

    def raw_frame(self, *, timeout: float = 0.0) -> Any:
        """Lease raw pixels and optionally wait for the capture owner to publish them.

        A cold preview lease has no retained pixels yet. Waiting releases the state
        lock; it never opens a capture or enables inference. Stop or reconnect
        invalidates the request instead of returning a frame from another session.
        """
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout)
            or not 0 <= timeout <= 5
        ):
            raise ValueError("Raw preview wait must be between 0 and 5 seconds")
        with self._preview_ready:
            now = time.monotonic()
            deadline = now + timeout
            session = self._capture_session
            self._raw_preview_requested_until = max(
                self._raw_preview_requested_until, now + 5, deadline + 0.25
            )
            while self._state == "running" and not self._stop.is_set():
                if session != self._capture_session:
                    return None
                now = time.monotonic()
                if self._preview_raw is not None and now - self._preview_updated <= 1:
                    return self._preview_raw.copy()
                remaining = deadline - now
                if remaining <= 0:
                    return None
                self._preview_ready.wait(remaining)
            return None

    def jpeg(self) -> bytes | None:
        with self._lock:
            if self._state != "running" or self._updated is None:
                return None
            if time.monotonic() - self._updated > max(2.0, 2.0 / self.config.fps):
                return None
            return self._jpeg

    def recording_sample(self) -> BufferedFrame | None:
        """Read encoded pixels and their capture timestamp as one atomic sample."""
        with self._lock:
            if (
                self._state != "running"
                or self._updated is None
                or self._recording_jpeg is None
                or time.monotonic() - self._updated > max(2.0, 2.0 / self.config.fps)
            ):
                return None
            return BufferedFrame(
                self._updated,
                self._recording_jpeg,
                self._capture_session,
                self._recording_annotations,
            )

    def _can_reconnect(self) -> bool:
        source = self.config.source
        return isinstance(source, int) or (
            isinstance(source, str)
            and (
                ("://" in source and not source.lower().startswith("file://"))
                or source.startswith(("/dev/video", "/dev/v4l/by-id/", "/dev/v4l/by-path/"))
            )
        )

    @staticmethod
    def _reconnect_delay(attempt: int) -> float:
        return min(30.0, 2.0 ** min(max(0, attempt - 1), 5))

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                if not self._run_capture():
                    break
                with self._lock:
                    if self._stop.is_set():
                        break
                    if (
                        self._retiring_analysis is not None and self._retiring_analysis.is_alive
                    ) or (self._retiring_pipeline is not None and self._retiring_pipeline.is_alive):
                        self._state, self._error = "error", "CV engine is still stopping"
                        break
                    self._reconnect_attempts += 1
                    delay = self._reconnect_delay(self._reconnect_attempts)
                    self._reconnect_at = time.monotonic() + delay
                if self._stop.wait(delay):
                    break
                with self._lock:
                    self._reconnect_at = None
                    self._applied_revision = -1
                    self._capture_session = uuid4().hex
                    if self._pre_event_buffer is not None:
                        self._pre_event_buffer.clear(self.config.id)
        finally:
            with self._lock:
                self._reconnect_at = None
                if self._state != "error":
                    self._state, self._error = "stopped", None

    def _bind_device(self, device_id: str) -> None:
        with self._lock:
            if self._device_id is not None and self._device_id.casefold() != device_id.casefold():
                raise CameraIdentityError("Camera identity changed; reconnect refused")
            self._device_id = device_id.casefold()
        if self._device_bindings is not None:
            self._device_bindings.bind(self.config.id, self.config.source, device_id)

    def _run_capture(self) -> bool:
        reconnect = False
        capture = None
        pipeline = None
        analysis = None
        analysis_error = False
        analysis_revision = -1
        vision_revision = -1
        vision_error = False
        try:
            try:
                self._connection_notice = None
                if self._capture_factory is OpenCVCapture:
                    source = self.config.source
                    if isinstance(source, int) and self._device_bindings is not None:
                        saved = self._device_bindings.get(self.config.id, source)
                        if self._device_id is None:
                            self._device_id = saved
                    capture = OpenCVCapture(
                        source, device_id=self._device_id, on_device_bound=self._bind_device
                    )
                    with self._lock:
                        self._device_index = capture.device_index
                else:
                    capture = self._capture_factory(self.config.source)
            except CameraIdentityError as error:
                self._connection_notice = str(error)
                raise _CaptureDisconnected from None
            except Exception:
                raise _CaptureDisconnected from None
            while not self._stop.is_set():
                began = time.monotonic()
                self._apply_desired(capture)
                try:
                    ok, frame = capture.read()
                    if not ok or frame is None:
                        raise _CaptureDisconnected
                except CameraIdentityError as error:
                    self._connection_notice = str(error)
                    raise _CaptureDisconnected from None
                except Exception:
                    raise _CaptureDisconnected from None
                with self._pipeline_activity_lock:
                    with self._lock:
                        desired_vision, pipeline_name = self._vision_revision, self.config.pipeline
                        vision_options = self.config.vision
                        vision_managed = self._workflow_vision_required is not None
                        vision_demanded = self._vision_demanded_locked()
                        vision_activity_changed = (
                            self._vision_active is None or self._vision_active != vision_demanded
                        )
                        if vision_activity_changed:
                            self._vision_generation += 1
                            self._vision_active = vision_demanded
                            self._metadata["cv"] = (
                                {"state": "scheduled", "detections": []}
                                if vision_demanded
                                else self._idle_cv()
                            )
                        vision_generation = self._vision_generation
                        current_pipeline = self._pipeline
                    if (
                        vision_activity_changed
                        and current_pipeline is not None
                        and pipeline_name == "vision"
                    ):
                        self._apply_pipeline_active_locked(current_pipeline, vision_demanded)
                if self._retiring_pipeline is not None and not self._retiring_pipeline.is_alive:
                    self._retiring_pipeline = None
                needs_pipeline_update = desired_vision != vision_revision or (
                    vision_managed
                    and pipeline_name == "vision"
                    and vision_demanded
                    and pipeline is None
                )
                if needs_pipeline_update and self._retiring_pipeline is None:
                    if pipeline is not None and hasattr(pipeline, "close"):
                        self._set_pipeline_active(pipeline, False)
                        try:
                            if hasattr(pipeline, "is_alive"):
                                pipeline.close(timeout=0.05)
                            else:
                                pipeline.close()
                        except Exception:
                            if getattr(pipeline, "is_alive", False):
                                self._retiring_pipeline = pipeline
                    pipeline = None
                    with self._lock:
                        self._pipeline = None
                        self._pipeline_activity_applied = None
                    if self._retiring_pipeline is None and (
                        not vision_managed or pipeline_name != "vision" or vision_demanded
                    ):
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
                        with self._pipeline_activity_lock:
                            with self._lock:
                                self._pipeline = pipeline
                                self._pipeline_activity_applied = None
                    elif self._retiring_pipeline is None:
                        vision_revision = desired_vision
                if pipeline is not None and pipeline_name == "vision":
                    vision_demanded = self._sync_pipeline_activity(pipeline)
                with self._lock:
                    preview_requested = time.monotonic() < self._raw_preview_requested_until
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
                    self._preview_ready.notify_all()
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
                vision_process = pipeline_name != "vision" or vision_demanded
                pipeline_may_annotate = (
                    pipeline is not None
                    and vision_process
                    and not (self._uses_default_pipeline and pipeline_name == "none")
                )
                clean_jpeg = (
                    self._encoder(frame) if analysis is not None or pipeline_may_annotate else None
                )
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
                original_frame = frame
                if pipeline is not None and vision_process:
                    frame, metadata = pipeline.process(frame)
                    if "cv" in metadata:
                        metadata["cv"]["generation"] = vision_generation
                elif pipeline_name == "vision" and vision_managed and not vision_demanded:
                    metadata = {"cv": self._idle_cv()}
                elif pipeline is None and pipeline_name == "vision":
                    metadata = {
                        "cv": {
                            "state": "error" if vision_error else "stopping",
                            "detections": [],
                            "message": "Model pipeline unavailable",
                        }
                    }
                else:
                    metadata = {}
                if analysis is not None:
                    frame = analysis.annotate(frame, analysis_result)
                    metadata["motion_fraction"] = analysis_result.get("motion_fraction", 0)
                if analysis_config.enabled or self._retiring_analysis is not None:
                    metadata["analysis"] = analysis_result
                jpeg = self._encoder(frame)
                if clean_jpeg is None:
                    clean_jpeg = jpeg
                with self._lock:
                    if self._stop.is_set():
                        break
                    if vision_generation != self._vision_generation:
                        frame = original_frame
                        metadata["cv"] = (
                            self._idle_cv()
                            if self._managed_vision_idle_locked()
                            else {"state": "scheduled", "detections": []}
                        )
                        jpeg = self._encoder(frame)
                    published_at = time.monotonic()
                    annotations = normalize_detection_metadata(metadata, original_frame)
                    self._jpeg, self._recording_jpeg, self._metadata = (
                        jpeg,
                        clean_jpeg,
                        copy.deepcopy(metadata),
                    )
                    self._updated = published_at
                    self._recording_annotations = annotations
                    self._frames += 1
                    if self._pre_event_buffer is not None:
                        self._pre_event_buffer.push(
                            self.config.id,
                            clean_jpeg,
                            published_at,
                            self._capture_session,
                            annotations=annotations,
                        )
                    if self._state != "running":
                        if self._reconnect_attempts:
                            self._recoveries += 1
                        self._connected_since = time.monotonic()
                    self._state, self._error = "running", None
                self._stop.wait(max(0.0, 1.0 / self.config.fps - (time.monotonic() - began)))
        except _CaptureDisconnected:
            with self._lock:
                if not self._stop.is_set():
                    reconnect = self._can_reconnect()
                    if self._connected_since is not None and (
                        time.monotonic() - self._connected_since >= 30
                    ):
                        self._reconnect_attempts = 0
                    self._connected_since = None
                    self._state = "reconnecting" if reconnect else "error"
                    self._error = (
                        (
                            self._connection_notice
                            or "Camera disconnected; reconnecting automatically"
                        )
                        if reconnect
                        else "Video ended or capture unavailable"
                    )
                    if self._pre_event_buffer is not None:
                        self._pre_event_buffer.clear(self.config.id)
                    self._jpeg, self._updated = None, None
                    self._recording_jpeg = None
                    self._recording_annotations = ()
                    self._preview_raw = None
                    self._analysis_runtime = None
                    self._metadata = {}
                    self._preview_ready.notify_all()
            logger.warning("Capture unavailable for camera %s", self.config.id)
        except Exception:
            # Backend exceptions may contain camera credentials. Do not expose their text.
            logger.warning("Capture or processing failed for camera %s", self.config.id)
            with self._lock:
                self._state, self._error = "error", "Capture or processing failed"
                self._jpeg, self._recording_jpeg, self._updated = None, None, None
                self._recording_annotations = ()
                self._preview_ready.notify_all()
                if self._pre_event_buffer is not None:
                    self._pre_event_buffer.clear(self.config.id)
        finally:
            if analysis is not None:
                try:
                    analysis.close()
                except RuntimeError:
                    self._retiring_analysis = analysis
            with self._lock:
                self._analysis_runtime = None
                self._preview_raw = None
                self._preview_ready.notify_all()
                self._pipeline = None
                self._pipeline_activity_applied = None
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
                        self._capture_release_failed = True
                        self._state, self._error = "error", "Camera backend could not be released"
            with self._lock:
                self._jpeg = None
                self._recording_jpeg = None
                if self._state not in ("error", "reconnecting"):
                    self._state = "stopped"
        with self._lock:
            return reconnect and self._state == "reconnecting"


class CameraManager:
    def __init__(
        self,
        cameras: list[CameraConfig],
        config_path: Path | None = None,
        profiles: list[SettingsProfile] | None = None,
        idle_policy: bool = False,
        media_dir: Path | None = None,
        pre_event_buffer: PreEventBuffer | None = None,
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
        self._workflow_vision_cameras: set[str] | None = None
        self.pre_event_buffer = (
            pre_event_buffer if pre_event_buffer is not None else PreEventBuffer()
        )
        for camera in cameras:
            self._desired(camera)  # Validate assignments before constructing any workers.
        self.app_data_dir = (
            config_path.parent
            if config_path
            else (
                Path(media_dir).parent if media_dir else user_data_path("SpyDER", appauthor=False)
            )
        ).resolve()
        self._device_bindings = None
        if (
            sys.platform == "win32"
            and worker_options.get("capture_factory", OpenCVCapture) is OpenCVCapture
        ):
            self._device_bindings = CameraBindings(
                self.app_data_dir / "camera-devices.json"
                if config_path is not None or media_dir is not None
                else None
            )
            worker_options = {**worker_options, "device_bindings": self._device_bindings}
        worker_options = {**worker_options, "pre_event_buffer": self.pre_event_buffer}
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

    def set_workflow_vision_cameras(self, camera_ids: set[str]) -> None:
        if not isinstance(camera_ids, set) or any(
            not isinstance(camera_id, str) for camera_id in camera_ids
        ):
            raise ValueError("Workflow camera ids must be a set of strings")
        with self._mutations:
            if self._closed:
                raise RuntimeError("Camera manager is closed")
            required_ids = set(camera_ids)
            with self._registry:
                self._workflow_vision_cameras = required_ids
                workers = list(self.workers.items())
            for camera_id, worker in workers:
                worker.set_workflow_vision_required(camera_id in required_ids)

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

    def add(self, camera: CameraConfig, *, capture_factory=None) -> dict[str, Any]:
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
                options = dict(self._worker_options)
                if capture_factory is not None:
                    options["capture_factory"] = capture_factory
                worker = CameraWorker(camera, desired_settings=self._desired(camera), **options)
                updated = self.workers | {camera.id: worker}
                self._persist(updated)
                self.workers = updated
                managed_demand = self._workflow_vision_cameras
            if managed_demand is not None:
                worker.set_workflow_vision_required(camera.id in managed_demand)
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
                self.pre_event_buffer.clear(camera_id)
                self.workers = updated
                self._intent.discard(camera_id)
                self._policy_paused.discard(camera_id)
                self._recording.discard(camera_id)
            if self._device_bindings is not None:
                self._device_bindings.remove(camera_id)

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
