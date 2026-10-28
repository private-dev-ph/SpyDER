"""Real bundled footage follows the same worker/frame path as native cameras."""

import json
import time
from importlib.resources import files

import cv2
import numpy as np

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig, load_app_config


def test_eight_packaged_demo_cameras_expose_jpeg_raw_frames_and_persistent_tuning(tmp_path):
    clips = json.loads(
        files("spyder_cctv").joinpath("assets", "demo-cameras.json").read_text(encoding="utf-8")
    )["cameras"]
    manager = CameraManager(
        [
            CameraConfig(f"demo-{i}", "demo://" + c["id"], fps=5, pipeline="motion")
            for i, c in enumerate(clips)
        ],
        config_path=tmp_path / "config.json",
    )
    try:
        for worker in manager.workers.values():
            worker.start()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not all(w.jpeg() for w in manager.workers.values()):
            time.sleep(0.02)
        assert all(w.jpeg() for w in manager.workers.values()), manager.statuses()
        for worker in manager.workers.values():
            frame = cv2.imdecode(np.frombuffer(worker.jpeg(), np.uint8), cv2.IMREAD_COLOR)
            assert frame.shape[0] == 360
            raw = worker.raw_frame(timeout=2)
            assert raw is not None and raw.shape == frame.shape
            assert worker.status()["state"] == "running"
        manager.set_settings("demo-0", {"brightness": 80, "zoom": 20})
        deadline = time.monotonic() + 5
        while (
            time.monotonic() < deadline
            and manager.get_worker("demo-0").settings_snapshot()["settings_state"] != "applied"
        ):
            time.sleep(0.02)
        snapshot = manager.get_worker("demo-0").settings_snapshot()
        assert snapshot["capabilities"]["zoom"]["implementation"] == "software"
        assert snapshot["settings_state"] == "applied"
        restored = load_app_config(tmp_path / "config.json")
        assert restored.cameras[0].source == "demo://driveway-arrival"
        assert restored.cameras[0].settings["brightness"] == 80
    finally:
        manager.close()
    assert all(s["state"] == "stopped" for s in manager.statuses())
