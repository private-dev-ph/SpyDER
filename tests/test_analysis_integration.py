import json
import threading
import time

import numpy as np
import pytest

from spyder_cctv.analysis_runtime import AnalysisRuntime
from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig, load_app_config
from spyder_cctv.motion_config import AnalysisConfig


def wait_for(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Analysis condition did not become true")


class SyntheticCapture:
    opened = 0

    def __init__(self, source):
        SyntheticCapture.opened += 1

    def read(self):
        return True, np.zeros((120, 160, 3), np.uint8)

    def close(self):
        pass


def test_analysis_changes_preserve_capture_recording_and_configuration(tmp_path):
    SyntheticCapture.opened = 0
    manager = CameraManager(
        [CameraConfig("cam", 0, fps=30, pipeline="none")],
        config_path=tmp_path / "config.json",
        capture_factory=SyntheticCapture,
    )
    try:
        manager.set_recording("cam", True)
        wait_for(lambda: manager.get_worker("cam").jpeg() is not None)
        manager.set_analysis("cam", {"enabled": True, "warmup_frames": 0})
        wait_for(
            lambda: manager.get_worker("cam").analysis_snapshot()["runtime"].get("state") == "ready"
        )
        assert manager.get_worker("cam").analysis_mask().startswith(b"\xff\xd8")
        assert manager.statuses()[0]["recording"] is True
        assert SyntheticCapture.opened == 1
        config = load_app_config(tmp_path / "config.json").cameras[0]
        assert config.pipeline == "none" and config.analysis.enabled
        manager.set_analysis("cam", {"enabled": False})
        wait_for(lambda: "analysis" not in manager.statuses()[0]["metadata"])
        assert manager.get_worker("cam").jpeg() is not None
        assert SyntheticCapture.opened == 1
        original = (tmp_path / "config.json").read_bytes()
        with pytest.raises(ValueError):
            manager.set_analysis("cam", {"enabled": True, "inference_fps": True})
        assert (tmp_path / "config.json").read_bytes() == original
        assert json.loads(original)["cameras"][0]["analysis"]["enabled"] is False
    finally:
        manager.close()


def test_analysis_engine_error_does_not_stop_camera(monkeypatch):
    class Broken:
        def __init__(self, config):
            pass

        def process(self, frame):
            raise RuntimeError("private native details")

        def close(self):
            pass

    monkeypatch.setattr(
        "spyder_cctv.cameras.AnalysisRuntime",
        lambda config: AnalysisRuntime(config, factory=Broken),
    )
    manager = CameraManager(
        [CameraConfig("cam", 0, fps=30, analysis={"enabled": True})],
        capture_factory=SyntheticCapture,
    )
    try:
        manager.control("cam", "start")
        wait_for(
            lambda: manager.statuses()[0]["metadata"].get("analysis", {}).get("state") == "error"
        )
        assert manager.statuses()[0]["state"] == "running"
        assert manager.get_worker("cam").jpeg() is not None
        assert "private native details" not in str(manager.statuses())
    finally:
        manager.close()


def test_latest_frame_worker_has_bounded_shutdown_and_pending_storage():
    entered, unblock = threading.Event(), threading.Event()

    class Slow:
        mask = None

        def __init__(self, config):
            pass

        def process(self, frame):
            entered.set()
            unblock.wait(3)
            return frame, {"state": "ready", "regions": [], "tracks": []}

        def close(self):
            pass

    runtime = AnalysisRuntime(AnalysisConfig(enabled=True, inference_fps=15), factory=Slow)
    try:
        frame = np.zeros((30, 40, 3), np.uint8)
        runtime.process(frame)
        assert entered.wait(1)
        for _ in range(4):
            time.sleep(0.075)
            result = runtime.process(frame)
        assert result["dropped_frames"] >= 1
        assert runtime._pending is not None
        started = time.monotonic()
        with pytest.raises(RuntimeError, match="still stopping"):
            runtime.close(0.02)
        assert time.monotonic() - started < 0.2
        assert runtime.is_alive
    finally:
        unblock.set()
        runtime.close(2)


def test_analysis_can_coexist_with_existing_model_configuration(tmp_path):
    config = CameraConfig(
        "cam",
        0,
        pipeline="vision",
        vision={"engine": "yolo", "model": str(tmp_path / "user-model.pt")},
    )
    manager = CameraManager([config], config_path=tmp_path / "config.json")
    try:
        original = manager.get_worker("cam").config.vision
        manager.set_analysis("cam", {"enabled": True, "contours": True, "components": True})
        camera = load_app_config(tmp_path / "config.json").cameras[0]
        assert camera.vision == original
        assert camera.pipeline == "vision" and camera.analysis.enabled
    finally:
        manager.close()
