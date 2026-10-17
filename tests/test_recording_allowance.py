import hashlib
import json
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta

import cv2
import numpy as np
import pytest

import spyder_cctv.recording_allowance as allowance_module
from spyder_cctv.recording import RecordingService
from spyder_cctv.recording_allowance import FINALIZE_RESERVE, MIN_ALLOWANCE, validate_policy
from spyder_cctv.video_encoder import compress_recording

MIB = 1024**2


class Manager:
    def __init__(self):
        self.workers = {"cam": self}
        self.retained = set()
        self.image = cv2.imencode(".jpg", np.full((90, 160, 3), 120, np.uint8))[1].tobytes()

    def set_recording(self, camera_id, active):
        if active:
            self.retained.add(camera_id)
        else:
            self.retained.discard(camera_id)

    def get_worker(self, camera_id):
        return self

    def jpeg(self):
        return self.image

    def status(self):
        return {"frame_age_seconds": 0}


@pytest.fixture
def service(tmp_path):
    instance = RecordingService(Manager(), tmp_path)
    yield instance
    instance.close()


def wait(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("Storage policy did not settle")


def file_of_size(path, size):
    with path.open("wb") as output:
        output.truncate(size)


def add_recording(service, size=25 * MIB, *, age=0, keep=False):
    ident = uuid.uuid4().hex
    file_of_size(service.output_dir / f"{ident}.mp4", size)
    item = service._new_item(
        ident,
        "recording",
        f"{ident}.mp4",
        size_bytes=size,
        duration_seconds=2,
        keep_forever=keep,
        created_at=(datetime.now(UTC) - timedelta(days=age)).isoformat(),
    )
    service._items[ident] = item
    service._save_catalog()
    return item


def test_allowance_validation_persistence_and_fail_closed(service):
    for value in (
        {},
        {"max_bytes": True, "action": "delete"},
        {"max_bytes": -1, "action": "stop"},
        {"max_bytes": 1, "action": "stop"},
        {"max_bytes": 0, "action": "unknown"},
    ):
        with pytest.raises(ValueError):
            validate_policy(value)
    assert (
        service.allowance.configure({"max_bytes": MIN_ALLOWANCE, "action": "stop"})["max_bytes"]
        == MIN_ALLOWANCE
    )
    restored = RecordingService(service.manager, service.output_dir)
    assert restored.allowance.snapshot()["max_bytes"] == MIN_ALLOWANCE
    restored.close()
    service.allowance.path.write_text("{bad", encoding="utf-8")
    restored = RecordingService(service.manager, service.output_dir)
    assert restored.allowance.snapshot()["blocked"]
    with pytest.raises(RuntimeError, match="storage"):
        restored.start(["cam"])
    restored.close()


def test_delete_policy_skips_kept_and_current_and_deletes_oldest(service):
    protected = add_recording(service, age=4, keep=True)
    oldest = add_recording(service, age=3)
    newest = add_recording(service, age=1)
    service._segment_id = newest["id"]
    status = service.allowance.configure({"max_bytes": MIN_ALLOWANCE, "action": "delete"})
    assert status["used_bytes"] == 50 * MIB
    assert service.media_path(protected["id"]).is_file()
    assert service.media_path(newest["id"]).is_file()
    with pytest.raises(KeyError):
        service.media_path(oldest["id"])
    assert len(service.allowance.alerts) == 1
    assert not status["blocked"]


def test_keep_forever_survives_restart_and_stale_recovery_journal(service):
    item = add_recording(service)
    service.allowance.keep(item["id"], True)
    journal = service.output_dir / f".{item['id']}.recording.json"
    journal.write_text(json.dumps({**item, "keep_forever": False}), encoding="utf-8")
    restored = RecordingService(service.manager, service.output_dir)
    assert restored.status()["items"][0]["keep_forever"] is True
    assert restored.allowance.snapshot()["protected_bytes"] == item["size_bytes"]
    with pytest.raises(RuntimeError, match="Protected"):
        restored.allowance.delete(item["id"])
    restored.close()


def test_stop_policy_saves_current_clip_and_blocks_future_starts_once(service):
    service.allowance.configure({"max_bytes": MIN_ALLOWANCE, "action": "stop"})
    service.start(["cam"])
    wait(lambda: service.status()["frames"] >= 3)
    file_of_size(service.output_dir / "unmanaged.mp4", MIN_ALLOWANCE - FINALIZE_RESERVE)
    wait(lambda: service.status()["state"] == "idle")
    done = service.status()
    assert "saved and stopped" in done["error"]
    assert len(done["items"]) == 1
    reader = cv2.VideoCapture(str(service.media_path(done["items"][0]["id"])))
    assert reader.read()[0]
    reader.release()
    for _ in range(3):
        with pytest.raises(RuntimeError, match="storage"):
            service.start(["cam"])
    assert not service.manager.retained
    assert len(service.allowance.alerts) == 1
    (service.output_dir / "unmanaged.mp4").unlink()
    assert not service.allowance.retry()["blocked"]
    service.start(["cam"])
    service.stop()


def test_no_eligible_recording_blocks_without_deleting_protected_or_unknown(service):
    kept = add_recording(service, size=40 * MIB, keep=True)
    unknown = service.output_dir / "unknown.mp4"
    file_of_size(unknown, 25 * MIB)
    status = service.allowance.configure({"max_bytes": MIN_ALLOWANCE, "action": "delete"})
    assert status["blocked"]
    assert unknown.exists() and service.media_path(kept["id"]).exists()
    with pytest.raises(RuntimeError):
        service.start(["cam"])


def test_scope_excludes_captures_and_previous_folders(service, tmp_path):
    file_of_size(service.output_dir / "capture.jpg", 80 * MIB)
    archived = tmp_path / "older"
    archived.mkdir()
    file_of_size(archived / "older.mp4", 80 * MIB)
    assert (
        service.allowance.configure({"max_bytes": MIN_ALLOWANCE, "action": "delete"})["used_bytes"]
        == 0
    )


def test_delete_permission_failure_blocks_without_touching_other_clips(service, monkeypatch):
    first = add_recording(service, size=40 * MIB, age=1)
    second = add_recording(service, size=30 * MIB)

    def denied(_):
        raise PermissionError("in use")

    monkeypatch.setattr(service.allowance, "_delete", denied)
    status = service.allowance.configure({"max_bytes": MIN_ALLOWANCE, "action": "delete"})
    assert status["blocked"] and status["error"]
    assert service.media_path(first["id"]).exists() and service.media_path(second["id"]).exists()


def test_manual_delete_reclaims_space_but_rejects_protected_and_archives(service):
    item = add_recording(service)
    service._segment_id = item["id"]
    assert service.allowance.delete(item["id"])["used_bytes"] == 0
    with pytest.raises(KeyError):
        service.allowance.keep("../outside", True)
    capture = service.capture(["cam"])
    with pytest.raises(ValueError):
        service.allowance.keep(capture["id"], True)


def noisy_video(service):
    item = add_recording(service, size=1)
    path = service.media_path(item["id"])
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 15, (640, 360))
    assert writer.isOpened()
    rng = np.random.default_rng(22)
    for _ in range(30):
        writer.write(rng.integers(0, 256, (360, 640, 3), np.uint8))
    writer.release()
    item.update(size_bytes=path.stat().st_size, fps=15, bitrate_kbps=2000, profile="detail")
    service._save_catalog()
    return item


