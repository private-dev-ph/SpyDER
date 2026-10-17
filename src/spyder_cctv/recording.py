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

from .recording_allowance import RecordingAllowance
from .recording_profiles import DEFAULT_SETTINGS, PROFILES, describe_settings, validate_settings
from .video_encoder import H264Writer

logger = logging.getLogger(__name__)

WIDTH = 1920
HEIGHT = 1080
FPS = 15
MIN_FREE_BYTES = 64 * 1024 * 1024
_MANIFEST = "manifest.json"


class RecordingService:
    """Write composite sessions from camera workers' latest JPEG samples."""

    def __init__(
        self, manager: Any, output_dir: Path, *, archive_dirs: list[Path] | None = None
    ) -> None:
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
        self._stopped_at = 0.0
        self._last_elapsed = 0.0
        self._frames = 0
        self._disk_checked_at = 0.0
        self._disk_free = None
        self._settings_path = self.output_dir / "recording-settings.json"
        self._settings = dict(DEFAULT_SETTINGS)
        try:
            self._settings = validate_settings(
                json.loads(self._settings_path.read_text(encoding="utf-8"))
            )
        except (OSError, ValueError, TypeError):
            pass
        self._profile = describe_settings(self._settings)
        self._segment_frames = 0
        self._segment_index = 0
        self._segment_id: str | None = None
        self._writer: H264Writer | None = None
        self._temp_path: Path | None = None
        self._session_id: str | None = None
        self._session_filename: str | None = None
        self._items = self._load_catalog()
        self._archive_items: dict[str, dict[str, Any]] = {}
        self._archive_paths: dict[str, Path] = {}
        for directory in list(dict.fromkeys(Path(p).resolve() for p in (archive_dirs or [])))[:33]:
            if directory == self.output_dir.resolve() or not directory.is_dir():
                continue
            for item_id, item in self._load_catalog(directory).items():
                self._archive_items[item_id] = item
                self._archive_paths[item_id] = directory

        self._closed = False
        self.allowance = RecordingAllowance(self)

    def start(self, camera_ids: list[str]) -> dict[str, Any]:
        ids = self._validate_ids(camera_ids)
        with self._lock:
            self._ensure_open()
            if self._state in ("recording", "stopping") or (
                self._thread is not None and self._thread.is_alive()
            ):
                raise RuntimeError("A recording is already active")
            try:
                free = shutil.disk_usage(self.output_dir).free
            except OSError as error:
                self.allowance.notify_full(
                    "Recording storage is unavailable. Check the output drive before recording."
                )
                raise RuntimeError("Recording storage is unavailable") from error
            if free < MIN_FREE_BYTES:
                self.allowance.notify_full(
                    "Local disk space is low. Recording is blocked until at least 64 MiB is free."
                )
                raise RuntimeError("Recording needs at least 64 MiB of free local storage")
            if not self.allowance.permit():
                raise RuntimeError(
                    "Recording storage is full or unavailable. "
                    "Resolve the allowance in System before recording."
                )
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
            self._segment_frames = 0
            self._segment_index = 0
            self._profile = describe_settings(self._settings)
            self._started = time.monotonic()
            self._stopped_at = 0.0
            self._last_elapsed = 0.0
            self._session_id = uuid.uuid4().hex
            self._segment_id = self._session_id
            self._session_filename = f"{self._segment_id}.mp4"
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
                self._stopped_at = time.monotonic()
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
            elapsed = (
                ((self._stopped_at or time.monotonic()) - self._started)
                if self._started
                else self._last_elapsed
            )
            return {
                "state": self._state,
                "session_id": self._session_id,
                "camera_ids": list(self._camera_ids),
                "elapsed_seconds": round(elapsed, 3),
                "frames": self._frames,
                "width": self._profile["width"],
                "height": self._profile["height"],
                "fps": self._profile["fps"],
                "storage": describe_settings(self._settings),
                "allowance": self.allowance.snapshot(),
                "profiles": PROFILES,
                "segments_saved": self._segment_index,
                "encoder": "Local FFmpeg · H.264 / MP4",
                "error": self._error,
                "items": [
                    dict(item)
                    for item in {
                        **{
                            key: {**item, "archived": True}
                            for key, item in self._archive_items.items()
                        },
                        **self._items,
                    }.values()
                ],
            }

    def configure(self, settings: dict[str, Any]) -> dict[str, Any]:
        validated = validate_settings(settings)
        with self._lock:
            self._ensure_open()
            if self._thread is not None or self._state in ("recording", "stopping"):
                raise RuntimeError("Stop recording before changing storage settings")
            self._write_atomic(self._settings_path, json.dumps(validated).encode("utf-8"))
            self._settings = validated
            self._profile = describe_settings(validated)
            return self.status()

    def media_path(self, item_id: str) -> Path:
        with self._lock:
            item = self._items.get(item_id)
            directory = self.output_dir
            if item is None:
                item = self._archive_items.get(item_id)
                directory = self._archive_paths.get(item_id, self.output_dir)
            if item is None:
                raise KeyError(item_id)
            path = (directory / item["filename"]).resolve()
            if path.parent != directory.resolve() or not path.is_file():
                raise KeyError(item_id)
            return path

    def close(self, timeout: float = 10.0) -> None:
        with self._lock:
            self._closed = True
        self.allowance.cancel()
        result = self.stop(timeout)
        self.allowance.close()
        with self._lock:
            still_alive = self._thread is not None and self._thread.is_alive()
        if result["state"] == "stopping" or still_alive:
            raise RuntimeError("Recording writer did not stop within timeout")

    def _recording_space_available(self) -> bool:
        """Also check within catch-up batches after laptop sleep or a slow sampler."""
        with self._lock:
            if self._state != "recording":
                return False
        notice = None
        try:
            now = time.monotonic()
            if self._disk_free is None or now - self._disk_checked_at >= 0.5:
                self._disk_free = shutil.disk_usage(self.output_dir).free
                self._disk_checked_at = now
            free = self._disk_free
        except OSError:
            self.allowance.notify_full("Storage unavailable; attempting to save the current clip.")
            notice = "Recording stopped: output storage unavailable; saving current clip"
        else:
            if free < MIN_FREE_BYTES:
                self.allowance.notify_full(
                    "Disk space is low. Saving the current clip. Free space to record again."
                )
                notice = "Recording saved and stopped: less than 64 MiB free"
            elif not self.allowance.permit():
                notice = "Recording saved and stopped: storage allowance is full or unavailable"
        if notice is not None:
            with self._lock:
                self._stop_notice = notice
                self._stopped_at = self._stopped_at or time.monotonic()
                self._state = "stopping"
            return False
        return True

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
                if not self._recording_space_available():
                    break
                samples = self._samples(selected)
                composite = self._compose(
                    samples, selected, width=self._profile["width"], height=self._profile["height"]
                )
                if self._writer is None:
                    self._open_writer()
                # Duplicate the latest frame when sampling falls behind, preserving elapsed time.
                due = max(
                    1,
                    int((time.monotonic() - self._started) * self._profile["fps"])
                    - self._frames
                    + 1,
                )
                for _ in range(due):
                    if not self._recording_space_available():
                        break
                    if self._writer is None:
                        self._open_writer()
                    self._writer.write(composite)
                    with self._lock:
                        self._frames += 1
                        self._segment_frames += 1
                    if self._segment_frames >= self._segment_frame_limit():
                        self._finish_segment()
                remaining = max(
                    0.0, 1.0 / self._profile["fps"] - (time.monotonic() - frame_started)
                )
                self._wake.wait(remaining)
                self._wake.clear()
        except Exception:
            logger.exception("Recording writer failed")
            with self._lock:
                self._error = "Recording writer failed. Check local encoder and available storage."
                self._state = "error"
        finally:
            self._finalize()

    def _segment_frame_limit(self) -> int:
        return self._profile["fps"] * self._settings["segment_minutes"] * 60

    def _open_writer(self) -> None:
        self._segment_id = self._session_id if self._segment_index == 0 else uuid.uuid4().hex
        self._session_filename = f"{self._segment_id}.mp4"
        self._temp_path = self.output_dir / f".{self._segment_id}.partial.mp4"
        self._writer = H264Writer(self._temp_path, self._profile)

    def _finish_segment(self) -> None:
        writer, self._writer = self._writer, None
        if writer is not None:
            writer.release()
        temp_path = self._temp_path
        if self._segment_frames and temp_path is not None and temp_path.is_file():
            final_path = self.output_dir / self._session_filename
            item = self._new_item(
                self._segment_id,
                "recording",
                self._session_filename,
                duration_seconds=round(self._segment_frames / self._profile["fps"], 3),
                size_bytes=temp_path.stat().st_size,
                session_id=self._session_id,
                segment_index=self._segment_index + 1,
                codec="H.264",
                profile=self._settings["profile"],
                width=self._profile["width"],
                height=self._profile["height"],
                fps=self._profile["fps"],
                bitrate_kbps=self._profile["bitrate_kbps"],
            )
            # A small recovery journal bridges the video rename and catalog update.
            journal = self.output_dir / f".{self._segment_id}.recording.json"
            self._write_atomic(journal, json.dumps(item).encode("utf-8"))
            os.replace(temp_path, final_path)
            with self._lock:
                self._items[self._segment_id] = item
                self._save_catalog()
                self._segment_index += 1
            self._segment_frames = 0
            self._temp_path = None

    def _finalize(self) -> None:
        with self._lock:
            camera_ids = list(self._camera_ids)
            self._stopped_at = self._stopped_at or time.monotonic()
        try:
            if self._error is None:
                self._finish_segment()
            else:
                writer, self._writer = self._writer, None
                if writer is not None:
                    writer.release()
        except Exception:
            logger.exception("Recording finalization failed")
            with self._lock:
                self._error = "Recording finalization failed; earlier completed clips remain saved"
                self._state = "error"
        finally:
            if self._temp_path is not None:
                try:
                    self._temp_path.unlink(missing_ok=True)
                except OSError:
                    logger.exception("Could not remove incomplete recording")
        for camera_id in camera_ids:
            self._release(camera_id)
        with self._lock:
            if self._state != "error":
                self._state = "idle"
                self._error = self._stop_notice
            self._camera_ids = []
            if self._started:
                self._last_elapsed = self._stopped_at - self._started
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
    def _compose(
        images: list[np.ndarray | None],
        labels: list[str] | None = None,
        *,
        width: int = WIDTH,
        height: int = HEIGHT,
    ) -> np.ndarray:
        count = max(1, len(images))
        columns = math.ceil(math.sqrt(count))
        rows = math.ceil(count / columns)
        cell_w, cell_h = width // columns, height // rows
        canvas = np.zeros((height, width, 3), dtype=np.uint8)
        for index, image in enumerate(images):
            x, y = (index % columns) * cell_w, (index // columns) * cell_h
            w = width - x if index % columns == columns - 1 else cell_w
            h = height - y if index // columns == rows - 1 else cell_h
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
                (max(0, width - 330), height - 12),
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

    def _load_catalog(self, directory: Path | None = None) -> dict[str, dict[str, Any]]:
        directory = directory or self.output_dir
        try:
            data = json.loads((directory / _MANIFEST).read_text(encoding="utf-8"))
            raw_items = data.get("items", []) if isinstance(data, dict) else []
            if not isinstance(raw_items, list):
                raw_items = []
        except (OSError, ValueError, TypeError):
            raw_items = []
        # Recover finalized clips when the process stopped between file and catalog commits.
        for journal in directory.glob(".*.recording.json"):
            try:
                if journal.stat().st_size <= 16384:
                    raw = json.loads(journal.read_text(encoding="utf-8"))
                    if isinstance(raw, dict) and journal.name == f".{raw.get('id')}.recording.json":
                        raw_items.append(raw)
            except (OSError, ValueError, TypeError):
                continue
        items = {}
        for raw in raw_items:
            item = self._validated_catalog_item(raw, directory)
            if item is not None and item["id"] not in items:
                # A valid committed catalog wins over a stale recovery journal.
                items[item["id"]] = item
        return items

    def _validated_catalog_item(
        self, raw: Any, directory: Path | None = None
    ) -> dict[str, Any] | None:
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
        directory = directory or self.output_dir
        path = directory / filename
        try:
            if path.resolve().parent != directory.resolve() or not path.is_file():
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
            if type(raw.get("keep_forever")) is bool:
                item["keep_forever"] = raw["keep_forever"]
            for flag in ("compression_attempted", "compressed"):
                if type(raw.get(flag)) is bool:
                    item[flag] = raw[flag]
            session_id = raw.get("session_id")
            try:
                valid_session = (
                    isinstance(session_id, str) and uuid.UUID(hex=session_id).hex == session_id
                )
            except ValueError:
                valid_session = False
            if valid_session and type(raw.get("segment_index")) is int and raw["segment_index"] > 0:
                item.update(session_id=session_id, segment_index=raw["segment_index"])
            if isinstance(raw.get("profile"), str) and raw["profile"] in PROFILES:
                profile = PROFILES[raw["profile"]]
                item.update(
                    profile=raw["profile"],
                    codec="H.264",
                    **{key: profile[key] for key in ("width", "height", "fps", "bitrate_kbps")},
                )
        if item.get("compressed"):
            for key, maximum in (
                ("width", 1920),
                ("height", 1080),
                ("fps", 60),
                ("bitrate_kbps", 2000),
            ):
                value = raw.get(key)
                if type(value) in (int, float) and math.isfinite(value) and 0 < value <= maximum:
                    item[key] = value
        return item

    def _save_catalog(self) -> None:
        data = json.dumps({"items": list(self._items.values())}, indent=2).encode("utf-8")
        self._write_atomic(self._manifest, data)
        if hasattr(self, "allowance"):
            self.allowance.invalidate_usage()
        for item_id in self._items:
            try:
                (self.output_dir / f".{item_id}.recording.json").unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not remove recording recovery journal")

    @staticmethod
    def _write_atomic(path: Path, data: bytes) -> None:
        temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temp.write_bytes(data)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)
