"""Recording-only allowance and opt-in retention, entirely on the local machine."""

from __future__ import annotations

import json
import logging
import os
import shutil
import stat
import threading
import time
import uuid
from datetime import UTC, datetime
from typing import Any

from .video_encoder import compress_recording

logger = logging.getLogger(__name__)
MIN_ALLOWANCE = 64 * 1024 * 1024
FINALIZE_RESERVE = 4 * 1024 * 1024
DEFAULT_POLICY = {"max_bytes": 0, "action": "stop"}


def validate_policy(value: Any) -> dict:
    if not isinstance(value, dict) or set(value) != {"max_bytes", "action"}:
        raise ValueError("Send max_bytes and action")
    maximum = value["max_bytes"]
    if type(maximum) is not int or maximum != 0 and not MIN_ALLOWANCE <= maximum <= 16 * 1024**4:
        raise ValueError("Allowance must be zero (unlimited) or between 64 MiB and 16 TiB")
    if not isinstance(value["action"], str) or value["action"] not in (
        "stop",
        "delete",
        "compress",
    ):
        raise ValueError("Choose stop, delete or compress")
    return dict(value)


class RecordingAllowance:
    def __init__(self, recorder):
        self.recorder = recorder
        self.path = recorder.output_dir / "recording-allowance.json"
        self.policy = dict(DEFAULT_POLICY)
        self.error = None
        self.phase = "idle"
        self.alerts = []
        self._full = False
        self._worker = None
        self._cancel = threading.Event()
        self._failed = set()
        self._usage_cache = None
        self._usage_time = 0.0
        try:
            if self.path.exists():
                self.policy = validate_policy(json.loads(self.path.read_text(encoding="utf-8")))
        except (OSError, ValueError, TypeError):
            # A corrupt allowance must never silently enable unlimited recording/deletion.
            self.error = "Recording allowance is unreadable. Save valid settings in System."
        try:
            data = json.loads(
                (recorder.output_dir / "storage-alerts.json").read_text(encoding="utf-8")
            )
            self.alerts = (
                [
                    item
                    for item in data
                    if isinstance(item, dict) and item.get("source") == "storage"
                ][-20:]
                if isinstance(data, list)
                else []
            )
        except (OSError, ValueError, TypeError):
            pass

    def invalidate_usage(self):
        self._usage_cache = None

    def used_bytes(self) -> int:
        if self._usage_cache is not None and time.monotonic() - self._usage_time < 0.5:
            return self._usage_cache
        total = 0
        for path in self.recorder.output_dir.iterdir():
            if path.suffix.lower() not in (".mp4", ".avi", ".webm"):
                continue
            try:
                info = path.stat()
            except FileNotFoundError:
                continue
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
        self._usage_cache = total
        self._usage_time = time.monotonic()
        return total

    def snapshot(self) -> dict:
        with self.recorder._lock:
            try:
                used = self.used_bytes()
                free = shutil.disk_usage(self.recorder.output_dir).free
            except OSError:
                used = self._usage_cache or 0
                free = 0
                self.error = "Cannot measure recording storage. Recording is blocked."
                self.notify_full(self.error)
            limit = self.policy["max_bytes"]
            blocked = bool(
                self.error or limit and used + FINALIZE_RESERVE >= limit or free < MIN_ALLOWANCE
            )
            if blocked:
                self.notify_full(
                    self.error
                    or "Recording storage is full or below its safety margin. "
                    "Check System to resolve space before recording."
                )
            else:
                self._full = False
            return {
                **self.policy,
                "used_bytes": used,
                "reserve_bytes": FINALIZE_RESERVE,
                "protected_bytes": sum(
                    item["size_bytes"]
                    for item in self.recorder._items.values()
                    if item.get("kind") == "recording" and item.get("keep_forever")
                ),
                "blocked": blocked,
                "alerts": [dict(item) for item in self.alerts],
                "phase": self.phase,
                "error": self.error,
                "scope": (
                    "Videos in the active output folder; "
                    "captures, models and previous folders excluded"
                ),
            }

    def configure(self, value):
        policy = validate_policy(value)
        with self.recorder._lock:
            self.recorder._ensure_open()
            if self._worker and self._worker.is_alive():
                raise RuntimeError("Wait for storage maintenance before changing the allowance")
            self.recorder._write_atomic(self.path, json.dumps(policy).encode("utf-8"))
            self.policy = policy
            self.invalidate_usage()
            self.error = None
            self._failed.clear()
            self._full = False
            self.phase = "idle"
        # Saving a policy authorizes its selected cleanup action immediately.
        self.permit()
        self.recorder._wake.set()
        return self.snapshot()

    def notify_full(self, message):
        with self.recorder._lock:
            if self._full:
                return
            self._full = True
            item = {
                "id": "storage-" + uuid.uuid4().hex,
                "source": "storage",
                "title": "Recording storage full",
                "message": message[:500],
                "camera_id": "system",
                "workflow_name": "Recording storage",
                "created_at": datetime.now(UTC).isoformat(),
            }
            self.alerts.append(item)
            self.alerts = self.alerts[-20:]
            try:
                self.recorder._write_atomic(
                    self.recorder.output_dir / "storage-alerts.json",
                    json.dumps(self.alerts).encode("utf-8"),
                )
            except OSError:
                logger.warning("Could not persist storage alert")

    def permit(self, *, maintenance=True) -> bool:
        with self.recorder._lock:
            if self.error or self._cancel.is_set():
                if self.error:
                    self.notify_full(self.error)
                return False
            limit = self.policy["max_bytes"]
            if not limit:
                self._full = False
                return True
            try:
                if self.used_bytes() + FINALIZE_RESERVE < limit:
                    self._full = False
                    return True
                self.notify_full(
                    "Recording allowance reached its safety limit. Applying the selected policy. "
                    "If space cannot be recovered, the current clip is saved and new recordings "
                    "are blocked. Check System."
                )
                if maintenance and self.policy["action"] == "delete":
                    while self.used_bytes() + FINALIZE_RESERVE >= limit:
                        candidates = self._candidates()
                        if not candidates:
                            break
                        self._delete(candidates[0]["id"])
                    if self.used_bytes() + FINALIZE_RESERVE < limit:
                        self.phase = "idle"
                        self._full = False
                        return True
                if maintenance and self.policy["action"] == "compress":
                    self._schedule()
                return False
            except (OSError, KeyError, RuntimeError):
                self.error = (
                    "Storage maintenance failed. Current recording will stop and save; "
                    "check free space and permissions."
                )
                self.notify_full(self.error)
                return False

    def _candidates(self, *, compress=False):
        candidates = [
            item
            for item in self.recorder._items.values()
            if item.get("kind") == "recording"
            and not item.get("keep_forever")
            and item["id"] != self.recorder._segment_id
            and (
                not compress
                or item["filename"].endswith(".mp4")
                and not item.get("compression_attempted")
                and item["id"] not in self._failed
            )
        ]
        return sorted(
            candidates, key=lambda item: (datetime.fromisoformat(item["created_at"]), item["id"])
        )

    def _delete(self, item_id, *, automatic=True):
        item = self.recorder._items[item_id]
        if (
            item.get("keep_forever")
            or item_id == self.recorder._segment_id
            and (automatic or self.recorder._state in ("recording", "stopping"))
        ):
            raise RuntimeError("Protected or current recording cannot be removed")
        path = self.recorder.media_path(item_id)
        path.unlink()
        del self.recorder._items[item_id]
        self.recorder._save_catalog()

    def delete(self, item_id):
        with self.recorder._lock:
            self.recorder._ensure_open()
            if item_id not in self.recorder._items:
                raise KeyError(item_id)
            if self.recorder._items[item_id].get("kind") != "recording":
                raise ValueError("Only recordings can be deleted here")
            self._delete(item_id, automatic=False)
            self.error = None
            return self.snapshot()

    def keep(self, item_id, keep):
        if type(keep) is not bool:
            raise ValueError("keep_forever must be true or false")
        with self.recorder._lock:
            self.recorder._ensure_open()
            item = self.recorder._items.get(item_id)
            if item is None:
                raise KeyError(item_id)
            if item.get("kind") != "recording":
                raise ValueError("Only recordings support keep forever")
            previous = dict(item)
            item["keep_forever"] = keep
            try:
                self.recorder._save_catalog()
            except OSError:
                self.recorder._items[item_id] = previous
                raise
            return dict(item)

    def retry(self):
        with self.recorder._lock:
            if not self.path.exists() and self.error:
                raise RuntimeError("Save allowance settings before retrying")
            # Validate persistent policy before clearing a read/permission error.
            if self.path.exists():
                validate_policy(json.loads(self.path.read_text(encoding="utf-8")))
            self.error = None
            self.invalidate_usage()
            self._failed.clear()
        self.permit()
        return self.snapshot()

    def _schedule(self):
        if self._worker and self._worker.is_alive():
            return
        if not self._candidates(compress=True):
            self.phase = "blocked"
            return
        self.phase = "compressing"
        self._worker = threading.Thread(
            target=self._compress_loop, name="spyder-storage-maintenance", daemon=True
        )
        self._worker.start()

    def _compress_loop(self):
        try:
            while not self._cancel.is_set():
                with self.recorder._lock:
                    if self.permit(maintenance=False):
                        break
                    candidates = self._candidates(compress=True)
                    if not candidates:
                        break
                    item = dict(candidates[0])
                    source = self.recorder.media_path(item["id"])
                temporary = self.recorder.output_dir / f".{item['id']}.repack.mp4"
                try:
                    # Compression needs temporary disk headroom; it never replaces a larger file.
                    result = compress_recording(source, temporary, item, self._cancel)
                    with self.recorder._lock:
                        current = self.recorder._items.get(item["id"])
                        if (
                            current is None
                            or current.get("keep_forever")
                            or item["id"] == self.recorder._segment_id
                        ):
                            continue
                        updated = {**current, "compression_attempted": True}
                        if result and temporary.stat().st_size < source.stat().st_size * 0.95:
                            updated.update(
                                result, compressed=True, size_bytes=temporary.stat().st_size
                            )
                            journal = self.recorder.output_dir / f".{item['id']}.recording.json"
                            self.recorder._write_atomic(
                                journal, json.dumps(updated).encode("utf-8")
                            )
                            os.replace(temporary, source)
                        self.recorder._items[item["id"]] = updated
                        self.recorder._save_catalog()
                except Exception as error:
                    logger.exception("Recording recompression failed")
                    with self.recorder._lock:
                        self._failed.add(item["id"])
                        if isinstance(error, OSError):
                            self.error = (
                                "Storage maintenance could not update local files/catalog. "
                                "Check permissions and retry."
                            )
                finally:
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError:
                        logger.warning("Could not remove temporary recompression file")
                    with self.recorder._lock:
                        self.invalidate_usage()
        finally:
            with self.recorder._lock:
                self.phase = "blocked" if not self.permit(maintenance=False) else "idle"

    def cancel(self):
        self._cancel.set()

    def close(self):
        self.cancel()
        worker = self._worker
        if worker is not None:
            worker.join(3)
            if worker.is_alive():
                raise RuntimeError("Recording storage maintenance did not stop")
