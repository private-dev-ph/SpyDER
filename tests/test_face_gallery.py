"""Tests for local face gallery storage and enrollment."""

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from spyder_cctv.cv.engines import _load_identity_gallery
from spyder_cctv.cv.contracts import VisionUnavailable
from spyder_cctv.face_gallery import FaceEnrollmentService


class _Detector:
    taskname = "detection"

    def prepare(self, **kwargs):
        pass

    def detect(self, image, max_num=0):
        return (
            np.asarray([[1, 2, 40, 48, 0.98], [50, 5, 90, 52, 0.9]], dtype=np.float32),
            np.asarray(
                [
                    [[5, 10], [30, 10], [18, 22], [8, 35], [28, 35]],
                    [[55, 12], [80, 12], [68, 24], [58, 37], [78, 37]],
                ],
                dtype=np.float32,
            ),
        )


class _Recognizer:
    taskname = "recognition"

    def get_feat(self, images):
        return np.asarray([[3.0, 4.0]], dtype=np.float32)


class _ModelZoo:
    @staticmethod
    def get_model(path, **kwargs):
        return _Detector() if "detector" in path else _Recognizer()


class _Align:
    last_landmarks = None

    @classmethod
    def norm_crop(cls, image, landmarks, image_size):
        assert image_size == 112
        cls.last_landmarks = np.asarray(landmarks).copy()
        return np.zeros((112, 112, 3), dtype=np.uint8)


def _setup(tmp_path, monkeypatch):
    detector, recognition = tmp_path / "detector.onnx", tmp_path / "recognition.onnx"
    detector.write_bytes(b"detector weights")
    recognition.write_bytes(b"recognition weights")
    monkeypatch.setattr(
        "spyder_cctv.face_gallery.importlib.import_module",
        lambda name: _ModelZoo if name == "insightface.model_zoo" else _Align,
    )
    service = FaceEnrollmentService(tmp_path / "galleries")
    gallery = service.create_gallery(
        "Office", detector, recognition, detector_model_id="d1", recognition_model_id="r1"
    )
    ok, encoded = cv2.imencode(".jpg", np.zeros((128, 128, 3), dtype=np.uint8))
    assert ok
    return service, gallery, detector, recognition, encoded.tobytes()


def test_gallery_crud_exports_centroid_and_metadata_hides_vectors(tmp_path, monkeypatch):
    service, gallery, detector, recognition, image = _setup(tmp_path, monkeypatch)
    ambiguous = service.enroll(gallery["id"], "Ada", image, detector, recognition)
    assert ambiguous["needs_face_selection"] is True
    assert [candidate["index"] for candidate in ambiguous["candidates"]] == [0, 1]
    assert service.list_identities(gallery["id"])["identities"] == []

    enrolled = service.enroll(gallery["id"], "Ada", image, face_index=1)
    assert enrolled["needs_face_selection"] is False
    assert enrolled["face"]["index"] == 1
    assert np.array_equal(
        _Align.last_landmarks,
        np.asarray([[55, 12], [80, 12], [68, 24], [58, 37], [78, 37]], dtype=np.float32),
    )
    assert enrolled["identity"]["sample_count"] == 1
    assert "embedding" not in json.dumps(service.list_galleries())
    assert "embedding" not in json.dumps(service.list_identities(gallery["id"]))
    assert np.allclose(
        service.export_gallery(gallery["id"])["identities"][0]["embedding"], [0.6, 0.8]
    )

    renamed = service.rename_identity(gallery["id"], enrolled["identity"]["id"], "Ada Lovelace")
    assert renamed["name"] == "Ada Lovelace"
    service.delete_sample(gallery["id"], renamed["id"], enrolled["sample"]["id"])
    assert service.export_gallery(gallery["id"]) == {"version": 1, "identities": []}
    assert _load_identity_gallery(service.gallery_path(gallery["id"])) == []
    service.delete_gallery(gallery["id"])
    assert gallery["id"] not in service._catalog_cache
    assert service.list_galleries() == {"galleries": []}


