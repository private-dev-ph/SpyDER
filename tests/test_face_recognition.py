import json
from types import SimpleNamespace

import numpy as np
import pytest

from spyder_cctv.cv.contracts import VisionConfig, VisionUnavailable
from spyder_cctv.cv.engines import InsightFaceEngine, _load_identity_gallery


def test_local_gallery_validates_and_normalizes_vectors(tmp_path):
    path = tmp_path / "people.json"
    path.write_text(
        json.dumps({"version": 1, "identities": [{"name": "Ada", "embedding": [3, 4]}]})
    )
    gallery = _load_identity_gallery(path)
    assert gallery[0][0] == "Ada"
    assert np.allclose(gallery[0][1], [0.6, 0.8])


@pytest.mark.parametrize(
    "data",
    [
        {"version": 2, "identities": [{"name": "Ada", "embedding": [1]}]},
        {"version": 1, "identities": [{"name": "Ada", "embedding": [0]}]},
        {
            "version": 1,
            "identities": [{"name": "Ada", "embedding": [1]}, {"name": "Ada", "embedding": [1]}],
        },
        {
            "version": 1,
            "identities": [{"name": "Ada", "embedding": [1, 2]}, {"name": "Bob", "embedding": [1]}],
        },
        {"version": 1, "identities": [{"name": "Ada", "embedding": [float("nan")]}]},
    ],
)
def test_local_gallery_rejects_bad_schema_and_vectors(tmp_path, data):
    path = tmp_path / "people.json"
    path.write_text(json.dumps(data))
    with pytest.raises(VisionUnavailable) as error:
        _load_identity_gallery(path)
    assert error.value.code == "gallery_invalid"


def test_insightface_matches_aligned_local_embedding_and_applies_threshold(tmp_path, monkeypatch):
    detector_path, recognition_path, gallery_path = (
        tmp_path / name for name in ("det.onnx", "rec.onnx", "people.json")
    )
    detector_path.touch()
    recognition_path.touch()
    gallery_path.write_text(
        json.dumps({"version": 1, "identities": [{"name": "Ada", "embedding": [1, 0]}]})
    )
    calls = {}

    class Detector:
        taskname = "detection"

        def prepare(self, **kwargs):
            calls["prepare"] = kwargs

        def detect(self, frame, **kwargs):
            calls["frame"] = frame
            return np.array([[1, 2, 10, 12, 0.9]]), np.array(
                [[[2, 3], [8, 3], [5, 6], [3, 9], [7, 9]]]
            )

    class Recognizer:
        taskname = "recognition"
        vector = [2.0, 0.0]

        def get_feat(self, images):
            calls["images"] = images
            return np.array([self.vector], dtype=np.float32)

    def get_model(path, **kwargs):
        calls.setdefault("models", []).append((path, kwargs))
        return Detector() if path == str(detector_path) else Recognizer()

    def import_module(name):
        if name == "insightface.model_zoo":
            return SimpleNamespace(get_model=get_model)
        if name == "insightface.utils.face_align":
            return SimpleNamespace(
                norm_crop=lambda frame, points, image_size: (
                    calls.update(alignment=(frame, points, image_size))
                    or np.zeros((112, 112, 3), dtype=np.uint8)
                )
            )
        raise AssertionError(name)

    monkeypatch.setattr("spyder_cctv.cv.engines.importlib.import_module", import_module)
    config = VisionConfig(
        engine="insightface",
        model=str(detector_path),
        recognition_model=str(recognition_path),
        identity_gallery=str(gallery_path),
        recognition_threshold=0.65,
    )
    engine = InsightFaceEngine(config)
    frame = np.zeros((32, 32, 3), dtype=np.uint8)
    detection = engine.infer(frame)[0]
    assert detection.identity == "Ada" and detection.similarity == 1.0
    assert calls["alignment"][0] is frame and calls["alignment"][2] == 112
    assert calls["models"][0][1]["download"] is False
    engine.recognizer.vector = [0.0, 2.0]
    unknown = engine.infer(frame)[0]
    assert unknown.identity is None and unknown.similarity == 0.0
    engine.recognizer.vector = [1.0, 0.0, 0.0]
    with pytest.raises(VisionUnavailable) as error:
        engine.infer(frame)
    assert error.value.code == "model_incompatible"
    engine.close()


def test_insightface_keeps_face_unidentified_without_landmarks(tmp_path, monkeypatch):
    detector_path, recognition_path, gallery_path = (
        tmp_path / name for name in ("det.onnx", "rec.onnx", "people.json")
    )
    detector_path.touch()
    recognition_path.touch()
    gallery_path.write_text(
        json.dumps({"version": 1, "identities": [{"name": "Ada", "embedding": [1]}]})
    )

    class Detector:
        taskname = "detection"

        def prepare(self, **kwargs):
            pass

        def detect(self, frame, **kwargs):
            return np.array([[1, 2, 10, 12, 0.9]]), None

    class Recognizer:
        taskname = "recognition"

    monkeypatch.setattr(
        "spyder_cctv.cv.engines.importlib.import_module",
        lambda name: SimpleNamespace(
            get_model=lambda *args, **kwargs: Detector() if "det.onnx" in args[0] else Recognizer(),
            norm_crop=lambda *args, **kwargs: None,
        ),
    )
    engine = InsightFaceEngine(
        VisionConfig(
            engine="insightface",
            model=str(detector_path),
            recognition_model=str(recognition_path),
            identity_gallery=str(gallery_path),
        )
    )
    result = engine.infer(np.zeros((32, 32, 3), dtype=np.uint8))[0]
    assert result.identity is None and result.similarity is None
    engine.close()
