"""Exercise workflow demand through real capture and inference workers."""

import time

import numpy as np

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig
from spyder_cctv.cv.contracts import VisionConfig
from spyder_cctv.cv.runtime import VisionPipeline
from spyder_cctv.workflow import WorkflowService


def wait_for(predicate):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Timed out waiting for worker")


def test_shared_workflows_idle_and_resume_same_engine_without_stopping_capture(tmp_path):
    engines, calls, resets = [], [], []

    class Capture:
        def __init__(self, source):
            pass

        def read(self):
            return True, np.zeros((8, 8, 3), dtype=np.uint8)

        def close(self):
            pass

    class Engine:
        def __init__(self):
            engines.append(self)

        def infer(self, frame):
            calls.append(True)
            return []

        def reset(self):
            resets.append(True)

        def close(self):
            pass

    manager = CameraManager(
        [CameraConfig("cam", 0, fps=60, pipeline="vision", vision=VisionConfig())],
        config_path=tmp_path / "cameras.json",
        capture_factory=Capture,
        pipeline_factory=lambda name: VisionPipeline(
            VisionConfig(inference_fps=30), lambda config: Engine()
        ),
        encoder=lambda frame: b"jpeg",
    )

    class Recorder:
        def status(self):
            return {"state": "idle", "camera_ids": []}

    service = WorkflowService(manager, Recorder(), tmp_path)
    worker = manager.get_worker("cam")
    graph = {
        "id": "one",
        "name": "One",
        "enabled": True,
        "camera_ids": ["cam"],
        "nodes": [{"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {}}],
        "edges": [],
    }
    try:
        worker.start()
        wait_for(lambda: worker.status()["frames"] >= 3)
        assert engines == []
        original = worker.config
        one = service.save(graph)
        wait_for(lambda: len(calls) >= 2)
        two = service.save({**graph, "id": "two", "name": "Two"})
        service.save({**one, "enabled": False})
        before = len(calls)
        wait_for(lambda: len(calls) > before)
        service.save({**two, "enabled": False})
        wait_for(lambda: worker.vision_snapshot()["runtime"]["state"] == "idle")
        before, frames = len(calls), worker.status()["frames"]
        wait_for(lambda: worker.status()["frames"] > frames + 3)
        assert len(calls) == before
        assert worker.config == original
        assert worker.jpeg() == b"jpeg"
        service.save(one)
        before = len(calls)
        wait_for(lambda: len(calls) > before)
        assert len(engines) == 1
        assert resets
        service.remove("one")
        wait_for(lambda: worker.vision_snapshot()["runtime"]["state"] == "idle")
        # A preview can temporarily wake an otherwise disabled detector.
        worker.request_vision_preview(ttl=0.12)
        before = len(calls)
        wait_for(lambda: len(calls) > before)
        wait_for(lambda: worker.vision_snapshot()["runtime"]["state"] == "idle")
        assert len(engines) == 1
    finally:
        service.close()
        manager.close()