def test_gallery_rejects_changed_models_and_bad_images(tmp_path, monkeypatch):
    service, gallery, detector, recognition, image = _setup(tmp_path, monkeypatch)
    detector.write_bytes(b"changed detector")
    with pytest.raises(ValueError, match="provenance"):
        service.enroll(gallery["id"], "Ada", image, detector, recognition, face_index=0)
    detector.write_bytes(b"detector weights")
    with pytest.raises(ValueError, match="valid JPEG or PNG image"):
        service.enroll(gallery["id"], "Ada", b"bad", detector, recognition, face_index=0)


def test_gallery_rejects_same_size_model_replacement_with_preserved_mtime(tmp_path, monkeypatch):
    import os

    service, gallery, detector, _, _ = _setup(tmp_path, monkeypatch)
    original_stat = detector.stat()
    detector.write_bytes(b"changed detector")
    assert detector.stat().st_size == original_stat.st_size
    os.utime(detector, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))

    with pytest.raises(VisionUnavailable) as error:
        service.config(gallery["id"], verify_models=True)
    assert getattr(error.value, "code", None) == "model_missing"


def test_gallery_config_reuses_model_hashes_until_forced_verification(tmp_path, monkeypatch):
    import os

    import spyder_cctv.face_gallery as module

    service, gallery, detector, _, _ = _setup(tmp_path, monkeypatch)
    service = FaceEnrollmentService(service.root)
    original_hash = module._sha256
    calls = []

    def count_hashes(path):
        calls.append(Path(path).name)
        return original_hash(path)

    monkeypatch.setattr(module, "_sha256", count_hashes)
    service.config(gallery["id"])
    service.config(gallery["id"])
    assert len(calls) == 2

    before = detector.stat()
    detector.write_bytes(b"changed detector")
    os.utime(detector, ns=(before.st_atime_ns, before.st_mtime_ns))
    with pytest.raises(VisionUnavailable) as error:
        service.config(gallery["id"], verify_models=True)
    assert error.value.code == "model_missing"


def test_gallery_snapshot_returns_metadata_and_identity_samples_without_vectors(
    tmp_path, monkeypatch
):
    service, gallery, _, _, image = _setup(tmp_path, monkeypatch)
    enrolled = service.enroll(gallery["id"], "Ada", image, face_index=0)

    snapshot = service.snapshot(gallery["id"])

    assert snapshot["gallery"]["id"] == gallery["id"]
    assert snapshot["gallery"]["identity_count"] == 1
    assert snapshot["identities"] == [
        {
            "id": enrolled["identity"]["id"],
            "name": "Ada",
            "sample_count": 1,
            "samples": [{"id": enrolled["sample"]["id"]}],
        }
    ]
    assert "embedding" not in json.dumps(snapshot)


def test_corrupt_catalog_does_not_hide_healthy_galleries_or_allow_model_deletion(
    tmp_path, monkeypatch
):
    service, healthy, _, _, _ = _setup(tmp_path, monkeypatch)
    corrupt_id = "a" * 32
    corrupt_dir = service.root / corrupt_id
    corrupt_dir.mkdir()
    corrupt_catalog = corrupt_dir / "catalog.json"
    corrupt_bytes = b'{"version":1,"id":"wrong","identities":[]}'
    corrupt_catalog.write_bytes(corrupt_bytes)

    result = service.list_galleries()

    assert [item["id"] for item in result["galleries"]] == [healthy["id"]]
    assert result["error"] == "One or more face galleries could not be loaded"
    assert result["errors"] == [
        {"gallery_id": corrupt_id, "error": "Gallery catalog is invalid"}
    ]
    assert corrupt_catalog.read_bytes() == corrupt_bytes
    with pytest.raises(RuntimeError, match="unreadable face gallery"):
        service.model_references("d1")


def test_gallery_reload_uses_changed_atomic_export(tmp_path, monkeypatch):
    service, gallery, detector, recognition, image = _setup(tmp_path, monkeypatch)
    service.enroll(gallery["id"], "Ada", image, detector, recognition, face_index=0)
    path = service.gallery_path(gallery["id"])
    before = path.read_text(encoding="utf-8")
    service.rename_identity(
        gallery["id"], service.list_identities(gallery["id"])["identities"][0]["id"], "Grace"
    )
    after = path.read_text(encoding="utf-8")
    assert before != after
    assert json.loads(after)["identities"][0]["name"] == "Grace"


