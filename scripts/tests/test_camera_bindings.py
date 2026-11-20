import json
import threading
from pathlib import Path

import pytest

from spyder_cctv.camera_bindings import CameraBindings


def test_roundtrip_and_source_mismatch(tmp_path: Path) -> None:
    path = tmp_path / "camera-devices.json"
    store = CameraBindings(path)
    store.bind("front_cam", 2, "device:front")

    assert CameraBindings(path).get("front_cam", 2) == "device:front"
    assert CameraBindings(path).get("front_cam", 3) is None
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "version": 1,
        "bindings": {"front_cam": {"source": 2, "device_id": "device:front"}},
    }


def test_in_memory_bindings_are_thread_safe() -> None:
    store = CameraBindings()
    errors: list[BaseException] = []

    def bind(index: int) -> None:
        try:
            store.bind(f"camera_{index}", index, f"device:{index}")
        except BaseException as error:  # pragma: no cover - asserted below
            errors.append(error)

    threads = [threading.Thread(target=bind, args=(index,)) for index in range(64)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not errors
    assert all(store.get(f"camera_{index}", index) == f"device:{index}" for index in range(64))


def test_source_change_replaces_binding(tmp_path: Path) -> None:
    store = CameraBindings(tmp_path / "camera-devices.json")
    store.bind("front", 1, "old-device")
    store.bind("front", 2, "new-device")

    assert store.get("front", 1) is None
    assert store.get("front", 2) == "new-device"


def test_same_source_cannot_silently_rebind(tmp_path: Path) -> None:
    path = tmp_path / "camera-devices.json"
    store = CameraBindings(path)
    store.bind("front", 1, "device-a")

    with pytest.raises(RuntimeError, match="different device binding"):
        store.bind("front", 1, "device-b")

    assert store.get("front", 1) == "device-a"
    assert CameraBindings(path).get("front", 1) == "device-a"


@pytest.mark.parametrize(
    "contents",
    [
        b"{",
        b'{"version":2,"bindings":{}}',
        b'{"version":1,"bindings":{"bad id":{"source":1,"device_id":"x"}}}',
        b'{"version":1,"bindings":{"x":{"source":true,"device_id":"x"}}}',
        b'{"version":1,"bindings":{},"extra":1}',
    ],
)
def test_malformed_store_fails_closed(tmp_path: Path, contents: bytes) -> None:
    path = tmp_path / "camera-devices.json"
    path.write_bytes(contents)
    with pytest.raises(RuntimeError, match="Camera bindings store is invalid"):
        CameraBindings(path)


def test_oversized_store_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "camera-devices.json"
    path.write_bytes(b" " * (512 * 1024 + 1))

    with pytest.raises(RuntimeError, match="Camera bindings store is invalid"):
        CameraBindings(path)


def test_failed_save_preserves_memory_and_disk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "camera-devices.json"
    store = CameraBindings(path)
    store.bind("front", 1, "device-a")
    old_data = path.read_bytes()

    def fail_replace(source: str, destination: Path) -> None:
        raise OSError("private path detail")

    monkeypatch.setattr("spyder_cctv.camera_bindings.os.replace", fail_replace)
    with pytest.raises(RuntimeError, match="Cannot save camera bindings") as error:
        store.bind("rear", 2, "device-b")

    assert "private path detail" not in str(error.value)
    assert store.get("front", 1) == "device-a"
    assert store.get("rear", 2) is None
    assert path.read_bytes() == old_data


def test_remove_persists_and_is_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "camera-devices.json"
    store = CameraBindings(path)
    store.bind("front", 1, "device-a")
    store.remove("front")
    store.remove("front")

    assert CameraBindings(path).get("front", 1) is None


def test_device_ids_are_globally_unique_case_insensitively(tmp_path: Path) -> None:
    path = tmp_path / "camera-devices.json"
    store = CameraBindings(path)
    store.bind("front", 1, r"\\?\usb#vid_1234")

    store.bind("side", 4, "other-device")
    with pytest.raises(RuntimeError, match="Device already has a camera binding"):
        store.bind("rear", 2, r"\\?\USB#VID_1234")
    with pytest.raises(RuntimeError, match="Device already has a camera binding"):
        store.bind("front", 3, "other-device")
    assert store.get("front", 1) == r"\\?\usb#vid_1234"
    assert store.get("rear", 2) is None


def test_duplicate_device_ids_in_store_fail_closed(tmp_path: Path) -> None:
    path = tmp_path / "camera-devices.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "bindings": {
                    "front": {"source": 1, "device_id": "DevicePath"},
                    "rear": {"source": 2, "device_id": "devicepath"},
                },
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="Camera bindings store is invalid"):
        CameraBindings(path)


def test_runtime_cannot_add_more_than_sixty_four_bindings():
    registry = CameraBindings(None)
    for index in range(64):
        registry.bind(f"camera-{index}", index, f"device-{index}")
    with pytest.raises(RuntimeError, match="Too many"):
        registry.bind("extra", 64, "device-extra")
    assert registry.get("extra", 64) is None
