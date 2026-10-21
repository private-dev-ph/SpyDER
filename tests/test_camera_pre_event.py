import threading
import time

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig
from spyder_cctv.pre_event import PreEventBuffer


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

    def read(self):
        return True, self.source

    def close(self):
        pass


class StoppableCapture(FakeCapture):
    def __init__(self, source, disconnected):
        super().__init__(source)
        self.disconnected = disconnected

    def read(self):
        if self.disconnected.is_set():
            return False, None
        return True, self.source


class FakePipeline:
    def process(self, frame):
        return frame, {}


def make_manager(configs, buffer, capture_factory=FakeCapture):
    return CameraManager(
        configs,
        pre_event_buffer=buffer,
        capture_factory=capture_factory,
        pipeline_factory=lambda name: FakePipeline(),
        encoder=lambda frame: str(frame).encode(),
    )


def test_manager_shares_opt_in_buffer_and_workers_publish_session_frames():
    buffer = PreEventBuffer()
    manager = make_manager(
        [CameraConfig("front", 1, fps=60), CameraConfig("back", 2, fps=60)], buffer
    )
    try:
        assert manager.pre_event_buffer is buffer
        assert all(worker._pre_event_buffer is buffer for worker in manager.workers.values())
        buffer.configure({"front": 3})
        for worker in manager.workers.values():
            worker.start()
        wait_for(lambda: buffer.snapshot("front", 3))
        front_frames = buffer.snapshot("front", 3)
        assert front_frames
        assert all(frame.jpeg == b"1" for frame in front_frames)
        assert all(
            frame.capture_session == manager.workers["front"].status()["capture_session"]
            for frame in front_frames
        )
        assert buffer.snapshot("back", 3) == ()
        assert set(buffer.status()["cameras"]) == {"front"}
    finally:
        manager.close()
    assert buffer.snapshot("front", 3) == ()


def test_start_stop_and_restart_clear_buffer_and_rotate_capture_session():
    buffer = PreEventBuffer()
    buffer.configure({"front": 3})
    buffer.push("front", b"stale", time.monotonic(), "old-session")
    manager = make_manager([CameraConfig("front", 1, fps=60)], buffer)
    worker = manager.workers["front"]
    try:
        worker.start()
        wait_for(lambda: buffer.snapshot("front", 3))
        first_session = worker.status()["capture_session"]
        assert all(frame.capture_session == first_session for frame in buffer.snapshot("front", 3))
        assert all(frame.jpeg != b"stale" for frame in buffer.snapshot("front", 3))
        worker.stop()
        assert buffer.snapshot("front", 3) == ()
        worker.start()
        wait_for(lambda: buffer.snapshot("front", 3))
        assert worker.status()["capture_session"] != first_session
    finally:
        manager.close()


def test_disconnect_clears_history_and_camera_removal_clears_history():
    disconnected = threading.Event()
    buffer = PreEventBuffer()
    manager = make_manager(
        [CameraConfig("front", 1, fps=60)],
        buffer,
        capture_factory=lambda source: StoppableCapture(source, disconnected),
    )
    worker = manager.workers["front"]
    worker._reconnect_delay = lambda attempt: 0.02
    try:
        buffer.configure({"front": 3})
        worker.start()
        wait_for(lambda: buffer.snapshot("front", 3))
        first_session = worker.status()["capture_session"]
        disconnected.set()
        wait_for(lambda: worker.status()["state"] == "reconnecting")
        assert buffer.snapshot("front", 3) == ()
        disconnected.clear()
        wait_for(lambda: buffer.snapshot("front", 3))
        assert worker.status()["capture_session"] != first_session
        manager.remove("front")
        assert buffer.snapshot("front", 3) == ()
        assert "front" not in manager.workers
    finally:
        manager.close()
