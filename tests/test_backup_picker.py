"""Tests for isolated native backup path selection."""

import json
import subprocess
import threading
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from spyder_cctv import backup_picker, web
from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import save_config


class _ChildProcess:
    def __init__(self, path=None, returncode=0):
        self.returncode = returncode
        self.stdout = json.dumps({"path": path})
        self.killed = False

    def communicate(self, timeout=None):
        return self.stdout, ""

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


def _spawn(path=None, returncode=0):
    child = _ChildProcess(path, returncode)
    calls = []

    def factory(command, **kwargs):
        calls.append((command, kwargs))
        return child

    return child, calls, factory


def test_choose_path_runs_separate_module_and_validates_new_zip(tmp_path):
    target = tmp_path / "new-backup.zip"
    child, calls, factory = _spawn(str(target))
    assert backup_picker.choose_path("save_archive", popen_factory=factory) == str(target)
    command, options = calls[0]
    assert command[-4:] == ["-m", "spyder_cctv.backup_picker", "--dialog", "save_archive"]
    assert options["stdout"] == subprocess.PIPE and options["stderr"] == subprocess.PIPE
    assert child.returncode == 0


def test_choose_path_rejects_existing_save_and_validates_open_archive(tmp_path):
    existing = tmp_path / "exists.zip"
    existing.write_bytes(b"archive")
    with pytest.raises(RuntimeError, match="already exists"):
        backup_picker.choose_path(
            "save_archive", popen_factory=lambda *a, **k: _ChildProcess(str(existing))
        )
    assert backup_picker.choose_path(
        "open_archive", popen_factory=lambda *a, **k: _ChildProcess(str(existing))
    ) == str(existing.resolve())
    with pytest.raises(RuntimeError, match="ZIP archive"):
        backup_picker.choose_path(
            "open_archive", popen_factory=lambda *a, **k: _ChildProcess(str(tmp_path))
        )


def test_restore_parent_returns_new_child_without_creating_it(tmp_path):
    (tmp_path / "SpyDER-Restored").mkdir()
    (tmp_path / "SpyDER-Restored-2").mkdir()
    expected = tmp_path / "SpyDER-Restored-3"
    result = backup_picker.choose_path(
        "restore_parent", popen_factory=lambda *a, **k: _ChildProcess(str(tmp_path))
    )
    assert result == str(expected)
    assert not expected.exists()


def test_choose_path_handles_cancel_timeout_and_bad_child_data(tmp_path):
    assert (
        backup_picker.choose_path("save_archive", popen_factory=lambda *a, **k: _ChildProcess())
        is None
    )

    class TimedChild(_ChildProcess):
        def communicate(self, timeout=None):
            if not self.killed:
                raise subprocess.TimeoutExpired("picker", timeout)
            return "", ""

    with pytest.raises(RuntimeError, match="timed out"):
        backup_picker.choose_path("open_archive", popen_factory=lambda *a, **k: TimedChild())
    with pytest.raises(RuntimeError, match="invalid data"):
        backup_picker.choose_path(
            "open_archive",
            popen_factory=lambda *a, **k: SimpleNamespace(
                returncode=0, communicate=lambda timeout=None: ("{}", ""), poll=lambda: 0
            ),
        )


def test_close_active_picker_kills_dialog_child():
    child = _ChildProcess()
    child.returncode = None
    with backup_picker._PROCESS_LOCK:
        backup_picker._ACTIVE_PROCESS = child
    backup_picker.close_active_picker()
    assert child.killed
    with backup_picker._PROCESS_LOCK:
        backup_picker._ACTIVE_PROCESS = None


def test_picker_api_guards_schema_cancellation_and_single_dialog(tmp_path, monkeypatch):
    config = tmp_path / "config.json"
    save_config(config, [])
    manager = CameraManager([], config_path=config)
    server = web.create_server(manager, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}/api/system/backup/picker"
    started = threading.Event()
    release = threading.Event()

    def choose(kind):
        started.set()
        release.wait(2)
        return None

    monkeypatch.setattr(web, "choose_path", choose)

    def post(body, *, guarded=True):
        headers = {"Content-Type": "application/json"}
        if guarded:
            headers["X-Spyder-Control"] = "1"
        request = Request(base, data=json.dumps(body).encode(), headers=headers)
        with urlopen(request, timeout=4) as response:
            return response.status, json.load(response)

    try:
        with pytest.raises(HTTPError) as error:
            post({"kind": "save_archive"}, guarded=False)
        assert error.value.code == 403
        with pytest.raises(HTTPError) as error:
            post({"kind": "unknown"})
        assert error.value.code == 400

        results = []
        first = threading.Thread(target=lambda: results.append(post({"kind": "open_archive"})))
        first.start()
        assert started.wait(1)
        with pytest.raises(HTTPError) as error:
            post({"kind": "save_archive"})
        assert error.value.code == 409
        release.set()
        first.join(2)
        assert results == [(200, {"path": None})]
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        manager.close()
        thread.join(2)
