import json
import threading
import time

import cv2
import numpy as np
import pytest

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig
from spyder_cctv.pre_event import PreEventBuffer
from spyder_cctv.recording import RecordingService


class StaticCapture:
    def __init__(self, source):
        self.source = source

    def read(self):
        color = (20, 20, 230) if self.source == 0 else (20, 220, 20)
        return True, np.full((90, 160, 3), color, dtype=np.uint8)

    def close(self):
        pass


@pytest.fixture
def service_rig(tmp_path):
    manager = CameraManager(
        [CameraConfig("red", 0, fps=15), CameraConfig("green", 1, fps=15)],
        capture_factory=StaticCapture,
    )
    manager.pre_event_buffer = PreEventBuffer()
    service = RecordingService(manager, tmp_path)
    service.configure({"profile": "archive", "segment_minutes": 5})
    yield manager, service, tmp_path
    service.close()
    manager.close()


def wait_for(predicate, timeout=8):
    limit = time.monotonic() + timeout
    while time.monotonic() < limit:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("Condition did not become true")


def encode_color(color):
    ok, encoded = cv2.imencode(".jpg", np.full((90, 160, 3), color, dtype=np.uint8))
    assert ok
    return encoded.tobytes()


def decoded_frames(path):
    capture = cv2.VideoCapture(str(path))
    frames = []
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        frames.append(frame)
    capture.release()
    return frames


def test_real_encoder_writes_red_history_then_green_post_and_catalog_metadata(service_rig):
    manager, service, output = service_rig
    history = manager.pre_event_buffer
    history.configure({"red": 2})
    trigger = time.monotonic()
    red = encode_color((20, 20, 230))
    for offset in (0.3, 0.1):
        history.push("red", red, trigger - offset, "camera-session")

    started = service.start(
        ["red"], pre_event_seconds=2, event_trigger_time=trigger, post_event_seconds=1
    )
    assert started["requested_pre_event_seconds"] == 2
    assert started["pre_event_seconds"] >= 0.25

    green = encode_color((20, 220, 20))
    finish = threading.Event()

    def publish_post_frames():
        while not finish.is_set():
            stamp = time.monotonic()
            try:
                history.push("red", green, stamp, "camera-session")
            except ValueError:
                pass
            time.sleep(0.22)

    publisher = threading.Thread(target=publish_post_frames, daemon=True)
    publisher.start()
    try:
        wait_for(
            lambda: service.status()["state"] == "idle"
            and not service.status()["writer_active"]
        )
    finally:
        finish.set()
        publisher.join(2)
    item = next(item for item in service.status()["items"] if item["kind"] == "recording")
    frames = decoded_frames(service.media_path(item["id"]))
    assert len(frames) >= 4
    center = [frame[100:-50, 100:-50] for frame in frames]
    assert center[0][:, :, 2].mean() > center[0][:, :, 1].mean() * 2
    assert center[-1][:, :, 1].mean() > center[-1][:, :, 2].mean() * 2
    assert item["requested_pre_event_seconds"] == 2
    assert item["pre_event_seconds"] >= 0.25

    restored = RecordingService(manager, output)
    try:
        recovered = next(x for x in restored.status()["items"] if x["id"] == item["id"])
        assert recovered["requested_pre_event_seconds"] == 2
        assert recovered["pre_event_seconds"] == item["pre_event_seconds"]
    finally:
        restored.close()


def test_partial_history_reports_actual_duration_and_no_history_is_zero(service_rig):
    manager, service, _ = service_rig
    history = manager.pre_event_buffer
    history.configure({"red": 10})
    trigger = time.monotonic()
    history.push("red", encode_color((20, 20, 230)), trigger - 0.35, "s")
    partial = service.start(
        ["red"], pre_event_seconds=5, event_trigger_time=trigger, post_event_seconds=1
    )
    assert 0.3 <= partial["pre_event_seconds"] <= 0.4
    service.stop(timeout=4)
    wait_for(lambda: not service.status()["writer_active"])

    history.configure({})
    empty = service.start(
        ["red"], pre_event_seconds=2, event_trigger_time=time.monotonic(), post_event_seconds=1
    )
    assert empty["pre_event_seconds"] == 0
    wait_for(lambda: service.status()["frames"] >= 1)
    service.stop(timeout=4)
    wait_for(lambda: not service.status()["writer_active"])
    item = service.status()["items"][-1]
    assert item["requested_pre_event_seconds"] == 2
    assert item["pre_event_seconds"] == 0


def test_validation_requires_one_camera_and_valid_durations(service_rig):
    manager, service, _ = service_rig
    for value in (-1, 31, True, 1.0):
        with pytest.raises(ValueError):
            service.start(["red"], pre_event_seconds=value)
    with pytest.raises(ValueError, match="one camera"):
        service.start(["red", "green"], pre_event_seconds=1, post_event_seconds=2)
    for post in (None, 0, 301, True, 1.0):
        with pytest.raises(ValueError, match="post_event_seconds"):
            service.start(["red"], pre_event_seconds=1, post_event_seconds=post)
    assert service.status()["state"] == "idle"


def test_select_same_membership_and_explicit_takeover_cancel_auto_finish(service_rig):
    manager, service, _ = service_rig
    history = manager.pre_event_buffer
    history.configure({"red": 1})
    trigger = time.monotonic()
    history.push("red", encode_color((20, 20, 230)), trigger, "s")
    started = service.start(
        ["red"], pre_event_seconds=1, event_trigger_time=trigger, post_event_seconds=2
    )
    # Same membership still transfers ownership and cancels pre-event mode.
    service.select(["red"])
    assert service._event_end_time is None
    time.sleep(2.1)
    assert service.status()["state"] == "recording"
    service.stop(timeout=5)
    wait_for(lambda: not service.status()["writer_active"])

    trigger = time.monotonic()
    history.push("red", encode_color((20, 20, 230)), trigger, "s")
    started = service.start(
        ["red"], pre_event_seconds=1, event_trigger_time=trigger, post_event_seconds=1
    )
    assert service.cancel_event_limit(started["session_id"])
    assert not service.cancel_event_limit("different-session")
    time.sleep(1.1)
    assert service.status()["state"] == "recording"
    service.stop(timeout=5)
    wait_for(lambda: not service.status()["writer_active"])


def test_catalog_clamps_recovered_actual_history_to_duration(service_rig):
    manager, service, output = service_rig
    history = manager.pre_event_buffer
    history.configure({"red": 1})
    trigger = time.monotonic()
    history.push("red", encode_color((20, 20, 230)), trigger - 0.5, "s")
    started = service.start(
        ["red"], pre_event_seconds=1, event_trigger_time=trigger, post_event_seconds=1
    )
    wait_for(lambda: service.status()["frames"] >= 1)
    service.stop(timeout=5)
    wait_for(lambda: not service.status()["writer_active"])
    item = next(x for x in service.status()["items"] if x["kind"] == "recording")
    manifest = output / "manifest.json"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    row = next(x for x in data["items"] if x["id"] == item["id"])
    row["pre_event_seconds"] = 28
    manifest.write_text(json.dumps(data), encoding="utf-8")
    restored = RecordingService(manager, output)
    try:
        recovered = next(x for x in restored.status()["items"] if x["id"] == started["session_id"])
        assert recovered["pre_event_seconds"] <= recovered["duration_seconds"]
    finally:
        restored.close()
