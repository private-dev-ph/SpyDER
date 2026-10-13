import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig, load_config


class Capture:
    def __init__(self, source):
        self.source = source
        self.closed = False

    def read(self):
        return True, self.source

    def close(self):
        self.closed = True


class Pipeline:
    def process(self, frame):
        return frame, {}


def test_live_add_remove_persist_and_restart(tmp_path):
    path = tmp_path / "config.json"
    ready = threading.Event()
    captures = []

    def factory(source):
        capture = Capture(source)
        captures.append(capture)
        return capture

    def encode(frame):
        ready.set()
        return b"frame"

    manager = CameraManager(
        [],
        config_path=path,
        capture_factory=factory,
        pipeline_factory=lambda name: Pipeline(),
        encoder=encode,
    )
    try:
        manager.add(CameraConfig("a", 0, autostart=True, name="Entrance"))
        assert ready.wait(2)
        manager.add(CameraConfig("b", 1, name="Side view"))
        assert [camera.name for camera in load_config(path)] == ["Entrance", "Side view"]
        assert manager.get_worker("a").status()["name"] == "Entrance"
        removed = manager.get_worker("a")
        manager.remove("a")
        assert captures[0].closed
        assert [camera.id for camera in load_config(path)] == ["b"]
        with pytest.raises(RuntimeError, match="closed"):
            removed.start()
    finally:
        manager.close()


def test_duplicate_source_and_id_do_not_change_config(tmp_path):
    path = tmp_path / "config.json"
    manager = CameraManager([], config_path=path)
    manager.add(CameraConfig("a", 0))
    original = path.read_bytes()
    with pytest.raises(RuntimeError, match="source"):
        manager.add(CameraConfig("b", 0))
    with pytest.raises(RuntimeError, match="id"):
        manager.add(CameraConfig("a", 1))
    assert path.read_bytes() == original
    manager.close()


def test_persistence_failure_preserves_registry_and_existing_config(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    manager = CameraManager([], config_path=path)
    manager.add(CameraConfig("a", 0))
    original = path.read_bytes()

    def fail_replace(*args):
        raise OSError("disk full")

    monkeypatch.setattr("spyder_cctv.config.os.replace", fail_replace)
    with pytest.raises(OSError):
        manager.add(CameraConfig("b", 1))
    with pytest.raises(OSError):
        manager.remove("a")
    assert list(manager.workers) == ["a"]
    assert path.read_bytes() == original
    assert not list(tmp_path.glob(".spyder-*"))
    manager.close()


def test_relative_source_resolves_before_persistence(tmp_path):
    path = tmp_path / "config.json"
    manager = CameraManager([], config_path=path)
    try:
        manager.add(CameraConfig("video", "clip.avi", name="Recording"))
        assert manager.get_worker("video").config == load_config(path)[0]
        assert load_config(path)[0].source == str(tmp_path / "clip.avi")
    finally:
        manager.close()


def test_concurrent_additions_and_status_snapshots(tmp_path):
    manager = CameraManager([], config_path=tmp_path / "config.json")

    def add(index):
        manager.add(CameraConfig(f"camera-{index}", index))
        return manager.statuses()

    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(add, range(12)))
        assert all(results)
        assert len(manager.statuses()) == 12
        assert len(load_config(tmp_path / "config.json")) == 12
    finally:
        manager.close()
    with pytest.raises(RuntimeError, match="closed"):
        manager.add(CameraConfig("late", 99))
