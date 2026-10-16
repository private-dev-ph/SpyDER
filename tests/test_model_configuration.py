import time

import numpy as np
import pytest

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig, load_app_config


def wait_for(predicate):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Model configuration did not apply")


def test_model_changes_reuse_capture_preserve_recording_and_persist(tmp_path):
    opened = []

    class Capture:
        def __init__(self, source):
            opened.append(source)

        def read(self):
            return True, np.zeros((64, 64, 3), np.uint8)

        def close(self):
            pass

    class Pipeline:
        def __init__(self, name):
            self.name = name

        def process(self, frame):
            return frame, {"pipeline": self.name}

    manager = CameraManager(
        [CameraConfig("cam", 0, pipeline="none")],
        config_path=tmp_path / "config.json",
        capture_factory=Capture,
        pipeline_factory=Pipeline,
    )
    try:
        manager.set_recording("cam", True)
        wait_for(lambda: manager.statuses()[0]["state"] == "running")
        session = manager.statuses()[0]["capture_session"]
        manager.set_vision("cam", {"engine": "opencv"})
        wait_for(lambda: manager.statuses()[0]["metadata"].get("pipeline") == "vision")
        assert opened == [0] and manager.statuses()[0]["recording"]
        assert manager.statuses()[0]["capture_session"] == session
        assert load_app_config(tmp_path / "config.json").cameras[0].vision.engine == "opencv"
        worker = manager.get_worker("cam")
        revision = worker._vision_revision
        before_config = (tmp_path / "config.json").read_bytes()
        manager.set_vision("cam", {"engine": "opencv"})
        manager.set_vision("cam", vars(worker.config.vision))
        manager.restore_vision("cam", worker.config)
        assert worker._vision_revision == revision
        assert (tmp_path / "config.json").read_bytes() == before_config
        assert manager.statuses()[0]["capture_session"] == session
        assert manager.statuses()[0]["recording"]
        before = (tmp_path / "config.json").read_bytes()
        with pytest.raises(ValueError):
            manager.set_vision("cam", {"unknown": True})
        assert (tmp_path / "config.json").read_bytes() == before
        manager.set_vision("cam", None)
        wait_for(lambda: manager.statuses()[0]["metadata"].get("pipeline") == "none")
        assert opened == [0] and manager.statuses()[0]["recording"]
    finally:
        manager.close()


def test_restore_vision_keeps_previous_pipeline_and_current_tuning(tmp_path):
    manager = CameraManager(
        [CameraConfig("cam", 0, pipeline="motion", autostart=False)],
        config_path=tmp_path / "config.json",
    )
    try:
        previous = manager.get_worker("cam").config
        manager.set_vision("cam", {"engine": "opencv"})
        manager.set_settings("cam", {"brightness": 42})
        current_settings = manager.get_worker("cam").config.settings
        manager.restore_vision("cam", previous)
        restored = manager.get_worker("cam").config
        assert restored.pipeline == "motion" and restored.vision is None
        assert restored.settings == current_settings
        assert load_app_config(tmp_path / "config.json").cameras[0] == restored
    finally:
        manager.close()
