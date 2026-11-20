import json
from datetime import datetime
from types import SimpleNamespace

import pytest

from spyder_cctv.schedules import RecordingSchedules


class Manager:
    def __init__(self):
        self.workers = {"a": object(), "b": object(), "c": object()}


class Recorder:
    def __init__(self):
        self.revision = 0
        self.session_id = None
        self.camera_ids = []
        self.state = "idle"
        self.starts = []
        self.stops = 0

    def status(self):
        return {
            "state": self.state,
            "session_id": self.session_id,
            "camera_ids": list(self.camera_ids),
            "control_revision": self.revision,
        }

    def start(self, camera_ids):
        if self.state != "idle":
            raise RuntimeError("active")
        self.revision += 1
        self.session_id = f"session-{self.revision}"
        self.camera_ids = list(camera_ids)
        self.state = "recording"
        self.starts.append(list(camera_ids))
        return self.status()

    def select(self, camera_ids):
        self.revision += 1
        self.camera_ids = list(camera_ids)
        return self.status()

    def stop(self):
        self.revision += 1
        self.state = "idle"
        self.camera_ids = []
        self.stops += 1
        return self.status()


def rule(ident, cameras, days=(0,), start="09:00", end="10:00", enabled=True):
    return {
        "id": ident,
        "name": ident,
        "enabled": enabled,
        "camera_ids": list(cameras),
        "days": list(days),
        "start": start,
        "end": end,
    }


def controller(tmp_path):
    return Manager(), Recorder(), tmp_path / "schedules.json"


def make_schedules(manager, recorder, path):
    return RecordingSchedules(
        manager, recorder, path, autostart=False, clock=lambda: datetime(2026, 10, 19, 12, 0)
    )


def test_union_overlapping_rules_start_once_and_stop_owned_session(tmp_path):
    manager, recorder, path = controller(tmp_path)
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule("one", ["a", "b"]), rule("two", ["b", "c"])])
    schedules.tick(datetime(2026, 10, 19, 9, 30))
    assert recorder.starts == [["a", "b", "c"]]
    schedules.tick(datetime(2026, 10, 19, 9, 40))
    assert len(recorder.starts) == 1
    schedules.tick(datetime(2026, 10, 19, 10, 0))
    assert recorder.stops == 1


def test_weekday_and_overnight_window(tmp_path):
    manager, recorder, path = controller(tmp_path)
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule("night", ["a"], days=(0,), start="23:00", end="02:00")])
    schedules.tick(datetime(2026, 10, 20, 1, 0))  # Tuesday, Monday's window
    assert recorder.starts == [["a"]]
    recorder.state = "idle"
    recorder.camera_ids = []
    schedules.tick(datetime(2026, 10, 20, 2, 0))
    assert len(recorder.starts) == 1
    schedules.tick(datetime(2026, 10, 20, 23, 30))
    assert len(recorder.starts) == 1


def test_manual_takeover_revision_is_relinquished_until_window_ends(tmp_path):
    manager, recorder, path = controller(tmp_path)
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule("daily", ["a"])])
    monday = datetime(2026, 10, 19, 9, 30)
    schedules.tick(monday)
    recorder.revision += 1  # manual select, even if camera list is unchanged
    schedules.tick(monday)
    schedules.tick(datetime(2026, 10, 19, 9, 45))
    assert len(recorder.starts) == 1
    recorder.stop()
    schedules.tick(datetime(2026, 10, 19, 10, 0))
    schedules.tick(datetime(2026, 10, 26, 9, 30))
    assert len(recorder.starts) == 2


def test_overnight_manual_takeover_stays_relinquished_until_tuesday_end(tmp_path):
    manager, recorder, path = controller(tmp_path)
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule("night", ["a"], start="23:00", end="02:00")])
    assert (
        schedules._window_key(datetime(2026, 10, 20, 1, 0), schedules._rules) == "night@2026-10-19"
    )
    schedules.tick(datetime(2026, 10, 19, 23, 30))
    recorder.revision += 1
    schedules.tick(datetime(2026, 10, 20, 1, 0))
    recorder.stop()
    schedules.tick(datetime(2026, 10, 20, 1, 30))
    assert len(recorder.starts) == 1
    schedules.tick(datetime(2026, 10, 20, 2, 0))
    schedules.tick(datetime(2026, 10, 26, 23, 30))
    assert len(recorder.starts) == 2


def test_owned_session_stopped_by_quota_is_not_restarted_in_same_window(tmp_path):
    manager, recorder, path = controller(tmp_path)
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule("daily", ["a"])])
    now = datetime(2026, 10, 19, 9, 30)
    schedules.tick(now)
    recorder.stop()  # Recorder allowance or writer stopped session.
    schedules.tick(now)
    schedules.tick(datetime(2026, 10, 19, 9, 45))
    assert len(recorder.starts) == 1
    assert schedules.snapshot()["state"] == "waiting"


