import json
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig
from spyder_cctv.presence import PresenceLeases
from spyder_cctv.web import create_server


def wait_for(predicate, timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Condition did not become true")


class Capture:
    opened = 0
    closed = 0

    def __init__(self, source):
        type(self).opened += 1

    def read(self):
        return True, b"frame"

    def close(self):
        type(self).closed += 1


class Pipeline:
    def process(self, frame):
        return frame, {}


@pytest.fixture(autouse=True)
def reset_capture_counts():
    Capture.opened = Capture.closed = 0


def test_leases_expire_and_blur_has_grace(monkeypatch):
    now = [10.0]
    monkeypatch.setattr("spyder_cctv.presence.time.monotonic", lambda: now[0])
    leases = PresenceLeases(ttl=15, inactive_grace=2)
    leases.heartbeat("tab-a", True, True)
    assert leases.keeps_cameras()
    leases.heartbeat("tab-a", False, True)
    assert leases.keeps_cameras()
    now[0] += 2.1
    assert not leases.keeps_cameras()
    leases.heartbeat("tab-b", False, False)
    now[0] += 3
    assert leases.keeps_cameras()
    now[0] += 13
    assert not leases.keeps_cameras()


def test_lease_bound_rejects_new_clients():
    leases = PresenceLeases(limit=1)
    leases.heartbeat("one", True, True)
    with pytest.raises(ValueError, match="Too many"):
        leases.heartbeat("two", True, True)


def test_idle_policy_releases_then_resumes_only_policy_paused_camera():
    manager = CameraManager(
        [CameraConfig("auto", 0, autostart=True), CameraConfig("manual", 1)],
        idle_policy=True,
        capture_factory=Capture,
        pipeline_factory=lambda name: Pipeline(),
        encoder=lambda frame: b"jpeg",
    )
    try:
        manager.set_presence("tab-a", True, True)
        manager.control("manual", "start")
        manager.start_configured()
        wait_for(lambda: all(item["state"] == "running" for item in manager.statuses()))
        manager.set_presence("tab-a", False, True)
        wait_for(lambda: all(item["state"] == "stopped" for item in manager.statuses()), timeout=4)
        assert {item["id"] for item in manager.statuses() if item["idle_suspended"]} == {
            "auto",
            "manual",
        }
        manager.set_presence("tab-b", True, True)
        wait_for(lambda: all(item["state"] == "running" for item in manager.statuses()))
        assert Capture.opened >= 4
        manager.control("manual", "stop")
        manager.set_presence("tab-b", False, True)
        wait_for(lambda: manager.statuses()[0]["idle_suspended"], timeout=4)
        manager.set_presence("tab-c", True, True)
        wait_for(lambda: manager.statuses()[0]["state"] == "running")
        assert manager.statuses()[1]["state"] == "stopped"
        assert not manager.statuses()[1]["idle_suspended"]
    finally:
        manager.close()
    assert Capture.opened == Capture.closed


def test_autostart_camera_added_while_idle_keeps_intent():
    manager = CameraManager(
        [],
        idle_policy=True,
        capture_factory=Capture,
        pipeline_factory=lambda name: Pipeline(),
        encoder=lambda frame: b"jpeg",
    )
    try:
        status = manager.add(CameraConfig("late", 0, autostart=True))
        assert status["idle_suspended"] is True
        assert Capture.opened == 0
        manager.set_presence("tab", True, True)
        wait_for(lambda: manager.statuses()[0]["state"] == "running")
    finally:
        manager.close()
    assert Capture.opened == Capture.closed == 1


def test_recording_retention_survives_idle_policy():
    manager = CameraManager(
        [CameraConfig("record", 0)],
        idle_policy=True,
        capture_factory=Capture,
        pipeline_factory=lambda name: Pipeline(),
        encoder=lambda frame: b"jpeg",
    )
    try:
        manager.set_recording("record", True)
        wait_for(lambda: manager.statuses()[0]["state"] == "running")
        manager.set_presence("tab", False, True)
        time.sleep(0.3)
        assert manager.statuses()[0]["state"] == "running"
        manager.set_recording("record", False)
        wait_for(lambda: manager.statuses()[0]["state"] == "stopped")
        assert manager.statuses()[0]["idle_suspended"]
    finally:
        manager.close()


def test_recording_retains_only_its_camera_while_idle():
    manager = CameraManager(
        [CameraConfig("record", 0, autostart=True), CameraConfig("other", 1, autostart=True)],
        idle_policy=True,
        capture_factory=Capture,
        pipeline_factory=lambda name: Pipeline(),
        encoder=lambda frame: b"jpeg",
    )
    try:
        manager.set_presence("tab", True, True)
        manager.start_configured()
        manager.set_recording("record", True)
        wait_for(lambda: all(item["state"] == "running" for item in manager.statuses()))
        manager.set_presence("tab", False, True)
        wait_for(lambda: manager.statuses()[1]["idle_suspended"], timeout=4)
        assert manager.statuses()[0]["state"] == "running"
        assert manager.statuses()[1]["state"] == "stopped"
        manager.set_recording("record", False)
        wait_for(lambda: all(item["state"] == "stopped" for item in manager.statuses()))
        assert all(item["idle_suspended"] for item in manager.statuses())
    finally:
        manager.close()
    assert Capture.opened == Capture.closed


def test_stop_failure_does_not_prevent_other_camera_release_and_retries():
    release_blocked_read = threading.Event()
    blocked_read_entered = threading.Event()

    class BlockedCapture(Capture):
        def read(self):
            blocked_read_entered.set()
            release_blocked_read.wait()
            return True, b"blocked"

    manager = CameraManager(
        [CameraConfig("blocked", 0, autostart=True), CameraConfig("free", 1, autostart=True)],
        idle_policy=True,
        capture_factory=lambda source: BlockedCapture(source) if source == 0 else Capture(source),
        pipeline_factory=lambda name: Pipeline(),
        encoder=lambda frame: b"jpeg",
    )
    blocked = manager.workers["blocked"]
    actual_stop = blocked.stop
    fail_stop = [True]
    calls = [0]

    def stop_with_temporary_failure(timeout=2.0):
        calls[0] += 1
        if fail_stop[0]:
            raise RuntimeError("simulated backend stop failure")
        return actual_stop(timeout)

    blocked.stop = stop_with_temporary_failure
    try:
        manager.set_presence("tab", True, True)
        manager.start_configured()
        assert blocked_read_entered.wait(2)
        wait_for(lambda: manager.statuses()[1]["state"] == "running")
        manager.set_presence("tab", False, True)
        wait_for(lambda: manager.statuses()[1]["state"] == "stopped", timeout=4)
        assert manager.statuses()[0]["idle_suspended"]
        assert manager.statuses()[1]["idle_suspended"]
        assert manager.statuses()[0]["state"] == "stopping"
        assert calls[0] > 0
        fail_stop[0] = False
        release_blocked_read.set()
        wait_for(lambda: manager.statuses()[0]["state"] == "stopped")
        assert manager.statuses()[0]["idle_suspended"]
    finally:
        fail_stop[0] = False
        release_blocked_read.set()
        manager.close()
    assert Capture.opened == Capture.closed


def test_recording_state_requires_boolean_and_open_manager():
    manager = CameraManager([CameraConfig("front", 0)], idle_policy=True)
    try:
        with pytest.raises(ValueError, match="boolean"):
            manager.set_recording("front", 1)
    finally:
        manager.close()
    with pytest.raises(RuntimeError, match="closed"):
        manager.set_recording("front", True)


def test_presence_endpoint_validates_and_obeys_control_guards(tmp_path):
    manager = CameraManager([], idle_policy=True)
    server = create_server(manager, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"

    def post(data, headers=None):
        return urlopen(
            Request(
                url + "/api/presence",
                method="POST",
                data=json.dumps(data).encode(),
                headers={"Content-Type": "application/json", "X-Spyder-Control": "1"}
                | (headers or {}),
            ),
            timeout=2,
        )

    try:
        body = {"client_id": "tab-123", "active": True, "release_when_idle": True}
        with post(body) as response:
            assert response.status == 200
        with pytest.raises(HTTPError) as error:
            post(body, {"Origin": "https://evil.example"})
        assert error.value.code == 403
        with pytest.raises(HTTPError) as error:
            post(body | {"active": 1})
        assert error.value.code == 400
    finally:
        server.shutdown()
        server.server_close()
        manager.close()
        thread.join(2)
