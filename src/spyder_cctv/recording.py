"""Local, single-writer camera recording and capture catalog."""

from __future__ import annotations

import json
import logging
import math
import os
import shutil
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)

WIDTH = 1920
HEIGHT = 1080
FPS = 15
MIN_FREE_BYTES = 64 * 1024 * 1024
_MANIFEST = "manifest.json"


class RecordingService:
    """Write composite sessions from camera workers' latest JPEG samples."""

    def __init__(self, manager: Any, output_dir: Path) -> None:
        self.manager = manager
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._manifest = self.output_dir / _MANIFEST
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._state = "idle"
        self._error: str | None = None
        self._stop_notice: str | None = None
        self._camera_ids: list[str] = []
        self._started = 0.0
        self._last_elapsed = 0.0
        self._frames = 0
        self._writer: cv2.VideoWriter | None = None
        self._temp_path: Path | None = None
        self._session_id: str | None = None
        self._session_filename: str | None = None
        self._items = self._load_catalog()
        self._closed = False

    def start(self, camera_ids: list[str]) -> dict[str, Any]:
        ids = self._validate_ids(camera_ids)
        with self._lock:
            self._ensure_open()
            if self._state in ("recording", "stopping") or (
                self._thread is not None and self._thread.is_alive()
            ):
                raise RuntimeError("A recording is already active")
            if shutil.disk_usage(self.output_dir).free < MIN_FREE_BYTES:
                raise RuntimeError("Recording needs at least 64 MiB of free local storage")
            retained: list[str] = []
            try:
                for camera_id in ids:
                    self.manager.set_recording(camera_id, True)
                    retained.append(camera_id)
            except Exception:
                for camera_id in reversed(retained):
                    self._release(camera_id)
                raise
            self._camera_ids = ids
            self._error = None
            self._stop_notice = None
            self._frames = 0
            self._started = time.monotonic()
            self._last_elapsed = 0.0
            self._session_id = uuid.uuid4().hex
            self._session_filename = f"{self._session_id}.mp4"
            self._temp_path = self.output_dir / f".{self._session_id}.partial.mp4"
            self._state = "recording"
            self._wake.clear()
            self._thread = threading.Thread(
                target=self._write_loop, name="spyder-recording-writer", daemon=True
            )
            self._thread.start()
            return self.status()

    def select(self, camera_ids: list[str]) -> dict[str, Any]:
        ids = self._validate_ids(camera_ids, allow_empty=True)
        with self._lock:
            self._ensure_open()
            if self._state != "recording":
                raise RuntimeError("No recording is active")
            before = list(self._camera_ids)
            added = [camera_id for camera_id in ids if camera_id not in before]
            retained: list[str] = []
            try:
                for camera_id in added:
                    self.manager.set_recording(camera_id, True)
                    retained.append(camera_id)
            except Exception:
                for camera_id in reversed(retained):
                    self._release(camera_id)
                raise
            self._camera_ids = ids
            if not ids:
                self._state = "stopping"
            for camera_id in before:
                if camera_id not in ids:
                    self._release(camera_id)
            if not ids:
                self._wake.set()
            return self.status()

    def stop(self, timeout: float = 5.0) -> dict[str, Any]:
        with self._lock:
            if self._state == "recording":
                self._state = "stopping"
                self._wake.set()
            thread = self._thread
        if thread is not None:
            thread.join(max(0.0, timeout))
        with self._lock:
            if thread is not None and thread.is_alive():
                # The writer remains responsible for release/finalization.
                return self.status()
            return self.status()

    def capture(self, camera_ids: list[str]) -> dict[str, Any]:
        ids = self._validate_ids(camera_ids)
        with self._lock:
            self._ensure_open()
            samples = self._samples(ids)
            if all(image is None for image in samples):
                raise RuntimeError("No fresh camera frames are available")
            if len(ids) == 1:
                kind = "capture"
                suffix = "jpg"
                data = self._jpeg(samples[0])
            else:
                image = self._compose(samples, ids)
                kind = "capture"
                suffix = "jpg"
                ok, encoded = cv2.imencode(".jpg", image)
                if not ok:
                    raise RuntimeError("Cannot encode capture")
                data = encoded.tobytes()
            item_id = uuid.uuid4().hex
            filename = f"{item_id}.{suffix}"
            path = self.output_dir / filename
            self._write_atomic(path, data)
            item = self._new_item(item_id, kind, filename, size_bytes=len(data))
            self._items[item_id] = item
            self._save_catalog()
            return dict(item)

    def status(self) -> dict[str, Any]:
        with self._lock:
            elapsed = time.monotonic() - self._started if self._started else self._last_elapsed
            return {
                "state": self._state,
                "camera_ids": list(self._camera_ids),
                "elapsed_seconds": round(elapsed, 3),
                "frames": self._frames,
                "width": WIDTH,
                "height": HEIGHT,
                "fps": FPS,
                "error": self._error,
                "items": [dict(item) for item in self._items.values()],
            }

    def media_path(self, item_id: str) -> Path:
        with self._lock:
            item = self._items.get(item_id)
            if item is None:
                raise KeyError(item_id)
            path = (self.output_dir / item["filename"]).resolve()
            if path.parent != self.output_dir.resolve() or not path.is_file():
                raise KeyError(item_id)
            return path

    def close(self, timeout: float = 10.0) -> None:
        with self._lock:
            self._closed = True
        result = self.stop(timeout)
        with self._lock:
            still_alive = self._thread is not None and self._thread.is_alive()
        if result["state"] == "stopping" or still_alive:
            raise RuntimeError("Recording writer did not stop within timeout")

    def _write_loop(self) -> None:
        try:
            while True:
                frame_started = time.monotonic()
                with self._lock:
                    selected = list(self._camera_ids)
                    if not selected:
                        self._state = "stopping"
                current = set(self.manager.workers)
                selected = [camera_id for camera_id in selected if camera_id in current]
                with self._lock:
                    removed = [
                        camera_id for camera_id in self._camera_ids if camera_id not in current
                    ]
                    if removed:
                        self._camera_ids = [
                            camera_id for camera_id in self._camera_ids if camera_id in current
                        ]
                    should_stop = self._state == "stopping" or not self._camera_ids
                    selected = list(self._camera_ids)
                for camera_id in removed:
                    self._release(camera_id)
                if should_stop:
                    break
                if shutil.disk_usage(self.output_dir).free < MIN_FREE_BYTES:
                    with self._lock:
                        self._stop_notice = "Recording saved and stopped: less than 64 MiB free"
                        self._state = "stopping"
                    break
                samples = self._samples(selected)
                composite = self._compose(samples, selected)
                if self._writer is None:
                    self._open_writer()
                self._writer.write(composite)
                with self._lock:
                    self._frames += 1
                remaining = max(0.0, 1.0 / FPS - (time.monotonic() - frame_started))
                self._wake.wait(remaining)
                self._wake.clear()
        except Exception:
            logger.exception("Recording writer failed")
            with self._lock:
                self._error = "Recording writer failed"
                self._state = "error"
        finally:
            self._finalize()

    def _open_writer(self) -> None:
        assert self._temp_path is not None
        writer = cv2.VideoWriter(
            str(self._temp_path), cv2.VideoWriter_fourcc(*"mp4v"), FPS, (WIDTH, HEIGHT)
        )
        final_name = self._session_filename
        if not writer.isOpened():
            writer.release()
            self._temp_path.unlink(missing_ok=True)
            self._temp_path = self.output_dir / f".{self._session_id}.partial.avi"
            final_name = f"{self._session_id}.avi"
            writer = cv2.VideoWriter(
                str(self._temp_path), cv2.VideoWriter_fourcc(*"MJPG"), FPS, (WIDTH, HEIGHT)
            )
        if not writer.isOpened():
            writer.release()
            raise RuntimeError("Cannot open video writer")
        self._writer = writer
        self._session_filename = final_name

    def _finalize(self) -> None:
        with self._lock:
            writer, self._writer = self._writer, None
            temp_path = self._temp_path
            session_id = self._session_id
            filename = self._session_filename
            camera_ids = self._camera_ids
        if writer is not None:
            try:
                writer.release()
            except Exception:
                logger.exception("Video writer release failed")
                with self._lock:
                    self._error = "Video writer release failed"
                    self._state = "error"
        try:
            with self._lock:
                publish = self._error is None and self._frames > 0
            if (
                publish
                and temp_path is not None
                and temp_path.is_file()
                and session_id
                and filename
            ):
                final_path = self.output_dir / filename
                os.replace(temp_path, final_path)
                item = self._new_item(
                    session_id,
                    "recording",
                    filename,
                    duration_seconds=round(self._frames / FPS, 3),
                    size_bytes=final_path.stat().st_size,
                )
                with self._lock:
                    self._items[session_id] = item
                    self._save_catalog()
            elif temp_path is not None:
                temp_path.unlink(missing_ok=True)
        except Exception:
            logger.exception("Recording finalization failed")
            with self._lock:
                self._error = "Recording finalization failed"
                self._state = "error"
        for camera_id in camera_ids:
            self._release(camera_id)
        with self._lock:
            if self._state != "error":
                self._state = "idle"
                self._error = self._stop_notice
            self._camera_ids = []
            if self._started:
                self._last_elapsed = time.monotonic() - self._started
            self._started = 0.0
            self._thread = None

    def _samples(self, ids: list[str]) -> list[np.ndarray | None]:
        images = []
        for camera_id in ids:
            try:
                worker = self.manager.get_worker(camera_id)
                jpeg = worker.jpeg()
                stamp = worker.status().get("frame_age_seconds")
                image = (
                    cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR) if jpeg else None
                )
                if image is None or stamp is None or stamp > 2.0:
                    image = None
            except (KeyError, RuntimeError, ValueError, cv2.error):
                image = None
            images.append(image)
        return images

    @staticmethod
    def _jpeg(image: np.ndarray | None) -> bytes:
        if image is None:
            raise RuntimeError("No fresh camera frame is available")
        ok, encoded = cv2.imencode(".jpg", image)
        if not ok:
            raise RuntimeError("Cannot encode capture")
        return encoded.tobytes()

    @staticmethod
    def _compose(images: list[np.ndarray | None], labels: list[str] | None = None) -> np.ndarray:
        count = max(1, len(images))
        columns = math.ceil(math.sqrt(count))
        rows = math.ceil(count / columns)
        cell_w, cell_h = WIDTH // columns, HEIGHT // rows
        canvas = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
        for index, image in enumerate(images):
            x, y = (index % columns) * cell_w, (index // columns) * cell_h
            w = WIDTH - x if index % columns == columns - 1 else cell_w
            h = HEIGHT - y if index // columns == rows - 1 else cell_h
            if image is None:
                tile = RecordingService._placeholder("Camera unavailable", w, h)
            else:
                ih, iw = image.shape[:2]
                scale = min(w / iw, h / ih)
                resized = cv2.resize(image, (max(1, round(iw * scale)), max(1, round(ih * scale))))
                tile = np.zeros((h, w, 3), dtype=np.uint8)
                left, top = (w - resized.shape[1]) // 2, (h - resized.shape[0]) // 2
                tile[top : top + resized.shape[0], left : left + resized.shape[1]] = resized
            canvas[y : y + h, x : x + w] = tile
            if labels:
                label = labels[index][: max(1, w // 12)]
                cv2.rectangle(canvas, (x, y), (x + w - 1, y + 30), (20, 20, 20), -1)
                cv2.putText(
                    canvas,
                    label,
                    (x + 10, y + 21),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.55,
                    (230, 230, 230),
                    1,
                    cv2.LINE_AA,
                )
        if labels:
            stamp = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")
            cv2.putText(
                canvas,
                stamp,
                (WIDTH - 330, HEIGHT - 12),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (230, 230, 230),
                1,
                cv2.LINE_AA,
            )
        return canvas

    @staticmethod
    def _placeholder(label: str, width: int = 640, height: int = 360) -> np.ndarray:
        image = np.zeros((height, width, 3), dtype=np.uint8)
        cv2.putText(
            image,
            label,
            (24, max(40, height // 2)),
            cv2.FONT_HERSHEY_SIMPLEX,
            max(0.5, min(width, height) / 600),
            (220, 220, 220),
            2,
            cv2.LINE_AA,
        )
        return image

    def _validate_ids(self, camera_ids: list[str], *, allow_empty: bool = False) -> list[str]:
        if (
            not isinstance(camera_ids, list)
            or len(camera_ids) > 64
            or (not camera_ids and not allow_empty)
            or any(not isinstance(x, str) for x in camera_ids)
        ):
            raise ValueError("camera_ids must be a non-empty list of camera ids")
        ids = list(dict.fromkeys(camera_ids))
        workers = self.manager.workers
        missing = [camera_id for camera_id in ids if camera_id not in workers]
        if missing:
            raise KeyError(missing[0])
        return ids

    def _release(self, camera_id: str) -> None:
        try:
            if camera_id in self.manager.workers:
                self.manager.set_recording(camera_id, False)
        except (KeyError, RuntimeError):
            pass

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("Recording service is closed")

    def _new_item(self, item_id: str, kind: str, filename: str, **extra: Any) -> dict[str, Any]:
        return {
            "id": item_id,
            "kind": kind,
            "filename": filename,
            "created_at": datetime.now(UTC).isoformat(),
            "url": f"/api/media/{item_id}",
            **extra,
        }

    def _load_catalog(self) -> dict[str, dict[str, Any]]:
        try:
            data = json.loads(self._manifest.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("items"), list):
                return {}
            items: dict[str, dict[str, Any]] = {}
            for raw in data["items"]:
                item = self._validated_catalog_item(raw)
                if item is not None:
                    items[item["id"]] = item
            return items
        except (OSError, ValueError, TypeError, AttributeError):
            return {}

    def _validated_catalog_item(self, raw: Any) -> dict[str, Any] | None:
        if not isinstance(raw, dict):
            return None
        item_id, kind = raw.get("id"), raw.get("kind")
        try:
            parsed_id = uuid.UUID(hex=item_id) if isinstance(item_id, str) else None
        except ValueError:
            return None
        if parsed_id is None or parsed_id.hex != item_id:
            return None
        if kind == "capture":
            suffix = "jpg"
        elif kind == "recording" and raw.get("filename") in (
            f"{item_id}.mp4",
            f"{item_id}.avi",
        ):
            suffix = Path(raw["filename"]).suffix[1:]
        else:
            return None
        filename = f"{item_id}.{suffix}"
        if raw.get("filename") != filename:
            return None
        created_at = raw.get("created_at")
        if not isinstance(created_at, str):
            return None
        try:
            parsed_date = datetime.fromisoformat(created_at)
        except ValueError:
            return None
        if parsed_date.tzinfo is None:
            return None
        size = raw.get("size_bytes")
        if type(size) is not int or size < 1:
            return None
        if kind == "recording":
            duration = raw.get("duration_seconds")
            try:
                finite_duration = math.isfinite(float(duration))
            except (OverflowError, TypeError, ValueError):
                finite_duration = False
            if (
                isinstance(duration, bool)
                or not isinstance(duration, (int, float))
                or not finite_duration
                or duration < 0
            ):
                return None
        else:
            duration = None
        path = self.output_dir / filename
        try:
            if path.resolve().parent != self.output_dir.resolve() or not path.is_file():
                return None
            actual_size = path.stat().st_size
        except OSError:
            return None
        if actual_size != size:
            return None
        item = {
            "id": item_id,
            "kind": kind,
            "filename": filename,
            "created_at": created_at,
            "size_bytes": actual_size,
            "url": f"/api/media/{item_id}",
        }
        if duration is not None:
            item["duration_seconds"] = duration
        return item

    def _save_catalog(self) -> None:
        data = json.dumps({"items": list(self._items.values())}, indent=2).encode("utf-8")
        self._write_atomic(self._manifest, data)

    @staticmethod
    def _write_atomic(path: Path, data: bytes) -> None:
        temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temp.write_bytes(data)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)
