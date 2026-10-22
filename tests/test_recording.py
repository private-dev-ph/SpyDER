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
    # Test camera composition, independently of an asynchronous capture's cold start.
    service.manager.get_worker("red").start()
    wait_for(lambda: service.manager.get_worker("red").jpeg() is not None)
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


def test_recording_catalog_tracks_camera_selection_and_rotation_resets_membership(
    rig, monkeypatch
):
    _, service, _ = rig
    monkeypatch.setattr(service, "_segment_frame_limit", lambda: 4)
    first_segment_saved = threading.Event()
    continue_recording = threading.Event()
    finish_segment = service._finish_segment
    paused = False

    def pause_between_segments():
        nonlocal paused
        finish_segment()
        if service.status()["segments_saved"] == 1 and not paused:
            paused = True
            first_segment_saved.set()
            assert continue_recording.wait(5)

    monkeypatch.setattr(service, "_finish_segment", pause_between_segments)
    service.start(["red"])
    assert first_segment_saved.wait(5)
    service.select(["green"])
    continue_recording.set()
    wait_for(lambda: service.status()["segments_saved"] >= 2)
    result = service.stop(timeout=10)
    clips = sorted(
        (item for item in result["items"] if item["kind"] == "recording"),
        key=lambda item: item["segment_index"],
    )
    assert len(clips) >= 2
    assert clips[0]["camera_ids"] == ["red"]
    assert clips[1]["camera_ids"] == ["green"]
    restored = RecordingService(service.manager, service.output_dir)
    assert [item["camera_ids"] for item in restored.status()["items"]] == [
        item["camera_ids"] for item in clips
    ]
    restored.close()


def test_invalid_optional_camera_metadata_does_not_discard_valid_clip(rig):
    manager, service, output = rig
    service.start(["red"])
    wait_for(lambda: service.status()["frames"] >= 3)
    item = service.stop(timeout=10)["items"][-1]
    manifest = output / "manifest.json"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    raw = next(entry for entry in data["items"] if entry["id"] == item["id"])
    raw["camera_ids"] = ["red", 7]
    manifest.write_text(json.dumps(data), encoding="utf-8")
    restored = RecordingService(manager, output)
    loaded = next(entry for entry in restored.status()["items"] if entry["id"] == item["id"])
    assert "camera_ids" not in loaded
    assert restored.media_path(item["id"]).is_file()
    restored.close()


def test_legacy_recording_catalog_keeps_camera_membership_unknown(rig):
    manager, service, output = rig
    service.start(["red"])
    wait_for(lambda: service.status()["frames"] >= 3)
    item = service.stop(timeout=10)["items"][-1]
    manifest = output / "manifest.json"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    raw = next(entry for entry in data["items"] if entry["id"] == item["id"])
    raw.pop("camera_ids", None)
    manifest.write_text(json.dumps(data), encoding="utf-8")
    restored = RecordingService(manager, output)
    loaded = next(entry for entry in restored.status()["items"] if entry["id"] == item["id"])
    assert "camera_ids" not in loaded
    assert restored.media_path(item["id"]).is_file()
    restored.close()


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

    def fail_next(camera_ids):
        if service._segment_index:
            raise RuntimeError("synthetic encoder failure")
        original(camera_ids)

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
    recovered = restored.status()["items"][0]
    assert recovered["id"] == items[0]["id"]
    assert recovered["recovered"] and recovered["keep_forever"]
    restored._save_catalog()
    assert not list(folder.glob(".*.recording.json"))
    restored.close()


def test_scheduled_commands_cannot_modify_a_manually_transferred_session(rig):
    _, service, _ = rig
    started = service.start(["red"])
    schedule_revision = started["control_revision"]
    transferred = service.select(["red"])
    assert transferred["control_revision"] > schedule_revision
    with pytest.raises(RuntimeError, match="ownership changed"):
        service.stop(expected_revision=schedule_revision)
    with pytest.raises(RuntimeError, match="ownership changed"):
        service.select(["green"], expected_revision=schedule_revision)
    assert service.status()["state"] == "recording"
    assert service.status()["camera_ids"] == ["red"]
    service.stop()


