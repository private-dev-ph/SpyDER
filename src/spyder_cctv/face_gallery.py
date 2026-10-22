"""Local, atomic face enrollment and identity-gallery storage."""

from __future__ import annotations

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
        self._verified_models: dict[str, tuple[int, int, str]] = {}
        self._catalog_cache: dict[str, tuple[int, int, dict[str, Any]]] = {}
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
            if cached is not None and cached[:2] == (stat.st_size, stat.st_mtime_ns):
                return copy.deepcopy(cached[2]) if copy_data else cached[2]
            with path.open("r", encoding="utf-8") as stream:
                data = json.load(
                    stream,
                    parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
                )
            self._validate_catalog(data, gallery_id)
            exported_path = directory / "gallery-v1.json"
            try:
                with exported_path.open("r", encoding="utf-8") as stream:
                    exported = json.load(
                        stream,
                        parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
                    )
            except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError):
                exported = None
            expected = self._v1(data)
            if exported != expected:
                _atomic_json(exported_path, expected)
            stat = path.stat()
            self._catalog_cache[gallery_id] = (
                stat.st_size,
                stat.st_mtime_ns,
                copy.deepcopy(data),
            )
            return data
        except (OSError, UnicodeError, json.JSONDecodeError, TypeError, OverflowError) as error:
            raise ValueError("Gallery catalog is invalid") from error

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
        _atomic_json(directory / "catalog.json", catalog)
        _atomic_json(directory / "gallery-v1.json", exported)
        stat = (directory / "catalog.json").stat()
        self._catalog_cache[gallery_id] = (
            stat.st_size,
            stat.st_mtime_ns,
            copy.deepcopy(catalog),
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
    def list_galleries(self) -> dict[str, list[dict[str, Any]]]:
        result = []
        for path in sorted(self.root.iterdir()):
            if (
                path.is_dir()
                and re.fullmatch(r"[a-f0-9]{32}", path.name)
                and (path / "catalog.json").is_file()
            ):
                result.append(self._metadata(self._load(path.name)))
        return {"galleries": result}

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

    def _remember_model(self, path: Path, digest: str) -> None:
        stat = path.stat()
        self._verified_models[str(path.resolve())] = (stat.st_size, stat.st_mtime_ns, digest)

    def _verify_model(self, path: Path, expected: str) -> bool:
        resolved = str(path.resolve())
        try:
            stat = path.stat()
        except OSError:
            return False
        cached = self._verified_models.get(resolved)
        fingerprint = (stat.st_size, stat.st_mtime_ns)
        if cached is not None and cached[:2] == fingerprint:
            return cached[2] == expected
        digest = _sha256(path)
        self._verified_models[resolved] = (stat.st_size, stat.st_mtime_ns, digest)
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
        for name in ("catalog.json", "gallery-v1.json"):
            (directory / name).unlink(missing_ok=True)
        directory.rmdir()

    @_serialized
    def gallery_path(self, gallery_id: str) -> Path:
        """Return managed v1 gallery path for trusted local inference configuration."""
        self._load(gallery_id)
        return self._dir(gallery_id) / "gallery-v1.json"

    @_serialized
    def config(self, gallery_id: str) -> dict[str, str | None]:
        """Return trusted, local paths for workflow recognition configuration."""
        catalog = self._load(gallery_id)
        detector = Path(catalog["detector"]["path"])
        recognition = Path(catalog["recognition"]["path"])
        if (
            not detector.is_file()
            or not recognition.is_file()
            or not self._verify_model(detector, catalog["detector"]["sha256"])
            or not self._verify_model(recognition, catalog["recognition"]["sha256"])
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
    def model_references(self, model_id: str | None) -> list[dict[str, str]]:
        if model_id is None:
            return []
        return [
            {"gallery_id": item["id"], "gallery_name": item["name"]}
            for item in self.list_galleries()["galleries"]
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
                return {"needs_face_selection": True, "candidates": candidates}
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