def test_engine_hot_reloads_empty_gallery_as_unknown(tmp_path):
    import os
    from types import SimpleNamespace

    from spyder_cctv.cv.engines import InsightFaceEngine
    from spyder_cctv.cv.identity_stability import IdentityStabilizer

    path = tmp_path / "gallery.json"
    path.write_text(
        json.dumps({"version": 1, "identities": [{"name": "Ada", "embedding": [1.0, 0.0]}]}),
        encoding="utf-8",
    )

    class Detector:
        def detect(self, frame, max_num):
            return (
                np.asarray([[1, 2, 20, 24, 0.98]], dtype=np.float32),
                np.asarray([[[3, 5], [15, 5], [9, 12], [5, 19], [14, 19]]], dtype=np.float32),
            )

    class Recognizer:
        def get_feat(self, aligned_faces):
            return np.asarray([[1.0, 0.0]], dtype=np.float32)

    engine = InsightFaceEngine.__new__(InsightFaceEngine)
    engine.config = SimpleNamespace(max_detections=100, recognition_threshold=0.5)
    engine.model = Detector()
    engine.recognizer = Recognizer()
    engine.classifier = None
    engine.align = SimpleNamespace(
        norm_crop=lambda *args, **kwargs: np.zeros((112, 112, 3), np.uint8)
    )
    engine.gallery_path = path
    engine._gallery_fingerprint = engine._gallery_stat_fingerprint(path)
    engine.gallery = _load_identity_gallery(path)
    engine.identity_stabilizer = IdentityStabilizer(confirmations=1, switch_confirmations=1)
    frame = np.zeros((32, 32, 3), dtype=np.uint8)

    known = engine.infer(frame)[0]
    assert known.identity == "Ada" and known.identity_status == "known"

    path.write_text(json.dumps({"version": 1, "identities": []}), encoding="utf-8")
    os.utime(path, ns=(path.stat().st_atime_ns, engine._gallery_fingerprint[3] + 2_000_000_000))
    unknown = engine.infer(frame)[0]
    assert engine.gallery == []
    assert unknown.identity is None and unknown.identity_status == "unknown"


def test_engine_reloads_same_size_gallery_replacement_with_unchanged_mtime(tmp_path):
    import os
    from types import SimpleNamespace

    from spyder_cctv.cv.engines import InsightFaceEngine
    from spyder_cctv.cv.identity_stability import IdentityStabilizer

    path = tmp_path / "gallery.json"
    original = json.dumps(
        {"version": 1, "identities": [{"name": "Ada", "embedding": [1.0, 0.0]}]},
        separators=(",", ":"),
    )
    replacement = original.replace("Ada", "Eve")
    path.write_text(original, encoding="utf-8")

    class Detector:
        def detect(self, frame, max_num):
            return (
                np.asarray([[1, 2, 20, 24, 0.98]], dtype=np.float32),
                np.asarray([[[3, 5], [15, 5], [9, 12], [5, 19], [14, 19]]], dtype=np.float32),
            )

    engine = InsightFaceEngine.__new__(InsightFaceEngine)
    engine.config = SimpleNamespace(max_detections=100, recognition_threshold=0.5)
    engine.model = Detector()
    engine.recognizer = SimpleNamespace(get_feat=lambda _: np.asarray([[1.0, 0.0]]))
    engine.classifier = None
    engine.align = SimpleNamespace(norm_crop=lambda *args, **kwargs: np.zeros((112, 112, 3), np.uint8))
    engine.gallery_path = path
    engine._gallery_fingerprint = engine._gallery_stat_fingerprint(path)
    engine.gallery = _load_identity_gallery(path)
    engine.identity_stabilizer = IdentityStabilizer(confirmations=1, switch_confirmations=1)

    replacement_path = tmp_path / "replacement.json"
    replacement_path.write_text(replacement, encoding="utf-8")
    os.utime(replacement_path, ns=(path.stat().st_atime_ns, engine._gallery_fingerprint[3]))
    os.replace(replacement_path, path)

    result = engine.infer(np.zeros((32, 32, 3), dtype=np.uint8))[0]
    assert engine.gallery[0][0] == "Eve"
    assert result.identity == "Eve"


