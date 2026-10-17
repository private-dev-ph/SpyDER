import json
import os
import struct
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime

import cv2
import numpy as np
import pytest

from spyder_cctv.recording import RecordingService
from spyder_cctv.recording_profiles import DEFAULT_SETTINGS, PROFILES, validate_settings
from spyder_cctv.recording_recovery import (
    RecordingLease,
    complete_fragment_end,
    encoder_running,
    process_identity,
    recover_fragmented_file,
)
from spyder_cctv.video_encoder import H264Writer


class Manager:
    workers = {"camera": object()}

    def set_recording(self, camera_id, value):
        pass


def active_metadata(folder, ident=None):
    ident = ident or uuid.uuid4().hex
    item = {
        "id": ident,
        "kind": "recording",
        "format_version": 1,
        "filename": f"{ident}.mp4",
        "session_id": ident,
        "segment_index": 1,
        "created_at": datetime.now(UTC).isoformat(),
        "profile": "archive",
        "encoder_pid": 2147483647,
    }
    (folder / f".{ident}.active.json").write_text(json.dumps(item), encoding="utf-8")
    return item


def video_file(folder, frames=30):
    item = active_metadata(folder)
    path = folder / f".{item['id']}.partial.mp4"
    writer = H264Writer(path, PROFILES["archive"])
    for index in range(frames):
        writer.write(np.full((360, 640, 3), (index * 3) % 255, np.uint8))
    writer.release()
    return item, path


def test_all_extended_clip_lengths_and_six_hour_default():
    assert DEFAULT_SETTINGS["segment_minutes"] == 360
    for minutes in (5, 15, 30, 60, 180, 360, 720, 1440):
        assert (
            validate_settings({"profile": "efficient", "segment_minutes": minutes})[
                "segment_minutes"
            ]
            == minutes
        )
    for minutes in (2, 179, 1441, True):
        with pytest.raises(ValueError):
            validate_settings({"profile": "archive", "segment_minutes": minutes})


def test_complete_fragments_recover_without_copying_the_full_recording(tmp_path):
    item, path = video_file(tmp_path)
    original = path.read_bytes()
    with path.open("ab") as output:
        output.write(struct.pack(">I4s", 100000, b"moof") + b"incomplete-tail")
    size = path.stat().st_size
    metadata = recover_fragmented_file(path)
    assert metadata["duration_seconds"] >= 8
    assert path.stat().st_size < size
    assert path.read_bytes() == original
    assert path.with_name(path.name + ".interrupted-tail").read_bytes().endswith(b"incomplete-tail")
    assert recover_fragmented_file(path) == metadata


def test_startup_recovers_protects_and_is_idempotent(tmp_path):
    item, path = video_file(tmp_path)
    restored = RecordingService(Manager(), tmp_path)
    recovered = restored.status()["items"]
    assert len(recovered) == 1 and recovered[0]["id"] == item["id"]
    assert recovered[0]["keep_forever"] and recovered[0]["recovered"]
    assert restored.status()["recovery"]["recovered"] == [item["id"]]
    assert not path.exists()
    video = cv2.VideoCapture(str(restored.media_path(item["id"])))
    assert video.read()[0]
    video.release()
    restored.close()
    again = RecordingService(Manager(), tmp_path)
    assert again.status()["items"] == recovered
    assert again.status()["recovery"]["recovered"] == []
    again.close()


def test_corrupt_and_legacy_partials_remain_untouched(tmp_path):
    item = active_metadata(tmp_path)
    path = tmp_path / f".{item['id']}.partial.mp4"
    payload = b"not recoverable video"
    path.write_bytes(payload)
    legacy = tmp_path / f".{uuid.uuid4().hex}.partial.mp4"
    legacy.write_bytes(b"legacy original")
    for _ in range(2):
        service = RecordingService(Manager(), tmp_path)
        assert service.status()["items"] == []
        assert service.status()["recovery"]["pending"]
        service.close()
    assert path.read_bytes() == payload and legacy.read_bytes() == b"legacy original"


def test_recording_lease_prevents_recovery_and_parallel_writer(tmp_path):
    item, path = video_file(tmp_path)
    lease = RecordingLease(tmp_path)
    lease.acquire()
    try:
        service = RecordingService(Manager(), tmp_path)
        assert not service.status()["items"] and path.is_file()
        with pytest.raises(RuntimeError, match="Another recording"):
            service.start(["camera"])
        service.close()
    finally:
        lease.release()
    service = RecordingService(Manager(), tmp_path)
    assert service.status()["items"][0]["id"] == item["id"]
    service.close()


