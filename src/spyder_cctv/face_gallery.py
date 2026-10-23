"""Local, atomic face enrollment and identity-gallery storage."""

from __future__ import annotations

import base64
import copy
import hashlib
import importlib
import json
import math
import os
import re
import tempfile
import threading
import uuid
from functools import wraps
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from spyder_cctv.cv.contracts import VisionUnavailable

_MAX_IMAGE_BYTES = 16 * 1024 * 1024
_MAX_IMAGE_PIXELS = 24_000_000
_MAX_GALLERIES = 100
_MAX_IDENTITIES = 1000
_MAX_SAMPLES = 100
_MAX_GALLERY_SAMPLES = 1000
_MAX_CATALOG_BYTES = 16 * 1024 * 1024
_MAX_EMBEDDING_VALUES = 1_000_000
_NAME_LIMIT = 128


def _clean_name(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Name must be text")
    name = value.strip()
    if not name or len(name) > _NAME_LIMIT or any(ord(char) < 32 for char in name):
        raise ValueError("Name must contain 1 to 128 printable characters")
    return name


def _atomic_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(data, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _encoded_dimensions(data: bytes | bytearray | memoryview) -> tuple[int, int] | None:
    """Read JPEG or PNG dimensions before decode allocates pixel storage."""
    view = memoryview(data)
    if view[:8] == b"\x89PNG\r\n\x1a\n" and len(view) >= 24:
        if view[12:16] != b"IHDR":
            return None
        width = int.from_bytes(view[16:20], "big")
        height = int.from_bytes(view[20:24], "big")
        return width, height
    if len(view) < 4 or view[:2] != b"\xff\xd8":
        return None
    offset = 2
    sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while offset + 4 <= len(view):
        if view[offset] != 0xFF:
            return None
        while offset < len(view) and view[offset] == 0xFF:
            offset += 1
        if offset >= len(view):
            return None
        marker = view[offset]
        offset += 1
        if marker in {0xD8, 0xD9, 0x01, *range(0xD0, 0xD8)}:
            continue
        if offset + 2 > len(view):
            return None
        segment_length = int.from_bytes(view[offset : offset + 2], "big")
        if segment_length < 2 or offset + segment_length > len(view):
            return None
        if marker in sof_markers and segment_length >= 7:
            height = int.from_bytes(view[offset + 3 : offset + 5], "big")
            width = int.from_bytes(view[offset + 5 : offset + 7], "big")
            return width, height
        offset += segment_length
    return None


def _serialized(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return wrapped


def _enrollment_slot(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        if not self._enrollment_slots.acquire(blocking=False):
            raise VisionUnavailable("enrollment_busy", "Another local enrollment is in progress.")
        try:
            with self._lock:
                return method(self, *args, **kwargs)
        finally:
            self._enrollment_slots.release()

    return wrapped


class FaceEnrollmentService:
    """Manage local face galleries; retain vectors, never source images."""

    def __init__(self, storage_dir: str | Path) -> None:
        self._lock = threading.RLock()
        self._enrollment_slots = threading.BoundedSemaphore(1)
        self._verified_models: dict[str, tuple[int, int, int, int, int, str]] = {}
        self._verified_exports: dict[
            str, tuple[tuple[int, int, int, int, int], tuple[int, int, int, int, int] | None]
        ] = {}
        self._catalog_cache: dict[str, tuple[int, int, int, int, int, dict[str, Any]]] = {}
        self._analysis_models = None
        self.root = Path(storage_dir).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _dir(self, gallery_id: str) -> Path:
        if not isinstance(gallery_id, str) or not re.fullmatch(r"[a-f0-9]{32}", gallery_id):
            raise ValueError("Unknown gallery")
        directory = self.root / gallery_id
        if not directory.is_dir():
            raise ValueError("Unknown gallery")
        return directory

    def _load(self, gallery_id: str, *, copy_data: bool = False) -> dict[str, Any]:
        directory = self._dir(gallery_id)
        path = directory / "catalog.json"
        try:
            stat = path.stat()
            if stat.st_size > _MAX_CATALOG_BYTES:
                raise ValueError("Gallery catalog too large")
            cached = self._catalog_cache.get(gallery_id)
            fingerprint = (
                stat.st_dev,
                stat.st_ino,
                stat.st_size,
                stat.st_mtime_ns,
                stat.st_ctime_ns,
            )
            if cached is not None and cached[:5] == fingerprint:
                self._repair_export(directory, cached[5], fingerprint)
                return copy.deepcopy(cached[5]) if copy_data else cached[5]
            with path.open("r", encoding="utf-8") as stream:
                data = json.load(
                    stream,
                    parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
                )
            self._validate_catalog(data, gallery_id)
            self._repair_export(directory, data, self._file_fingerprint(path))
            stat = path.stat()
            self._catalog_cache[gallery_id] = (
                stat.st_dev,
                stat.st_ino,
                stat.st_size,
                stat.st_mtime_ns,
                stat.st_ctime_ns,
                copy.deepcopy(data),
            )
            return data
        except (OSError, UnicodeError, json.JSONDecodeError, TypeError, OverflowError) as error:
            raise ValueError("Gallery catalog is invalid") from error

    @staticmethod
    def _file_fingerprint(path: Path) -> tuple[int, int, int, int, int]:
        stat = path.stat()
        return (
            stat.st_dev,
            stat.st_ino,
            stat.st_size,
            stat.st_mtime_ns,
            stat.st_ctime_ns,
        )

    def _repair_export(
        self,
        directory: Path,
        catalog: dict[str, Any],
        canonical_fingerprint: tuple[int, int, int, int, int] | None = None,
    ) -> None:
        exported_path = directory / "gallery-v1.json"
        if canonical_fingerprint is None:
            canonical_fingerprint = self._file_fingerprint(directory / "catalog.json")
        gallery_id = catalog["id"]
        try:
            export_stat = exported_path.stat()
            export_fingerprint = (
                export_stat.st_dev,
                export_stat.st_ino,
                export_stat.st_size,
                export_stat.st_mtime_ns,
                export_stat.st_ctime_ns,
            )
        except OSError:
            export_fingerprint = None
        if self._verified_exports.get(gallery_id) == (
            canonical_fingerprint,
            export_fingerprint,
        ):
            return
        try:
            if export_fingerprint is None or export_stat.st_size > _MAX_CATALOG_BYTES:
                exported = None
            else:
                with exported_path.open("r", encoding="utf-8") as stream:
                    exported = json.load(
                        stream,
                        parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
                    )
        except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError):
            exported = None
        expected = self._v1(catalog)
        if exported != expected:
            _atomic_json(exported_path, expected)
            export_fingerprint = self._file_fingerprint(exported_path)
        self._verified_exports[gallery_id] = (canonical_fingerprint, export_fingerprint)

    @staticmethod
    def _validate_catalog(data: Any, gallery_id: str) -> None:
        if (
            not isinstance(data, dict)
            or data.get("version") != 1
            or data.get("id") != gallery_id
            or not isinstance(data.get("name"), str)
            or not isinstance(data.get("identities"), list)
            or not isinstance(data.get("detector"), dict)
            or not isinstance(data.get("recognition"), dict)
        ):
            raise ValueError("Gallery catalog is invalid")
        if len(data["identities"]) > _MAX_IDENTITIES:
            raise ValueError("Gallery has too many identities")
        names, identity_ids, dimension, samples = set(), set(), None, 0
        for identity in data["identities"]:
            if not isinstance(identity, dict) or not isinstance(identity.get("id"), str):
                raise ValueError("Gallery identity record is invalid")
            identity_id = identity["id"]
            name = _clean_name(identity.get("name"))
            if identity_id in identity_ids or name.casefold() in names:
                raise ValueError("Gallery identity names and IDs must be unique")
            identity_ids.add(identity_id)
            names.add(name.casefold())
            rows = identity.get("samples")
            if not isinstance(rows, list) or not rows or len(rows) > _MAX_SAMPLES:
                raise ValueError("Gallery sample count is invalid")
            sample_ids = set()
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("id"), str):
                    raise ValueError("Gallery sample record is invalid")
                if row["id"] in sample_ids:
                    raise ValueError("Gallery sample IDs must be unique")
                sample_ids.add(row["id"])
                values = row.get("embedding")
                if not isinstance(values, list) or not values:
                    raise ValueError("Gallery embedding is invalid")
                vector = np.asarray(values, dtype=np.float64)
                if vector.ndim != 1 or not np.isfinite(vector).all():
                    raise ValueError("Gallery embedding is invalid")
                norm = float(np.linalg.norm(vector))
                if not math.isfinite(norm) or norm < 1e-12:
                    raise ValueError("Gallery embedding norm is invalid")
                if dimension is not None and dimension != vector.size:
                    raise ValueError("Gallery embedding dimensions differ")
                dimension = vector.size
                if abs(norm - 1) > 1e-3:
                    raise ValueError("Gallery embeddings must be normalized")
                samples += 1
        recorded = data.get("dimension")
        if recorded != dimension:
            raise ValueError("Gallery model dimension does not match samples")
        if not isinstance(data.get("recognition"), dict) or not re.fullmatch(
            r"[a-f0-9]{64}", str(data["recognition"].get("sha256", ""))
        ):
            raise ValueError("Gallery recognition model provenance is invalid")
        if not re.fullmatch(r"[a-f0-9]{64}", str(data["detector"].get("sha256", ""))):
            raise ValueError("Gallery detector model provenance is invalid")
        if samples > _MAX_GALLERY_SAMPLES:
            raise ValueError("Gallery has too many samples")
        if dimension is not None and dimension > 4096:
            raise ValueError("Gallery embedding dimension is too large")
        if samples * (dimension or 0) > _MAX_EMBEDDING_VALUES:
            raise ValueError("Gallery has too many embedding values")
        for key in ("detector", "recognition"):
            model_path = data[key].get("path")
            if not isinstance(model_path, str) or not Path(model_path).is_absolute():
                raise ValueError("Gallery model path is invalid")
        for key in ("detector_model_id", "recognition_model_id"):
            value = data.get(key)
            if value is not None and (not isinstance(value, str) or not value or len(value) > 128):
                raise ValueError("Gallery model reference is invalid")

    def _save(self, gallery_id: str, catalog: dict[str, Any]) -> None:
        self._validate_catalog(catalog, gallery_id)
        exported = self._v1(catalog)
        directory = self._dir(gallery_id)
        previous = self._catalog_cache.get(gallery_id)
        self._verified_exports.pop(gallery_id, None)
        _atomic_json(directory / "gallery-v1.json", exported)
        try:
            _atomic_json(directory / "catalog.json", catalog)
        except BaseException:
            self._catalog_cache.pop(gallery_id, None)
            if previous is not None:
                try:
                    self._repair_export(directory, previous[5], previous[:5])
                except BaseException:
                    pass
            raise
        stat = (directory / "catalog.json").stat()
        self._catalog_cache[gallery_id] = (
            stat.st_dev,
            stat.st_ino,
            stat.st_size,
            stat.st_mtime_ns,
            stat.st_ctime_ns,
            copy.deepcopy(catalog),
        )
        self._verified_exports[gallery_id] = (
            self._file_fingerprint(directory / "catalog.json"),
            self._file_fingerprint(directory / "gallery-v1.json"),
        )

    @staticmethod
    def _v1(catalog: dict[str, Any]) -> dict[str, Any]:
        exported = []
        for identity in catalog["identities"]:
            vectors = np.asarray(
                [row["embedding"] for row in identity["samples"]], dtype=np.float64
            )
            centroid = vectors.mean(axis=0)
            norm = float(np.linalg.norm(centroid))
            if not math.isfinite(norm) or norm < 1e-12:
                raise ValueError("Identity samples have no stable centroid")
            centroid /= norm
            exported.append(
                {"name": identity["name"], "embedding": centroid.astype(float).tolist()}
            )
        return {"version": 1, "identities": exported}

    @staticmethod
    def _metadata(catalog: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": catalog["id"],
            "name": catalog["name"],
            "detector_model_id": catalog.get("detector_model_id"),
            "recognition_model_id": catalog.get("recognition_model_id"),
            "detector_sha256": catalog["detector"]["sha256"],
            "recognition_sha256": catalog["recognition"]["sha256"],
            "dimension": catalog["dimension"],
            "identity_count": len(catalog["identities"]),
            "sample_count": sum(len(item["samples"]) for item in catalog["identities"]),
        }

    @_serialized
    def list_galleries(self) -> dict[str, Any]:
        result = []
        errors = []
        for path in sorted(self.root.iterdir()):
            if (
                path.is_dir()
                and re.fullmatch(r"[a-f0-9]{32}", path.name)
                and (path / "catalog.json").is_file()
            ):
                try:
                    result.append(self._metadata(self._load(path.name)))
                except ValueError:
                    errors.append({"gallery_id": path.name, "error": "Gallery catalog is invalid"})
        response: dict[str, Any] = {"galleries": result}
        if errors:
            response["error"] = "One or more face galleries could not be loaded"
            response["errors"] = errors
        return response

    @_serialized
    def get_gallery(self, gallery_id: str) -> dict[str, Any]:
        return self._metadata(self._load(gallery_id))

    @_serialized
    def descriptor(self, gallery_id: str) -> dict[str, Any]:
        """Return one metadata-only virtual classifier descriptor."""
        catalog = self._load(gallery_id)
        return {
            **self._metadata(catalog),
            "descriptor_id": f"gallery-{gallery_id}",
            "model_type": "face_gallery",
            "classes": [identity["name"] for identity in catalog["identities"]],
        }

    @_serialized
    def create_gallery(
        self,
        name: str,
        detector_path: str | Path,
        recognition_path: str | Path,
        *,
        detector_model_id: str | None = None,
        recognition_model_id: str | None = None,
    ) -> dict[str, Any]:
        name = _clean_name(name)
        if len(self.list_galleries()["galleries"]) >= _MAX_GALLERIES:
            raise ValueError("Gallery limit reached")
        detector, recognition = Path(detector_path), Path(recognition_path)
        if not detector.is_file() or not recognition.is_file():
            raise VisionUnavailable(
                "model_missing", "Select local detector and recognition models."
            )
        gallery_id = uuid.uuid4().hex
        directory = self.root / gallery_id
        directory.mkdir()
        detector_hash, recognition_hash = _sha256(detector), _sha256(recognition)
        catalog = {
            "version": 1,
            "id": gallery_id,
            "name": name,
            "detector_model_id": detector_model_id,
            "recognition_model_id": recognition_model_id,
            "detector": {
                "sha256": detector_hash,
                "filename": detector.name,
                "path": str(detector.resolve()),
            },
            "recognition": {
                "sha256": recognition_hash,
                "filename": recognition.name,
                "path": str(recognition.resolve()),
            },
            "dimension": None,
            "identities": [],
        }
        try:
            self._save(gallery_id, catalog)
        except BaseException:
            try:
                (directory / "catalog.json").unlink(missing_ok=True)
                (directory / "gallery-v1.json").unlink(missing_ok=True)
                directory.rmdir()
            except OSError:
                pass
            raise
        self._remember_model(detector, detector_hash)
        self._remember_model(recognition, recognition_hash)
        return self._metadata(catalog)

    @staticmethod
    def _model_fingerprint(path: Path) -> tuple[int, int, int, int, int]:
        stat = path.stat()
        return (
            stat.st_dev,
            stat.st_ino,
            stat.st_size,
            stat.st_mtime_ns,
            stat.st_ctime_ns,
        )

    def _remember_model(self, path: Path, digest: str) -> None:
        self._verified_models[str(path.resolve())] = (*self._model_fingerprint(path), digest)

    def _verify_model(self, path: Path, expected: str, *, force: bool = False) -> bool:
        resolved = str(path.resolve())
        try:
            fingerprint = self._model_fingerprint(path)
        except OSError:
            return False
        cached = self._verified_models.get(resolved)
        if not force and cached is not None and cached[:5] == fingerprint:
            return cached[5] == expected
        try:
            digest = _sha256(path)
        except OSError:
            return False
        self._verified_models[resolved] = (*fingerprint, digest)
        return digest == expected

    @_serialized
    def rename_gallery(self, gallery_id: str, name: str) -> dict[str, Any]:
        catalog = self._load(gallery_id, copy_data=True)
        catalog["name"] = _clean_name(name)
        self._save(gallery_id, catalog)
        return self._metadata(catalog)

    @_serialized
    def delete_gallery(self, gallery_id: str) -> None:
        directory = self._dir(gallery_id)
        if any(
            path.name not in {"catalog.json", "gallery-v1.json"} for path in directory.iterdir()
        ):
            raise ValueError("Gallery storage contains unexpected files")
        for name in ("catalog.json", "gallery-v1.json"):
            (directory / name).unlink(missing_ok=True)
        directory.rmdir()
        self._catalog_cache.pop(gallery_id, None)
        self._verified_exports.pop(gallery_id, None)

    @_serialized
    def gallery_path(self, gallery_id: str) -> Path:
        """Return managed v1 gallery path for trusted local inference configuration."""
        self._load(gallery_id)
        return self._dir(gallery_id) / "gallery-v1.json"

    def _config(self, gallery_id: str, *, verify_models: bool) -> dict[str, str | None]:
        catalog = self._load(gallery_id)
        detector = Path(catalog["detector"]["path"])
        recognition = Path(catalog["recognition"]["path"])
        if (
            not detector.is_file()
            or not recognition.is_file()
            or not self._verify_model(detector, catalog["detector"]["sha256"], force=verify_models)
            or not self._verify_model(
                recognition, catalog["recognition"]["sha256"], force=verify_models
            )
        ):
            raise VisionUnavailable(
                "model_missing", "A model linked to this gallery changed or is unavailable."
            )
        return {
            "recognition_model": str(recognition),
            "identity_gallery": str(self.gallery_path(gallery_id)),
            "detector_model_id": catalog.get("detector_model_id"),
            "recognition_model_id": catalog.get("recognition_model_id"),
        }

    @_serialized
    def config(self, gallery_id: str, *, verify_models: bool = False) -> dict[str, str | None]:
        """Return local paths, optionally hashing model files despite cached fingerprints."""
        return self._config(gallery_id, verify_models=verify_models)

    @_serialized
    def model_references(self, model_id: str | None) -> list[dict[str, str]]:
        if model_id is None:
            return []
        galleries = self.list_galleries()
        if galleries.get("errors"):
            raise RuntimeError("Cannot verify model references: unreadable face gallery")
        return [
            {"gallery_id": item["id"], "gallery_name": item["name"]}
            for item in galleries["galleries"]
            if model_id in (item["detector_model_id"], item["recognition_model_id"])
        ]

    @_serialized
    def list_identities(self, gallery_id: str) -> dict[str, Any]:
        catalog = self._load(gallery_id)
        return {
            "gallery_id": gallery_id,
            "identities": [
                {
                    "id": item["id"],
                    "name": item["name"],
                    "sample_count": len(item["samples"]),
                    "samples": [{"id": sample["id"]} for sample in item["samples"]],
                }
                for item in catalog["identities"]
            ],
        }

    @_serialized
    def snapshot(self, gallery_id: str) -> dict[str, Any]:
        """Return gallery metadata and identity details from one catalog read."""
        catalog = self._load(gallery_id)
        return {
            "gallery": self._metadata(catalog),
            "identities": [
                {
                    "id": item["id"],
                    "name": item["name"],
                    "sample_count": len(item["samples"]),
                    "samples": [{"id": sample["id"]} for sample in item["samples"]],
                }
                for item in catalog["identities"]
            ],
        }

    @_serialized
    def rename_identity(self, gallery_id: str, identity_id: str, name: str) -> dict[str, Any]:
        catalog = self._load(gallery_id, copy_data=True)
        name = _clean_name(name)
        if any(
            item["id"] != identity_id and item["name"].casefold() == name.casefold()
            for item in catalog["identities"]
        ):
            raise ValueError("Identity name already exists")
        identity = self._identity(catalog, identity_id)
        identity["name"] = name
        self._save(gallery_id, catalog)
        return {"id": identity["id"], "name": name, "sample_count": len(identity["samples"])}

    @_serialized
    def delete_identity(self, gallery_id: str, identity_id: str) -> None:
        catalog = self._load(gallery_id, copy_data=True)
        self._identity(catalog, identity_id)
        catalog["identities"] = [
            item for item in catalog["identities"] if item["id"] != identity_id
        ]
        self._recompute_dimension(catalog)
        self._save(gallery_id, catalog)

    @staticmethod
    def _identity(catalog: dict[str, Any], identity_id: str) -> dict[str, Any]:
        for item in catalog["identities"]:
            if item["id"] == identity_id:
                return item
        raise ValueError("Unknown identity")

    @_serialized
    def delete_sample(self, gallery_id: str, identity_id: str, sample_id: str) -> dict[str, Any]:
        catalog = self._load(gallery_id, copy_data=True)
        identity = self._identity(catalog, identity_id)
        if not any(row["id"] == sample_id for row in identity["samples"]):
            raise ValueError("Unknown sample")
        identity["samples"] = [row for row in identity["samples"] if row["id"] != sample_id]
        if not identity["samples"]:
            catalog["identities"].remove(identity)
        self._recompute_dimension(catalog)
        self._save(gallery_id, catalog)
        return {
            "gallery_id": gallery_id,
            "identity_id": identity_id,
            "sample_count": len(identity["samples"]),
        }

    @staticmethod
    def _recompute_dimension(catalog: dict[str, Any]) -> None:
        dimensions = {
            len(sample["embedding"]) for item in catalog["identities"] for sample in item["samples"]
        }
        catalog["dimension"] = next(iter(dimensions), None)

    @_enrollment_slot
    def analyze(self, gallery_id: str, image_bytes: bytes, roi=None) -> dict[str, Any]:
        """Detect and embed faces without changing gallery storage."""
        catalog = self._load(gallery_id, copy_data=True)
        if (
            not isinstance(image_bytes, (bytes, bytearray, memoryview))
            or not 1 <= len(image_bytes) <= _MAX_IMAGE_BYTES
        ):
            raise ValueError("Image must be between 1 byte and 16 MiB")
        dimensions = _encoded_dimensions(image_bytes)
        if (
            dimensions is None
            or min(dimensions) < 1
            or dimensions[0] * dimensions[1] > _MAX_IMAGE_PIXELS
        ):
            raise ValueError("Upload must be a valid image under 24 megapixels")
        image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None or image.ndim != 3:
            raise ValueError("Upload must be a valid color image")
        height, width = image.shape[:2]
        if width * height > _MAX_IMAGE_PIXELS:
            raise ValueError("Decoded image exceeds 24 megapixels")
        left, top, right, bottom = 0, 0, width, height
        if roi is not None:
            if not isinstance(roi, (list, tuple)) or len(roi) != 4:
                raise ValueError("ROI must contain normalized x, y, width and height")
            if any(type(value) not in (int, float) or not math.isfinite(value) for value in roi):
                raise ValueError("ROI values must be finite numbers")
            x, y, rw, rh = map(float, roi)
            if x < 0 or y < 0 or rw <= 0 or rh <= 0 or x + rw > 1 or y + rh > 1:
                raise ValueError("ROI must fit within normalized image bounds")
            left, top = int(x * width), int(y * height)
            right, bottom = (
                min(width, int(math.ceil((x + rw) * width))),
                min(height, int(math.ceil((y + rh) * height))),
            )
            if right <= left or bottom <= top:
                raise ValueError("ROI is empty")
        crop = image[top:bottom, left:right]
        detector, recognition = (
            Path(catalog["detector"]["path"]),
            Path(catalog["recognition"]["path"]),
        )
        if (
            not detector.is_file()
            or not recognition.is_file()
            or not self._verify_model(detector, catalog["detector"]["sha256"])
            or not self._verify_model(recognition, catalog["recognition"]["sha256"])
        ):
            raise VisionUnavailable(
                "model_missing", "A model linked to this gallery changed or is unavailable."
            )
        model_key = (
            str(detector.resolve()),
            catalog["detector"]["sha256"],
            str(recognition.resolve()),
            catalog["recognition"]["sha256"],
        )
        cached = self._analysis_models
        if cached is None or cached[0] != model_key:
            try:
                library = importlib.import_module("insightface.model_zoo")
                detector_model = library.get_model(
                    str(detector), providers=["CPUExecutionProvider"], download=False
                )
                recognition_model = library.get_model(
                    str(recognition), providers=["CPUExecutionProvider"], download=False
                )
                align = importlib.import_module("insightface.utils.face_align")
            except ImportError as error:
                raise VisionUnavailable(
                    "dependency_missing", "Install spyder-cctv[insightface] in this environment."
                ) from error
            if (
                detector_model is None
                or detector_model.taskname != "detection"
                or recognition_model is None
                or recognition_model.taskname != "recognition"
            ):
                raise VisionUnavailable(
                    "model_incompatible", "Select compatible local InsightFace models."
                )
            detector_model.prepare(ctx_id=-1, input_size=(640, 640), det_thresh=0.5)
            self._analysis_models = (model_key, detector_model, recognition_model, align)
        else:
            _, detector_model, recognition_model, align = cached
        try:
            boxes, landmarks = detector_model.detect(crop, max_num=0)
            if boxes is None:
                boxes = np.empty((0, 5), dtype=np.float32)
            boxes = np.asarray(boxes)
            if boxes.size == 0:
                boxes = np.empty((0, 5), dtype=np.float32)
            if (
                boxes.ndim != 2
                or boxes.shape[1] < 4
                or not np.isfinite(boxes[:, :4]).all()
                or np.any(boxes[:, 2] <= boxes[:, 0])
                or np.any(boxes[:, 3] <= boxes[:, 1])
            ):
                raise VisionUnavailable("detection_failed", "Detector returned invalid face boxes.")
            boxes = boxes.copy()
            crop_height, crop_width = crop.shape[:2]
            boxes[:, 0] = np.clip(boxes[:, 0], 0, crop_width)
            boxes[:, 1] = np.clip(boxes[:, 1], 0, crop_height)
            boxes[:, 2] = np.clip(boxes[:, 2], 0, crop_width)
            boxes[:, 3] = np.clip(boxes[:, 3], 0, crop_height)
            if np.any(boxes[:, 2] <= boxes[:, 0]) or np.any(boxes[:, 3] <= boxes[:, 1]):
                raise VisionUnavailable(
                    "detection_failed", "Detector returned boxes outside the analyzed image."
                )
            if len(boxes) > 16:
                boxes = boxes[:16]
            if landmarks is None:
                if len(boxes):
                    raise VisionUnavailable(
                        "alignment_failed", "Detector did not return five-point face landmarks."
                    )
                landmarks = np.empty((0, 5, 2), dtype=np.float32)
            landmarks = np.asarray(landmarks)
            if (
                landmarks.ndim != 3
                or landmarks.shape[1:] != (5, 2)
                or len(landmarks) < len(boxes)
                or not np.isfinite(landmarks[: len(boxes)]).all()
            ):
                raise VisionUnavailable(
                    "alignment_failed", "Detector returned invalid face landmarks."
                )
            faces = []
            for index, row in enumerate(boxes):
                candidate = self._candidate(row, index)
                x1, y1, x2, y2 = candidate["box"]
                x1, y1, x2, y2 = x1 + left, y1 + top, x2 + left, y2 + top
                candidate["bbox"] = [
                    max(0, x1 / width),
                    max(0, y1 / height),
                    min(1, x2 / width),
                    min(1, y2 / height),
                ]
                face_thumb = image[
                    max(0, int(y1)) : min(height, int(math.ceil(y2))),
                    max(0, int(x1)) : min(width, int(math.ceil(x2))),
                ]
                if face_thumb.size:
                    scale = min(1.0, 160 / max(face_thumb.shape[:2]))
                    if scale < 1:
                        face_thumb = cv2.resize(
                            face_thumb, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA
                        )
                ok, thumb = cv2.imencode(".jpg", face_thumb)
                candidate["thumbnail"] = (
                    "data:image/jpeg;base64," + base64.b64encode(thumb).decode("ascii")
                    if ok
                    else None
                )
                if landmarks is None or index >= len(landmarks):
                    raise VisionUnavailable(
                        "alignment_failed", "Detector did not return five-point face landmarks."
                    )
                try:
                    aligned = align.norm_crop(crop, landmarks[index], image_size=112)
                    features = np.asarray(
                        recognition_model.get_feat([aligned]), dtype=np.float64
                    ).reshape(-1)
                except Exception as error:
                    raise VisionUnavailable(
                        "recognition_failed", "Could not align or embed detected face."
                    ) from error
                norm = float(np.linalg.norm(features)) if features.size else 0
                if (
                    not 1 <= features.size <= 4096
                    or not np.isfinite(features).all()
                    or not math.isfinite(norm)
                    or norm < 1e-12
                ):
                    raise VisionUnavailable(
                        "recognition_failed", "Recognition model returned invalid features."
                    )
                features /= norm
                if catalog["dimension"] is not None and catalog["dimension"] != features.size:
                    raise ValueError("Embedding dimension does not match gallery recognition model")
                candidate["embedding"] = features.astype(float).tolist()
                candidate["confidence"] = candidate.pop("score")
                candidate.pop("box", None)
                faces.append(candidate)
            preview_image = image
            scale = min(1.0, 1280 / max(image.shape[:2]))
            if scale < 1:
                preview_image = cv2.resize(
                    image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA
                )
            ok, preview = cv2.imencode(".jpg", preview_image)
            if not ok:
                raise ValueError("Could not encode review preview")
            return {
                "preview": "data:image/jpeg;base64," + base64.b64encode(preview).decode("ascii"),
                "width": width,
                "height": height,
                "faces": faces,
                "_provenance": self._review_provenance(catalog),
            }
        finally:
            detector_model = recognition_model = None

    @_enrollment_slot
    def enroll_embeddings(
        self, gallery_id: str, identity_name: str, embeddings: list[list[float]]
    ) -> dict[str, Any]:
        """Validate all reviewed embeddings, then save gallery once."""
        catalog = self._load(gallery_id, copy_data=True)
        name = _clean_name(identity_name)
        if not isinstance(embeddings, list) or not 1 <= len(embeddings) <= 20:
            raise ValueError("Select between 1 and 20 reviewed faces")
        vectors = []
        for values in embeddings:
            vector = np.asarray(values, dtype=np.float64)
            norm = float(np.linalg.norm(vector)) if vector.ndim == 1 and vector.size else 0
            if (
                vector.ndim != 1
                or not np.isfinite(vector).all()
                or not math.isfinite(norm)
                or norm < 1e-12
            ):
                raise ValueError("Reviewed face embedding is invalid")
            vector /= norm
            if catalog["dimension"] is not None and catalog["dimension"] != vector.size:
                raise ValueError("Embedding dimension does not match gallery recognition model")
            vectors.append(vector)
        matching = next(
            (item for item in catalog["identities"] if item["name"].casefold() == name.casefold()),
            None,
        )
        if matching is None and len(catalog["identities"]) >= _MAX_IDENTITIES:
            raise ValueError("Gallery identity limit reached")
        existing_samples = len(matching["samples"]) if matching else 0
        if existing_samples + len(vectors) > _MAX_SAMPLES:
            raise ValueError("Identity sample limit reached")
        total = sum(len(item["samples"]) for item in catalog["identities"])
        if total + len(vectors) > _MAX_GALLERY_SAMPLES:
            raise ValueError("Gallery sample limit reached")
        if matching is None:
            matching = {"id": uuid.uuid4().hex, "name": name, "samples": []}
            catalog["identities"].append(matching)
        for vector in vectors:
            matching["samples"].append(
                {"id": uuid.uuid4().hex, "embedding": vector.astype(float).tolist()}
            )
        catalog["dimension"] = int(vectors[0].size)
        self._config(gallery_id, verify_models=True)
        self._save(gallery_id, catalog)
        return {
            "gallery": self._metadata(catalog),
            "identity": {
                "id": matching["id"],
                "name": matching["name"],
                "sample_count": len(matching["samples"]),
            },
            "samples": [{"id": row["id"]} for row in matching["samples"][-len(vectors) :]],
        }

    @staticmethod
    def _review_provenance(catalog: dict[str, Any]) -> tuple[str | None, ...]:
        return (
            catalog.get("detector_model_id"),
            catalog.get("recognition_model_id"),
            catalog["detector"]["sha256"],
            catalog["recognition"]["sha256"],
        )

    @_serialized
    def close(self) -> None:
        self._analysis_models = None

    @_enrollment_slot
    def enroll(
        self,
        gallery_id: str,
        identity_name: str,
        image_bytes: bytes,
        detector_path: str | Path | None = None,
        recognition_path: str | Path | None = None,
        *,
        face_index: int | None = None,
    ) -> dict[str, Any]:
        catalog = self._load(gallery_id, copy_data=True)
        name = _clean_name(identity_name)
        if (detector_path is None) != (recognition_path is None):
            raise ValueError("Provide both model paths or use the gallery's stored models")
        detector = Path(detector_path or catalog["detector"]["path"])
        recognition = Path(recognition_path or catalog["recognition"]["path"])
        if not detector.is_file() or not recognition.is_file():
            raise VisionUnavailable(
                "model_missing", "Select local detector and recognition models."
            )
        if (
            _sha256(detector) != catalog["detector"]["sha256"]
            or _sha256(recognition) != catalog["recognition"]["sha256"]
        ):
            raise ValueError("Selected models do not match this gallery provenance")
        if (
            not isinstance(image_bytes, (bytes, bytearray, memoryview))
            or not 1 <= len(image_bytes) <= _MAX_IMAGE_BYTES
        ):
            raise ValueError("Image must be between 1 byte and 16 MiB")
        dimensions = _encoded_dimensions(image_bytes)
        if dimensions is None:
            raise ValueError("Upload must be a valid JPEG or PNG image")
        encoded_width, encoded_height = dimensions
        if (
            encoded_width < 1
            or encoded_height < 1
            or encoded_width * encoded_height > _MAX_IMAGE_PIXELS
        ):
            raise ValueError("Decoded image exceeds 24 megapixels")
        image_array = np.frombuffer(image_bytes, dtype=np.uint8)
        image = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
        if image is None or image.ndim != 3:
            raise ValueError("Upload must be a valid color image")
        height, width = image.shape[:2]
        if width < 1 or height < 1 or width * height > _MAX_IMAGE_PIXELS:
            raise ValueError("Decoded image exceeds 24 megapixels")
        try:
            library = importlib.import_module("insightface.model_zoo")
            align = importlib.import_module("insightface.utils.face_align")
        except ImportError as error:
            raise VisionUnavailable(
                "dependency_missing", "Install spyder-cctv[insightface] in this environment."
            ) from error
        detector_model = recognition_model = None
        try:
            detector_model = library.get_model(
                str(detector), providers=["CPUExecutionProvider"], download=False
            )
            recognition_model = library.get_model(
                str(recognition), providers=["CPUExecutionProvider"], download=False
            )
            if detector_model is None or detector_model.taskname != "detection":
                raise VisionUnavailable(
                    "model_incompatible", "Select a compatible InsightFace detection ONNX model."
                )
            if recognition_model is None or recognition_model.taskname != "recognition":
                raise VisionUnavailable(
                    "model_incompatible", "Select a compatible InsightFace recognition ONNX model."
                )
            detector_model.prepare(ctx_id=-1, input_size=(640, 640), det_thresh=0.5)
            boxes, landmarks = detector_model.detect(image, max_num=0)
            count = 0 if boxes is None else len(boxes)
            if count == 0:
                raise ValueError("No face detected")
            if face_index is None and count != 1:
                candidates = [self._candidate(row, index) for index, row in enumerate(boxes)]
                preview = image.copy()
                scale = min(1, 640 / max(preview.shape[:2]))
                if scale < 1:
                    preview = cv2.resize(preview, None, fx=scale, fy=scale)
                for candidate in candidates:
                    x1, y1, x2, y2 = (round(value * scale) for value in candidate["box"])
                    cv2.rectangle(preview, (x1, y1), (x2, y2), (30, 30, 210), 2)
                    cv2.putText(
                        preview,
                        str(candidate["index"] + 1),
                        (x1, max(18, y1)),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.7,
                        (127, 216, 247),
                        2,
                    )
                ok, encoded = cv2.imencode(".jpg", preview)
                return {
                    "needs_face_selection": True,
                    "candidates": candidates,
                    "preview": "data:image/jpeg;base64," + base64.b64encode(encoded).decode()
                    if ok
                    else None,
                }
            if face_index is None:
                face_index = 0
            if (
                isinstance(face_index, bool)
                or not isinstance(face_index, int)
                or not 0 <= face_index < count
            ):
                raise ValueError("Selected face index is invalid")
            if landmarks is None or face_index >= len(landmarks):
                raise VisionUnavailable(
                    "alignment_failed", "Detector did not return five-point face landmarks."
                )
            try:
                aligned = align.norm_crop(image, landmarks[face_index], image_size=112)
                features = np.asarray(
                    recognition_model.get_feat([aligned]), dtype=np.float64
                ).reshape(-1)
            except Exception as error:
                raise VisionUnavailable(
                    "recognition_failed", "Could not align or embed selected face."
                ) from error
            if features.size == 0 or not np.isfinite(features).all():
                raise VisionUnavailable(
                    "recognition_failed", "Recognition model returned invalid features."
                )
            norm = float(np.linalg.norm(features))
            if not math.isfinite(norm) or norm < 1e-12:
                raise VisionUnavailable(
                    "recognition_failed", "Recognition model returned zero features."
                )
            features /= norm
            if catalog["dimension"] is not None and catalog["dimension"] != features.size:
                raise ValueError("Embedding dimension does not match gallery recognition model")
        finally:
            if detector_model is not None:
                detector_model = None
            if recognition_model is not None:
                recognition_model = None
        matching = next(
            (item for item in catalog["identities"] if item["name"].casefold() == name.casefold()),
            None,
        )
        if matching is None:
            if len(catalog["identities"]) >= _MAX_IDENTITIES:
                raise ValueError("Gallery identity limit reached")
            matching = {"id": uuid.uuid4().hex, "name": name, "samples": []}
            catalog["identities"].append(matching)
        if len(matching["samples"]) >= _MAX_SAMPLES:
            raise ValueError("Identity sample limit reached")
        sample = {"id": uuid.uuid4().hex, "embedding": features.astype(float).tolist()}
        matching["samples"].append(sample)
        catalog["dimension"] = int(features.size)
        self._save(gallery_id, catalog)
        return {
            "needs_face_selection": False,
            "gallery": self._metadata(catalog),
            "identity": {
                "id": matching["id"],
                "name": matching["name"],
                "sample_count": len(matching["samples"]),
            },
            "sample": {"id": sample["id"]},
            "face": self._candidate(boxes[face_index], face_index),
        }

    @staticmethod
    def _candidate(row: Any, index: int) -> dict[str, Any]:
        values = [float(value) for value in row[:5]]
        return {"index": index, "box": values[:4], "score": values[4] if len(values) > 4 else None}

    @_serialized
    def export_gallery(self, gallery_id: str) -> dict[str, Any]:
        return self._v1(self._load(gallery_id))
