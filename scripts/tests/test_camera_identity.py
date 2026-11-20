"""Simulate DirectShow's shared slots and Windows hotplug index changes."""

import time
from types import SimpleNamespace

import pytest

import spyder_cctv.cameras as camera_module
import spyder_cctv.capture as capture_module
import spyder_cctv.directshow as directshow
from spyder_cctv.cameras import CameraManager, CameraWorker
from spyder_cctv.config import CameraConfig


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("Camera did not reach expected state")


class Pipeline:
    def process(self, frame):
        return frame, {}


@pytest.fixture
def devices(monkeypatch):
    state = SimpleNamespace(
        order=["device-a", "device-b"],
        slots={},
        opened=[],
        workers=[],
        generation=0,
        drop_a=False,
        on_open=None,
        duplicate_slots=[],
        opening=0,
        max_opening=0,
    )

    class NativeCapture:
        def __init__(self, index, backend):
            state.opening += 1
            state.max_opening = max(state.max_opening, state.opening)
            try:
                time.sleep(0.005)
                self.index = index
                # Reproduce the actual shared videoInput behavior: setupDevice
                # on an occupied slot reuses the other handle's existing frames.
                if index in state.slots:
                    state.duplicate_slots.append(index)
                self.identity = state.slots.setdefault(index, state.order[index])
                self.generation = state.generation
                self.closed = False
                state.opened.append(self)
                if state.on_open is not None:
                    state.on_open()
            finally:
                state.opening -= 1

        def isOpened(self):
            return True

        def read(self):
            if self.identity == "device-a" and self.generation == 0 and state.drop_a:
                return False, None
            return True, state.slots.get(self.index)

        def release(self):
            self.closed = True
            state.slots.pop(self.index, None)

    class Controls:
        def __init__(self, index):
            self.index = index

        def capabilities(self):
            return {}

        def close(self):
            pass

    monkeypatch.setattr(capture_module, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(camera_module, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(capture_module.cv2, "VideoCapture", NativeCapture)
    monkeypatch.setattr(directshow, "DirectShowControls", Controls)
    monkeypatch.setattr(directshow, "enumerate_video_devices", lambda: list(state.order))

    def worker(ident, source):
        result = CameraWorker(
            CameraConfig(ident, source, fps=60),
            pipeline_factory=lambda name: Pipeline(),
            encoder=lambda frame: frame.encode(),
        )
        result._reconnect_delay = lambda attempt: 0.02
        state.workers.append(result)
        return result

    state.worker = worker
    yield state
    for instance in state.workers:
        instance.stop()
    assert all(instance.closed for instance in state.opened)
    assert state.duplicate_slots == []
    assert not capture_module._DEVICE_SLOTS and not capture_module._DEVICE_CLAIMS


def test_reconnect_follows_original_device_after_indices_swap(devices):
    front, back = devices.worker("front", 0), devices.worker("back", 1)
    for worker in (front, back):
        worker.start()
    wait_for(lambda: front.jpeg() == b"device-a" and back.jpeg() == b"device-b")
    devices.order[:] = ["device-b", "device-a"]
    devices.generation = 1
    devices.drop_a = True
    wait_for(
        lambda: (
            front.status()["reconnection"]["recoveries"] == 1
            and front.jpeg() == b"device-a"
            and back.jpeg() == b"device-b"
        )
    )
    assert devices.opened[1].closed  # Other old slot had to drain before reassignment.
    assert devices.max_opening == 1


def test_missing_original_camera_never_falls_back_to_remaining_webcam(devices):
    front, back = devices.worker("front", 0), devices.worker("back", 1)
    front.start()
    back.start()
    wait_for(lambda: front.jpeg() == b"device-a" and back.jpeg() == b"device-b")
    devices.order[:] = ["device-b"]
    devices.generation = 1
    devices.drop_a = True
    wait_for(
        lambda: (
            front.status()["state"] == "reconnecting"
            and back.status()["reconnection"]["recoveries"] == 1
        )
    )
    assert front.jpeg() is None and back.jpeg() == b"device-b"
    devices.order.append("device-a")
    wait_for(lambda: front.jpeg() == b"device-a")


def test_hotplug_during_initial_open_keeps_first_selected_identity(devices):
    def change_order():
        devices.order[:] = ["device-b", "device-a"]
        devices.on_open = None

    devices.on_open = change_order
    front = devices.worker("front", 0)
    front.start()
    wait_for(lambda: front.jpeg() == b"device-a")
    assert len(devices.opened) == 2 and devices.opened[0].closed
    assert devices.opened[-1].index == 1


def test_bindings_survive_application_restart_and_index_change(devices, tmp_path):
    def manager():
        return CameraManager(
            [CameraConfig("front", 0, fps=60), CameraConfig("back", 1, fps=60)],
            config_path=tmp_path / "config.json",
            media_dir=tmp_path / "media",
            pipeline_factory=lambda name: Pipeline(),
            encoder=lambda frame: frame.encode(),
        )

    first = manager()
    try:
        for worker in first.workers.values():
            worker.start()
        wait_for(lambda: all(w.status()["state"] == "running" for w in first.workers.values()))
    finally:
        first.close()
    assert (tmp_path / "camera-devices.json").is_file()
    devices.order.reverse()
    second = manager()
    try:
        for worker in second.workers.values():
            worker.start()
        wait_for(
            lambda: (
                second.get_worker("front").jpeg() == b"device-a"
                and second.get_worker("back").jpeg() == b"device-b"
            )
        )
        statuses = second.statuses()
        assert len({s["device_binding"]["fingerprint"] for s in statuses}) == 2
        assert "device-a" not in str(statuses)
    finally:
        second.close()


def test_same_physical_device_cannot_be_opened_twice_and_old_close_is_harmless(devices):
    first = capture_module.OpenCVCapture(0)
    try:
        with pytest.raises(capture_module.CameraIdentityError, match="already in use"):
            capture_module.OpenCVCapture(1, device_id="device-a")
    finally:
        first.close()
    second = capture_module.OpenCVCapture(0)
    try:
        first.close()  # Must not erase the new owner's physical/slot reservations.
        with pytest.raises(capture_module.CameraIdentityError):
            capture_module.OpenCVCapture(0)
    finally:
        second.close()


def test_unknown_device_identity_keeps_slot_but_never_opens_it(devices):
    devices.order[:] = [None, "device-b"]
    front, back = devices.worker("front", 0), devices.worker("back", 1)
    front.start()
    back.start()
    wait_for(lambda: front.status()["state"] == "reconnecting" and back.jpeg() == b"device-b")
    assert front.jpeg() is None and len(devices.opened) == 1
    assert devices.opened[0].index == 1
