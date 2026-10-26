import json
import sqlite3
import zipfile
from pathlib import Path

import pytest

from spyder_cctv.complete_backup import CompleteBackup
from spyder_cctv.config import CameraConfig, save_config
from spyder_cctv.model_library import ModelLibrary


def _config(path):
    save_config(path, [CameraConfig(id="cam1", source=0, autostart=True)])


def test_roundtrip_storage_and_database_and_portable_model(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    _config(source / "custom-camera-config.json")
    (source / "storage.json").write_text(
        json.dumps(
            {"version": 1, "media_directory": str(source / "footage"), "previous_directories": []}
        )
    )
    (source / "models").mkdir()
    (source / "models" / "weights.onnx").write_bytes(b"weights")
    (source / "models" / "registry.json").write_text(
        json.dumps(
            [
                {
                    "id": "a" * 32,
                    "name": "portable",
                    "engine": "yolo",
                    "path": str(source / "models" / "weights.onnx"),
                    "classes": [],
                    "settings": {"model": str(source / "models" / "weights.onnx")},
                    "format": "onnx",
                    "metadata": {},
                    "uploaded": False,
                }
            ]
        )
    )
    (source / "workflows.json").write_text(json.dumps({"workflows": []}))
    (source / "schedules.json").write_text(json.dumps({"version": 1, "schedules": []}))
    db = sqlite3.connect(source / "workflow-history.sqlite3")
    db.execute("create table runs(id text)")
    db.execute("insert into runs values('one')")
    db.commit()
    db.close()
    output = tmp_path / "backup.zip"
    made = CompleteBackup.create(source / "custom-camera-config.json", output)
    assert made["file_count"] >= 5
    info = CompleteBackup.inspect(output)
    assert info["files"] == made["file_count"]
    restored = tmp_path / "restored"
    result = CompleteBackup.restore(output, restored)
    assert result["config_path"] == str(restored / "appdata" / "custom-camera-config.json")
    assert json.loads(Path(result["config_path"]).read_text())["cameras"][0]["autostart"] is False
    assert json.loads((restored / "appdata" / "models" / "registry.json").read_text())[0][
        "path"
    ] == str(restored / "appdata" / "models" / "weights.onnx")
    assert ModelLibrary(restored / "appdata" / "media").list()[0]["path"] == str(
        restored / "appdata" / "models" / "weights.onnx"
    )
    assert json.loads((restored / "appdata" / "storage.json").read_text())[
        "media_directory"
    ] == str(restored / "media")
    db = sqlite3.connect(restored / "appdata" / "workflow-history.sqlite3")
    assert db.execute("select id from runs").fetchone()[0] == "one"
    db.close()


def test_media_opt_in_and_browser_state(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    media = src / "footage"
    media.mkdir()
    old_media = tmp_path / "old-footage"
    old_media.mkdir()
    _config(src / "config.json")
    (src / "private-notes.txt").write_text("must not enter backup")
    (media / "clip.mp4").write_bytes(b"clip")
    (old_media / "older.mp4").write_bytes(b"old clip")
    (media / "recording-settings.json").write_text('{"profile":"efficient","segment_minutes":360}')
    (media / "recording-allowance.json").write_text('{"max_bytes":0,"action":"stop"}')
    (src / "storage.json").write_text(
        json.dumps(
            {"version": 1, "media_directory": str(media), "previous_directories": [str(old_media)]}
        )
    )
    default_archive = tmp_path / "default.zip"
    CompleteBackup.create(src / "config.json", default_archive)
    default_info = CompleteBackup.inspect(default_archive)
    assert not default_info["include_media"] and default_info["counts"]["media"] == 2
    with zipfile.ZipFile(default_archive) as bundle:
        names = set(bundle.namelist())
    assert "media/recording-settings.json" in names
    assert "media/recording-allowance.json" in names
    assert not any("clip.mp4" in name or "older.mp4" in name for name in names)
    assert not any("private-notes.txt" in name for name in names)
    out = tmp_path / "a.zip"
    data = {"version": 1, "local_storage": {"spyder.layout": "x", "spyder-theme": "dark"}}
    CompleteBackup.create(src / "config.json", out, include_media=True, browser_data=data)
    info = CompleteBackup.inspect(out)
    assert info["include_media"] and info["browser_data_included"]
    dest = tmp_path / "restore"
    CompleteBackup.restore(out, dest)
    assert (dest / "media" / "clip.mp4").read_bytes() == b"clip"
    assert (dest / "media-archives" / "0" / "older.mp4").read_bytes() == b"old clip"
    restored_storage = json.loads((dest / "appdata" / "storage.json").read_text())
    assert restored_storage["previous_directories"] == [str(dest / "media-archives" / "0")]
    assert json.loads((dest / "browser-state.json").read_text()) == data


def test_reject_traversal_and_no_overwrite(tmp_path):
    arc = tmp_path / "evil.zip"
    with zipfile.ZipFile(arc, "w") as zf:
        zf.writestr("../escape", "x")
    with pytest.raises(ValueError):
        CompleteBackup.inspect(arc)
    src = tmp_path / "src"
    src.mkdir()
    _config(src / "config.json")
    out = tmp_path / "ok.zip"
    CompleteBackup.create(src / "config.json", out)
    with pytest.raises(FileExistsError):
        CompleteBackup.create(src / "config.json", out)
    dest = tmp_path / "existing"
    dest.mkdir()
    with pytest.raises(FileExistsError):
        CompleteBackup.restore(out, dest)


def test_external_registered_weights_are_copied_and_rebased(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    _config(app / "config.json")
    outside = tmp_path / "vendor"
    outside.mkdir()
    model = outside / "vision.onnx"
    model.write_bytes(b"portable weights")
    (app / "models").mkdir()
    (app / "models" / "registry.json").write_text(
        json.dumps(
            [
                {
                    "id": "b" * 32,
                    "name": "external",
                    "engine": "yolo",
                    "path": str(model),
                    "classes": [],
                    "settings": {"model": str(model)},
                    "format": "onnx",
                    "metadata": {},
                    "uploaded": False,
                }
            ]
        )
    )
    archive = tmp_path / "complete.zip"
    CompleteBackup.create(app / "config.json", archive)
    restored = tmp_path / "portable"
    CompleteBackup.restore(archive, restored)
    record = json.loads((restored / "appdata/models/registry.json").read_text())[0]
    assert Path(record["path"]).is_file()
    assert Path(record["path"]).read_bytes() == b"portable weights"
    assert record["settings"]["model"] == record["path"]
    assert ModelLibrary(restored / "appdata" / "media").list()[0]["path"] == record["path"]


def test_tampered_payload_fails_without_publishing_destination(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    _config(app / "config.json")
    archive = tmp_path / "good.zip"
    CompleteBackup.create(app / "config.json", archive)
    changed = tmp_path / "changed.zip"
    with zipfile.ZipFile(archive) as source, zipfile.ZipFile(changed, "w") as target:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == "appdata/config.json":
                data += b" "
            target.writestr(item.filename, data)
    dest = tmp_path / "destination"
    with pytest.raises(ValueError):
        CompleteBackup.restore(changed, dest)
    assert not dest.exists()


def test_casefold_duplicates_and_browser_data_are_rejected(tmp_path):
    dup = tmp_path / "duplicate.zip"
    with zipfile.ZipFile(dup, "w") as archive:
        archive.writestr("appdata/config.json", "{}")
        archive.writestr("APPDATA/CONFIG.JSON", "{}")
    with pytest.raises(ValueError):
        CompleteBackup.inspect(dup)
    app = tmp_path / "app"
    app.mkdir()
    _config(app / "config.json")
    with pytest.raises(ValueError):
        CompleteBackup.create(
            app / "config.json",
            tmp_path / "browser.zip",
            browser_data={"version": 1, "local_storage": {"untrusted": "value"}},
        )


def test_truncated_archive_and_cancelled_restore_leave_no_destination(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    _config(app / "config.json")
    archive = tmp_path / "complete.zip"
    CompleteBackup.create(app / "config.json", archive)
    truncated = tmp_path / "truncated.zip"
    truncated.write_bytes(archive.read_bytes()[:-20])
    with pytest.raises(zipfile.BadZipFile):
        CompleteBackup.inspect(truncated)
    destination = tmp_path / "cancelled"
    cancelled = False

    def stop_restore(progress):
        nonlocal cancelled
        if progress["phase"] == "restore":
            cancelled = True
            raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        CompleteBackup.restore(archive, destination, progress=stop_restore)
    assert cancelled and not destination.exists()
    assert not list(tmp_path.glob(".cancelled.restore-*"))


def test_source_change_during_snapshot_aborts_and_cleans_temporary_files(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    config = app / "config.json"
    _config(config)
    archive = tmp_path / "race.zip"
    changed = False

    def mutate(progress):
        nonlocal changed
        if (
            progress["phase"] == "snapshot"
            and progress["path"] == "appdata/config.json"
            and not changed
        ):
            changed = True
            config.write_text(config.read_text() + " ")

    with pytest.raises(ValueError, match="changed"):
        CompleteBackup.create(config, archive, progress=mutate)
    assert changed and not archive.exists()
    assert not list(tmp_path.glob(".spyder-backup-*"))
