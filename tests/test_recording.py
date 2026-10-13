import json
import threading
import time

import cv2
import numpy as np
import pytest

import spyder_cctv.recording as recording_module
from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig
from spyder_cctv.recording import HEIGHT, WIDTH, RecordingService


class ColorCapture:
    def __init__(self, source):
        self.source = source

    def read(self):
        colors = {0: (20, 20, 230), 1: (20, 220, 20)}
        return True, np.full((90, 160, 3), colors[self.source], dtype=np.uint8)

    def close(self):
        pass


def wait_for(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("Condition did not become true")


@pytest.fixture
def rig(tmp_path):
    manager = CameraManager(
        [CameraConfig("red", 0, fps=15), CameraConfig("green", 1, fps=15)],
        capture_factory=ColorCapture,
    )
    service = RecordingService(manager, tmp_path)
    yield manager, service, tmp_path
    service.close()
    manager.close()


def test_tiled_recording_reshapes_and_decodes(rig):
    _, service, _ = rig
    service.start(["red"])
    wait_for(lambda: service.status()["frames"] >= 5)
    service.select(["red", "green"])
    wait_for(lambda: service.status()["frames"] >= 15)
    service.select(["green"])
    wait_for(lambda: service.status()["frames"] >= 25)
    assert service.stop()["state"] == "idle"

    item = service.status()["items"][-1]
    path = service.media_path(item["id"])
    capture = cv2.VideoCapture(str(path))
    assert capture.isOpened()
    frames = []
    while len(frames) < 30:
        ok, frame = capture.read()
        if not ok:
            break
        frames.append(frame)
    capture.release()
    assert len(frames) >= 25
    assert frames[0].shape[:2] == (HEIGHT, WIDTH)
    center = frames[0][HEIGHT // 3 : HEIGHT * 2 // 3]
    if center[:, :, 2].mean() < center[:, :, 1].mean() * 2:
        center = frames[1][HEIGHT // 3 : HEIGHT * 2 // 3]
    assert center[:, :, 2].mean() > center[:, :, 1].mean() * 2
    two = frames[10]
    middle = two[HEIGHT // 3 : HEIGHT * 2 // 3]
    assert middle[:, : WIDTH // 2, 2].mean() > middle[:, : WIDTH // 2, 1].mean() * 2
    assert middle[:, WIDTH // 2 :, 1].mean() > middle[:, WIDTH // 2 :, 2].mean() * 2
    middle = frames[-1][HEIGHT // 3 : HEIGHT * 2 // 3]
    assert middle[:, :, 1].mean() > middle[:, :, 2].mean() * 2
    assert item["size_bytes"] == path.stat().st_size


def test_capture_catalog_restart_and_safe_media_lookup(rig):
    manager, service, output = rig
    manager.set_recording("red", True)
    wait_for(lambda: manager.get_worker("red").jpeg() is not None)
    capture = service.capture(["red"])
    assert capture["kind"] == "capture"
    raw_bytes = service.media_path(capture["id"]).read_bytes()
    assert raw_bytes.startswith(b"\xff\xd8")
    raw_decoded = cv2.imdecode(np.frombuffer(raw_bytes, np.uint8), cv2.IMREAD_COLOR)
    assert raw_decoded.shape[:2] == (90, 160)
    tiled = service.capture(["red", "green"])
    encoded = np.frombuffer(service.media_path(tiled["id"]).read_bytes(), np.uint8)
    decoded = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    assert decoded.shape[:2] == (HEIGHT, WIDTH)
    restarted = RecordingService(manager, output)
    assert {x["id"] for x in restarted.status()["items"]} == {capture["id"], tiled["id"]}
    with pytest.raises(KeyError):
        restarted.media_path("../manifest.json")
    manager.set_recording("red", False)


def test_selection_rolls_back_retention_on_failure(rig):
    manager, service, _ = rig
    original = manager.set_recording

    def fail_second(camera_id, active):
        if camera_id == "green" and active:
            raise RuntimeError("start failed")
        return original(camera_id, active)

    manager.set_recording = fail_second
    with pytest.raises(RuntimeError, match="start failed"):
        service.start(["red", "green"])
    assert service.status()["state"] == "idle"
    assert "red" not in manager._recording
    manager.set_recording = original


def test_stop_timeout_reports_writer_still_stopping(rig):
    _, service, _ = rig
    service.start(["red"])
    # A zero timeout cannot claim that an active encoder finished.
    result = service.stop(timeout=0)
    assert result["state"] in ("stopping", "idle")
    assert service.stop(timeout=10)["state"] == "idle"


def test_removed_selected_camera_is_dropped_and_empty_selection_finalizes(rig):
    manager, service, _ = rig
    service.start(["red"])
    wait_for(lambda: service.status()["frames"] >= 2)
    manager.remove("red")
    wait_for(lambda: service.status()["state"] == "idle")
    assert service.status()["camera_ids"] == []


def test_writer_open_failure_tries_fallback_and_releases_retention(rig, monkeypatch):
    manager, service, _ = rig
    writers = []

    class ClosedWriter:
        def __init__(self, *args):
            self.released = False
            writers.append(self)

        def isOpened(self):
            return False

        def release(self):
            self.released = True

    monkeypatch.setattr(recording_module.cv2, "VideoWriter", ClosedWriter)
    service.start(["red"])
    wait_for(lambda: service.status()["state"] == "error")
    assert len(writers) == 2
    assert all(writer.released for writer in writers)
    assert "red" not in manager._recording
    assert service.status()["items"] == []


def test_hung_write_does_not_hold_service_lock_or_allow_restart(rig, monkeypatch):
    manager, service, _ = rig
    entered = threading.Event()
    release = threading.Event()

    class BlockingWriter:
        def __init__(self, *args):
            self.opened = True

        def isOpened(self):
            return self.opened

        def write(self, frame):
            entered.set()
            release.wait(5)

        def release(self):
            self.opened = False

    monkeypatch.setattr(recording_module.cv2, "VideoWriter", BlockingWriter)
    service.start(["red"])
    assert entered.wait(3)
    before = time.monotonic()
    result = service.stop(timeout=0.05)
    assert time.monotonic() - before < 0.5
    assert result["state"] == "stopping"
    assert service.status()["state"] == "stopping"
    with pytest.raises(RuntimeError, match="already active"):
        service.start(["red"])
    with pytest.raises(RuntimeError, match="did not stop"):
        service.close(timeout=0.05)
    release.set()
    assert service.stop(timeout=3)["state"] == "idle"
    service.close(timeout=3)
    manager.close()


def test_error_state_cannot_restart_before_old_writer_exits(rig, monkeypatch):
    manager, service, _ = rig
    releasing = threading.Event()
    release = threading.Event()

    class FailingWriter:
        def isOpened(self):
            return True

        def write(self, frame):
            raise RuntimeError("synthetic write failure")

        def release(self):
            releasing.set()
            release.wait(5)

    monkeypatch.setattr(recording_module.cv2, "VideoWriter", lambda *args: FailingWriter())
    service.start(["red"])
    assert releasing.wait(3)
    assert service.status()["state"] == "error"
    with pytest.raises(RuntimeError, match="already active"):
        service.start(["red"])
    release.set()
    wait_for(lambda: service.status()["state"] == "error" and not service._thread)
    service.close(timeout=3)
    manager.close()


def test_capture_requires_at_least_one_fresh_sample(rig):
    _, service, _ = rig
    with pytest.raises(RuntimeError, match="No fresh camera frames"):
        service.capture(["red"])
    assert service.status()["items"] == []


def test_catalog_revalidates_fields_and_rebuilds_media_urls(rig):
    manager, service, output = rig
    manager.set_recording("red", True)
    wait_for(lambda: manager.get_worker("red").jpeg() is not None)
    item = service.capture(["red"])
    manifest = output / "manifest.json"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["items"][0]["url"] = "https://evil.example/elsewhere"
    data["items"].append(data["items"][0] | {"id": "../outside", "filename": "../outside.jpg"})
    manifest.write_text(json.dumps(data), encoding="utf-8")
    restarted = RecordingService(manager, output)
    assert restarted.status()["items"] == [item]
    assert restarted.status()["items"][0]["url"] == f"/api/media/{item['id']}"
    manager.set_recording("red", False)
