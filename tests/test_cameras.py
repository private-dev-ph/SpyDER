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
        wait_for(lambda: manager.workers["bad"].status()["state"] == "error")
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
