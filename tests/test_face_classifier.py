import sys
import types

import numpy as np
import pytest

from spyder_cctv.cv.contracts import VisionConfig, VisionUnavailable
from spyder_cctv.cv.face_classifier import FaceClassifier


class Metadata:
    def __init__(self, name, shape, type="tensor(float)"):
        self.name, self.shape, self.type = name, shape, type


class Session:
    def __init__(
        self, output, shape=(1, 3, 112, 112), output_name="probabilities", extra_outputs=()
    ):
        self.output = output
        self.input = Metadata("image", shape)
        self.output_meta = Metadata(output_name, list(np.asarray(output).shape))
        self.extra_outputs = list(extra_outputs)
        self.feed = None

    def get_inputs(self):
        return [self.input]

    def get_outputs(self):
        return [self.output_meta, *self.extra_outputs]

    def run(self, names, feed):
        self.feed = feed["image"]
        return [self.output]


def config(**kwargs):
    return VisionConfig(
        engine="insightface",
        model="detector.onnx",
        classifier_model="classifier.onnx",
        classifier_labels=("cat", "dog"),
        **kwargs,
    )


@pytest.mark.parametrize(
    "kwargs",
    [
        {"engine": "yolo"},
        {"classifier_model": "https://host/model.onnx"},
        {"classifier_model": "model.pt"},
        {"classifier_labels": ()},
        {"classifier_labels": ("same", "same")},
        {"classifier_threshold": float("nan")},
        {"classifier_threshold": 1.1},
        {"classifier_output": "scores"},
        {"classifier_preprocessing": "bgr"},
        {"recognition_model": "recognizer.onnx", "identity_gallery": "people.json"},
    ],
)
def test_classifier_configuration_rejects_invalid_combinations(kwargs):
    options = {
        "engine": "insightface",
        "model": "detector.onnx",
        "classifier_model": "classifier.onnx",
        "classifier_labels": ("a", "b"),
    }
    options.update(kwargs)
    with pytest.raises(ValueError):
        VisionConfig(**options)


def install_runtime(monkeypatch, session):
    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        types.SimpleNamespace(InferenceSession=lambda _path, providers: session),
    )


def test_classifier_probabilities_and_arcface_rgb_preprocessing(tmp_path, monkeypatch):
    path = tmp_path / "classifier.onnx"
    path.touch()
    session = Session(np.array([[0.2, 0.8]], dtype=np.float32))
    install_runtime(monkeypatch, session)
    classifier = FaceClassifier(config(), path)
    bgr = np.zeros((112, 112, 3), dtype=np.uint8)
    bgr[:] = (10, 20, 30)

    label, confidence = classifier.classify(bgr)

    assert label == "dog"
    assert confidence == pytest.approx(0.8)
    tensor = session.feed[0]
    assert tensor[:, 0, 0] == pytest.approx(np.array([30, 20, 10]) / 127.5 - 1)
    classifier.close()
    assert classifier.session is None


def test_logits_are_softmax_normalized_and_threshold_rejects(tmp_path, monkeypatch):
    path = tmp_path / "classifier.onnx"
    path.touch()
    session = Session(np.array([[0.0, 0.0]], dtype=np.float32), output_name="logits")
    install_runtime(monkeypatch, session)
    classifier = FaceClassifier(config(classifier_output="logits", classifier_threshold=0.6), path)

    label, confidence = classifier.classify(np.zeros((112, 112, 3), dtype=np.uint8))

    assert label is None
    assert confidence == pytest.approx(0.5)


@pytest.mark.parametrize("output", [np.array([[0.2, 0.2]]), np.array([[np.nan, 1.0]])])
def test_invalid_probabilities_fail_closed(tmp_path, monkeypatch, output):
    path = tmp_path / "classifier.onnx"
    path.touch()
    install_runtime(monkeypatch, Session(output))
    classifier = FaceClassifier(config(), path)
    with pytest.raises(VisionUnavailable) as error:
        classifier.classify(np.zeros((112, 112, 3), dtype=np.uint8))
    assert error.value.code == "classification_failed"


def test_classifier_rejects_input_or_output_class_mismatch(tmp_path, monkeypatch):
    path = tmp_path / "classifier.onnx"
    path.touch()
    install_runtime(monkeypatch, Session(np.array([[0.2, 0.3, 0.5]])))
    with pytest.raises(VisionUnavailable) as error:
        FaceClassifier(config(), path)
    assert error.value.code == "model_incompatible"

    install_runtime(monkeypatch, Session(np.array([[0.2, 0.8]]), shape=[1, 3, 224, 224]))
    with pytest.raises(VisionUnavailable) as error:
        FaceClassifier(config(), path)
    assert error.value.code == "model_incompatible"


