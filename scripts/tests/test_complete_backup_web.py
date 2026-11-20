"""Native backup routes keep control guards and run archive I/O in a job."""

import json
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from spyder_cctv import backup_jobs
from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import save_config
from spyder_cctv.web import create_server


def test_backup_job_routes_guards_progress_cancel_and_validation(tmp_path, monkeypatch):
    running = threading.Event()
    release = threading.Event()

    class Core:
        @staticmethod
        def inspect(path, progress=None):
            running.set()
            release.wait(2)
            progress({"phase": "verify", "files": 1, "bytes": 4, "message": "Verifying"})
            return {"format": "spyder-complete-backup", "version": 1, "files": 1, "total_bytes": 4}

    Core.create = staticmethod(
        lambda *args, **kwargs: Core.inspect(args[1], progress=kwargs.get("progress"))
    )
    monkeypatch.setattr(backup_jobs, "_complete_backup", lambda: Core)
    config = tmp_path / "config.json"
    save_config(config, [])
    manager = CameraManager([], config_path=config)
    server = create_server(manager, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"

    def get():
        with urlopen(base + "/api/system/backup/jobs", timeout=5) as r:
            return json.load(r)

    def post(data, guard=True, suffix=""):
        headers = {"Content-Type": "application/json"}
        if guard:
            headers["X-Spyder-Control"] = "1"
        with urlopen(
            Request(
                base + "/api/system/backup/jobs" + suffix,
                data=json.dumps(data).encode(),
                headers=headers,
            ),
            timeout=5,
        ) as r:
            return r.status, json.load(r)

    try:
        assert get()["state"] == "idle"
        body = {"operation": "inspect", "path": str(tmp_path / "backup.zip")}
        with pytest.raises(HTTPError) as error:
            post(body, guard=False)
        assert error.value.code == 403
        with pytest.raises(HTTPError) as error:
            post({**body, "path": "relative.zip"})
        assert error.value.code == 400
        status, job = post(body)
        assert status == 202 and job["state"] == "running"
        assert running.wait(1)
        assert get()["state"] == "running"
        with pytest.raises(HTTPError) as error:
            post(body)
        assert error.value.code == 409
        assert post({}, suffix="/cancel")[0] == 202
        release.set()
        deadline = time.monotonic() + 3
        while get()["state"] == "running" and time.monotonic() < deadline:
            time.sleep(0.01)
        assert "cancelled" in get()["error"]
        assert manager.statuses() == []
        time.sleep(0.03)
        running.clear()
        release.clear()
        assert post({"operation": "create", "path": str(tmp_path / "new.zip")})[0] == 202
        assert running.wait(1)
        with pytest.raises(HTTPError) as error:
            with urlopen(
                Request(
                    base + "/api/preferences",
                    data=b"{}",
                    headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
                ),
                timeout=2,
            ):
                pass
        assert error.value.code == 409
        assert post({}, suffix="/cancel")[0] == 202
        release.set()
        deadline = time.monotonic() + 3
        while get()["state"] == "running" and time.monotonic() < deadline:
            time.sleep(0.01)
        assert get()["state"] == "error"

        with pytest.raises(HTTPError) as error:
            post(
                {
                    "operation": "restore",
                    "path": str(tmp_path / "backup.zip"),
                    "destination": str(tmp_path),
                }
            )
        assert error.value.code == 400
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        manager.close()
        thread.join(2)
