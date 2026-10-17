"""Loopback-only monitoring server. No package-relative filesystem assumptions."""

import json
import math
import platform
import re
import shutil
import socket
import sys
import tempfile
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from importlib.resources import files
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import cv2

from spyder_cctv.analysis_preview import AnalysisPreviews
from spyder_cctv.cameras import CameraManager
from spyder_cctv.capacity import CapacityAssessment
from spyder_cctv.capture import encode_jpeg
from spyder_cctv.config import CameraConfig, SettingsProfile, load_app_config
from spyder_cctv.cv.detectors import DetectorCatalog
from spyder_cctv.cv.diagnostics import engine_info
from spyder_cctv.model_library import MAX_UPLOAD_BYTES, ModelLibrary
from spyder_cctv.recording import RecordingService
from spyder_cctv.workflow import WorkflowService
from spyder_cctv.workflow_code import run_code


def create_server(manager: CameraManager, port: int = 8765) -> ThreadingHTTPServer:
    started_at = time.monotonic()
    settings = manager.storage_settings
    recorder = RecordingService(
        manager, manager.media_dir, archive_dirs=settings.archives(manager.media_dir)
    )
    capacity = CapacityAssessment(manager)
    previews = AnalysisPreviews(manager)
    app_data_dir = getattr(manager, "app_data_dir", None)
    models = ModelLibrary(
        Path(app_data_dir) / "media" if app_data_dir is not None else manager.media_dir
    )
    detectors = DetectorCatalog()
    workflows = WorkflowService(
        manager,
        recorder,
        manager.app_data_dir,
        model_library=models,
        detector_catalog=detectors,
    )

    def system_snapshot() -> dict:
        statuses = manager.statuses()
        disk = shutil.disk_usage(manager.media_dir)
        return {
            **settings.snapshot(manager.media_dir, overridden=manager.media_dir_overridden),
            "free_bytes": disk.free,
            "version": version("spyder-cctv"),
            "python_version": sys.version.split()[0],
            "platform": platform.system(),
            "uptime_seconds": round(time.monotonic() - started_at, 1),
            "camera_count": len(statuses),
            "running_cameras": sum(item.get("state") == "running" for item in statuses),
            "recording_state": recorder.status()["state"],
            "engines": engine_info()["engines"],
            "event_count": len(workflows.event_store.list()["events"]),
            "event_retention_limit": 10000,
        }

    def camera_configurations() -> list[tuple[CameraConfig, Path | None]]:
        with manager._registry:
            configurations = [(worker.config, None) for worker in manager.workers.values()]
        config_path = getattr(manager, "_config_path", None)
        if config_path is not None and Path(config_path).exists():
            try:
                configurations.extend(
                    (camera, Path(config_path).parent)
                    for camera in load_app_config(Path(config_path)).cameras
                )
            except (OSError, ValueError) as error:
                raise RuntimeError(
                    "Camera configuration is unreadable; model use cannot be checked"
                ) from error
        return configurations

    def camera_model_references(model_path: Path, configurations=None) -> list[str]:
        """Resolve persisted relative paths against their config, not process cwd."""
        expected = model_path.expanduser().resolve()
        references = []
        if configurations is None:
            configurations = camera_configurations()
        for camera, base in configurations:
            vision = camera.vision
            if vision is None:
                continue
            for value in (vision.model, vision.recognition_model, vision.classifier_model):
                if not value:
                    continue
                candidate = Path(value).expanduser()
                if base is not None and not candidate.is_absolute():
                    candidate = base / candidate
                if candidate.resolve() == expected:
                    references.append(f"Camera {camera.name or camera.id} / {camera.id}")
                    break
        return list(dict.fromkeys(references))

    class LocalServer(ThreadingHTTPServer):
        # Windows SO_REUSEADDR can let two live servers share the same port.
        allow_reuse_address = sys.platform != "win32"

        def server_bind(self) -> None:
            if sys.platform == "win32":
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()

        def server_close(self) -> None:
            try:
                workflows.close()
            finally:
                try:
                    recorder.close()
                finally:
                    try:
                        previews.close()
                    finally:
                        try:
                            capacity.close()
                        finally:
                            super().server_close()

    class Handler(BaseHTTPRequestHandler):
        # Reuse preview/status connections instead of exhausting local ephemeral ports.
        protocol_version = "HTTP/1.1"

        def setup(self) -> None:
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, format: str, *args: object) -> None:
            # URLs and camera sources should not become access logs.
            pass

        def send(self, code: int, body: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            if self.close_connection:
                self.send_header("Connection", "close")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'",
            )
            self.end_headers()
            self.wfile.write(body)

        def json(self, code: int, value: object) -> None:
            self.send(code, json.dumps(value).encode(), "application/json")

        def body(self, maximum: int = 16384) -> dict:
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise ValueError("Send application/json")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= maximum:
                raise ValueError("Request body exceeds the size limit")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("Request must contain an object")
            return data

        def allowed(self) -> bool:
            # Reject hostile Host headers (DNS rebinding) and cross-origin control.
            expected = f"127.0.0.1:{self.server.server_port}"
            if self.headers.get("Host") != expected:
                self.json(403, {"error": "Use the displayed loopback URL"})
                return False
            origin = self.headers.get("Origin")
            if origin is not None and origin != f"http://{expected}":
                self.json(403, {"error": "Cross-origin requests are forbidden"})
                return False
            return True

        def do_GET(self) -> None:
            if not self.allowed():
                return
            path = urlsplit(self.path).path
            if path == "/":
                self.send(
                    200,
                    files("spyder_cctv").joinpath("assets/dashboard.html").read_bytes(),
                    "text/html; charset=utf-8",
                )
            elif path == "/dashboard.js":
                self.send(
                    200,
                    files("spyder_cctv").joinpath("assets/dashboard.js").read_bytes(),
                    "text/javascript; charset=utf-8",
                )
            elif path == "/dashboard.css":
                self.send(
                    200,
                    files("spyder_cctv").joinpath("assets/dashboard.css").read_bytes(),
                    "text/css; charset=utf-8",
                )
            elif path in ("/settings.js", "/settings.css"):
                asset = path.removeprefix("/")
                self.send(
                    200,
                    files("spyder_cctv").joinpath("assets", asset).read_bytes(),
                    "text/javascript; charset=utf-8"
                    if asset.endswith(".js")
                    else "text/css; charset=utf-8",
                )
            elif path in (
                "/icons.svg",
                "/spyder-emblem.png",
                "/activity.js",
                "/wall-order.js",
                "/layouts.js",
                "/layouts.css",
                "/workspaces.js",
                "/workspaces.css",
                "/fullscreen.js",
                "/fullscreen.css",
                "/vision-lab.js",
                "/vision-lab.css",
                "/workflow-editor.js",
                "/workflow-preview.js",
                "/workflow-notifications.js",
                "/workflow-editor.css",
                "/event-library.js",
                "/event-library.css",
            ):
                asset = path.removeprefix("/")
                content_type = {
                    ".svg": "image/svg+xml",
                    ".png": "image/png",
                    ".js": "text/javascript; charset=utf-8",
                    ".css": "text/css; charset=utf-8",
                }[asset[asset.rfind(".") :]]
                self.send(
                    200,
                    files("spyder_cctv").joinpath("assets", asset).read_bytes(),
                    content_type,
                )
            elif path == "/api/cameras":
                self.json(200, manager.statuses())
            elif path == "/api/preferences":
                self.json(200, manager.preferences())
            elif path == "/api/profiles":
                self.json(200, manager.profiles())
            elif path == "/api/recordings":
                self.json(200, recorder.status())
            elif path == "/api/events":
                self.json(200, workflows.event_store.list())
            elif path == "/api/events/download":
                try:
                    query = parse_qs(urlsplit(self.path).query)
                    ids = query.get("ids", [""])[0].split(",")
                    selected = workflows.event_store.selected(ids)
                    with tempfile.TemporaryFile() as archive:
                        with zipfile.ZipFile(
                            archive, "w", compression=zipfile.ZIP_DEFLATED
                        ) as bundle:
                            for event in selected:
                                bundle.writestr(
                                    f"events/{event['id']}/event.json",
                                    json.dumps(event, ensure_ascii=False, indent=2),
                                )
                                for media_item in event.get("media", []):
                                    try:
                                        media_path = workflows.event_store.media_path(
                                            media_item["id"]
                                        )
                                    except (KeyError, ValueError, OSError):
                                        continue
                                    bundle.write(
                                        media_path,
                                        f"events/{event['id']}/{media_path.name}",
                                    )
                        size = archive.tell()
                        archive.seek(0)
                        self.send_response(200)
                        self.send_header("Content-Type", "application/zip")
                        self.send_header("Content-Length", str(size))
                        self.send_header("Content-Disposition", 'attachment; filename="events.zip"')
                        self.send_header("Cache-Control", "no-store")
                        self.end_headers()
                        shutil.copyfileobj(archive, self.wfile, length=256 * 1024)
                except KeyError:
                    self.json(404, {"error": "Unknown event"})
                except ValueError as error:
                    self.json(400, {"error": str(error)})
            elif path == "/api/analysis/capacity":
                self.json(200, capacity.snapshot())
            elif path == "/api/workflows/notifications":
                self.json(200, workflows.notifications())
            elif path == "/api/workflows":
                self.json(200, workflows.list())
            elif path == "/api/vision/detectors":
                self.json(200, {"detectors": detectors.list(), "default": "scrfd-500mf"})
            elif path == "/api/models":
                descriptors = models.list()
                usage_errors = []
                workflow_usage = {}
                camera_configs = []
                try:
                    workflow_usage = workflows.model_usage()
                except RuntimeError as error:
                    usage_errors.append(str(error))
                try:
                    camera_configs = camera_configurations()
                except RuntimeError as error:
                    usage_errors.append(str(error))
                for descriptor in descriptors:
                    model_path = Path(descriptor["path"]).expanduser().resolve()
                    references = [
                        *usage_errors,
                        *workflow_usage.get(descriptor["id"], []),
                        *camera_model_references(model_path, camera_configs),
                    ]
                    descriptor["usage"] = {
                        "in_use": bool(references),
                        "references": list(dict.fromkeys(references)),
                    }
                    if descriptor["classes"]:
                        continue
                    for camera in manager.statuses():
                        try:
                            worker = manager.get_worker(camera["id"])
                        except KeyError:
                            continue
                        config = worker.config.vision
                        if (
                            config is None
                            or config.engine != descriptor["engine"]
                            or not config.model
                            or Path(config.model).expanduser().resolve()
                            != Path(descriptor["path"]).resolve()
                        ):
                            continue
                        runtime = worker.vision_snapshot().get("runtime", {})
                        classes = runtime.get("classes")
                        if (
                            isinstance(classes, list)
                            and classes
                            and all(isinstance(label, str) and label.strip() for label in classes)
                        ):
                            descriptor["classes"] = list(classes)
                            descriptor["metadata"] = {
                                **descriptor["metadata"],
                                "inspection": "loaded from active camera",
                                "classes": "available",
                            }
                        break
                self.json(
                    200,
                    {
                        "models": descriptors,
                        "storage_error": models.storage_error,
                        "storage_directory": str(models.root),
                    },
                )
            elif path == "/api/system":
                self.json(200, system_snapshot())
            elif re.fullmatch(r"/api/media/[0-9a-f]{32}/(info|frame)", path):
                media_id, action = path.split("/")[-2:]
                capture = None
                try:
                    item = next(
                        item
                        for item in recorder.status().get("items", [])
                        if item.get("id") == media_id and item.get("kind") == "recording"
                    )
                    media = recorder.media_path(media_id)
                    capture = cv2.VideoCapture(str(media))
                    if not capture.isOpened():
                        capture.release()
                        self.json(415, {"error": "Recording cannot be decoded"})
                        return
                    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
                    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
                    duration = float(item.get("duration_seconds") or 0)
                    if action == "info":
                        capture.release()
                        self.json(
                            200,
                            {
                                "duration_seconds": duration,
                                "fps": fps if fps > 0 else 0,
                                "frame_count": max(0, frame_count),
                            },
                        )
                        return
                    query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                    raw_time = query.get("time", ["0"])
                    try:
                        position = float(raw_time[0])
                    except (TypeError, ValueError):
                        capture.release()
                        self.json(400, {"error": "Invalid video time"})
                        return
                    if (
                        len(raw_time) != 1
                        or not math.isfinite(position)
                        or position < 0
                        or position > duration
                        or duration <= 0
                    ):
                        capture.release()
                        self.json(400, {"error": "Video time is outside recording duration"})
                        return
                    capture.set(cv2.CAP_PROP_POS_MSEC, position * 1000)
                    ok, frame = capture.read()
                    capture.release()
                    if not ok or frame is None:
                        self.json(416, {"error": "No frame at requested time"})
                        return
                    height, width = frame.shape[:2]
                    if width > 960:
                        frame = cv2.resize(
                            frame,
                            (960, max(1, round(height * 960 / width))),
                            interpolation=cv2.INTER_AREA,
                        )
                    self.send(200, encode_jpeg(frame), "image/jpeg")
                except StopIteration:
                    if capture is not None:
                        capture.release()
                    self.json(404, {"error": "Unknown recording"})
                except (KeyError, FileNotFoundError, ValueError):
                    if capture is not None:
                        capture.release()
                    self.json(404, {"error": "Unknown recording"})
                except cv2.error:
                    if capture is not None:
                        capture.release()
                    self.json(415, {"error": "Recording frame decode failed"})
            elif path.startswith("/api/media/") or path.startswith("/api/events/media/"):
                try:
                    media_id = path.rsplit("/", 1)[-1]
                    media = (
                        workflows.event_store.media_path(media_id)
                        if path.startswith("/api/events/media/")
                        else recorder.media_path(media_id)
                    )
                    size = media.stat().st_size
                    start, end, status_code = 0, size - 1, 200
                    range_header = self.headers.get("Range")
                    if range_header:
                        match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
                        if not match or (not match.group(1) and not match.group(2)):
                            self.send_response(416)
                            self.send_header("Content-Range", f"bytes */{size}")
                            self.send_header("Content-Length", "0")
                            self.end_headers()
                            return
                        if match.group(1):
                            try:
                                start = int(match.group(1))
                                end = int(match.group(2)) if match.group(2) else size - 1
                            except ValueError:
                                self.send_response(416)
                                self.send_header("Content-Range", f"bytes */{size}")
                                self.send_header("Content-Length", "0")
                                self.end_headers()
                                return
                        else:
                            try:
                                suffix = int(match.group(2))
                            except ValueError:
                                self.send_response(416)
                                self.send_header("Content-Range", f"bytes */{size}")
                                self.send_header("Content-Length", "0")
                                self.end_headers()
                                return
                            start, end = max(0, size - suffix), size - 1
                        if start >= size or end < start:
                            self.send_response(416)
                            self.send_header("Content-Range", f"bytes */{size}")
                            self.send_header("Content-Length", "0")
                            self.end_headers()
                            return
                        end = min(end, size - 1)
                        status_code = 206
                    with media.open("rb") as source:
                        self.send_response(status_code)
                        self.send_header(
                            "Content-Type",
                            {
                                ".jpg": "image/jpeg",
                                ".jpeg": "image/jpeg",
                                ".png": "image/png",
                                ".mp4": "video/mp4",
                                ".webm": "video/webm",
                                ".avi": "video/x-msvideo",
                            }.get(media.suffix.lower(), "application/octet-stream"),
                        )
                        self.send_header("Content-Length", str(end - start + 1))
                        self.send_header("Accept-Ranges", "bytes")
                        if status_code == 206:
                            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                            self.send_header("Accept-Ranges", "bytes")
                        inline = bool(range_header) or "image/" in self.headers.get("Accept", "")
                        disposition = "inline" if inline else "attachment"
                        self.send_header(
                            "Content-Disposition",
                            f'{disposition}; filename="{media.name}"',
                        )
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("X-Content-Type-Options", "nosniff")
                        self.end_headers()
                        source.seek(start)
                        remaining = end - start + 1
                        while remaining:
                            chunk = source.read(min(256 * 1024, remaining))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            remaining -= len(chunk)
                except (KeyError, FileNotFoundError, ValueError):
                    self.json(404, {"error": "Unknown media"})
            else:
                parts = path.strip("/").split("/")
                if len(parts) in (4, 5) and parts[:3] == ["api", "analysis", "preview"]:
                    try:
                        if len(parts) == 4:
                            self.json(200, previews.snapshot(parts[3]))
                        elif parts[4] in ("frame", "mask"):
                            jpeg = previews.image(parts[3], mask=parts[4] == "mask")
                            if jpeg is None:
                                self.json(503, {"error": "No fresh draft preview available"})
                            else:
                                self.send(200, jpeg, "image/jpeg")
                        else:
                            self.json(404, {"error": "Unknown preview route"})
                    except KeyError:
                        self.json(404, {"error": "Preview expired or camera removed"})
                    except ValueError:
                        self.json(400, {"error": "Invalid preview session"})
                    return
                if (
                    len(parts) in (4, 5)
                    and parts[:2] == ["api", "cameras"]
                    and parts[3] == "analysis"
                ):
                    try:
                        worker = manager.get_worker(parts[2])
                    except KeyError:
                        self.json(404, {"error": "Unknown camera"})
                        return
                    if len(parts) == 4:
                        self.json(200, worker.analysis_snapshot())
                    elif parts[4] == "mask":
                        jpeg = worker.analysis_mask()
                        if jpeg is None:
                            self.json(503, {"error": "No fresh foreground mask available"})
                        else:
                            self.send(200, jpeg, "image/jpeg")
                    else:
                        self.json(404, {"error": "Unknown analysis route"})
                    return
                if (
                    len(parts) == 4
                    and parts[:2] == ["api", "cameras"]
                    and parts[3] in ("frame", "preview-frame", "settings", "vision")
                ):
                    try:
                        worker = manager.get_worker(parts[2])
                    except KeyError:
                        self.json(404, {"error": "Unknown camera"})
                        return
                    if parts[3] == "settings":
                        self.json(200, worker.settings_snapshot())
                        return
                    if parts[3] == "vision":
                        self.json(200, worker.vision_snapshot())
                        return
                    if parts[3] == "preview-frame":
                        frame = worker.raw_frame()
                        if frame is None:
                            self.json(503, {"error": "No fresh raw preview frame available"})
                        else:
                            self.send(200, encode_jpeg(frame), "image/jpeg")
                        return
                    if (jpeg := worker.jpeg()) is None:
                        self.json(503, {"error": "No fresh frame available"})
                    else:
                        self.send(200, jpeg, "image/jpeg")
                else:
                    self.json(404, {"error": "Unknown route"})

        def do_POST(self) -> None:
            # Action requests may carry an unused body. Close rather than allowing
            # those bytes to be interpreted as another request on a persistent socket.
            self.close_connection = True
            if not self.allowed():
                return
            # A custom header prevents browser form requests from controlling cameras.
            if self.headers.get("X-Spyder-Control") != "1":
                self.json(403, {"error": "Control header required"})
                return
            parts = urlsplit(self.path).path.strip("/").split("/")
            try:
                if len(parts) == 4 and parts[:2] == ["api", "events"] and parts[3] == "rename":
                    data = self.body()
                    if set(data) != {"name"}:
                        raise ValueError("Send event name")
                    self.json(200, workflows.event_store.rename(parts[2], data["name"]))
                elif parts == ["api", "events", "delete"]:
                    data = self.body()
                    if set(data) != {"ids"}:
                        raise ValueError("Send event ids")
                    self.json(200, {"deleted": workflows.event_store.delete(data["ids"])})
                elif (
                    len(parts) == 5
                    and parts[:3] == ["api", "vision", "detectors"]
                    and parts[4] == "install"
                ):
                    data = self.body()
                    if data:
                        raise ValueError("Detector installation accepts an empty object")
                    self.json(200, detectors.install(parts[3]))
                elif parts == ["api", "models", "upload"]:
                    query = parse_qs(
                        urlsplit(self.path).query, keep_blank_values=True, strict_parsing=True
                    )
                    if (
                        set(query) - {"filename", "engine", "name"}
                        or not query.get("filename")
                        or not query.get("engine")
                    ):
                        raise ValueError("Send filename and engine query parameters")
                    if (
                        self.headers.get("Content-Type", "").split(";")[0]
                        != "application/octet-stream"
                    ):
                        raise ValueError("Send application/octet-stream")
                    try:
                        length = int(self.headers.get("Content-Length", "0"))
                    except ValueError:
                        raise ValueError("Invalid Content-Length") from None
                    if not 0 < length <= MAX_UPLOAD_BYTES:
                        raise ValueError("Upload must be between 1 byte and 256 MiB")
                    result = models.upload(
                        query["filename"][0],
                        query["engine"][0],
                        self.rfile,
                        length,
                        query.get("name", [None])[0],
                    )
                    self.json(201, result)
                elif parts == ["api", "models", "register"]:
                    data = self.body()
                    if (
                        set(data) - {"path", "name", "engine", "classes"}
                        or "path" not in data
                        or "engine" not in data
                    ):
                        raise ValueError("Send path and engine, with optional name and classes")
                    self.json(
                        201,
                        models.register(
                            data["path"], data.get("name"), data["engine"], data.get("classes")
                        ),
                    )
                elif len(parts) == 4 and parts[:2] == ["api", "models"] and parts[3] == "remove":
                    if self.body() != {}:
                        raise ValueError("Send an empty object")
                    # Match workflow activation: workflow, manager mutation, registry.
                    with workflows._lock, manager._mutations, manager._registry:
                        descriptor = models.get(parts[2])
                        model_path = Path(descriptor["path"]).expanduser().resolve()
                        references = workflows.model_references(parts[2])
                        references.extend(camera_model_references(model_path))
                        references = list(dict.fromkeys(references))
                        outcome = None if references else models.remove(parts[2])
                    if references:
                        self.json(409, {"error": "Model is in use", "references": references})
                    else:
                        self.json(200, outcome)
                elif len(parts) == 4 and parts[:2] == ["api", "models"] and parts[3] == "inspect":
                    data = self.body()
                    if set(data) - {"label_source"}:
                        raise ValueError("Send an empty object or label_source")
                    self.json(
                        200,
                        models.reinspect(
                            parts[2],
                            label_source=data.get("label_source"),
                            reset_source="label_source" in data and data["label_source"] is None,
                        ),
                    )
                elif len(parts) == 4 and parts[:2] == ["api", "models"] and parts[3] == "metadata":
                    data = self.body()
                    if not data or set(data) - {"name", "classes"}:
                        raise ValueError("Send name and/or classes")
                    self.json(200, models.update_metadata(parts[2], **data))
                elif parts == ["api", "workflows", "code", "test"]:
                    data = self.body(1048576)
                    if set(data) - {"source", "detections", "context", "language"} or not {
                        "source",
                        "detections",
                        "context",
                    }.issubset(data):
                        self.json(
                            400,
                            {
                                "error": (
                                    "Send source, detections and context, with optional language"
                                )
                            },
                        )
                        return
                    try:
                        detections = run_code(
                            data["source"],
                            data["detections"],
                            data["context"],
                            language=data.get("language", "python"),
                        )
                    except ValueError as error:
                        self.json(400, {"error": str(error)})
                    else:
                        self.json(200, {"detections": detections})
                elif parts == ["api", "workflows", "activation-preview"]:
                    data = self.body(1048576)
                    if set(data) != {"workflow"}:
                        raise ValueError("Send a workflow graph")
                    self.json(200, workflows.activation_preview(data["workflow"]))
                elif parts == ["api", "workflows", "preview"]:
                    data = self.body(1048576)
                    if set(data) - {"workflow", "node_id", "camera_id"} or not {
                        "workflow",
                        "node_id",
                    }.issubset(data):
                        raise ValueError("Send workflow and node_id, with optional camera_id")
                    self.json(
                        200,
                        workflows.preview(data["workflow"], data["node_id"], data.get("camera_id")),
                    )
                elif parts == ["api", "workflows"]:
                    data = self.body(1048576)
                    if "workflow" not in data or set(data) - {"workflow", "disable_motion"}:
                        raise ValueError("Send a workflow graph with optional disable_motion")
                    self.json(
                        200,
                        workflows.save(
                            data["workflow"], disable_motion=data.get("disable_motion", False)
                        ),
                    )
                elif len(parts) == 4 and parts[:2] == ["api", "workflows"] and parts[3] == "remove":
                    if self.body() != {}:
                        raise ValueError("Send an empty object")
                    workflows.remove(parts[2])
                    self.json(200, {"removed": parts[2]})
                elif len(parts) == 4 and parts[:2] == ["api", "cameras"] and parts[3] == "vision":
                    data = self.body()
                    if set(data) != {"settings"}:
                        raise ValueError("Send model settings")
                    self.json(202, manager.set_vision(parts[2], data["settings"]))
                elif len(parts) in (4, 5) and parts[:3] == ["api", "analysis", "preview"]:
                    data = self.body()
                    if len(parts) == 5 and parts[4] == "release" and data == {}:
                        previews.release(parts[3])
                        self.json(200, {"released": True})
                    elif len(parts) == 4 and set(data) == {"camera_id", "settings"}:
                        self.json(
                            202, previews.configure(parts[3], data["camera_id"], data["settings"])
                        )
                    else:
                        raise ValueError("Invalid preview fields")
                elif parts == ["api", "analysis", "assess"]:
                    if self.body() != {}:
                        raise ValueError("Send an empty object")
                    self.json(202, capacity.start())
                elif len(parts) == 4 and parts[:2] == ["api", "cameras"] and parts[3] == "analysis":
                    data = self.body()
                    if set(data) != {"settings"}:
                        raise ValueError("Send a settings object")
                    self.json(202, manager.set_analysis(parts[2], data["settings"]))
                elif parts in (
                    ["api", "recordings", "start"],
                    ["api", "recordings", "cameras"],
                    ["api", "captures"],
                ):
                    data = self.body()
                    if set(data) != {"camera_ids"}:
                        raise ValueError("Send camera_ids")
                    outcome = (
                        recorder.capture(data["camera_ids"])
                        if parts == ["api", "captures"]
                        else workflows.manual_recording(
                            "start" if parts[-1] == "start" else "select", data["camera_ids"]
                        )
                    )
                    self.json(200, outcome)
                elif parts == ["api", "recordings", "stop"]:
                    if self.body() != {}:
                        raise ValueError("Send an empty object")
                    outcome = workflows.manual_recording("stop")
                    self.json(200, outcome)
                elif parts == ["api", "cameras"]:
                    data = self.body()
                    data.setdefault("id", "cam-" + uuid4().hex[:12])
                    try:
                        camera = CameraConfig(**data)
                    except TypeError as error:
                        raise ValueError("Camera contains missing or unknown fields") from error
                    self.json(201, manager.add(camera))
                elif parts == ["api", "presence"]:
                    data = self.body()
                    if set(data) != {"client_id", "active", "release_when_idle"}:
                        raise ValueError("Invalid presence fields")
                    client_id = data["client_id"]
                    if (
                        not isinstance(client_id, str)
                        or not 1 <= len(client_id) <= 128
                        or any(not (char.isalnum() or char in "-_") for char in client_id)
                        or type(data["active"]) is not bool
                        or type(data["release_when_idle"]) is not bool
                    ):
                        raise ValueError("Invalid presence fields")
                    enabled = manager.set_presence(
                        client_id, data["active"], data["release_when_idle"]
                    )
                    self.json(200, {"accepted": True, "idle_policy": enabled})
                elif parts == ["api", "system", "storage"]:
                    data = self.body()
                    if set(data) != {"media_directory"}:
                        raise ValueError("Send media_directory")
                    settings.save(data["media_directory"], manager.media_dir)
                    self.json(
                        200,
                        settings.snapshot(
                            manager.media_dir, overridden=manager.media_dir_overridden
                        ),
                    )
                elif parts == ["api", "preferences"]:
                    data = self.body()
                    if (
                        set(data) != {"pause_when_unfocused"}
                        or type(data["pause_when_unfocused"]) is not bool
                    ):
                        raise ValueError("Send pause_when_unfocused as a boolean")
                    self.json(200, manager.set_pause_when_unfocused(data["pause_when_unfocused"]))
                elif parts == ["api", "profiles"]:
                    data = self.body()
                    data.setdefault("id", "profile-" + uuid4().hex[:12])
                    try:
                        profile = SettingsProfile(**data)
                    except TypeError as error:
                        raise ValueError("Invalid profile fields") from error
                    self.json(201, manager.create_profile(profile))
                elif len(parts) == 4 and parts[:2] == ["api", "profiles"] and parts[3] == "remove":
                    manager.remove_profile(parts[2])
                    self.json(200, {"removed": parts[2]})
                elif len(parts) == 4 and parts[:2] == ["api", "cameras"]:
                    if parts[3] == "remove":
                        manager.remove(parts[2])
                        self.json(200, {"removed": parts[2]})
                    elif parts[3] in ("start", "stop"):
                        self.json(200, manager.control(parts[2], parts[3]))
                    elif parts[3] == "settings":
                        data = self.body()
                        if set(data) != {"settings"}:
                            raise ValueError("Send a settings object")
                        self.json(202, manager.set_settings(parts[2], data["settings"]))
                    elif parts[3] == "profile":
                        data = self.body()
                        if set(data) != {"profile_id"}:
                            raise ValueError("Send a profile id")
                        self.json(202, manager.assign_profile(parts[2], data["profile_id"]))
                    else:
                        self.json(404, {"error": "Unknown action"})
                else:
                    self.json(404, {"error": "Unknown route"})
            except KeyError:
                self.json(404, {"error": "Unknown camera or profile"})
            except (ValueError, UnicodeDecodeError) as error:
                self.json(
                    400,
                    {
                        "error": str(error)
                        if parts[:2]
                        in (
                            ["api", "workflows"],
                            ["api", "models"],
                            ["api", "preferences"],
                            ["api", "events"],
                            ["api", "system"],
                        )
                        or parts[:3] == ["api", "vision", "detectors"]
                        else "Invalid details. Check camera selection, fields or settings (0-100%)."
                    },
                )
            except OSError:
                self.json(
                    500,
                    {"error": "Cannot save local data. Check storage permissions and free space."},
                )
            except RuntimeError as error:
                self.json(409, {"error": str(error)})

    try:
        return LocalServer(("127.0.0.1", port), Handler)
    except Exception:
        workflows.close()
        previews.close()
        capacity.close()
        recorder.close()
        raise