def test_oversized_png_is_rejected_from_header_before_decode(tmp_path, monkeypatch):
    service, gallery, detector, recognition, _ = _setup(tmp_path, monkeypatch)
    oversized = (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00\x00\x00\x0dIHDR"
        + (5000).to_bytes(4, "big")
        + (5000).to_bytes(4, "big")
        + b"\x08\x02\x00\x00\x00\x00\x00\x00\x00"
    )
    with pytest.raises(ValueError, match="24 megapixels"):
        service.enroll(gallery["id"], "Ada", oversized, detector, recognition, face_index=0)


def test_failed_export_publication_does_not_commit_catalog_mutation(tmp_path, monkeypatch):
    import spyder_cctv.face_gallery as module

    service, gallery, _, _, _ = _setup(tmp_path, monkeypatch)
    original_atomic_json = module._atomic_json

    def fail_export(path, data):
        if path.name == "gallery-v1.json":
            raise OSError("simulated interrupted publication")
        return original_atomic_json(path, data)

    monkeypatch.setattr(module, "_atomic_json", fail_export)
    with pytest.raises(OSError, match="interrupted"):
        service.rename_gallery(gallery["id"], "Renamed")
    monkeypatch.setattr(module, "_atomic_json", original_atomic_json)

    assert service.get_gallery(gallery["id"])["name"] == "Office"
    assert service.export_gallery(gallery["id"]) == {"version": 1, "identities": []}
    assert json.loads(service.gallery_path(gallery["id"]).read_text(encoding="utf-8")) == {
        "version": 1,
        "identities": [],
    }


def test_failed_catalog_publication_restores_export_and_repairs_after_restart(
    tmp_path, monkeypatch
):
    import spyder_cctv.face_gallery as module

    service, gallery, _, _, image = _setup(tmp_path, monkeypatch)
    enrolled = service.enroll(gallery["id"], "Ada", image, face_index=0)
    service.get_gallery(gallery["id"])
    original_atomic_json = module._atomic_json
    export_writes = 0

    def fail_catalog(path, data):
        if path.name == "catalog.json":
            raise OSError("simulated catalog publication failure")
        nonlocal export_writes
        if path.name == "gallery-v1.json":
            export_writes += 1
            if export_writes == 2:
                raise OSError("simulated export rollback failure")
        return original_atomic_json(path, data)

    monkeypatch.setattr(module, "_atomic_json", fail_catalog)
    with pytest.raises(OSError, match="catalog publication failure"):
        service.rename_identity(gallery["id"], enrolled["identity"]["id"], "Grace")
    monkeypatch.setattr(module, "_atomic_json", original_atomic_json)
    assert export_writes == 2
    service.get_gallery(gallery["id"])

    expected = {
        "version": 1,
        "identities": [{"name": "Ada", "embedding": [0.6, 0.8]}],
    }
    exported = service.gallery_path(gallery["id"]).read_text(encoding="utf-8")
    assert json.loads(exported) == expected

    restarted = FaceEnrollmentService(service.root)
    restarted_path = restarted.gallery_path(gallery["id"])
    assert json.loads(restarted_path.read_text(encoding="utf-8")) == expected


def test_cached_catalog_read_repairs_modified_managed_export(tmp_path, monkeypatch):
    service, gallery, _, _, image = _setup(tmp_path, monkeypatch)
    service.enroll(gallery["id"], "Ada", image, face_index=0)
    service.get_gallery(gallery["id"])
    path = service.gallery_path(gallery["id"])
    path.write_text('{"version":1,"identities":[]}', encoding="utf-8")

    service.config(gallery["id"])

    assert json.loads(path.read_text(encoding="utf-8")) == {
        "version": 1,
        "identities": [{"name": "Ada", "embedding": [0.6, 0.8]}],
    }
