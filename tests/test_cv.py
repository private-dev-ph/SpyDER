import json
import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest

from spyder_cctv.cameras import CameraManager, CameraWorker
from spyder_cctv.config import CameraConfig, load_config, save_config
from spyder_cctv.cv.contracts import Detection, VisionConfig, VisionUnavailable
from spyder_cctv.cv.engines import InsightFaceEngine, OpenCVPeopleEngine, YoloEngine
from spyder_cctv.cv.runtime import VisionPipeline


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("CV condition did not become true")


@pytest.mark.parametrize(
    "options",
    [
        {"engine": "remote"},
        {"engine": "yolo"},
        {"engine": "yolo", "model": "https://host/model.pt"},
        {"engine": "insightface", "model": "face.pt"},
        {"device": "cuda:0"},
        {"inference_fps": True},
        {"inference_fps": float("nan")},
        {"confidence": 1.1},
        {"input_size": 123},
        {"max_detections": 0},
    ],
)
def test_cv_config_rejects_invalid_options(options):
    with pytest.raises(ValueError):
        VisionConfig(**options)


def test_model_paths_and_configuration_roundtrip(tmp_path, monkeypatch):
    config = CameraConfig(
        "cam", 0, pipeline="vision", vision={"engine": "yolo", "model": "models/detect.pt"}
    )
    path = tmp_path / "config.json"
    save_config(path, [config])
    monkeypatch.chdir(tmp_path.parent)
    loaded = load_config(path)[0]
    assert loaded.vision.model == str(tmp_path / "models/detect.pt")
    save_config(path, [loaded])
    assert load_config(path)[0] == loaded
    with pytest.raises(ValueError):
        CameraConfig("cam", 0, pipeline="none", vision={})


def test_dynamic_camera_model_paths_match_persisted_configuration(tmp_path):
    path = tmp_path / "config.json"
    manager = CameraManager([], config_path=path)
    try:
        manager.add(
            CameraConfig(
                "cam", 0, pipeline="vision", vision={"engine": "yolo", "model": "models/detect.pt"}
            )
        )
        live = manager.get_worker("cam").config
        assert live == load_config(path)[0]
        assert live.vision.model == str(tmp_path / "models/detect.pt")
    finally:
        manager.close()


def test_detections_are_finite_native_json_without_embeddings():
    box = [np.float32(1), 2, 3, 4]
    detection = Detection("face", box, np.float32(0.75), 0)
    box[0] = 99
    result = json.loads(json.dumps(detection.to_dict(), allow_nan=False))
    assert result["bbox"] == [1, 2, 3, 4]
    assert "embedding" not in result
    with pytest.raises(ValueError):
        Detection("bad", (0, 0, float("nan"), 4))
    with pytest.raises(ValueError):
        Detection("bad", (4, 0, 0, 4))


def test_real_opencv_detector_accepts_bgr_frames_and_small_images():
    engine = OpenCVPeopleEngine(VisionConfig())
    try:
        assert engine.infer(np.zeros((32, 32, 3), dtype=np.uint8)) == []
        assert engine.infer(np.zeros((240, 320, 3), dtype=np.uint8)) == []
    finally:
        engine.close()


def test_optional_libraries_are_not_imported_when_model_missing(tmp_path, monkeypatch):
    def forbidden(name):
        raise AssertionError("Optional library must not load without a model")

    monkeypatch.setattr("spyder_cctv.cv.engines.importlib.import_module", forbidden)
    for factory, name, extension in [
        (YoloEngine, "yolo", ".pt"),
        (InsightFaceEngine, "insightface", ".onnx"),
    ]:
        with pytest.raises(VisionUnavailable, match="configured model"):
            factory(VisionConfig(engine=name, model=str(tmp_path / ("missing" + extension))))


def test_missing_optional_dependency_is_actionable(tmp_path, monkeypatch):
    def missing(name):
        raise ModuleNotFoundError("private import details")

    monkeypatch.setattr("spyder_cctv.cv.engines.importlib.import_module", missing)
    path = tmp_path / "detector.onnx"
    path.touch()
    with pytest.raises(VisionUnavailable) as error:
        InsightFaceEngine(VisionConfig(engine="insightface", model=str(path)))
    assert error.value.code == "dependency_missing"
    assert "spyder-cctv[insightface]" in str(error.value)
    assert "private" not in str(error.value)


def test_yolo_adapter_uses_local_bgr_frames_and_normalizes_boxes(tmp_path, monkeypatch):
    weights = tmp_path / "local.pt"
    weights.touch()
    calls = {}

    class Tensor:
        def __init__(self, value):
            self.value = value

        def cpu(self):
            return self

        def tolist(self):
            return self.value

    class Model:
        def __init__(self, path, task):
            calls.update(path=path, task=task)

        def predict(self, **kwargs):
            calls.update(kwargs)
            return [
                SimpleNamespace(
                    names={0: "person"},
                    boxes=SimpleNamespace(
                        xyxy=Tensor([[1, 2, 3, 4]]), conf=Tensor([0.8]), cls=Tensor([0])
                    ),
                )
            ]

    library = SimpleNamespace(
        YOLO=Model, settings=SimpleNamespace(update=lambda values: calls.update(settings=values))
    )
    monkeypatch.setattr("spyder_cctv.cv.engines.importlib.import_module", lambda name: library)
    monkeypatch.setenv("YOLO_OFFLINE", "false")
    monkeypatch.setenv("YOLO_AUTOINSTALL", "true")
    engine = YoloEngine(VisionConfig(engine="yolo", model=str(weights)))
    image = np.zeros((32, 32, 3), dtype=np.uint8)
    assert engine.infer(image)[0].label == "person"
    assert calls["source"] is image and calls["device"] == "cpu"
    assert calls["path"] == str(weights) and calls["save"] is False
    assert calls["settings"] == {"sync": False}
    import os

    assert os.environ["YOLO_OFFLINE"] == "true" and os.environ["YOLO_AUTOINSTALL"] == "false"
    engine.close()