def sharing_violation():
    error = PermissionError("recording file temporarily held by another process")
    error.winerror = 32
    return error


@pytest.mark.parametrize("locked_step", ["journal", "confirmed_journal", "video", "catalog"])
def test_rotation_retries_transient_journal_lock_and_continues(rig, monkeypatch, locked_step):
    _, service, folder = rig
    original = recording_module.os.replace
    blocked = []

    def replace(source, destination):
        destination = recording_module.Path(destination)
        target = {
            "journal": destination.name.endswith(".active.json") and not destination.exists(),
            "confirmed_journal": destination.name.endswith(".active.json") and destination.exists(),
            "video": destination.suffix == ".mp4",
            "catalog": destination.name == "manifest.json",
        }[locked_step]
        if target and service._segment_index >= 1 and len(blocked) < 3:
            blocked.append(str(destination))
            raise sharing_violation()
        return original(source, destination)

    monkeypatch.setattr(recording_module.os, "replace", replace)
    monkeypatch.setattr(service, "_segment_frame_limit", lambda: 4)
    service.start(["red", "green"])
    wait_for(
        lambda: service.status()["segments_saved"] >= 2 or service.status()["state"] == "error"
    )
    result = service.stop()
    assert result["state"] == "idle", result["error"]
    assert len(blocked) == 3
    clips = [item for item in result["items"] if item["kind"] == "recording"]
    assert len(clips) >= 2
    assert clips[0]["session_id"] == clips[1]["session_id"]
    assert [item["segment_index"] for item in clips[:2]] == [1, 2]
    for item in clips[:2]:
        reader = cv2.VideoCapture(str(folder / item["filename"]))
        try:
            assert reader.read()[0]
            assert reader.get(cv2.CAP_PROP_FRAME_COUNT) == 4
        finally:
            reader.release()


def test_atomic_write_does_not_mask_replace_failure_with_cleanup(rig, monkeypatch):
    _, service, folder = rig
    original = recording_module.Path.unlink
    failure = OSError("original storage failure")

    def replace(*args):
        raise failure

    def unlink(path, *args, **kwargs):
        if path.suffix == ".tmp":
            raise sharing_violation()
        return original(path, *args, **kwargs)

    monkeypatch.setattr(recording_module.os, "replace", replace)
    monkeypatch.setattr(recording_module.Path, "unlink", unlink)
    with pytest.raises(OSError, match="original storage failure"):
        service._write_atomic(folder / "test.json", b"{}")


def test_atomic_write_permanent_permission_failure_is_not_retried(rig, monkeypatch):
    _, service, folder = rig
    calls = []
    (folder / "test.json").write_bytes(b"old")

    def replace(*args):
        calls.append(args)
        raise PermissionError("access denied")

    monkeypatch.setattr(recording_module.os, "replace", replace)
    with pytest.raises(PermissionError, match="access denied"):
        service._write_atomic(folder / "test.json", b"new")
    assert len(calls) == 1
    assert (folder / "test.json").read_bytes() == b"old"


@pytest.mark.parametrize("winerror", [32, 33])
def test_atomic_write_persistent_lock_has_bounded_retries(rig, monkeypatch, winerror):
    _, service, folder = rig
    calls, delays = [], []
    (folder / "test.json").write_bytes(b"old")

    def replace(*args):
        calls.append(args)
        error = sharing_violation()
        error.winerror = winerror
        raise error

    monkeypatch.setattr(recording_module.os, "replace", replace)
    monkeypatch.setattr(recording_module.time, "sleep", delays.append)
    with pytest.raises(PermissionError):
        service._write_atomic(folder / "test.json", b"new")
    assert len(calls) == 8
    assert sum(delays) == pytest.approx(3.15)
    assert (folder / "test.json").read_bytes() == b"old"


