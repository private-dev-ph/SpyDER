import pytest

from spyder_cctv.storage import StorageSettings


def test_output_preference_persists_without_moving_files(tmp_path):
    active = tmp_path / "media"
    active.mkdir()
    original = active / "old.mp4"
    original.write_bytes(b"unchanged")
    target = tmp_path / "video-drive" / "SpyDER"
    settings = StorageSettings(tmp_path / "storage.json", active)
    result = settings.save(str(target), active)
    assert result["restart_required"]
    assert original.read_bytes() == b"unchanged"
    restored = StorageSettings(settings.path, active)
    assert restored.directory == target
    assert active in restored.archives(target)
    assert not restored.snapshot(target)["restart_required"]


@pytest.mark.parametrize("value", ["", "relative/path", "https://example.test/videos", 42])
def test_storage_rejects_relative_or_remote_url(tmp_path, value):
    settings = StorageSettings(tmp_path / "storage.json", tmp_path / "media")
    with pytest.raises(ValueError):
        settings.save(value, tmp_path / "media")
    assert not settings.path.exists()


def test_corrupt_storage_settings_cannot_be_overwritten(tmp_path):
    path = tmp_path / "storage.json"
    path.write_text("corrupt", encoding="utf-8")
    settings = StorageSettings(path, tmp_path / "media")
    with pytest.raises(RuntimeError):
        settings.save(str(tmp_path / "other"), tmp_path / "media")
    assert path.read_text(encoding="utf-8") == "corrupt"


def test_failed_save_preserves_current_preference(tmp_path, monkeypatch):
    import spyder_cctv.storage as storage

    settings = StorageSettings(tmp_path / "storage.json", tmp_path / "media")
    monkeypatch.setattr(storage.os, "replace", lambda *_: (_ for _ in ()).throw(OSError("denied")))
    with pytest.raises(OSError):
        settings.save(str(tmp_path / "other"), settings.directory)
    assert settings.directory == tmp_path / "media"
    assert not list(tmp_path.glob(".storage-*"))
