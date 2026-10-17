import json
import threading
import time

import cv2
import numpy as np
import pytest

import spyder_cctv.recording as recording_module
from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig
from spyder_cctv.events import EventService
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


def test_previous_output_folders_remain_readable_without_rewriting_catalogs(rig):
    manager, original, folder = rig
    for camera_id in ("red", "green"):
        manager.set_recording(camera_id, True)
        wait_for(lambda camera_id=camera_id: manager.get_worker(camera_id).jpeg() is not None)
    capture = original.capture(["red"])
    store = EventService(folder / "event-data", original)
    event = store.create(
        name="Archived capture",
        kind="workflow",
        camera_id="red",
        camera_name="Red",
        media=[capture],
    )
    manifest_before = (folder / "manifest.json").read_bytes()
    replacement = RecordingService(manager, folder / "new-output", archive_dirs=[folder])
    try:
        assert capture["id"] in {item["id"] for item in replacement.status()["items"]}
        restored = EventService(folder / "event-data", replacement)
        assert restored.list()["events"][0]["id"] == event["id"]
        assert restored.list()["events"][0]["media"][0]["id"] == capture["id"]
        assert restored.media_path(capture["id"]) == original.media_path(capture["id"])
        assert replacement.media_path(capture["id"]) == folder / capture["filename"]
        fresh = replacement.capture(["green"])
        assert replacement.media_path(fresh["id"]).parent == folder / "new-output"
        assert (folder / "manifest.json").read_bytes() == manifest_before
        active_catalog = json.loads((folder / "new-output" / "manifest.json").read_text())
        assert [item["id"] for item in active_catalog["items"]] == [fresh["id"]]
        with pytest.raises(KeyError):
            replacement.media_path("../manifest.json")
    finally:
        replacement.close()


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
    wait_for(lambda: service.manager.get_worker("green").jpeg() is not None)
    two_start = service.status()["frames"]
    wait_for(lambda: service.status()["frames"] >= two_start + 10)
    service.select(["green"])
    single_start = service.status()["frames"]
    wait_for(lambda: service.status()["frames"] >= single_start + 10)
    assert service.stop()["state"] == "idle"

    item = service.status()["items"][-1]
    path = service.media_path(item["id"])
    capture = cv2.VideoCapture(str(path))
    assert capture.isOpened()
    frames = []
    while len(frames) < 500:
        ok, frame = capture.read()
        if not ok:
            break
        frames.append(frame)
    capture.release()
    assert len(frames) >= 25
    height, width = service.status()["height"], service.status()["width"]
    assert frames[0].shape[:2] == (height, width)
    center = frames[0][height // 3 : height * 2 // 3]
    if center[:, :, 2].mean() < center[:, :, 1].mean() * 2:
        center = frames[1][height // 3 : height * 2 // 3]
    assert center[:, :, 2].mean() > center[:, :, 1].mean() * 2

    # Encoder startup/catch-up can repeat frames; verify a real two-camera stage,
    # rather than assuming that it always occupies frame 10 on every machine.
    def has_both(frame):
        middle = frame[height // 3 : height * 2 // 3]
        return (
            middle[:, : width // 2, 2].mean() > middle[:, : width // 2, 1].mean() * 2
            and middle[:, width // 2 :, 1].mean() > middle[:, width // 2 :, 2].mean() * 2
        )

    assert any(has_both(frame) for frame in frames)
    middle = frames[-1][height // 3 : height * 2 // 3]
    assert middle[:, :, 1].mean() > middle[:, :, 2].mean() * 2
    assert item["size_bytes"] == path.stat().st_size


def test_low_storage_stops_and_saves_existing_frames(rig, monkeypatch):
    manager, service, _ = rig
    service.start(["red"])
    wait_for(lambda: service.status()["frames"] >= 3)
    monkeypatch.setattr(
        recording_module.shutil, "disk_usage", lambda path: type("Disk", (), {"free": 0})()
    )
    wait_for(lambda: service.status()["state"] == "idle")
    assert service.status()["error"] == "Recording saved and stopped: less than 64 MiB free"
    assert service.status()["items"][-1]["kind"] == "recording"
    assert manager.statuses()[0]["recording"] is False
    with pytest.raises(RuntimeError, match="free local storage"):
        service.start(["red"])


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


def test_encoder_open_failure_releases_retention_without_large_fallback(rig, monkeypatch):
    manager, service, _ = rig

    def fail(*args):
        raise RuntimeError("missing encoder")

    monkeypatch.setattr(recording_module, "H264Writer", fail)
    service.start(["red"])
    wait_for(lambda: service.status()["state"] == "error" and not service._thread)
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

    monkeypatch.setattr(recording_module, "H264Writer", BlockingWriter)
    service.start(["red"])
    assert entered.wait(3)
    before = time.monotonic()
    result = service.stop(timeout=0.05)
    assert time.monotonic() - before < 0.5
    assert result["state"] == "stopping"
    assert service.status()["state"] == "stopping"
    frozen_elapsed = service.status()["elapsed_seconds"]
    time.sleep(0.05)
    assert service.status()["elapsed_seconds"] == frozen_elapsed
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

    monkeypatch.setattr(recording_module, "H264Writer", lambda *args: FailingWriter())
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


def test_storage_settings_validate_persist_and_lock_during_recording(rig):
    manager, service, folder = rig
    for value in (
        {},
        {"profile": "unknown", "segment_minutes": 15},
        {"profile": "archive", "segment_minutes": True},
        {"profile": "archive", "segment_minutes": 0},
    ):
        with pytest.raises(ValueError):
            service.configure(value)
    result = service.configure({"profile": "archive", "segment_minutes": 5})
    assert result["storage"]["estimated_day_bytes"] == 691200000
    assert result["storage"]["estimated_clip_bytes"] == 2400000
    restored = RecordingService(manager, folder)
    assert restored.status()["storage"] == result["storage"]
    restored.close()
    service.start(["red"])
    with pytest.raises(RuntimeError, match="Stop recording"):
        service.configure({"profile": "detail", "segment_minutes": 15})
    service.stop()


def test_rotating_clips_are_decodable_share_session_and_survive_restart(rig, monkeypatch):
    manager, service, folder = rig
    service.configure({"profile": "archive", "segment_minutes": 15})
    # Accelerate clip boundaries without weakening public settings validation.
    monkeypatch.setattr(service, "_segment_frame_limit", lambda: 3)
    started = service.start(["red"])
    wait_for(lambda: len(service.status()["items"]) >= 1)
    first = service.status()["items"][0]
    assert service.status()["state"] == "recording"
    assert manager.statuses()[0]["recording"]
    service.select(["red", "green"])
    wait_for(lambda: len(service.status()["items"]) >= 2)
    done = service.stop()
    clips = done["items"]
    assert len(clips) >= 2
    assert {item["session_id"] for item in clips} == {started["session_id"]}
    assert [item["segment_index"] for item in clips] == list(range(1, len(clips) + 1))
    assert first["id"] == started["session_id"]
    for item in clips:
        video = cv2.VideoCapture(str(service.media_path(item["id"])))
        ok, frame = video.read()
        assert ok and frame.shape[:2] == (360, 640)
        assert video.get(cv2.CAP_PROP_FPS) == 3
        video.release()
    restored = RecordingService(manager, folder)
    assert restored.status()["items"] == clips
    restored.close()
    assert not list(folder.glob("*.partial.*"))


def test_completed_clips_survive_later_encoder_failure(rig, monkeypatch):
    _, service, folder = rig
    monkeypatch.setattr(service, "_segment_frame_limit", lambda: 2)
    original = service._open_writer

    def fail_next():
        if service._segment_index:
            raise RuntimeError("synthetic encoder failure")
        original()

    monkeypatch.setattr(service, "_open_writer", fail_next)
    service.start(["red"])
    wait_for(lambda: service.status()["state"] == "error" and not service._thread)
    assert len(service.status()["items"]) == 1
    assert service.media_path(service.status()["items"][0]["id"]).is_file()
    assert not list(folder.glob("*.partial.*"))


def test_slow_sampling_preserves_elapsed_video_time(rig, monkeypatch):
    from types import SimpleNamespace

    _, service, _ = rig
    original = service._samples
    clock = [100.0]
    # Advance capture time deterministically; host disk/encoder load must not
    # decide whether the catch-up algorithm preserves the sampled timeline.
    monkeypatch.setattr(recording_module, "time", SimpleNamespace(monotonic=lambda: clock[0]))

    def slow(ids):
        clock[0] += 0.35
        time.sleep(0.01)
        return original(ids)

    monkeypatch.setattr(service, "_samples", slow)
    service.start(["red"])
    wait_for(lambda: service.status()["frames"] >= 10)
    done = service.stop()
    duration = sum(item["duration_seconds"] for item in done["items"])
    assert abs(duration - done["elapsed_seconds"]) < 0.6


def test_h264_encoder_is_playable_and_compact_on_noisy_frames(tmp_path):
    from spyder_cctv.recording_profiles import PROFILES
    from spyder_cctv.video_encoder import H264Writer

    path = tmp_path / "noise.mp4"
    writer = H264Writer(path, PROFILES["archive"])
    random = np.random.default_rng(42)
    for _ in range(90):
        writer.write(random.integers(0, 256, (360, 640, 3), dtype=np.uint8))
    writer.release()
    video = cv2.VideoCapture(str(path))
    assert video.isOpened()
    assert int(video.get(cv2.CAP_PROP_FRAME_COUNT)) == 90
    assert int(video.get(cv2.CAP_PROP_FOURCC)) in {
        cv2.VideoWriter_fourcc(*name) for name in ("avc1", "h264", "H264")
    }
    assert video.read()[0]
    video.release()
    # 30 seconds of high-entropy footage at a 64 kbit/s target, with overhead allowance.
    assert 1000 < path.stat().st_size < 400000


def test_finalized_video_recovers_if_manifest_commit_fails(rig, monkeypatch):
    manager, service, folder = rig

    def fail_catalog():
        raise OSError("synthetic disk failure")

    monkeypatch.setattr(service, "_save_catalog", fail_catalog)
    service.start(["red"])
    wait_for(lambda: service.status()["frames"] >= 2)
    assert service.stop()["state"] == "error"
    items = service.status()["items"]
    assert len(items) == 1
    assert list(folder.glob(".*.recording.json"))
    restored = RecordingService(manager, folder)
    assert restored.status()["items"] == items
    restored._save_catalog()
    assert not list(folder.glob(".*.recording.json"))
    restored.close()
