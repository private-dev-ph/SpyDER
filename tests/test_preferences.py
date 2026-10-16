import json

import pytest

from spyder_cctv.preferences import Preferences, PreferencesStorageError


def test_preference_defaults_and_persists_across_instances(tmp_path):
    path = tmp_path / "preferences.json"
    first = Preferences(path)
    assert first.snapshot() == {
        "pause_when_unfocused": True,
        "configured": False,
        "storage_error": None,
    }
    assert first.set_pause_when_unfocused(False)["configured"] is True
    assert json.loads(path.read_text()) == {"version": 1, "pause_when_unfocused": False}
    assert Preferences(path).snapshot() == {
        "pause_when_unfocused": False,
        "configured": True,
        "storage_error": None,
    }


@pytest.mark.parametrize("value", [1, "false", None])
def test_preference_rejects_non_boolean_values(tmp_path, value):
    preferences = Preferences(tmp_path / "preferences.json")
    with pytest.raises(ValueError, match="boolean"):
        preferences.set_pause_when_unfocused(value)
    assert preferences.snapshot()["configured"] is False


def test_corrupt_file_is_preserved_and_writes_rejected(tmp_path):
    path = tmp_path / "preferences.json"
    path.write_text('{"version": 2, "pause_when_unfocused": false}')
    preferences = Preferences(path)
    original = path.read_bytes()
    assert preferences.snapshot()["pause_when_unfocused"] is True
    assert preferences.snapshot()["configured"] is False
    assert preferences.snapshot()["storage_error"]
    with pytest.raises(PreferencesStorageError, match="invalid"):
        preferences.set_pause_when_unfocused(False)
    assert path.read_bytes() == original


def test_write_failure_does_not_change_preference(tmp_path, monkeypatch):
    path = tmp_path / "preferences.json"
    preferences = Preferences(path)

    def fail_replace(*_args):
        raise OSError("disk full")

    monkeypatch.setattr("spyder_cctv.preferences.os.replace", fail_replace)
    with pytest.raises(PreferencesStorageError, match="disk full"):
        preferences.set_pause_when_unfocused(False)
    assert preferences.snapshot() == {
        "pause_when_unfocused": True,
        "configured": False,
        "storage_error": None,
    }
    assert not path.exists()