def test_missing_camera_does_not_extend_owned_recording_past_window(tmp_path):
    manager, recorder, path = controller(tmp_path)
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule("daily", ["a"])])
    schedules.tick(datetime(2026, 10, 19, 9, 30))
    manager.workers.pop("a")
    schedules.tick(datetime(2026, 10, 19, 9, 45))
    assert recorder.state == "recording"
    assert recorder.stops == 0
    schedules.tick(datetime(2026, 10, 19, 10, 0))
    assert recorder.state == "idle"
    assert recorder.stops == 1


def test_snapshot_is_deep_copy_and_warnings_are_bounded(tmp_path):
    manager, recorder, path = controller(tmp_path)
    manager.workers = {}
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule(f"missing-{index}", [f"cam-{index}"]) for index in range(64)])
    snapshot = schedules.snapshot()
    snapshot["schedules"][0]["camera_ids"].append("mutated")
    assert len(schedules.snapshot()["schedules"][0]["camera_ids"]) == 1
    assert len(schedules.snapshot()["warnings"]) <= 20


def test_schema_size_and_corrupt_save_fail_closed(tmp_path):
    manager, recorder, path = controller(tmp_path)
    schedules = make_schedules(manager, recorder, path)
    with pytest.raises(ValueError, match="fields"):
        schedules.save([dict(rule("extra", ["a"]), surprise=True)])
    with pytest.raises(ValueError, match="fields"):
        schedules.save({"schedules": [], "surprise": True})
    for payload in (
        {"version": True, "schedules": []},
        {"version": 1, "schedules": [], "surprise": True},
    ):
        path.write_text(json.dumps(payload), encoding="utf-8")
        invalid = RecordingSchedules(manager, recorder, path, autostart=False)
        original = path.read_text(encoding="utf-8")
        with pytest.raises(RuntimeError, match="corrupt"):
            invalid.save([])
        assert path.read_text(encoding="utf-8") == original
    path.write_bytes(b" " * (256 * 1024 + 1))
    oversized = RecordingSchedules(manager, recorder, path, autostart=False)
    original = path.read_bytes()
    with pytest.raises(RuntimeError, match="corrupt"):
        oversized.save([])
    assert path.read_bytes() == original


def test_close_prevents_future_tick_and_save(tmp_path):
    manager, recorder, path = controller(tmp_path)
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule("daily", ["a"])])
    schedules.close()
    schedules.tick(datetime(2026, 10, 19, 9, 30))
    assert recorder.starts == []
    assert schedules.snapshot()["state"] == "closed"
    with pytest.raises(RuntimeError, match="closed"):
        schedules.save([])


def test_manual_session_is_never_stopped_or_replaced(tmp_path):
    manager, recorder, path = controller(tmp_path)
    recorder.start(["c"])
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule("daily", ["a"])])
    schedules.tick(datetime(2026, 10, 19, 9, 30))
    schedules.tick(datetime(2026, 10, 19, 10, 0))
    assert recorder.stops == 0
    assert recorder.starts == [["c"]]


def test_quota_failure_retries_at_bounded_interval(tmp_path, monkeypatch):
    manager, recorder, path = controller(tmp_path)
    attempts = []

    def fail(_):
        attempts.append("quota")
        raise RuntimeError("quota")

    recorder.start = fail
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule("daily", ["a"])])
    now = datetime(2026, 10, 19, 9, 30)
    monotonic = [100.0]
    monkeypatch.setattr(
        "spyder_cctv.schedules.time",
        SimpleNamespace(monotonic=lambda: monotonic[0]),
    )
    schedules.tick(now)
    schedules.tick(now)
    assert len(attempts) == 1
    monotonic[0] = 160.0
    schedules.tick(now)
    assert len(attempts) == 2


def test_persistence_corrupt_data_fails_closed_and_missing_camera_waits(tmp_path):
    manager, recorder, path = controller(tmp_path)
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule("daily", ["gone"])])
    schedules.tick(datetime(2026, 10, 19, 9, 30))
    assert not recorder.starts
    assert "missing camera" in schedules.snapshot()["warnings"][0]
    original = path.read_text(encoding="utf-8")
    path.write_text("{broken", encoding="utf-8")
    failed = RecordingSchedules(manager, recorder, path)
    assert failed.snapshot()["state"] == "error"
    assert not recorder.starts
    assert path.read_text(encoding="utf-8") == "{broken"
    assert json.loads(original)["version"] == 1


def test_validation_rejects_unbounded_or_invalid_rules(tmp_path):
    manager, recorder, path = controller(tmp_path)
    schedules = RecordingSchedules(manager, recorder, path, autostart=False)
    with pytest.raises(ValueError):
        schedules.save([rule(str(i), ["a"]) for i in range(65)])
    with pytest.raises(ValueError):
        schedules.save([rule("bad", ["a"], days=(7,))])


def test_schedule_size_limit_is_checked_before_replacing_saved_rules(tmp_path, monkeypatch):
    import spyder_cctv.schedules as module

    manager, recorder, path = controller(tmp_path)
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule("first", ["a"], enabled=False)])
    original = path.read_bytes()
    monkeypatch.setattr(module, "MAX_FILE_BYTES", 10)
    with pytest.raises(ValueError, match="256 KiB"):
        schedules.save([rule("second", ["b"], enabled=False)])
    assert path.read_bytes() == original
    assert schedules.snapshot()["schedules"][0]["id"] == "first"