def test_classifier_runtime_requires_single_named_output(tmp_path, monkeypatch):
    path = tmp_path / "classifier.onnx"
    path.touch()
    session = Session(np.array([[0.2, 0.8]]), output_name="")
    install_runtime(monkeypatch, session)
    with pytest.raises(VisionUnavailable) as error:
        FaceClassifier(config(), path)
    assert error.value.code == "model_incompatible"


def test_classifier_selects_named_output_from_multi_output_dynamic_batch_model(
    tmp_path, monkeypatch
):
    path = tmp_path / "classifier.onnx"
    path.touch()
    labels = tuple(f"person-{index}" for index in range(12))
    session = Session(
        np.array([[1.0] + [0.0] * 11]),
        shape=["batch", 3, 112, 112],
        output_name="probabilities",
        extra_outputs=[
            Metadata("logits", ["batch", 12]),
            Metadata("class_ids", ["batch"], "tensor(int64)"),
        ],
    )
    install_runtime(monkeypatch, session)
    classifier = FaceClassifier(
        VisionConfig(
            engine="insightface",
            model="detector.onnx",
            classifier_model="classifier.onnx",
            classifier_labels=labels,
        ),
        path,
    )
    label, confidence = classifier.classify(np.zeros((112, 112, 3), dtype=np.uint8))
    assert classifier.output_name == "probabilities"
    assert label == labels[0] and confidence == pytest.approx(1.0)
    assert session.feed.shape == (1, 3, 112, 112)


def test_insightface_classifier_uses_five_point_alignment_and_preserves_detection(
    tmp_path, monkeypatch
):
    detector_path = tmp_path / "detector.onnx"
    classifier_path = tmp_path / "classifier.onnx"
    detector_path.touch()
    classifier_path.touch()
    observed = {}

    class Detector:
        taskname = "detection"

        def prepare(self, **_kwargs):
            pass

        def detect(self, _frame, max_num):
            observed["max_num"] = max_num
            boxes = np.array([[1, 2, 30, 40, 0.91]], dtype=np.float32)
            landmarks = np.arange(10, dtype=np.float32).reshape(1, 5, 2)
            return boxes, landmarks

    model_zoo = types.SimpleNamespace(get_model=lambda *_a, **_k: Detector())
    align_module = types.ModuleType("insightface.utils.face_align")

    def norm_crop(frame, landmarks, image_size):
        observed["landmarks"] = landmarks
        observed["image_size"] = image_size
        return np.full((112, 112, 3), 127, dtype=np.uint8)

    align_module.norm_crop = norm_crop
    insightface = types.ModuleType("insightface")
    insightface.__path__ = []
    utils = types.ModuleType("insightface.utils")
    utils.__path__ = []
    monkeypatch.setitem(sys.modules, "insightface", insightface)
    monkeypatch.setitem(sys.modules, "insightface.model_zoo", model_zoo)
    monkeypatch.setitem(sys.modules, "insightface.utils", utils)
    monkeypatch.setitem(sys.modules, "insightface.utils.face_align", align_module)
    install_runtime(monkeypatch, Session(np.array([[0.1, 0.9]], dtype=np.float32)))

    from spyder_cctv.cv.engines import InsightFaceEngine

    engine = InsightFaceEngine(
        VisionConfig(
            engine="insightface",
            model=str(detector_path),
            max_detections=7,
            classifier_model=str(classifier_path),
            classifier_labels=("staff", "visitor"),
        )
    )
    assert engine.class_names == ["staff", "visitor"]
    frame = np.zeros((50, 50, 3), dtype=np.uint8)
    assert engine.infer(frame)[0].identity is None
    assert engine.infer(frame)[0].identity is None
    detection = engine.infer(frame)[0]
    assert observed["max_num"] == 7
    assert observed["image_size"] == 112
    assert np.array_equal(observed["landmarks"], np.arange(10).reshape(5, 2))
    assert detection.bbox == (1.0, 2.0, 30.0, 40.0)
    assert detection.confidence == pytest.approx(0.91)
    assert detection.label == "face" and detection.class_id == 0
    assert detection.identity == "visitor"
    assert detection.identity_confidence == pytest.approx(0.9)
    assert detection.similarity is None
    engine.close()


