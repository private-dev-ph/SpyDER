import json
from types import SimpleNamespace

import pytest

from spyder_cctv.config import CameraConfig
from spyder_cctv.configuration_backup import ConfigurationBackup


class Preferences:
    def __init__(self):
        self.error = None

    def snapshot(self):
        return {"pause_when_unfocused": True, "storage_error": self.error}


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
    def __init__(self):
        self.workflows = []
        self.error = None

    def list(self):
        return {"workflows": self.workflows, "storage_error": self.error}


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


def test_export_rejects_corrupt_preferences_and_workflows(tmp_path):
    backup = service(tmp_path)
    backup.manager._preferences.error = "corrupt"
    with pytest.raises(ValueError, match="preferences storage is invalid"):
        backup.export()
    backup.manager._preferences.error = None
    backup.workflows.error = "corrupt"
    with pytest.raises(ValueError, match="workflow storage is invalid"):
        backup.export()


def test_preview_reports_camera_nodes_and_models_missing_on_destination(tmp_path):
    backup = service(tmp_path)
    backup.workflows.workflows = [
        {
            "id": "observe",
            "name": "Observe",
            "enabled": False,
            "camera_ids": [],
            "nodes": [
                {"id": "cam", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "other"}},
                {
                    "id": "model",
                    "type": "model",
                    "x": 1,
                    "y": 0,
                    "params": {"model_id": "local-model"},
                },
            ],
            "edges": [],
        }
    ]
    preview = backup.preview(backup.export())
    assert preview["missing_camera_references"] == ["other"]
    assert preview["missing_model_references"] == ["local-model"]


def test_import_sanitizes_machine_model_paths_and_dependent_labels(tmp_path):
    backup = service(tmp_path)
    data = json.loads(backup.export())
    camera = data["config"]["cameras"][0]
    camera["pipeline"] = "vision"
    camera["vision"] = {
        "engine": "insightface",
        "model": "C:/weights/detector.onnx",
        "device": "cpu",
        "inference_fps": 3.0,
        "confidence": 0.5,
        "input_size": 640,
        "max_detections": 100,
        "recognition_model": None,
        "identity_gallery": None,
        "recognition_threshold": 0.65,
        "classifier_model": "C:/weights/classifier.onnx",
        "classifier_labels": ["person"],
        "classifier_threshold": 0.5,
        "classifier_output": "probabilities",
        "classifier_preprocessing": "arcface",
        "classifier_confirmation_frames": 3,
        "classifier_switch_frames": 5,
        "classifier_min_margin": 0.15,
    }
    normalized = backup._validate(json.dumps(data))
    camera = normalized["config"]["cameras"][0]
    assert camera["pipeline"] == "motion"
    assert camera["vision"] is None
    assert "C:/weights" not in json.dumps(normalized)


def test_export_preserves_opencv_vision_settings_without_classifier_paths(tmp_path):
    backup = service(tmp_path)
    camera = CameraConfig(
        "front",
        0,
        pipeline="vision",
        vision={"engine": "opencv"},
    )
    backup.manager.workers = {"front": SimpleNamespace(config=camera)}
    exported = backup.export()
    preview = backup.preview(exported)
    exported_camera = json.loads(exported)["config"]["cameras"][0]
    assert preview["valid"] is True
    assert exported_camera["pipeline"] == "vision"
    assert exported_camera["vision"]["engine"] == "opencv"
    assert exported_camera["vision"]["classifier_labels"] == []


def test_invalid_profile_shape_becomes_validation_error(tmp_path):
    backup = service(tmp_path)
    data = json.loads(backup.export())
    data["config"]["profiles"] = [{"name": "missing id"}]
    with pytest.raises(ValueError, match="Profile contains"):
        backup.preview(json.dumps(data))


def test_recovery_rejects_different_media_directory_without_touching_it(tmp_path):
    backup = service(tmp_path)
    configured_media = tmp_path / "original-media"
    alternate_media = tmp_path / "alternate-media"
    alternate_media.mkdir()
    marker = alternate_media / "recording-settings.json"
    marker.write_bytes(b"preserve")
    journal = tmp_path / ".configuration-restore-journal.json"
    journal.write_text(
        json.dumps(
            {
                "version": 1,
                "config_path": str(backup.config_path.resolve()),
                "config_filename": backup.config_path.name,
                "media_dir": str(configured_media.resolve()),
                "old": [None, None, None, None],
            }
        )
    )
    with pytest.raises(RuntimeError, match="identity"):
        ConfigurationBackup.recover_interrupted(backup.config_path, alternate_media)
    assert marker.read_bytes() == b"preserve"
    assert journal.exists()


def test_pending_and_journal_reads_are_bounded_and_targets_do_not_alias(tmp_path):
    backup = service(tmp_path)
    backup.pending_path.write_bytes(b"x" * (2 * 1024 * 1024 + 1))
    with pytest.raises(ValueError, match="exceeds"):
        ConfigurationBackup.apply_pending(backup.config_path)
    backup.pending_path.unlink()
    with pytest.raises(ValueError, match="distinct"):
        ConfigurationBackup._target_paths(
            tmp_path / "media" / "recording-settings.json", tmp_path / "media"
        )
    with pytest.raises(ValueError, match="conflicts"):
        ConfigurationBackup._target_paths(
            tmp_path / ".configuration-restore.json", tmp_path / "media"
        )


def test_journal_read_is_bounded_before_parsing(tmp_path):
    from spyder_cctv.configuration_backup import MAX_JOURNAL_BYTES

    journal = tmp_path / ".configuration-restore-journal.json"
    with journal.open("wb") as stream:
        stream.truncate(MAX_JOURNAL_BYTES + 1)
    with pytest.raises(ValueError, match="exceeds"):
        ConfigurationBackup.recover_interrupted(tmp_path / "config.json")


def test_pending_unlink_failure_leaves_idempotent_committed_restore(tmp_path, monkeypatch):
    backup = service(tmp_path)
    backup.restore(backup.export())
    original_unlink = type(backup.pending_path).unlink
    failed = False

    def fail_pending_once(path, *args, **kwargs):
        nonlocal failed
        if path == backup.pending_path and not failed:
            failed = True
            raise OSError("sharing violation")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(type(backup.pending_path), "unlink", fail_pending_once)
    assert ConfigurationBackup.apply_pending(backup.config_path) is True
    assert backup.pending
    assert not (tmp_path / ".configuration-restore-journal.json").exists()
    assert ConfigurationBackup.apply_pending(backup.config_path) is True
    assert not backup.pending


def test_malformed_later_journal_entry_never_partially_rolls_back(tmp_path):
    from base64 import b64encode

    backup = service(tmp_path)
    media = tmp_path / "media"
    media.mkdir()
    targets = [
        backup.config_path,
        tmp_path / "preferences.json",
        tmp_path / "workflows.json",
        media / "recording-settings.json",
    ]
    for target in targets:
        target.write_bytes(b"current contents")
    journal = tmp_path / ".configuration-restore-journal.json"
    journal.write_text(
        json.dumps(
            {
                "version": 1,
                "config_path": str(backup.config_path),
                "config_filename": backup.config_path.name,
                "media_dir": str(media),
                "old": [
                    b64encode(b"old config").decode(),
                    b64encode(b"old preferences").decode(),
                    "%%%invalid%%",
                    None,
                ],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="Invalid restore journal"):
        ConfigurationBackup.recover_interrupted(backup.config_path, media)
    assert all(target.read_bytes() == b"current contents" for target in targets)
    assert journal.exists()
