import threading
import time

import pytest

from spyder_cctv.cameras import CameraManager, CameraWorker
from spyder_cctv.config import CameraConfig


def wait_for(predicate, timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("Condition did not become true")


class FakeCapture:
    def __init__(self, source):
        self.source = source
        self.owner = threading.get_ident()
        self.closed = False

    def read(self):
        assert threading.get_ident() == self.owner
        return True, self.source

    def close(self):
        assert threading.get_ident() == self.owner
        self.closed = True


class FakePipeline:
    def process(self, frame):
        return frame, {"processed": True}


def test_simultaneous_independent_control_and_restart():
    captures = []
    pipelines = []

    def capture_factory(source):
        capture = FakeCapture(source)
        captures.append(capture)
        return capture

    def pipeline_factory(name):
        pipeline = FakePipeline()
        pipelines.append(pipeline)
        return pipeline

    manager = CameraManager(
        [CameraConfig("front", 0, 60), CameraConfig("back", 1, 60)],
        capture_factory=capture_factory,
        pipeline_factory=pipeline_factory,
        encoder=lambda frame: str(frame).encode(),
    )
    front, back = manager.workers.values()
    try:
        front.start()
        back.start()
        wait_for(lambda: front.jpeg() == b"0" and back.jpeg() == b"1")
        front.start()  # Idempotent: does not open another capture.
        assert len(captures) == 2
        assert front.status()["metadata"] == {"processed": True}
        front.stop()
        assert front.jpeg() is None
        assert front.status()["metadata"] == {}
        previous = back.status()["frames"]
        wait_for(lambda: back.status()["frames"] > previous)
        front.start()
        wait_for(lambda: front.jpeg() == b"0")
        assert len(pipelines) == 3  # No stale motion history after restart.
    finally:
        manager.close()
    assert all(capture.closed for capture in captures)
    assert all(status["state"] == "stopped" for status in manager.statuses())


def test_failed_camera_does_not_stop_other_camera():
    def factory(source):
        if source == 0:
            raise RuntimeError("rtsp://secret:password@camera")
        return FakeCapture(source)

    manager = CameraManager(
        [CameraConfig("bad", 0), CameraConfig("good", 1)],
        capture_factory=factory,
        pipeline_factory=lambda name: FakePipeline(),
        encoder=lambda frame: b"jpeg",
    )
    try:
        for worker in manager.workers.values():
            worker.start()
        wait_for(lambda: manager.workers["bad"].status()["state"] == "reconnecting")
        wait_for(lambda: manager.workers["good"].jpeg() == b"jpeg")
        assert "password" not in str(manager.statuses())
    finally:
        manager.close()


def test_closed_manager_cannot_restart():
    manager = CameraManager([CameraConfig("front", 0)])
    manager.close()
    with pytest.raises(RuntimeError, match="closed"):
        manager.workers["front"].start()


def test_blocked_backend_shutdown_reports_timeout_and_prevents_second_owner():
    release = threading.Event()
    entered = threading.Event()

    class BlockedCapture(FakeCapture):
        def read(self):
            entered.set()
            release.wait(3)
            return super().read()

    worker = CameraWorker(
        CameraConfig("blocked", 0),
        capture_factory=BlockedCapture,
        pipeline_factory=lambda name: FakePipeline(),
        encoder=lambda frame: b"jpeg",
    )
    try:
        worker.start()
        assert entered.wait(2)
        with pytest.raises(RuntimeError, match="timeout"):
            worker.stop(timeout=0.01)
        assert worker.status()["state"] == "stopping"
        with pytest.raises(RuntimeError, match="still stopping"):
            worker.start()
    finally:
        release.set()
        worker.stop()


def test_stale_frame_not_served():
    worker = CameraWorker(
        CameraConfig("front", 0, fps=0.1),
        capture_factory=FakeCapture,
        pipeline_factory=lambda name: FakePipeline(),
        encoder=lambda frame: b"jpeg",
    )
    try:
        worker.start()
        wait_for(lambda: worker.jpeg() is not None)
        with worker._lock:
            worker._updated = time.monotonic() - 100
            assert worker._jpeg == b"jpeg"
        assert worker.jpeg() is None
    finally:
        worker.stop()


def test_reconnect_backoff_is_bounded_and_does_not_overflow():
    assert [CameraWorker._reconnect_delay(i) for i in range(1, 8)] == [1, 2, 4, 8, 16, 30, 30]
    assert CameraWorker._reconnect_delay(10**9) == 30


def test_stop_cancels_pending_reconnection_and_releases_single_owner():
    attempts = []

    def factory(source):
        attempts.append(source)
        raise RuntimeError("rtsp://private:secret@camera")

    worker = CameraWorker(CameraConfig("offline", 0), capture_factory=factory)
    try:
        worker.start()
        wait_for(lambda: worker.status()["reconnection"]["retry_in_seconds"] is not None)
        worker.start()  # Starting during retry must not open another worker.
        assert len(attempts) == 1
        began = time.monotonic()
        worker.stop()
        assert time.monotonic() - began < 0.5
        assert worker.status()["state"] == "stopped"
        assert worker.status()["reconnection"]["retry_in_seconds"] is None
        assert len(attempts) == 1
        assert "secret" not in str(worker.status())
    finally:
        worker.stop()


@pytest.mark.parametrize("read_raises", [False, True])
def test_reconnect_clears_stale_data_reapplies_settings_and_resets_pipeline(read_raises):
    import numpy as np

    dropped, restored = threading.Event(), threading.Event()
    captures, pipelines, controls = [], [], []

    class DroppingCapture(FakeCapture):
        def read(self):
            if self.source == 0 and dropped.is_set():
                if read_raises:
                    raise OSError("rtsp://user:secret@camera timed out")
                return False, None
            ok, source = super().read()
            return ok, np.full((2, 2, 3), source, dtype=np.uint8)

        def apply_controls(self, desired):
            controls.append((self.source, desired))
            return {"capabilities": {}, "results": {}}

    class Pipeline(FakePipeline):
        closed = False

        def close(self):
            self.closed = True

    def factory(source):
        if captures and not restored.is_set():
            assert captures[0].closed  # Never open two handles for a camera.
            raise RuntimeError("offline")
        capture = DroppingCapture(1 if restored.is_set() else 0)
        captures.append(capture)
        return capture

    def pipeline_factory(name):
        pipeline = Pipeline()
        pipelines.append(pipeline)
        return pipeline

    worker = CameraWorker(
        CameraConfig("front", 0, fps=60),
        capture_factory=factory,
        pipeline_factory=pipeline_factory,
        encoder=lambda frame: str(int(frame[0, 0, 0])).encode(),
        desired_settings={"brightness": 10.0},
    )
    worker._reconnect_delay = lambda attempt: 0.02
    try:
        worker.start()
        wait_for(lambda: worker.jpeg() == b"0")
        session = worker.status()["capture_session"]
        dropped.set()
        wait_for(lambda: worker.status()["state"] == "reconnecting" and captures[0].closed)
        assert worker.jpeg() is None and worker.raw_frame() is None
        assert worker.status()["metadata"] == {}
        assert pipelines[0].closed
        restored.set()
        wait_for(lambda: worker.jpeg() == b"1")
        status = worker.status()
        assert status["error"] is None and status["reconnection"]["recoveries"] == 1
        assert status["capture_session"] != session
        assert len(pipelines) == 2
        assert controls == [(0, {"brightness": 10.0}), (1, {"brightness": 10.0})]
    finally:
        worker.stop()
    assert all(capture.closed for capture in captures)


@pytest.mark.parametrize("source", ["clip.mp4", "file:///tmp/clip.mp4"])
def test_video_file_end_does_not_reconnect(source):
    attempts = []

    class Ended(FakeCapture):
        def read(self):
            return False, None

    def factory(source):
        attempts.append(source)
        return Ended(source)

    worker = CameraWorker(CameraConfig("file", source), capture_factory=factory)
    try:
        worker.start()
        wait_for(lambda: worker.status()["state"] == "error")
        assert worker.status()["reconnection"]["enabled"] is False
        assert worker.status()["reconnection"]["attempt"] == 0
        assert len(attempts) == 1
    finally:
        worker.stop()


def test_processing_error_is_terminal_not_a_reconnection_loop():
    attempts = []

    def factory(source):
        attempts.append(source)
        return FakeCapture(source)

    def encoder(frame):
        raise RuntimeError("processing failed")

    worker = CameraWorker(
        CameraConfig("front", 0),
        capture_factory=factory,
        pipeline_factory=lambda name: FakePipeline(),
        encoder=encoder,
    )
    try:
        worker.start()
        wait_for(lambda: worker.status()["state"] == "error")
        assert len(attempts) == 1
        assert worker.status()["reconnection"]["attempt"] == 0
    finally:
        worker.stop()


def test_failed_capture_release_prevents_second_owner():
    attempts = []

    class ReleaseFailed(FakeCapture):
        def read(self):
            return False, None

        def close(self):
            raise RuntimeError("release failed")

    def factory(source):
        attempts.append(source)
        return ReleaseFailed(source)

    worker = CameraWorker(CameraConfig("front", 0), capture_factory=factory)
    try:
        worker.start()
        wait_for(lambda: worker.status()["state"] == "error")
        assert "released" in worker.status()["error"]
        with pytest.raises(RuntimeError, match="could not be released"):
            worker.start()
        assert len(attempts) == 1
    finally:
        worker.stop()


def test_initial_open_failures_recover_and_stable_stream_resets_backoff():
    attempts = []
    drop = threading.Event()

    class Capture(FakeCapture):
        def read(self):
            if drop.is_set():
                return False, None
            return super().read()

    def factory(source):
        attempts.append(source)
        if len(attempts) < 3:
            raise OSError("temporarily offline")
        return Capture(source)

    worker = CameraWorker(
        CameraConfig("front", "rtsp://camera", fps=60),
        capture_factory=factory,
        pipeline_factory=lambda name: FakePipeline(),
        encoder=lambda frame: b"jpeg",
    )
    worker._reconnect_delay = lambda attempt: 0.02 if attempt < 3 else 30
    try:
        worker.start()
        wait_for(lambda: worker.jpeg() == b"jpeg")
        assert worker.status()["reconnection"]["attempt"] == 2
        assert len(attempts) == 3
        with worker._lock:
            worker._connected_since = time.monotonic() - 31
        drop.set()
        wait_for(lambda: worker.status()["reconnection"]["attempt"] == 1)
    finally:
        worker.stop()


@pytest.mark.parametrize("count", [4, 32])
def test_many_offline_cameras_cancel_retries_on_manager_close(count):
    attempts = []

    def factory(source):
        attempts.append(source)
        raise OSError("offline")

    manager = CameraManager(
        [CameraConfig(f"camera-{i}", i) for i in range(count)], capture_factory=factory
    )
    for worker in manager.workers.values():
        worker._reconnect_delay = lambda attempt: 30
        worker.start()
    wait_for(lambda: all(w.status()["state"] == "reconnecting" for w in manager.workers.values()))
    manager.close()
    assert len(attempts) == count
    assert all(not w._thread.is_alive() for w in manager.workers.values())
    assert all(w.status()["state"] == "stopped" for w in manager.workers.values())


@pytest.mark.parametrize(
    "source", ["/dev/video0", "/dev/v4l/by-id/usb-camera", "/dev/v4l/by-path/pci-usb-camera"]
)
def test_linux_device_paths_support_reconnection(source):
    assert CameraWorker(CameraConfig("device", source)).status()["reconnection"]["enabled"]
