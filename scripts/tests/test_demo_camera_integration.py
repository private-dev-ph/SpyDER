"""Real bundled footage follows the same worker/frame path as native cameras."""

import json
import time
from importlib.resources import files

import cv2
import numpy as np

from spyder_cctv.analysis_preview import AnalysisPreviews
from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig, load_app_config
from spyder_cctv.demo_sources import DemoClipCapture


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


def test_live_and_draft_analysis_follow_same_loop_without_reopening_or_stopping_recording(tmp_path):
    clock, captures = [100.0], []

    class ControlledDemo(DemoClipCapture):
        def read(self):
            return self._read_timed_frame(clock[0])

    def open_demo(source):
        capture = ControlledDemo(source)
        captures.append(capture)
        return capture

    def wait_for(predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        raise AssertionError("Loop epoch did not reach motion analysis")

    settings = {"enabled": True, "warmup_frames": 0, "roi": [0.1, 0.1, 0.8, 0.8]}
    manager = CameraManager(
        [CameraConfig("sample", "demo://porch-parcel", fps=30, pipeline="none", analysis=settings)],
        config_path=tmp_path / "config.json",
        capture_factory=open_demo,
    )
    previews = AnalysisPreviews(manager)
    try:
        manager.set_recording("sample", True)
        worker = manager.get_worker("sample")
        wait_for(lambda: worker.jpeg() is not None)
        session = worker.status()["capture_session"]
        previews.configure("loop-preview", "sample", settings)
        draft = previews._sessions["loop-preview"].runtime

        def both_observed(epoch):
            previews.snapshot("loop-preview")
            return (
                worker._analysis_runtime._source_epoch == (session, epoch)
                and draft._source_epoch == (session, epoch)
                and worker.analysis_snapshot()["runtime"]["state"] == "ready"
            )

        wait_for(lambda: both_observed(0))
        clock[0] += 8.1
        wait_for(lambda: both_observed(1))
        clock[0] += 16  # Skip complete loops; the next frame index can be unchanged.
        wait_for(lambda: both_observed(2))
        raw, epoch = worker.raw_frame_sample()
        assert raw is not None and epoch == (session, 2)
        assert len(captures) == 1
        assert worker.status()["capture_session"] == session
        assert worker.status()["state"] == "running"
        assert manager.statuses()[0]["recording"] is True
        assert worker.config.analysis.roi == (0.1, 0.1, 0.8, 0.8)
    finally:
        previews.close()
        manager.close()
