import json
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig, save_config
from spyder_cctv.web import create_server


@pytest.fixture
def local_app(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    save_config(path, [CameraConfig("front", 0)])
    manager = CameraManager([CameraConfig("front", 0)], config_path=path)
    import spyder_cctv.web as web_module

    original_recorder = web_module.RecordingService

    def capture_recorder(*args, **kwargs):
        service = original_recorder(*args, **kwargs)
        manager.test_recorder = service
        return service

    monkeypatch.setattr(web_module, "RecordingService", capture_recorder)
    server = create_server(manager, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"

    def request(route, data=None, control=True):
        headers = {"Content-Type": "application/json"}
        if control:
            headers["X-Spyder-Control"] = "1"
        with urlopen(
            Request(
                base + route,
                data=json.dumps(data).encode() if data is not None else None,
                headers=headers,
            ),
            timeout=5,
        ) as response:
            return json.load(response)

    yield manager, request
    server.shutdown()
    server.server_close()
    thread.join(2)
    manager.close()


def test_health_debug_and_schedules_are_guarded_and_persistent(local_app):
    _, request = local_app
    assert request("/api/system/health")["state"] == "healthy"
    assert request("/api/workflows/debug") == {"workflows": {}}
    rule = {
        "id": "workdays",
        "name": "Workdays",
        "enabled": False,
        "camera_ids": ["front"],
        "days": [0, 1, 2, 3, 4],
        "start": "09:00",
        "end": "17:00",
    }
    with pytest.raises(HTTPError) as denied:
        request("/api/recordings/schedules", {"schedules": [rule]}, control=False)
    assert denied.value.code == 403
    assert request("/api/recordings/schedules", {"schedules": [rule]})["schedules"] == [rule]
    assert request("/api/recordings/schedules")["schedules"] == [rule]
    assert request("/api/recordings/schedules/workdays/remove", {})["schedules"] == []


def test_restore_previews_then_stages_without_touching_current_configuration(local_app):
    manager, request = local_app
    backup = request("/api/system/backup")
    assert backup["config"]["cameras"][0]["id"] == "front"
    before = manager._config_path.read_bytes()
    preview = request("/api/system/backup/preview", {"backup": backup})
    assert preview["counts"]["cameras"] == 1
    rule = {
        "id": "off-hours",
        "name": "Off hours",
        "enabled": True,
        "camera_ids": ["front"],
        "days": [0],
        "start": "01:00",
        "end": "02:00",
    }
    request("/api/recordings/schedules", {"schedules": [rule]})
    with pytest.raises(HTTPError) as denied:
        request("/api/system/backup/restore", {"backup": backup})
    assert denied.value.code == 409
    rule["enabled"] = False
    request("/api/recordings/schedules", {"schedules": [rule]})
    staged = request("/api/system/backup/restore", {"backup": backup})
    assert staged["pending"]
    assert manager._config_path.read_bytes() == before
    assert request("/api/system/health")["restore_pending"]
    with pytest.raises(HTTPError) as locked:
        request("/api/preferences", {"pause_when_unfocused": False})
    assert locked.value.code == 409


def test_restore_waits_for_error_state_workers_to_finish(local_app):
    manager, request = local_app
    backup = request("/api/system/backup")

    class Retiring:
        def is_alive(self):
            return True

    recorder = manager.test_recorder
    recorder._state, recorder._thread = "error", Retiring()
    try:
        with pytest.raises(HTTPError) as denied:
            request("/api/system/backup/restore", {"backup": backup})
        assert denied.value.code == 409
    finally:
        recorder._state, recorder._thread = "idle", None
    worker = manager.get_worker("front")
    worker._state, worker._thread = "error", Retiring()
    try:
        with pytest.raises(HTTPError) as denied:
            request("/api/system/backup/restore", {"backup": backup})
        assert denied.value.code == 409
    finally:
        worker._state, worker._thread = "stopped", None


def test_restore_serializes_pending_marker_with_other_controls(local_app, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    from spyder_cctv.configuration_backup import ConfigurationBackup

    _, request = local_app
    backup = request("/api/system/backup")
    entered, release = threading.Event(), threading.Event()
    original = ConfigurationBackup.restore

    def blocked(self, raw):
        entered.set()
        assert release.wait(3)
        return original(self, raw)

    monkeypatch.setattr(ConfigurationBackup, "restore", blocked)
    with ThreadPoolExecutor(max_workers=2) as pool:
        restore = pool.submit(request, "/api/system/backup/restore", {"backup": backup})
        assert entered.wait(2)
        mutation = pool.submit(request, "/api/preferences", {"pause_when_unfocused": False})
        release.set()
        assert restore.result()["pending"]
        with pytest.raises(HTTPError) as locked:
            mutation.result()
        assert locked.value.code == 409