def test_persistent_video_lock_preserves_first_clip_and_reports_lock(rig, monkeypatch):
    _, service, folder = rig
    original = recording_module.os.replace

    def replace(source, destination):
        if str(destination).endswith(".mp4") and service._segment_index >= 1:
            raise sharing_violation()
        return original(source, destination)

    monkeypatch.setattr(recording_module.os, "replace", replace)
    monkeypatch.setattr(service, "_segment_frame_limit", lambda: 4)
    service.start(["red"])
    wait_for(lambda: service._thread is None, timeout=30)
    result = service.status()
    assert result["state"] == "error"
    assert "file locked after retries" in result["error"]
    assert result["segments_saved"] == 1
    first = result["items"][0]
    assert (folder / first["filename"]).is_file()
    assert result["recovery"]["pending"]
    partials = list(folder.glob(".*.partial.mp4"))
    assert len(partials) == 1
    reader = cv2.VideoCapture(str(partials[0]))
    try:
        assert reader.read()[0]
    finally:
        reader.release()


def test_completed_journal_cleanup_failure_does_not_stop_next_clip(rig, monkeypatch):
    _, service, _ = rig
    original = recording_module.Path.unlink

    def unlink(path, *args, **kwargs):
        if path.name.endswith(".active.json"):
            raise PermissionError("journal cleanup denied")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(recording_module.Path, "unlink", unlink)
    monkeypatch.setattr(service, "_segment_frame_limit", lambda: 4)
    service.start(["red"])
    wait_for(lambda: service.status()["segments_saved"] >= 2, timeout=15)
    assert service.stop(timeout=15)["state"] == "idle"
    assert len(service.status()["items"]) >= 2


@pytest.mark.skipif(recording_module.os.name != "nt", reason="Windows file sharing semantics")
def test_atomic_write_survives_real_windows_file_handle_lock(rig, monkeypatch):
    import ctypes
    from ctypes import wintypes

    _, service, folder = rig
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    original = recording_module.os.replace
    timer = None
    failures = []

    def replace(source, destination):
        nonlocal timer
        if timer is None:
            # Permit reads/writes, but deny rename/delete just like an external reader.
            handle = kernel.CreateFileW(str(source), 0x80000000, 3, None, 3, 0x80, None)
            assert handle != wintypes.HANDLE(-1).value, ctypes.get_last_error()
            timer = threading.Timer(0.2, lambda: kernel.CloseHandle(handle))
            timer.start()
        try:
            return original(source, destination)
        except PermissionError as error:
            failures.append(error.winerror)
            raise

    monkeypatch.setattr(recording_module.os, "replace", replace)
    try:
        service._write_atomic(folder / "test.json", b"durable metadata")
    finally:
        if timer is not None:
            timer.join()
    assert failures and set(failures) == {32}
    assert (folder / "test.json").read_bytes() == b"durable metadata"


def test_recording_keeps_session_during_camera_disconnect_and_recovery(tmp_path):
    dropped, restored = threading.Event(), threading.Event()

    class Capture(ColorCapture):
        def read(self):
            if self.source == 0 and dropped.is_set() and not restored.is_set():
                return False, None
            return super().read()

    manager = CameraManager(
        [CameraConfig("red", 0, fps=15), CameraConfig("green", 1, fps=15)],
        capture_factory=Capture,
    )
    manager.get_worker("red")._reconnect_delay = lambda attempt: 0.05
    service = RecordingService(manager, tmp_path)
    try:
        service.start(["red", "green"])
        wait_for(lambda: service.status()["frames"] >= 3)
        session = service.status()["session_id"]
        dropped.set()
        wait_for(lambda: manager.get_worker("red").status()["state"] == "reconnecting")
        frames = service.status()["frames"]
        wait_for(lambda: service.status()["frames"] >= frames + 3)
        assert service.status()["state"] == "recording"
        assert manager.get_worker("red").jpeg() is None
        restored.set()
        wait_for(lambda: manager.get_worker("red").status()["state"] == "running")
        wait_for(lambda: service.status()["frames"] >= frames + 6)
        assert service.status()["session_id"] == session
        result = service.stop(timeout=15)
        assert result["state"] == "idle" and result["error"] is None
        item = result["items"][-1]
        reader = cv2.VideoCapture(str(service.media_path(item["id"])))
        try:
            assert reader.read()[0]
        finally:
            reader.release()
    finally:
        service.close()
        manager.close()