def test_real_recompression_validates_smaller_video_and_persists_metadata(service):
    item = noisy_video(service)
    original_size = item["size_bytes"]
    file_of_size(service.output_dir / "unmanaged.mp4", 59 * MIB)
    service.allowance.configure({"max_bytes": MIN_ALLOWANCE, "action": "compress"})
    wait(lambda: service.allowance.phase != "compressing")
    updated = service._items[item["id"]]
    assert updated["compressed"] and updated["size_bytes"] < original_size * 0.95
    assert not service.allowance.snapshot()["blocked"]
    restored = RecordingService(service.manager, service.output_dir)
    recovered = next(x for x in restored.status()["items"] if x["id"] == item["id"])
    assert recovered["width"] == 640 and recovered["height"] == 360
    assert recovered["fps"] == 3 and recovered["compression_attempted"]
    restored.close()


def test_failed_recompression_preserves_original_and_never_deletes(service, monkeypatch):
    item = add_recording(service, size=65 * MIB)
    path = service.media_path(item["id"])
    before = path.stat().st_size
    calls = []

    def failed(*args):
        calls.append(True)
        raise RuntimeError("encoder failed")

    monkeypatch.setattr(allowance_module, "compress_recording", failed)
    service.allowance.configure({"max_bytes": MIN_ALLOWANCE, "action": "compress"})
    wait(lambda: service.allowance.phase != "compressing")
    assert len(calls) == 1 and path.stat().st_size == before
    assert service.allowance.snapshot()["blocked"]
    service.allowance.permit()
    assert len(calls) == 1


