"""Local face enrollment and network-camera controls behind the loopback API."""

from __future__ import annotations

import base64
import binascii
import threading
import time
from uuid import uuid4

from .capture import OpenCVCapture, encode_jpeg
from .config import CameraConfig


class DeviceServices:
    """Resolve trusted model IDs and keep ONVIF credentials out of camera configuration."""

    def __init__(self, manager, models, workflows, galleries, onvif):
        self.manager = manager
        self.models = models
        self.workflows = workflows
        self.galleries = galleries
        self.onvif = onvif
        self._lock = threading.RLock()
        self._camera_sessions = {}
        self._enrollment_frames = {}
        self._connections = {}

    def _model(self, model_id):
        if not isinstance(model_id, str):
            raise ValueError("Choose a registered local InsightFace model")
        descriptor = (
            self.workflows._model_descriptor(model_id)
            if model_id.startswith("builtin-")
            else self.models.get(model_id)
        )
        if descriptor["engine"] != "insightface":
            raise ValueError("Face enrollment requires local InsightFace ONNX models")
        return descriptor["path"]

    def get(self, parts):
        if parts == ["api", "onvif", "sessions"]:
            with self._lock:
                sessions = []
                for session_id, metadata in list(self._connections.items()):
                    try:
                        self.onvif.status(session_id)
                    except RuntimeError:
                        self._connections.pop(session_id, None)
                        continue
                    sessions.append(
                        {
                            **metadata,
                            "camera_ids": [
                                key
                                for key, value in self._camera_sessions.items()
                                if value == session_id
                            ],
                        }
                    )
                return {"sessions": sessions}
        if parts == ["api", "faces", "classifiers"]:
            descriptors = []
            for gallery in self.galleries.list_galleries()["galleries"]:
                item = self.galleries.descriptor(gallery["id"])
                descriptors.append(
                    {
                        "id": "gallery-" + gallery["id"],
                        "name": gallery["name"],
                        "engine": "insightface",
                        "classes": item["classes"],
                        "metadata": {"model_type": "face_gallery"},
                    }
                )
            return {"models": descriptors}
        if parts == ["api", "faces", "galleries"]:
            return self.galleries.list_galleries()
        if len(parts) in (4, 5) and parts[:3] == ["api", "faces", "galleries"]:
            if len(parts) == 4:
                return {
                    **self.galleries.get_gallery(parts[3]),
                    **self.galleries.list_identities(parts[3]),
                }
            if parts[4] == "export":
                return self.galleries.export_gallery(parts[3])
        raise KeyError("Unknown device resource")

    @staticmethod
    def _fields(data, required=(), optional=()):
        for key, value in data.items():
            if key in {"pan", "tilt", "zoom", "duration_ms", "face_index"}:
                if type(value) not in (int, float):
                    raise ValueError("Movement and face selection values must be numbers")
            elif not isinstance(value, str):
                raise ValueError("Device and gallery fields must contain text")
        if not set(required) <= set(data) or set(data) - set(required) - set(optional):
            raise ValueError("Invalid fields for this action")

    def post(self, parts, data):
        if parts[:2] == ["api", "onvif"]:
            return self._network(parts[2:], data)
        if parts == ["api", "faces", "galleries"]:
            self._fields(data, ("name", "detector_model_id", "recognition_model_id"))
            # Model deletion takes this same lock before inspecting references.
            with self.workflows._lock:
                return self.galleries.create_gallery(
                    data["name"],
                    self._model(data["detector_model_id"]),
                    self._model(data["recognition_model_id"]),
                    detector_model_id=data["detector_model_id"],
                    recognition_model_id=data["recognition_model_id"],
                )
        if len(parts) < 5 or parts[:3] != ["api", "faces", "galleries"]:
            raise KeyError("Unknown device action")
        gallery_id, tail = parts[3], parts[4:]
        if tail == ["rename"]:
            self._fields(data, ("name",))
            return self.galleries.rename_gallery(gallery_id, data["name"])
        if tail == ["remove"]:
            self._fields(data)
            with self.workflows._lock, self.manager._mutations:
                references = self.workflows.model_references("gallery-" + gallery_id)
                gallery_path = str(self.galleries.gallery_path(gallery_id))
                for worker in self.manager._snapshot():
                    if getattr(worker.config.vision, "identity_gallery", None) == gallery_path:
                        references.append("Camera " + worker.config.id)
                if references:
                    raise RuntimeError("Gallery is in use: " + ", ".join(references[:10]))
                return self.galleries.delete_gallery(gallery_id)
        if tail == ["enroll"]:
            self._fields(
                data,
                ("identity_name",),
                ("camera_id", "image_base64", "face_index", "enrollment_token"),
            )
            if sum(key in data for key in ("camera_id", "image_base64", "enrollment_token")) != 1:
                raise ValueError("Choose one live camera or one image")
            if "enrollment_token" in data:
                token = data["enrollment_token"]
                if not isinstance(token, str):
                    raise ValueError("Invalid enrollment selection")
                with self._lock:
                    cached = self._enrollment_frames.pop(token, None)
                if not cached or cached[0] < time.monotonic() or cached[1] != gallery_id:
                    raise ValueError("Face selection expired; capture the image again")
                image = cached[2]
            elif "camera_id" in data:
                worker = self.manager.get_worker(data["camera_id"])
                if worker.status()["state"] != "running":
                    raise ValueError("Start the selected camera before enrolling")
                frame = worker.raw_frame()
                if frame is None:
                    raise ValueError("Wait for a fresh camera frame")
                image = encode_jpeg(frame)
            else:
                value = data["image_base64"]
                if not isinstance(value, str) or len(value) > 12 * 1024 * 1024:
                    raise ValueError("Choose an image smaller than 8 MiB")
                try:
                    image = base64.b64decode(value, validate=True)
                except (ValueError, binascii.Error):
                    raise ValueError("Image must contain valid base64 data") from None
                if len(image) > 8 * 1024 * 1024:
                    raise ValueError("Choose an image smaller than 8 MiB")
            result = self.galleries.enroll(
                gallery_id, data["identity_name"], image, face_index=data.get("face_index")
            )
            if result.get("needs_face_selection"):
                with self._lock:
                    now = time.monotonic()
                    self._enrollment_frames = {
                        key: value
                        for key, value in self._enrollment_frames.items()
                        if value[0] > now
                    }
                    if len(self._enrollment_frames) >= 4:
                        self._enrollment_frames.pop(next(iter(self._enrollment_frames)))
                    token = uuid4().hex
                    self._enrollment_frames[token] = (now + 60, gallery_id, image)
                return {
                    "requires_selection": True,
                    "faces": [
                        {
                            "index": item["index"],
                            "bbox": item.get("bbox", item.get("box")),
                            "confidence": item.get("confidence", item.get("score")),
                        }
                        for item in result["candidates"]
                    ],
                    "preview": result.get("preview"),
                    "enrollment_token": token,
                }
            return result
        if len(tail) == 3 and tail[0] == "identities":
            if tail[2] == "rename":
                self._fields(data, ("name",))
                return self.galleries.rename_identity(gallery_id, tail[1], data["name"])
            if tail[2] == "remove":
                self._fields(data)
                return self.galleries.delete_identity(gallery_id, tail[1])
        if (
            len(tail) == 5
            and tail[0] == "identities"
            and tail[2] == "samples"
            and tail[4] == "remove"
        ):
            self._fields(data)
            return self.galleries.delete_sample(gallery_id, tail[1], tail[3])
        raise KeyError("Unknown face gallery action")

    def _network(self, parts, data):
        if parts == ["discover"]:
            self._fields(data)
            return {"devices": self.onvif.discover()}
        if parts == ["connect"]:
            self._fields(data, ("endpoint",), ("username", "password"))
            result = self.onvif.connect(
                data["endpoint"], data.get("username", ""), data.get("password", "")
            )
            with self._lock:
                self.get(["api", "onvif", "sessions"])
                self._connections[result["session_id"]] = result
            return result
        if parts == ["add"]:
            self._fields(data, ("session_id", "profile_token"), ("name",))
            with self._lock:
                source = self.onvif.get_stream_uri(data["session_id"], data["profile_token"])
                # Validate credentials before writing configuration, but never store them.
                self.onvif.authenticated_stream_uri(data["session_id"], data["profile_token"])
                original = self.manager._worker_options.get("capture_factory", OpenCVCapture)
                session_id, profile_token = data["session_id"], data["profile_token"]

                def authenticated_capture(_source):
                    return original(self.onvif.authenticated_stream_uri(session_id, profile_token))

                existing = next(
                    (
                        worker
                        for worker in self.manager._snapshot()
                        if worker.config.source == source
                    ),
                    None,
                )
                if existing is not None:
                    with self.manager._mutations:
                        if existing.status()["state"] not in ("stopped", "error") or (
                            existing._thread is not None and existing._thread.is_alive()
                        ):
                            raise RuntimeError(
                                "Stop this camera before reconnecting its ONVIF credentials"
                            )
                        camera_id, worker = existing.config.id, existing
                        worker._capture_factory = authenticated_capture
                else:
                    camera_id = "cam-" + uuid4().hex[:12]
                    camera = CameraConfig(
                        id=camera_id,
                        source=source,
                        name=data.get("name", "ONVIF camera"),
                        pipeline="none",
                    )
                    self.manager.add(camera, capture_factory=authenticated_capture)
                    worker = self.manager.get_worker(camera_id)
                self.onvif.pin_session(session_id)
                previous = self._camera_sessions.get(camera_id)
                self._camera_sessions[camera_id] = session_id
                if (
                    previous
                    and previous != session_id
                    and previous not in self._camera_sessions.values()
                ):
                    self.onvif.close(previous)
                    self._connections.pop(previous, None)
                return {
                    "camera": worker.status(),
                    "session_id": session_id,
                    "message": (
                        "Camera added. Start it in Control Room. ONVIF credentials last "
                        "until server exit or disconnect."
                    ),
                }
        if parts == ["move"]:
            self._fields(
                data, ("session_id", "profile_token", "pan", "tilt", "zoom"), ("duration_ms",)
            )
            return self.onvif.move(
                data["session_id"],
                data["profile_token"],
                data["pan"],
                data["tilt"],
                data["zoom"],
                data.get("duration_ms", 250),
            )
        if parts == ["stop"]:
            self._fields(data, ("session_id",))
            return self.onvif.stop(data["session_id"])
        if parts == ["disconnect"]:
            self._fields(data, ("session_id",))
            with self._lock:
                if data["session_id"] in self._camera_sessions.values():
                    raise RuntimeError("Remove cameras using this session before disconnecting")
                self.onvif.close(data["session_id"])
                self._connections.pop(data["session_id"], None)
                return {"disconnected": True}
        if parts == ["presets"]:
            self._fields(data, ("session_id", "profile_token"))
            return {"presets": self.onvif.presets(data["session_id"], data["profile_token"])}
        raise KeyError("Unknown ONVIF action")

    def camera_removed(self, camera_id):
        with self._lock:
            session_id = self._camera_sessions.pop(camera_id, None)
            if session_id and session_id not in self._camera_sessions.values():
                self.onvif.close(session_id)
                self._connections.pop(session_id, None)

    def expire_enrollments(self):
        with self._lock:
            now = time.monotonic()
            self._enrollment_frames = {
                key: value for key, value in self._enrollment_frames.items() if value[0] > now
            }

    def close(self):
        self.onvif.close_all()
        with self._lock:
            self._enrollment_frames.clear()
            self._connections.clear()


class UnavailableFaceGalleries:
    """Keep monitoring available when biometric storage cannot be opened."""

    def list_galleries(self):
        return {"galleries": [], "error": "Face gallery storage is unavailable"}

    def model_references(self, model_id):
        # Fail closed: unreadable galleries might still own either model.
        return [{"gallery_name": "storage unavailable; restore access before deleting models"}]

    def __getattr__(self, name):
        raise RuntimeError("Face gallery storage is unavailable")
