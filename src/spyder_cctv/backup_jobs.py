"""In-memory coordinator for long-running full backup operations."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any
from uuid import uuid4


def _complete_backup():
    from spyder_cctv.complete_backup import CompleteBackup

    return CompleteBackup


class BackupJobs:
    """Run one archive operation at a time and expose bounded status snapshots."""

    def __init__(self, manager: Any, recorder: Any, workflows: Any, schedules: Any):
        self.manager = manager
        self.recorder = recorder
        self.workflows = workflows
        self.schedules = schedules
        self._lock = threading.RLock()
        self._active = False
        self._closing = False
        self._cancel = threading.Event()
        self._thread: threading.Thread | None = None
        self._status: dict[str, Any] = {"state": "idle"}

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return _copy_status(self._status)

    def start(
        self,
        operation: str,
        path: Path,
        *,
        destination: Path | None = None,
        include_media: bool = False,
        browser_data: dict | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if self._closing:
                raise RuntimeError("SpyDER is closing")
            if self._active:
                raise RuntimeError("A full backup job is already running")
            self._cancel.clear()
            self._active = True
            job_id = uuid4().hex
            self._status = {
                "id": job_id,
                "operation": operation,
                "state": "running",
                "progress": {"phase": "queued", "files": 0, "bytes": 0, "message": "Queued"},
                "result": None,
                "error": None,
            }
            args = (operation, path, destination, include_media, browser_data)
            thread = threading.Thread(
                target=self._run, args=args, name=f"spyder-backup-{operation}", daemon=True
            )
            self._thread = thread
            thread.start()
            return _copy_status(self._status)

    def _progress(self, update: Any) -> None:
        if not isinstance(update, dict):
            return
        progress = {
            "phase": _bounded(update.get("phase"), 40, "working"),
            "files": _nonnegative_int(update.get("files", update.get("current"))),
            "bytes": _nonnegative_int(update.get("bytes")),
            "message": _bounded(update.get("message"), 160, "Working"),
        }
        if self._cancel.is_set():
            raise RuntimeError("Backup operation cancelled")
        with self._lock:
            if self._status.get("state") == "running":
                self._status["progress"] = progress

    def _run(self, operation, path, destination, include_media, browser_data) -> None:
        try:
            archive_core = _complete_backup()
            if operation == "create":
                # Preflight is atomic; the HTTP mutation barrier freezes new writes
                # during create without holding service locks across archive I/O.
                with self.workflows._lock, self.manager._mutations:
                    self._require_quiescent()
                    config_path = getattr(self.manager, "_config_path", None)
                    if config_path is None:
                        raise RuntimeError("Full backup requires a persistent configuration")
                    history = getattr(self.workflows, "history", None)
                    if history is not None and not history.flush():
                        raise RuntimeError("Workflow event history did not finish saving")
                result = archive_core.create(
                    Path(config_path),
                    path,
                    media_dir=self.manager.media_dir,
                    include_media=include_media,
                    browser_data=browser_data,
                    progress=self._progress,
                )
            elif operation == "inspect":
                result = archive_core.inspect(path, progress=self._progress)
            else:
                result = archive_core.restore(path, destination, progress=self._progress)
            if self._cancel.is_set():
                raise RuntimeError("Backup operation cancelled")
            result = _small_result(result)
            with self._lock:
                self._status.update(
                    state="completed",
                    progress={
                        "phase": "complete",
                        "files": _nonnegative_int(result.get("files", result.get("file_count"))),
                        "bytes": _nonnegative_int(result.get("total_bytes")),
                        "message": "Completed",
                    },
                    result=result,
                    error=None,
                )
        except Exception as error:
            with self._lock:
                self._status.update(
                    state="error",
                    progress={**self._status.get("progress", {}), "phase": "error"},
                    result=None,
                    error=_bounded(str(error), 240, "Backup job failed"),
                )
        finally:
            with self._lock:
                self._active = False

    def _require_quiescent(self) -> None:
        writer_thread = getattr(self.recorder, "_thread", None)
        if (
            self.recorder.status()["state"] not in ("idle", "error")
            or (writer_thread is not None and writer_thread.is_alive())
            or getattr(self.recorder, "_writer", None) is not None
        ):
            raise RuntimeError(
                "Stop recordings and wait for finalization before creating a full backup"
            )
        for worker in self.manager._snapshot():
            if (
                worker.status()["state"] not in ("stopped", "error")
                or (worker._thread is not None and worker._thread.is_alive())
                or any(
                    runtime is not None and runtime.is_alive
                    for runtime in (worker._retiring_pipeline, worker._retiring_analysis)
                )
            ):
                raise RuntimeError(
                    "Stop all cameras and wait for processing before creating a full backup"
                )
        if any(graph["enabled"] for graph in self.workflows.list()["workflows"]):
            raise RuntimeError("Disable all workflows before creating a full backup")
        if any(thread.is_alive() for thread in self.workflows._clip_threads):
            raise RuntimeError(
                "Wait for workflow event clips to finish before creating a full backup"
            )
        if any(rule["enabled"] for rule in self.schedules.snapshot()["schedules"]):
            raise RuntimeError("Disable recording schedules before creating a full backup")

    def cancel(self) -> dict[str, Any]:
        """Request cancellation without making the coordinator unusable."""
        with self._lock:
            self._cancel.set()
            return _copy_status(self._status)

    def close(self, timeout: float = 5.0) -> None:
        """Cancel active archive work, then wait briefly without blocking shutdown forever."""
        with self._lock:
            self._closing = True
            self._cancel.set()
            thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(max(0.0, timeout))


def validate_job_request(data: dict) -> tuple[str, Path, Path | None, bool, dict | None]:
    allowed = {"operation", "path", "destination", "include_media", "browser_data"}
    if set(data) - allowed:
        raise ValueError("Unknown full backup job fields")
    operation = data.get("operation")
    if operation not in ("create", "inspect", "restore"):
        raise ValueError("Operation must be create, inspect, or restore")
    raw_path = data.get("path")
    path = _absolute_path(raw_path, "path")
    destination = None
    include_media = data.get("include_media", False)
    browser_data = data.get("browser_data")
    if "include_media" in data and operation != "create":
        raise ValueError("include_media is only valid for create")
    if not isinstance(include_media, bool):
        raise ValueError("include_media must be boolean")
    if operation != "create" and browser_data is not None:
        raise ValueError("browser_data is only valid for create")
    if browser_data is not None and not isinstance(browser_data, dict):
        raise ValueError("browser_data must be an object")
    if operation == "restore":
        destination = _absolute_path(data.get("destination"), "destination")
        if destination.exists():
            raise ValueError("Restore destination must be a new folder")
        if not destination.parent.is_dir():
            raise ValueError("Restore destination parent must exist")
    elif "destination" in data:
        raise ValueError("destination is only valid for restore")
    return operation, path, destination, include_media, browser_data


def _absolute_path(value: Any, name: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be an absolute path")
    path = Path(value).expanduser()
    if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
        raise ValueError(f"{name} cannot be a symbolic link or junction")
    if not path.is_absolute():
        raise ValueError(f"{name} must be an absolute path")
    return path.resolve()


def _bounded(value: Any, limit: int, fallback: str) -> str:
    text = str(value) if value is not None else fallback
    return text.replace("\r", " ").replace("\n", " ")[:limit] or fallback


def _nonnegative_int(value: Any) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return min(max(0, value), 2**63 - 1)
    return 0


def _small_result(value: Any) -> dict:
    if not isinstance(value, dict):
        return {"summary": "Operation completed"}
    # Keep archive payload and unbounded metadata out of polling responses.
    result = {}
    for key in (
        "format",
        "version",
        "application_version",
        "created_at",
        "path",
        "file_count",
        "files",
        "total_bytes",
        "include_media",
        "browser_data_included",
        "destination",
        "config_path",
        "browser_state_path",
    ):
        item = value.get(key)
        if key in value and isinstance(item, (str, int, bool)):
            result[key] = _bounded(item, 500, "") if isinstance(item, str) else item
    counts = value.get("counts")
    if isinstance(counts, dict):
        result["counts"] = {
            _bounded(name, 80, ""): _nonnegative_int(count)
            for name, count in list(counts.items())[:32]
            if isinstance(name, str)
        }
    warnings = value.get("warnings")
    if isinstance(warnings, list):
        result["warnings"] = [
            _bounded(warning, 240, "") for warning in warnings[:32] if isinstance(warning, str)
        ]
    return result


def _copy_status(value: dict) -> dict:
    import copy

    return copy.deepcopy(value)