def test_keep_during_recompression_prevents_replacement(service, monkeypatch):
    item = add_recording(service, size=65 * MIB)
    entered, finish = threading.Event(), threading.Event()

    def delayed(source, target, metadata, cancel):
        entered.set()
        assert finish.wait(4)
        target.write_bytes(b"small")
        return {"fps": 3, "width": 640, "height": 360, "bitrate_kbps": 64}

    monkeypatch.setattr(allowance_module, "compress_recording", delayed)
    service.allowance.configure({"max_bytes": MIN_ALLOWANCE, "action": "compress"})
    assert entered.wait(2)
    service.allowance.keep(item["id"], True)
    finish.set()
    wait(lambda: service.allowance.phase != "compressing")
    assert service.media_path(item["id"]).stat().st_size == 65 * MIB
    assert not service._items[item["id"]].get("compressed")


def test_cancelled_recompression_leaves_source_unchanged(service):
    item = noisy_video(service)
    source = service.media_path(item["id"])
    before = hashlib.sha256(source.read_bytes()).digest()
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(RuntimeError, match="cancelled"):
        compress_recording(source, service.output_dir / "cancelled.mp4", item, cancel)
    assert hashlib.sha256(source.read_bytes()).digest() == before


def test_unavailable_drive_blocks_status_and_start_and_emits_one_alert(service, monkeypatch):
    def unavailable(path):
        raise OSError("drive disconnected")

    monkeypatch.setattr(allowance_module.shutil, "disk_usage", unavailable)
    assert service.status()["allowance"]["blocked"]
    assert service.status()["allowance"]["error"]
    with pytest.raises(RuntimeError, match="unavailable"):
        service.start(["cam"])
    assert len(service.allowance.alerts) == 1
    assert not service.manager.retained


def test_unhelpful_recompression_is_not_retried_or_replaced(service, monkeypatch):
    item = add_recording(service, size=65 * MIB)
    called = []

    def larger(source, target, metadata, cancel):
        called.append(True)
        file_of_size(target, 66 * MIB)
        return {"width": 640, "height": 360, "fps": 3, "bitrate_kbps": 64}

    monkeypatch.setattr(allowance_module, "compress_recording", larger)
    service.allowance.configure({"max_bytes": MIN_ALLOWANCE, "action": "compress"})
    wait(lambda: service.allowance.phase != "compressing")
    assert service._items[item["id"]]["compression_attempted"]
    assert not service._items[item["id"]].get("compressed")
    assert service.media_path(item["id"]).stat().st_size == 65 * MIB
    service.allowance.retry()
    assert len(called) == 1


def test_recompression_catalog_failure_recovers_replacement_after_restart(service, monkeypatch):
    item = noisy_video(service)
    file_of_size(service.output_dir / "unmanaged.mp4", 59 * MIB)

    def fail():
        raise OSError("catalog unavailable")

    monkeypatch.setattr(service, "_save_catalog", fail)
    service.allowance.configure({"max_bytes": MIN_ALLOWANCE, "action": "compress"})
    wait(lambda: service.allowance.phase != "compressing")
    assert service.allowance.snapshot()["blocked"]
    restored = RecordingService(service.manager, service.output_dir)
    restored_item = next(x for x in restored.status()["items"] if x["id"] == item["id"])
    assert restored_item["compressed"]
    assert restored_item["size_bytes"] == restored.media_path(item["id"]).stat().st_size
    restored.close()


def test_quota_guard_interrupts_long_catchup_batch_and_saves_clip(service, monkeypatch):
    original = service._samples

    def after_sleep(ids):
        service._started = time.monotonic() - 100
        return original(ids)

    monkeypatch.setattr(service, "_samples", after_sleep)
    monkeypatch.setattr(service.allowance, "permit", lambda **kwargs: service._frames < 10)
    service.start(["cam"])
    wait(lambda: service.status()["state"] == "idle")
    assert service.status()["frames"] == 10
    assert len(service.status()["items"]) == 1
