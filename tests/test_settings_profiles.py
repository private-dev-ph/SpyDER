import threading
import time
from dataclasses import replace

import pytest

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig, SettingsProfile, load_app_config, save_config
from spyder_cctv.controls import apply_settings, describe_control, unavailable_controls


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("Expected settings state did not arrive")


class ControlledCapture:
    def __init__(self, source):
        self.source = source
        self.owner = threading.get_ident()
        self.current = 0
        self.set_calls = []
        self.closed = False

    def read(self):
        assert threading.get_ident() == self.owner
        return True, self.source

    def close(self):
        assert threading.get_ident() == self.owner
        self.closed = True

    def capabilities(self):
        assert threading.get_ident() == self.owner
        values = unavailable_controls()
        maximum = 200 if self.source == 0 else 100
        values["brightness"] = describe_control("brightness", 0, maximum, 1, 0, self.current)
        return values

    get_controls = capabilities

    def set_value(self, name, value):
        assert threading.get_ident() == self.owner
        self.current = value
        self.set_calls.append(value)
        return True

    def apply_controls(self, settings):
        assert threading.get_ident() == self.owner
        return apply_settings(self, settings)


class Pipeline:
    def process(self, frame):
        return frame, {}


def manager_for(path, captures, profiles=None):
    def factory(source):
        capture = ControlledCapture(source)
        captures.append(capture)
        return capture

    return CameraManager(
        [CameraConfig("a", 0, fps=60), CameraConfig("b", 1, fps=60)],
        config_path=path,
        profiles=profiles,
        capture_factory=factory,
        pipeline_factory=lambda name: Pipeline(),
        encoder=lambda frame: b"jpeg",
    )


def test_controls_stay_on_worker_and_profile_scales_across_devices(tmp_path):
    captures = []
    path = tmp_path / "config.json"
    manager = manager_for(path, captures)
    try:
        manager.control("a", "start")
        manager.control("b", "start")
        wait_for(lambda: all(status["state"] == "running" for status in manager.statuses()))
        assert all(not capture.set_calls for capture in captures)  # Discovery never sets hardware.
        manager.create_profile(SettingsProfile("indoor", "Indoor", {"brightness": 75, "fov": 20}))
        manager.assign_profile("a", "indoor")
        manager.assign_profile("b", "indoor")
        wait_for(
            lambda: all(
                worker.settings_snapshot()["settings_state"] == "partial"
                for worker in manager.workers.values()
            )
        )
        by_source = {capture.source: capture for capture in captures}
        assert by_source[0].current == 150
        assert by_source[1].current == 75
        assert (
            manager.get_worker("a").settings_snapshot()["results"]["fov"]["status"] == "unsupported"
        )
        config = load_app_config(path)
        assert len(config.profiles) == 1
        assert all(camera.profile_id == "indoor" for camera in config.cameras)
        manager.control("a", "stop")
        manager.control("a", "start")
        wait_for(lambda: len(captures) == 3 and captures[-1].current == 150)
        assert captures[0].closed or captures[1].closed
    finally:
        manager.close()
    assert all(capture.closed for capture in captures)


def test_paused_assignment_persists_and_custom_edits_detach_profile(tmp_path):
    captures = []
    manager = manager_for(tmp_path / "config.json", captures)
    try:
        manager.create_profile(SettingsProfile("day", "Daylight", {"brightness": 60}))
        manager.assign_profile("a", "day")
        assert manager.get_worker("a").settings_snapshot()["settings_state"] == "scheduled"
        assert not captures
        with pytest.raises(RuntimeError, match="Unassign"):
            manager.remove_profile("day")
        manager.set_settings("a", {"brightness": 40})
        snapshot = manager.get_worker("a").settings_snapshot()
        assert snapshot["profile_id"] is None
        assert snapshot["desired"] == {"brightness": 40}
        manager.remove_profile("day")
        assert load_app_config(tmp_path / "config.json").profiles == []
    finally:
        manager.close()


def test_failed_persistence_never_publishes_or_applies_intent(tmp_path, monkeypatch):
    manager = manager_for(tmp_path / "config.json", [])
    try:
        manager.create_profile(SettingsProfile("day", "Daylight", {"brightness": 60}))
        original = (tmp_path / "config.json").read_bytes()

        def fail(*args):
            raise OSError("disk full")

        monkeypatch.setattr("spyder_cctv.config.os.replace", fail)
        with pytest.raises(OSError):
            manager.assign_profile("a", "day")
        with pytest.raises(OSError):
            manager.set_settings("a", {"brightness": 90})
        with pytest.raises(OSError):
            manager.create_profile(SettingsProfile("night", "Night", {"brightness": 20}))
        assert manager.get_worker("a").settings_snapshot()["desired"] == {}
        assert len(manager.profiles()) == 1
        assert (tmp_path / "config.json").read_bytes() == original
    finally:
        manager.close()


def test_latest_settings_win_when_a_driver_command_is_slow(tmp_path):
    entered, release = threading.Event(), threading.Event()

    class SlowCapture(ControlledCapture):
        def apply_controls(self, settings):
            if settings["brightness"] == 20:
                entered.set()
                assert release.wait(2)
            return super().apply_controls(settings)

    manager = CameraManager(
        [CameraConfig("a", 0, fps=60)],
        config_path=tmp_path / "config.json",
        capture_factory=SlowCapture,
        pipeline_factory=lambda name: Pipeline(),
        encoder=lambda frame: b"jpeg",
    )
    try:
        manager.control("a", "start")
        wait_for(lambda: manager.get_worker("a").status()["state"] == "running")
        manager.set_settings("a", {"brightness": 20})
        assert entered.wait(2)
        manager.set_settings("a", {"brightness": 80})
        release.set()
        wait_for(lambda: manager.get_worker("a").settings_snapshot()["settings_state"] == "applied")
        assert (
            manager.get_worker("a").settings_snapshot()["capabilities"]["brightness"][
                "native_value"
            ]
            == 160
        )
    finally:
        release.set()
        manager.close()


def test_config_migration_preserves_profiles_and_validates_references(tmp_path):
    path = tmp_path / "config.json"
    path.write_text('{"cameras":[{"id":"a","source":0}]}')
    assert load_app_config(path).profiles == []
    profile = SettingsProfile("day", "Daylight", {"brightness": 50})
    camera = replace(load_app_config(path).cameras[0], profile_id="day")
    save_config(path, [camera], [profile])
    assert load_app_config(path).cameras[0].profile_id == "day"
    save_config(path, [camera], [])
    with pytest.raises(ValueError, match="unknown profile"):
        load_app_config(path)