def test_insightface_loads_detection_only_without_pack_downloader(tmp_path, monkeypatch):
    model_path = tmp_path / "face.onnx"
    model_path.touch()
    calls = {}

    class Model:
        taskname = "detection"

        def prepare(self, **kwargs):
            calls.update(kwargs)

        def detect(self, frame, **kwargs):
            calls.update(kwargs)
            return np.array([[1, 2, 3, 4, 0.9]]), None

    def get_model(path, **kwargs):
        calls.update(path=path, **kwargs)
        return Model()

    monkeypatch.setattr(
        "spyder_cctv.cv.engines.importlib.import_module",
        lambda name: SimpleNamespace(get_model=get_model),
    )
    engine = InsightFaceEngine(VisionConfig(engine="insightface", model=str(model_path)))
    detections = engine.infer(np.zeros((32, 32, 3), dtype=np.uint8))
    assert calls["download"] is False and calls["providers"] == ["CPUExecutionProvider"]
    assert calls["ctx_id"] == -1 and detections[0].label == "face"
    engine.close()


def test_latest_frame_worker_does_not_block_preview_and_owns_engine(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls, owners = [], []

    class Engine:
        def __init__(self, config):
            owners.append(threading.get_ident())

        def infer(self, frame):
            owners.append(threading.get_ident())
            calls.append(int(frame[0, 0, 0]))
            if len(calls) == 1:
                entered.set()
                assert release.wait(3)
            return [Detection("test", (0, 0, 1, 1), 1)]

        def close(self):
            owners.append(threading.get_ident())

    pipeline = VisionPipeline(VisionConfig(inference_fps=30), Engine)
    image = np.zeros((2, 2, 3), dtype=np.uint8)
    try:
        assert pipeline.process(image)[0] is image
        assert entered.wait(2)
        for value in range(1, 5):
            with pipeline._condition:
                pipeline._next_submission = 0
            image.fill(value)
            pipeline.process(image)
        image.fill(99)  # Queued frame must own a copy.
        release.set()
        wait_for(lambda: len(calls) == 2)
        wait_for(lambda: pipeline.process(image)[1]["cv"].get("sequence") == 5)
        assert calls == [0, 4]
        result = pipeline.process(image)[1]["cv"]
        assert result["detections"][0]["label"] == "test"
        json.dumps(result, allow_nan=False)
    finally:
        release.set()
        pipeline.close()
    assert len(set(owners)) == 1 and owners[0] != threading.get_ident()


def test_cv_initialization_failure_keeps_video_running():
    def factory(config):
        raise RuntimeError("secret file path / credentials")

    class Capture:
        def __init__(self, source):
            pass

        def read(self):
            return True, np.zeros((32, 32, 3), dtype=np.uint8)

        def close(self):
            pass

    worker = CameraWorker(
        CameraConfig("cam", 0, pipeline="vision", fps=60),
        capture_factory=Capture,
        pipeline_factory=lambda name: VisionPipeline(VisionConfig(), factory),
        encoder=lambda frame: b"jpeg",
    )
    try:
        worker.start()
        wait_for(lambda: worker.status()["metadata"].get("cv", {}).get("state") == "error")
        assert worker.status()["state"] == "running" and worker.jpeg() == b"jpeg"
        assert "secret" not in json.dumps(worker.status())
    finally:
        worker.stop()


def test_hung_cv_stop_reports_timeout_and_prevents_duplicate_engine():
    entered, release = threading.Event(), threading.Event()

    class Engine:
        def infer(self, frame):
            entered.set()
            release.wait(5)
            return []

        def close(self):
            pass

    class Capture:
        def __init__(self, source):
            pass

        def read(self):
            return True, np.zeros((32, 32, 3), dtype=np.uint8)

        def close(self):
            pass

    pipeline = VisionPipeline(VisionConfig(), lambda config: Engine())
    worker = CameraWorker(
        CameraConfig("cam", 0, fps=60),
        capture_factory=Capture,
        pipeline_factory=lambda name: pipeline,
        encoder=lambda frame: b"jpeg",
    )
    try:
        worker.start()
        assert entered.wait(2)
        with pytest.raises(RuntimeError, match="CV engine is still stopping"):
            worker.stop()
        with pytest.raises(RuntimeError, match="CV engine is still stopping"):
            worker.start()
    finally:
        release.set()
        pipeline.close()
        worker.stop()
