import json
from datetime import datetime

import pytest

from spyder_cctv.schedules import RecordingSchedules


class Manager:
    workers = {"a": object(), "b": object(), "c": object()}


class Recorder:
    def __init__(self):
        self.revision = 0
        self.session_id = None
        self.camera_ids = []
        self.state = "idle"
        self.starts = []
        self.stops = 0

    def status(self):
        return {"state": self.state, "session_id": self.session_id,
                "camera_ids": list(self.camera_ids), "control_revision": self.revision}

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
    return {"id": ident, "name": ident, "enabled": enabled, "camera_ids": list(cameras),
            "days": list(days), "start": start, "end": end}


def controller(tmp_path):
    return Manager(), Recorder(), tmp_path / "schedules.json"


def make_schedules(manager, recorder, path):
    return RecordingSchedules(manager, recorder, path, autostart=False,
                              clock=lambda: datetime(2026, 10, 19, 12, 0))


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
    def fail(_):
        raise RuntimeError("quota")
    recorder.start = fail
    schedules = make_schedules(manager, recorder, path)
    schedules.save([rule("daily", ["a"])])
    now = datetime(2026, 10, 19, 9, 30)
    times = iter([100.0, 110.0, 160.0])
    monkeypatch.setattr("time.monotonic", lambda: next(times))
    schedules.tick(now)
    schedules.tick(now)
    schedules.tick(now)
    assert len([warning for warning in schedules.snapshot()["warnings"] if "quota" in warning]) == 1


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