def test_live_encoder_metadata_defers_recovery(tmp_path):
    item, path = video_file(tmp_path)
    item.update(encoder_pid=os.getpid(), encoder_birth=process_identity(os.getpid())[1])
    (tmp_path / f".{item['id']}.active.json").write_text(json.dumps(item), encoding="utf-8")
    assert encoder_running(item)
    service = RecordingService(Manager(), tmp_path)
    assert path.exists() and service.status()["items"] == []
    assert any("still closing" in warning for warning in service.status()["recovery"]["pending"])
    service.close()


CRASH_CHILD = r"""
import json,os,sys,time,threading
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import spyder_cctv.recording as module
from spyder_cctv.recording import RecordingService
class Manager:
    workers={"camera":object()}
    def set_recording(self,*args): pass
folder=Path(sys.argv[1])
service=RecordingService(Manager(),folder)
service.configure({"profile":"archive","segment_minutes":360})
clock=[100.0]
module.time=SimpleNamespace(monotonic=lambda:clock[0])
def samples(ids):
    if service._frames >= 60:
        temporary=folder/"ready.tmp"
        temporary.write_text(json.dumps(service._recovery))
        os.replace(temporary,folder/"ready")
        threading.Event().wait(60)
    clock[0]+=1/3
    return [np.full((90,160,3),(20,50,180),np.uint8)]
service._samples=samples
service.start(["camera"])
while not (folder/"kill").exists(): time.sleep(.02)
service._writer._process.kill()
os._exit(87)
"""


def test_real_app_and_encoder_hard_kill_recovers_active_six_hour_clip(tmp_path):
    process = subprocess.Popen(
        [sys.executable, "-u", "-c", CRASH_CHILD, str(tmp_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 25
        while not (tmp_path / "ready").exists():
            assert process.poll() is None, "Synthetic recording child exited early"
            if time.monotonic() > deadline:
                pytest.fail("Synthetic crash recording did not become ready")
            time.sleep(0.03)
        assert json.loads((tmp_path / "ready").read_text())["durability_warning"] is None
        metadata = json.loads(next(tmp_path.glob(".*.active.json")).read_text(encoding="utf-8"))
        path = tmp_path / f".{metadata['id']}.partial.mp4"
        assert complete_fragment_end(path) > 0
        (tmp_path / "kill").write_text("kill", encoding="utf-8")
        assert process.wait(timeout=5) == 87
        deadline = time.monotonic() + 5
        while encoder_running(metadata) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not encoder_running(metadata)
        restored = RecordingService(Manager(), tmp_path)
        try:
            item = restored.status()["items"][0]
            assert item["duration_seconds"] >= 14
            assert item["keep_forever"] and item["recovered"]
            video = cv2.VideoCapture(str(restored.media_path(item["id"])))
            assert video.read()[0]
            video.release()
        finally:
            restored.close()
    finally:
        if process.poll() is None:
            (tmp_path / "kill").write_text("kill", encoding="utf-8")
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def test_unconfirmed_encoder_launch_is_retained(tmp_path):
    item, path = video_file(tmp_path)
    item.pop("encoder_pid")
    (tmp_path / f".{item['id']}.active.json").write_text(json.dumps(item), encoding="utf-8")
    original = path.read_bytes()
    service = RecordingService(Manager(), tmp_path)
    assert not service.status()["items"]
    assert "launch was not confirmed" in service.status()["recovery"]["pending"][0]
    assert path.read_bytes() == original
    service.close()


def test_failed_decode_restores_original_tail(tmp_path, monkeypatch):
    _, path = video_file(tmp_path)
    with path.open("ab") as output:
        output.write(struct.pack(">I4s", 1000, b"moof") + b"uncertain original tail")
    original = path.read_bytes()

    class Unreadable:
        def get(self, _):
            return 0

        def read(self):
            return False, None

        def release(self):
            pass

    monkeypatch.setattr(cv2, "VideoCapture", lambda _: Unreadable())
    with pytest.raises(ValueError, match="cannot be decoded"):
        recover_fragmented_file(path)
    assert path.read_bytes() == original
    assert path.with_name(path.name + ".interrupted-tail").exists()
