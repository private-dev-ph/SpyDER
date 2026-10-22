"""Tests for local face gallery storage and enrollment."""

import json

import cv2
import numpy as np
import pytest

from spyder_cctv.cv.engines import _load_identity_gallery
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
    @staticmethod
    def norm_crop(image, landmarks, image_size):
        assert image_size == 112
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

    enrolled = service.enroll(gallery["id"], "Ada", image, detector, recognition, face_index=1)
    assert enrolled["needs_face_selection"] is False
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
    assert service.list_galleries() == {"galleries": []}


def test_gallery_rejects_changed_models_and_bad_images(tmp_path, monkeypatch):
    service, gallery, detector, recognition, image = _setup(tmp_path, monkeypatch)
    detector.write_bytes(b"changed detector")
    with pytest.raises(ValueError, match="provenance"):
        service.enroll(gallery["id"], "Ada", image, detector, recognition, face_index=0)
    detector.write_bytes(b"detector weights")
    with pytest.raises(ValueError, match="valid JPEG or PNG image"):
        service.enroll(gallery["id"], "Ada", b"bad", detector, recognition, face_index=0)


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


def test_engine_reloads_changed_gallery_and_accepts_empty_gallery(tmp_path):
    import os

    from spyder_cctv.cv.engines import InsightFaceEngine

    path = tmp_path / "gallery.json"
    path.write_text(
        json.dumps({"version": 1, "identities": [{"name": "Ada", "embedding": [1.0, 0.0]}]}),
        encoding="utf-8",
    )
    engine = InsightFaceEngine.__new__(InsightFaceEngine)
    engine.recognizer = object()
    engine.gallery_path = path
    engine._gallery_mtime_ns = path.stat().st_mtime_ns
    engine.gallery = _load_identity_gallery(path)
    path.write_text(json.dumps({"version": 1, "identities": []}), encoding="utf-8")
    os.utime(path, ns=(path.stat().st_atime_ns, engine._gallery_mtime_ns + 2_000_000_000))

    engine._reload_gallery_if_changed()
    assert engine.gallery == []


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


def test_catalog_read_repairs_interrupted_export_publication(tmp_path, monkeypatch):
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

    assert service.get_gallery(gallery["id"])["name"] == "Renamed"
    assert service.export_gallery(gallery["id"]) == {"version": 1, "identities": []}
    assert json.loads(service.gallery_path(gallery["id"]).read_text(encoding="utf-8")) == {
        "version": 1,
        "identities": [],
    }
