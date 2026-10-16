import time

import cv2
import numpy as np
import pytest

from spyder_cctv.analysis_preview import AnalysisPreviews
from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig


class Capture:
    opened = 0

    def __init__(self, source):
        Capture.opened += 1

    def read(self):
        return True, np.zeros((60, 80, 3), np.uint8)

    def close(self):
        pass


class PaintedPipeline:
    def process(self, frame):
        return np.full_like(frame, 220), {"painted": True}


def wait_for(predicate, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("Preview did not become ready")


@pytest.fixture
def rig(tmp_path):
    Capture.opened = 0
    manager = CameraManager(
        [CameraConfig("cam", 0, fps=20, pipeline="none")],
        config_path=tmp_path / "config.json",
        capture_factory=Capture,
        pipeline_factory=lambda name: PaintedPipeline(),
    )
    previews = AnalysisPreviews(manager)
    try:
        yield manager, previews, tmp_path / "config.json"
    finally:
        previews.close()
        manager.close()


def test_preview_is_raw_and_drafts_do_not_change_live_or_persisted_settings(rig):
    manager, previews, config = rig
    manager.set_analysis("cam", {"enabled": False})
    manager.set_recording("cam", True)
    original = config.read_bytes()
    worker = manager.get_worker("cam")
    previews.configure("draft-tab", "cam", {"enabled": False})
    wait_for(lambda: previews.image("draft-tab") is not None)
    draft = cv2.imdecode(np.frombuffer(previews.image("draft-tab"), np.uint8), cv2.IMREAD_COLOR)
    live = cv2.imdecode(np.frombuffer(worker.jpeg(), np.uint8), cv2.IMREAD_COLOR)
    assert draft.mean() < 1 and live.mean() > 200
    previews.configure("draft-tab", "cam", {"enabled": True, "warmup_frames": 0})
    wait_for(lambda: previews.snapshot("draft-tab")["runtime"]["state"] == "ready")
    engine = previews._sessions["draft-tab"].runtime
    previews.configure("draft-tab", "cam", {"enabled": True, "warmup_frames": 0, "threshold": 32})
    assert previews._sessions["draft-tab"].runtime is engine
    wait_for(lambda: previews.snapshot("draft-tab")["runtime"]["state"] == "ready")
    assert previews.image("draft-tab", mask=True).startswith(b"\xff\xd8")
    assert config.read_bytes() == original
    assert worker.config.analysis.enabled is False
    assert worker.status()["metadata"] == {"painted": True}
    assert manager.statuses()[0]["recording"] is True
    assert Capture.opened == 1
    manager.set_analysis("cam", {"enabled": True})
    assert worker.config.analysis.enabled
    previews.release("draft-tab")
    assert manager.statuses()[0]["recording"] is True


def test_preview_never_starts_paused_camera_and_release_rejects_late_edits(rig):
    manager, previews, _ = rig
    result = previews.configure("draft-tab", "cam", {"enabled": True})
    assert result["runtime"]["state"] == "paused"
    assert previews.image("draft-tab") is None
    assert Capture.opened == 0
    previews.release("draft-tab")
    with pytest.raises(KeyError):
        previews.snapshot("draft-tab")
    with pytest.raises(RuntimeError, match="closed"):
        previews.configure("draft-tab", "cam", {})


def test_preview_limit_expiration_and_validation(rig):
    manager, _, _ = rig
    previews = AnalysisPreviews(manager, ttl=0.05, limit=1)
    try:
        with pytest.raises(ValueError):
            previews.configure("bad", "cam", {})
        with pytest.raises(ValueError):
            previews.configure("draft-tab", "cam", {"enabled": True, "threshold": True})
        previews.configure("draft-one", "cam", {})
        with pytest.raises(RuntimeError, match="limit"):
            previews.configure("draft-two", "cam", {})
        time.sleep(0.1)
        with pytest.raises(KeyError):
            previews.snapshot("draft-one")
        assert previews.configure("draft-two", "cam", {})["camera_id"] == "cam"
    finally:
        previews.close()


def test_slow_retiring_preview_counts_toward_limit(rig, monkeypatch):
    manager, _, _ = rig

    class SlowRuntime:
        is_alive = True

        def __init__(self, config):
            pass

        def close(self, timeout=0.05):
            if self.is_alive:
                raise RuntimeError("Still stopping")

    monkeypatch.setattr("spyder_cctv.analysis_preview.AnalysisRuntime", SlowRuntime)
    previews = AnalysisPreviews(manager, limit=1)
    try:
        previews.configure("draft-one", "cam", {"enabled": True})
        with pytest.raises(RuntimeError, match="limit"):
            previews.configure("draft-one", "cam", {"enabled": False})
        assert len(previews._retiring) == 1
        previews._retiring[0].is_alive = False
        assert previews.configure("draft-two", "cam", {})["camera_id"] == "cam"
    finally:
        previews.close()
