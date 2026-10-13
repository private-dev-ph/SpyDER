import json

import pytest

from spyder_cctv.config import CameraConfig, load_config


@pytest.mark.parametrize(
    "options",
    [
        {"id": "../bad"},
        {"source": True},
        {"source": -1},
        {"source": ""},
        {"fps": 0},
        {"fps": float("nan")},
        {"fps": "10"},
        {"pipeline": "unknown"},
        {"autostart": "false"},
    ],
)
def test_invalid_camera(options):
    fields = {"id": "front", "source": 0} | options
    with pytest.raises(ValueError):
        CameraConfig(**fields)


def test_relative_video_resolves_against_config(tmp_path, monkeypatch):
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"cameras": [{"id": "front", "source": "clip.avi"}]}))
    monkeypatch.chdir(tmp_path.parent)
    assert load_config(config)[0].source == str(tmp_path / "clip.avi")


def test_duplicate_ids_rejected(tmp_path):
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"cameras": [{"id": "a", "source": 0}] * 2}))
    with pytest.raises(ValueError, match="unique"):
        load_config(config)


@pytest.mark.parametrize(
    "data",
    [
        [],
        {},
        {"cameras": {}},
        {"cameras": [False]},
        {"cameras": [{"id": "a", "source": 0, "extra": 1}]},
    ],
)
def test_invalid_document(tmp_path, data):
    config = tmp_path / "config.json"
    config.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        load_config(config)
