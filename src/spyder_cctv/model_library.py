"""Persistent registry for local vision model files."""

from __future__ import annotations

import copy
import json
import os
import re
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

if os.name == "nt":
    import msvcrt
else:
    import fcntl

from spyder_cctv.cv.contracts import VisionConfig
from spyder_cctv.model_metadata import inspect_metadata

MAX_MODELS = 64
MAX_UPLOAD_BYTES = 256 * 1024 * 1024
MAX_REGISTRY_BYTES = 16 * 1024 * 1024
LOCK_TIMEOUT_SECONDS = 5.0
_ENGINES = {"yolo": {".pt", ".onnx"}, "insightface": {".onnx"}}


class ModelLibrary:
    """Store descriptors and uploaded weights below the user's media directory."""

    def __init__(self, media_dir: Path):
        self.root = Path(media_dir).parent / "models"
        self.registry_path = self.root / "registry.json"
        self.lock_path = self.root / ".registry.lock"
        self._lock = threading.RLock()
        self._models: dict[str, dict[str, Any]] = {}
        self._storage_error: str | None = None
        self._registry_stamp: tuple[int, int, int] | None = None
        try:
            self.root.mkdir(parents=True, exist_ok=True)
        except OSError:
            self._storage_error = "Model storage is unavailable; existing data was preserved"
            return
        with self._lock:
            self._reload_if_changed(force=True)

    @contextmanager
    def _registry_lock(self):
        """Serialize writers across processes without unlinking the lock inode."""
        handle = self.lock_path.open("a+b")
        try:
            if os.name == "nt":
                handle.seek(0, os.SEEK_END)
                if handle.tell() == 0:
                    handle.write(b"\0")
                    handle.flush()
                deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
                while True:
                    try:
                        handle.seek(0)
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise TimeoutError(
                                "Timed out waiting for model registry lock"
                            ) from None
                        time.sleep(0.05)
            else:
                deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
                while True:
                    try:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise TimeoutError(
                                "Timed out waiting for model registry lock"
                            ) from None
                        time.sleep(0.05)
            yield
        finally:
            try:
                if os.name == "nt":
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            handle.close()

    @contextmanager
    def _mutation(self):
        with self._lock:
            self._check_storage()
            with self._registry_lock():
                self._reload_if_changed()
                self._check_storage()
                yield

    def _reload_if_changed(self, *, force: bool = False) -> None:
        """Read registry and its stamp from one opened inode."""
        try:
            with self.registry_path.open("rb") as stream:
                stat = os.fstat(stream.fileno())
                stamp = (stat.st_mtime_ns, stat.st_size, stat.st_ino)
                if not force and stamp == self._registry_stamp:
                    return
                if stat.st_size > MAX_REGISTRY_BYTES:
                    raise ValueError("registry exceeds 16 MiB")
                value = json.loads(stream.read().decode("utf-8"))
            if not isinstance(value, list) or len(value) > MAX_MODELS:
                raise ValueError("registry must be a list of at most 64 entries")
            if any(not isinstance(row, dict) or not self._valid_record(row) for row in value):
                raise ValueError("registry contains an invalid entry")
            models = {row["id"]: row for row in value}
            if len(models) != len(value):
                raise ValueError("registry contains duplicate IDs")
            self._models = models
            self._storage_error = None
            self._registry_stamp = stamp
        except FileNotFoundError:
            self._models = {}
            self._storage_error = None
            self._registry_stamp = None
        except (OSError, ValueError, UnicodeError):
            self._storage_error = "Model registry is corrupt or unreadable; file was preserved"

    @property
    def storage_error(self) -> str | None:
        with self._lock:
            self._reload_if_changed()
            return self._storage_error

    def _check_storage(self) -> None:
        if self._storage_error is not None:
            raise RuntimeError(self._storage_error)

    @staticmethod
    def _valid_record(row: dict[str, Any]) -> bool:
        engine = row.get("engine")
        path = row.get("path")
        labels = row.get("classes")
        return (
            isinstance(row.get("id"), str)
            and re.fullmatch(r"[0-9a-f]{32}", row["id"])
            and isinstance(engine, str)
            and engine in _ENGINES
            and isinstance(path, str)
            and Path(path).suffix.lower() in _ENGINES[engine]
            and row.get("format") == Path(path).suffix.lower().lstrip(".")
            and isinstance(row.get("name"), str)
            and 1 <= len(row["name"]) <= 128
            and isinstance(labels, list)
            and len(labels) <= 1000
            and all(isinstance(item, str) and 1 <= len(item) <= 128 for item in labels)
            and isinstance(row.get("settings"), dict)
            and row["settings"].get("model") == path
            and isinstance(row.get("metadata"), dict)
            and ("uploaded" not in row or type(row["uploaded"]) is bool)
        )

    @staticmethod
    def _filename(path: str) -> str:
        # Keep only a basename; reject URL-like paths and Windows/Unix traversal.
        if not isinstance(path, str) or not path or "\x00" in path or "://" in path:
            raise ValueError("Model path must name a local model file")
        name = path.replace("\\", "/").split("/")[-1]
        if name in ("", ".", ".."):
            raise ValueError("Invalid model filename")
        return name

    @staticmethod
    def _inspect(
        path: Path, engine: str, *, label_source: str | None = None
    ) -> tuple[list[str], dict[str, Any]]:
        if path.suffix.lower() == ".pt":
            # Never deserialize PyTorch weights: pickle payloads can execute code.
            if label_source is not None:
                raise ValueError("Label source selection currently supports ONNX metadata only")
            return [], {"inspection": "unverified", "classes": "manual labels required"}
        metadata = {"inspection": "unverified", "classes": "manual labels required"}
        try:
            import onnx  # type: ignore[import-not-found]

            model = onnx.load(str(path), load_external_data=False)
        except ImportError:
            metadata["inspection_error"] = "ONNX metadata inspection requires the onnx package."
            return [], metadata
        except Exception as error:
            metadata["inspection_error"] = f"Could not read ONNX metadata ({type(error).__name__})."
            return [], metadata
        return inspect_metadata(model, label_source=label_source)

    def _settings(self, engine: str, path: Path) -> dict[str, Any]:
        try:
            return copy.deepcopy(VisionConfig(engine=engine, model=str(path)).__dict__)
        except ValueError as error:
            raise ValueError(str(error)) from None

    def _add(
        self,
        path: Path,
        engine: str,
        name: str | None = None,
        classes: list[str] | None = None,
        *,
        uploaded: bool = False,
    ) -> dict[str, Any]:
        engine = engine.lower() if isinstance(engine, str) else ""
        if engine not in _ENGINES:
            raise ValueError("Engine must be yolo or insightface")
        if path.suffix.lower() not in _ENGINES[engine]:
            raise ValueError("Model extension does not match engine")
        if not path.is_file():
            raise ValueError("Model file does not exist")
        if name is not None and (not isinstance(name, str) or not name.strip() or len(name) > 128):
            raise ValueError("Name must contain 1 to 128 characters")
        if len(self._models) >= MAX_MODELS:
            raise ValueError("Model library is full (64 models maximum)")
        path = path.resolve()
        detected_classes, metadata = self._inspect(path, engine)
        if classes is not None:
            metadata.update(classes="manual labels", class_source="manual")
        labels = classes if classes is not None else detected_classes
        if (
            not isinstance(labels, list)
            or len(labels) > 1000
            or any(
                not isinstance(item, str) or not item.strip() or len(item) > 128 for item in labels
            )
        ):
            raise ValueError("Classes must be a list of up to 1000 non-empty labels")
        ident = uuid.uuid4().hex
        settings = self._settings(engine, path)
        row = {
            "id": ident,
            "name": name.strip() if name else path.stem,
            "engine": engine,
            "path": str(path),
            "classes": copy.deepcopy(labels),
            "settings": settings,
            "format": path.suffix.lower().lstrip("."),
            "metadata": metadata,
            "uploaded": uploaded,
        }
        self._models[ident] = row
        try:
            self._save()
        except OSError:
            del self._models[ident]
            raise
        return self._descriptor(row)

    def _save(self) -> None:
        with self._lock:
            temporary = self.root / (".registry-" + uuid.uuid4().hex + ".tmp")
            try:
                with temporary.open("w", encoding="utf-8") as stream:
                    json.dump(list(self._models.values()), stream, ensure_ascii=False)
                    stream.flush()
                    os.fsync(stream.fileno())
                for attempt in range(6):
                    try:
                        os.replace(temporary, self.registry_path)
                        break
                    except PermissionError:
                        if attempt == 5:
                            raise
                        time.sleep(0.05 * (attempt + 1))
                # Force next read to obtain data and stamp from the same open handle.
                self._registry_stamp = None
            finally:
                temporary.unlink(missing_ok=True)

    @staticmethod
    def _descriptor(row: dict[str, Any]) -> dict[str, Any]:
        return copy.deepcopy(
            {
                key: row.get(key, False) if key == "uploaded" else row[key]
                for key in (
                    "id",
                    "name",
                    "engine",
                    "path",
                    "classes",
                    "settings",
                    "format",
                    "metadata",
                    "uploaded",
                )
            }
        )

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            self._reload_if_changed()
            if self._storage_error is not None:
                return []
            return [self._descriptor(row) for row in self._models.values()]

    def get(self, ident: str) -> dict[str, Any]:
        with self._lock:
            self._reload_if_changed()
            self._check_storage()
            try:
                row = self._models[ident]
            except KeyError:
                raise KeyError(ident) from None
            return copy.deepcopy(
                {
                    key: row[key]
                    for key in ("id", "engine", "path", "classes", "settings", "metadata")
                }
            )

    def register(
        self,
        path: str,
        name: str | None = None,
        engine: str | None = None,
        classes: list[str] | None = None,
    ) -> dict[str, Any]:
        with self._mutation():
            self._filename(path)
            source = Path(path).expanduser()
            if not source.is_absolute():
                source = Path.cwd() / source
            if engine is None:
                raise ValueError("Engine is required")
            return self._add(source, engine, name, classes)

    def upload(
        self, filename: str, engine: str, stream: Any, length: int, name: str | None = None
    ) -> dict[str, Any]:
        with self._lock:
            self._reload_if_changed()
            self._check_storage()
        basename = self._filename(filename)
        engine = engine.lower() if isinstance(engine, str) else ""
        if engine not in _ENGINES:
            raise ValueError("Engine must be yolo or insightface")
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            raise ValueError("Upload must be between 1 byte and 256 MiB")
        suffix = Path(basename).suffix.lower()
        if suffix not in _ENGINES[engine]:
            raise ValueError("Model extension does not match engine")
        destination = self.root / (uuid.uuid4().hex + suffix)
        remaining = length
        try:
            with destination.open("xb") as output:
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("Upload ended before Content-Length bytes arrived")
                    output.write(chunk)
                    remaining -= len(chunk)
                output.flush()
                os.fsync(output.fileno())
            with self._mutation():
                return self._add(destination, engine, name or Path(basename).stem, uploaded=True)
        except Exception:
            destination.unlink(missing_ok=True)
            raise

    def update_metadata(
        self, ident: str, *, name: str | None = None, classes: list[str] | None = None
    ) -> dict[str, Any]:
        with self._mutation():
            if ident not in self._models:
                raise KeyError(ident)
            if name is not None and (
                not isinstance(name, str) or not name.strip() or len(name) > 128
            ):
                raise ValueError("Name must contain 1 to 128 characters")
            if classes is not None and (
                not isinstance(classes, list)
                or len(classes) > 1000
                or any(
                    not isinstance(item, str) or not item.strip() or len(item) > 128
                    for item in classes
                )
            ):
                raise ValueError("Classes must be a list of up to 1000 non-empty labels")
            row = self._models[ident]
            previous = copy.deepcopy(row)
            if name is not None:
                row["name"] = name.strip()
            if classes is not None:
                row["classes"] = copy.deepcopy(classes)
                row["metadata"] = {
                    **row.get("metadata", {}),
                    "classes": "manual labels",
                    "class_source": "manual",
                }
            try:
                self._save()
            except OSError:
                self._models[ident] = previous
                raise
            return self._descriptor(row)

    def remove(self, ident: str) -> dict[str, Any]:
        """Remove registry entry and delete only a verified library-owned upload."""
        with self._mutation():
            row = self._models.get(ident)
            if row is None:
                raise KeyError(ident)
            previous = copy.deepcopy(row)
            uploaded = row.get("uploaded", False) is True
            source = Path(row["path"])
            source_key = source.resolve()
            shared = any(
                other_id != ident and Path(other["path"]).resolve() == source_key
                for other_id, other in self._models.items()
            )
            quarantine: Path | None = None
            if uploaded and not shared:
                root = self.root.resolve()
                # Uploaded files use random UUID names. Refuse symlinks and path escapes.
                if not re.fullmatch(r"[0-9a-f]{32}", source.stem):
                    raise RuntimeError("Uploaded model path is not library-owned")
                try:
                    if source.parent.resolve() != root or source.is_symlink():
                        raise RuntimeError("Uploaded model path is not library-owned")
                    info = source.lstat()
                    if not source.is_file() or source.resolve().parent != root:
                        raise RuntimeError("Uploaded model path is not library-owned")
                except FileNotFoundError:
                    info = None
                if info is not None:
                    quarantine = root / (".remove-" + uuid.uuid4().hex)
                    os.replace(source, quarantine)
            del self._models[ident]
            try:
                self._save()
            except OSError:
                self._models[ident] = previous
                if quarantine is not None:
                    os.replace(quarantine, source)
                raise
            deleted_file = False
            cleanup_error = None
            if quarantine is not None:
                try:
                    quarantine.unlink()
                    deleted_file = True
                except OSError:
                    cleanup_error = (
                        "Could not delete uploaded model bytes; bytes remain in private quarantine"
                    )
            outcome = {"removed": True, "id": ident, "deleted_file": deleted_file}
            if cleanup_error is not None:
                outcome["cleanup_error"] = cleanup_error
                outcome["retained_quarantine"] = True
            return outcome

    def reinspect(
        self, ident: str, *, label_source: str | None = None, reset_source: bool = False
    ) -> dict[str, Any]:
        """Refresh metadata; explicit source selection replaces labels, never model weights."""
        descriptor = self.get(ident)
        if label_source is not None and (
            not isinstance(label_source, str)
            or not label_source.startswith("/")
            or len(label_source) > 1024
        ):
            raise ValueError("Label source must be a discovered metadata JSON Pointer")
        explicit_source = label_source is not None or reset_source
        previous_metadata = descriptor["metadata"]
        selected_source = label_source
        if not explicit_source and previous_metadata.get("resolution") == "selected":
            selected_source = previous_metadata.get("label_source")
        if selected_source is None:
            classes, metadata = self._inspect(Path(descriptor["path"]), descriptor["engine"])
        else:
            classes, metadata = self._inspect(
                Path(descriptor["path"]), descriptor["engine"], label_source=selected_source
            )
        with self._mutation():
            if ident not in self._models:
                raise KeyError(ident)
            row = self._models[ident]
            if row["path"] != descriptor["path"] or row["engine"] != descriptor["engine"]:
                raise RuntimeError("Model changed during inspection; retry")
            previous = copy.deepcopy(row)
            if not explicit_source and (
                row["metadata"].get("resolution") != previous_metadata.get("resolution")
                or row["metadata"].get("label_source") != previous_metadata.get("label_source")
            ):
                raise RuntimeError("Metadata source changed during inspection; retry")
            manual = row["metadata"].get("classes") == "manual labels" and (
                not explicit_source or bool(metadata.get("inspection_error"))
            )
            if not metadata.get("inspection_error") and not manual:
                row["classes"] = classes
            row["metadata"] = (
                {**row["metadata"], **metadata} if metadata.get("inspection_error") else metadata
            )
            if metadata.get("inspection_error") and row["classes"]:
                row["metadata"]["classes"] = "available from previous inspection"
            if manual:
                row["metadata"].update(classes="manual labels", class_source="manual")
            try:
                self._save()
            except OSError:
                self._models[ident] = previous
                raise
            return self._descriptor(row)