def test_classifier_engine_suppresses_alternating_face_identities(tmp_path, monkeypatch):
    detector_path = tmp_path / "detector.onnx"
    classifier_path = tmp_path / "classifier.onnx"
    detector_path.touch()
    classifier_path.touch()

    class Detector:
        taskname = "detection"

        def prepare(self, **_kwargs):
            pass

        def detect(self, _frame, max_num):
            return np.array([[1, 2, 30, 40, 0.91]]), np.arange(10).reshape(1, 5, 2)

    monkeypatch.setitem(
        sys.modules,
        "insightface.model_zoo",
        types.SimpleNamespace(get_model=lambda *_a, **_k: Detector()),
    )
    align_module = types.ModuleType("insightface.utils.face_align")
    align_module.norm_crop = lambda *_a, **_k: np.zeros((112, 112, 3), dtype=np.uint8)
    monkeypatch.setitem(sys.modules, "insightface.utils.face_align", align_module)
    session = Session(np.array([[0.1, 0.9]], dtype=np.float32))
    install_runtime(monkeypatch, session)
    from spyder_cctv.cv.engines import InsightFaceEngine

    engine = InsightFaceEngine(
        VisionConfig(
            engine="insightface",
            model=str(detector_path),
            classifier_model=str(classifier_path),
            classifier_labels=("staff", "visitor"),
        )
    )
    outputs = []
    for prediction in ([0.1, 0.9], [0.9, 0.1], [0.1, 0.9], [0.9, 0.1]):
        session.output = np.array([prediction], dtype=np.float32)
        outputs.append(engine.infer(np.zeros((50, 50, 3), dtype=np.uint8))[0].identity)

    assert outputs == [None, None, None, None]


def test_classifier_requires_landmarks_and_never_guesses_alignment(tmp_path, monkeypatch):
    detector_path = tmp_path / "detector.onnx"
    classifier_path = tmp_path / "classifier.onnx"
    detector_path.touch()
    classifier_path.touch()

    class Detector:
        taskname = "detection"

        def prepare(self, **_kwargs):
            pass

        def detect(self, _frame, max_num):
            return np.array([[1, 2, 30, 40, 0.91]]), None

    monkeypatch.setitem(
        sys.modules,
        "insightface.model_zoo",
        types.SimpleNamespace(get_model=lambda *_a, **_k: Detector()),
    )
    align_module = types.ModuleType("insightface.utils.face_align")
    align_module.norm_crop = lambda *_a, **_k: pytest.fail("must not crop without landmarks")
    monkeypatch.setitem(sys.modules, "insightface.utils.face_align", align_module)
    install_runtime(monkeypatch, Session(np.array([[0.1, 0.9]], dtype=np.float32)))

    from spyder_cctv.cv.engines import InsightFaceEngine

    engine = InsightFaceEngine(
        VisionConfig(
            engine="insightface",
            model=str(detector_path),
            classifier_model=str(classifier_path),
            classifier_labels=("staff", "visitor"),
        )
    )
    with pytest.raises(VisionUnavailable) as error:
        engine.infer(np.zeros((50, 50, 3), dtype=np.uint8))
    assert error.value.code == "alignment_failed"


def test_classifier_config_survives_json_round_trip():
    import json
    from dataclasses import asdict

    config = VisionConfig(
        engine="insightface",
        model="detector.onnx",
        classifier_model="classifier.onnx",
        classifier_labels=("Alice", "Bob"),
    )
    restored = VisionConfig(**json.loads(json.dumps(asdict(config))))
    assert restored == config


def test_classifier_rejects_close_competing_identities(monkeypatch):
    from pathlib import Path

    session = Session(np.array([[0.52, 0.48]], dtype=np.float32))
    install_runtime(monkeypatch, session)
    classifier = FaceClassifier(config(), Path("classifier.onnx"))
    identity, score = classifier.classify(np.zeros((112, 112, 3), dtype=np.uint8))
    assert identity is None
    assert score == pytest.approx(0.52)


@pytest.mark.parametrize("margin,expected", [(0.15, "cat"), (0.16, None), (0, "cat")])
def test_classifier_margin_obeys_setting_and_float_precision(monkeypatch, margin, expected):
    from pathlib import Path

    session = Session(np.array([[0.575, 0.425]], dtype=np.float32))
    install_runtime(monkeypatch, session)
    classifier = FaceClassifier(config(classifier_min_margin=margin), Path("classifier.onnx"))
    identity, _ = classifier.classify(np.zeros((112, 112, 3), np.uint8))
    assert identity == expected


@pytest.mark.parametrize(
    "options",
    [
        {"classifier_confirmation_frames": 0},
        {"classifier_confirmation_frames": True},
        {"classifier_confirmation_frames": 16},
        {"classifier_switch_frames": 2},
        {"classifier_switch_frames": 31},
        {"classifier_min_margin": float("nan")},
        {"classifier_min_margin": 1.1},
    ],
)
def test_classifier_stability_configuration_is_bounded(options):
    with pytest.raises(ValueError):
        config(**options)
