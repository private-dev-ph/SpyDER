import json
from types import SimpleNamespace

import pytest

from spyder_cctv.config import CameraConfig
from spyder_cctv.configuration_backup import ConfigurationBackup


class Preferences:
    def snapshot(self):
        return {"pause_when_unfocused": True}


class Manager:
    def __init__(self, root):
        self._config_path = root / "config.json"
        self._profiles = {}
        self._preferences = Preferences()
        self.workers = {"front": SimpleNamespace(config=CameraConfig("front", 0, autostart=True))}

    def _snapshot(self):
        return list(self.workers.values())


class Recorder:
    _settings = {"profile": "detail", "segment_minutes": 15}


class Workflows:
    def list(self):
        return {"workflows": []}


def service(root):
    return ConfigurationBackup(Manager(root), Recorder(), Workflows())


def test_export_preview_and_restore_stage_without_touching_live_files(tmp_path):
    backup = service(tmp_path)
    raw = backup.export()
    preview = backup.preview(raw)
    assert preview["counts"] == {"cameras": 1, "profiles": 0, "workflows": 0}
    assert preview["restart_required"] is True
    original = backup.config_path.read_bytes() if backup.config_path.exists() else None
    result = backup.restore(raw)
    assert result["pending"] is True
    assert backup.pending is True
    assert (backup.config_path.read_bytes() if backup.config_path.exists() else None) == original


def test_apply_pending_writes_only_settings_and_disables_autostart(tmp_path):
    backup = service(tmp_path)
    raw = json.loads(backup.export())
    raw["config"]["cameras"][0]["autostart"] = True
    backup.restore(json.dumps(raw))
    media = tmp_path / "chosen-media"
    media.mkdir()
    (media / "video.mp4").write_bytes(b"keep")
    assert ConfigurationBackup.apply_pending(backup.config_path, media)
    config = json.loads(backup.config_path.read_text())
    assert config["cameras"][0]["autostart"] is False
    assert json.loads((media / "recording-settings.json").read_text()) == Recorder._settings
    assert (media / "video.mp4").read_bytes() == b"keep"
    assert not backup.pending
    assert not ConfigurationBackup.apply_pending(backup.config_path, media)


def test_reject_invalid_backup_and_preserve_existing_pending(tmp_path):
    backup = service(tmp_path)
    with pytest.raises(ValueError):
        backup.preview('{"version":1,"config":{}}')
    assert not backup.pending
    backup.restore(backup.export())
    original = backup.pending_path.read_bytes()
    with pytest.raises(RuntimeError, match="already pending"):
        backup.restore(backup.export())
    assert backup.pending_path.read_bytes() == original


def test_backup_size_bound(tmp_path):
    backup = service(tmp_path)
    with pytest.raises(ValueError, match="2 MiB"):
        backup.preview(" " * (2 * 1024 * 1024 + 1))


def test_path_traversal_ids_and_unknown_schema_are_rejected(tmp_path):
    backup = service(tmp_path)
    data = json.loads(backup.export())
    data["config"]["cameras"][0]["id"] = "../escape"
    with pytest.raises(ValueError):
        backup.preview(json.dumps(data))
    data = json.loads(backup.export())
    data["unexpected"] = True
    with pytest.raises(ValueError, match="Unknown"):
        backup.preview(json.dumps(data))
    assert not backup.pending


def test_apply_failure_rolls_back_every_target(tmp_path, monkeypatch):
    backup = service(tmp_path)
    backup.restore(backup.export())
    files = {
        backup.config_path: b"old config",
        tmp_path / "preferences.json": b"old preferences",
        tmp_path / "workflows.json": b"old workflows",
        tmp_path / "media" / "recording-settings.json": b"old quality",
    }
    for path, contents in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
    import spyder_cctv.configuration_backup as module

    replace = module.os.replace
    calls = 0

    def fail_once(source, destination):
        nonlocal calls
        calls += 1
        if calls == 4:
            raise OSError("disk full")
        return replace(source, destination)

    monkeypatch.setattr(module.os, "replace", fail_once)
    with pytest.raises(OSError, match="disk full"):
        ConfigurationBackup.apply_pending(backup.config_path)
    assert {path: path.read_bytes() for path in files} == files
    assert backup.pending
    assert not (tmp_path / ".configuration-restore-journal.json").exists()
