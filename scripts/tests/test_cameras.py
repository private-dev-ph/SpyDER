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
        assert worker._pipeline is None
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


class DemandPipeline:
    def __init__(self):
        self.active = True
        self.processed = 0
        self.active_changes = []
        self.closed = False

    def set_active(self, active):
        self.active = active
        self.active_changes.append(active)

    def process(self, frame):
        assert self.active
        self.processed += 1
        return frame, {"cv": {"state": "ready", "detections": [{"label": "person"}]}}

    def close(self):
        self.closed = True


def test_managed_vision_is_lazy_and_idle_capture_continues():
    import numpy as np

    frames = []
    pipelines = []

    class ArrayCapture(FakeCapture):
        def read(self):
            return True, np.zeros((2, 2, 3), dtype=np.uint8)

    def make_pipeline(name):
        pipeline = DemandPipeline()
        pipelines.append(pipeline)
        return pipeline

    manager = CameraManager(
        [CameraConfig("front", 0, fps=60, pipeline="vision")],
        capture_factory=ArrayCapture,
        pipeline_factory=make_pipeline,
        encoder=lambda frame: frames.append(frame.copy()) or b"jpeg",
    )
    worker = manager.get_worker("front")
    try:
        manager.set_workflow_vision_cameras(set())
        worker.start()
        wait_for(lambda: worker.status()["frames"] >= 3)
        assert pipelines == []
        assert worker.vision_snapshot()["runtime"]["state"] == "idle"
        assert worker.status()["metadata"]["cv"]["result_age_seconds"] is None
        manager.set_vision("front", {"confidence": 0.6})
        assert pipelines == []
        assert worker.config.pipeline == "vision"
        assert worker.config.vision.confidence == 0.6
        frame_count = worker.status()["frames"]
        manager.set_workflow_vision_cameras({"front"})
        wait_for(lambda: pipelines and pipelines[0].processed > 0)
        assert worker.config.pipeline == "vision"
        manager.set_workflow_vision_cameras(set())
        wait_for(lambda: worker.status()["metadata"]["cv"]["state"] == "idle")
        wait_for(lambda: worker.status()["frames"] > frame_count)
        process_count = pipelines[0].processed
        frames_after_idle = worker.status()["frames"]
        wait_for(lambda: worker.status()["frames"] > frames_after_idle)
        assert pipelines[0].active is False
        assert pipelines[0].processed == process_count
        assert worker.config.pipeline == "vision"
        assert frames
    finally:
        manager.close()


def test_preview_is_temporary_demand_and_raw_reads_do_not_renew_it():
    import numpy as np

    pipelines = []

    class ArrayCapture(FakeCapture):
        def read(self):
            return True, np.zeros((2, 2, 3), dtype=np.uint8)

    manager = CameraManager(
        [CameraConfig("front", 0, fps=60, pipeline="vision")],
        capture_factory=ArrayCapture,
        pipeline_factory=lambda name: pipelines.append(DemandPipeline()) or pipelines[-1],
        encoder=lambda frame: b"jpeg",
    )
    worker = manager.get_worker("front")
    try:
        manager.set_workflow_vision_cameras(set())
        worker.start()
        wait_for(lambda: worker.status()["frames"] > 0)
        worker.request_vision_preview(ttl=0.08)
        wait_for(lambda: pipelines and pipelines[0].processed > 0)
        deadline = time.monotonic() + 0.12
        while time.monotonic() < deadline:
            worker.raw_frame()
            time.sleep(0.005)
        wait_for(lambda: worker.status()["metadata"]["cv"]["state"] == "idle")
        processed = pipelines[0].processed
        wait_for(lambda: worker.status()["frames"] > 2)
        assert pipelines[0].active is False
        assert pipelines[0].processed == processed
    finally:
        manager.close()


def test_manager_snapshot_applies_to_existing_and_added_workers(tmp_path):
    manager = CameraManager([], config_path=tmp_path / "config.json")
    try:
        manager.set_workflow_vision_cameras({"active"})
        manager.add(CameraConfig("active", 0, pipeline="vision"))
        manager.add(CameraConfig("idle", 1, pipeline="vision"))
        saved = (tmp_path / "config.json").read_bytes()
        assert manager.get_worker("active")._workflow_vision_required is True
        assert manager.get_worker("idle")._workflow_vision_required is False
        manager.set_workflow_vision_cameras(set())
        assert manager.get_worker("active").vision_snapshot()["runtime"]["state"] == "idle"
        assert (tmp_path / "config.json").read_bytes() == saved
    finally:
        manager.close()


def test_raw_preview_lease_keeps_frames_fresh_without_vision_demand():
    import numpy as np

    class ArrayCapture(FakeCapture):
        def __init__(self, source):
            super().__init__(source)
            self.sequence = 0

        def read(self):
            self.sequence += 1
            return True, np.full((2, 2, 3), self.sequence % 255, dtype=np.uint8)

    pipelines = []
    manager = CameraManager(
        [CameraConfig("front", 0, fps=60, pipeline="vision")],
        capture_factory=ArrayCapture,
        pipeline_factory=lambda name: pipelines.append(DemandPipeline()) or pipelines[-1],
        encoder=lambda frame: b"jpeg",
    )
    worker = manager.get_worker("front")
    try:
        manager.set_workflow_vision_cameras(set())
        worker.start()
        wait_for(lambda: worker.status()["frames"] >= 3)
        assert pipelines == []
        assert worker.vision_snapshot()["runtime"]["state"] == "idle"
        raw = worker.raw_frame(timeout=0.15)
        assert raw is not None
        initial_pixel = int(raw[0, 0, 0])
        time.sleep(0.04)
        renewed = worker.raw_frame()
        assert renewed is not None
        assert int(renewed[0, 0, 0]) != initial_pixel
        assert worker.status()["metadata"]["cv"]["state"] == "idle"
        assert pipelines == []
    finally:
        manager.close()


def test_config_change_during_pipeline_creation_fences_old_generation():
    import numpy as np

    factory_entered = threading.Event()
    release_factory = threading.Event()
    second_read = threading.Event()
    release_capture = threading.Event()
    pipelines = []

    class Capture(FakeCapture):
        def __init__(self, source):
            super().__init__(source)
            self.reads = 0

        def read(self):
            self.reads += 1
            if self.reads == 1:
                return True, np.zeros((2, 2, 3), dtype=np.uint8)
            second_read.set()
            release_capture.wait(2)
            return True, np.zeros((2, 2, 3), dtype=np.uint8)

    class OldPipeline(DemandPipeline):
        def process(self, frame):
            self.processed += 1
            return frame, {"cv": {"state": "ready", "detections": [{"label": "old"}]}}

    def make_pipeline(name):
        factory_entered.set()
        assert release_factory.wait(2)
        pipeline = OldPipeline()
        pipelines.append(pipeline)
        return pipeline

    manager = CameraManager(
        [CameraConfig("front", 0, fps=60, pipeline="vision")],
        capture_factory=Capture,
        pipeline_factory=make_pipeline,
        encoder=lambda frame: b"jpeg",
    )
    worker = manager.get_worker("front")
    try:
        manager.set_workflow_vision_cameras({"front"})
        worker.start()
        assert factory_entered.wait(2)
        manager.set_vision("front", {"confidence": 0.6})
        release_factory.set()
        assert second_read.wait(2)
        runtime = worker.status()["metadata"]["cv"]
        assert runtime["state"] == "scheduled"
        assert runtime["detections"] == []
        assert pipelines[0].processed == 1
    finally:
        release_factory.set()
        release_capture.set()
        manager.close()


def test_rapid_pause_resume_serializes_runtime_activity_transitions():
    pause_entered = threading.Event()
    release_pause = threading.Event()
    resume_lock_attempted = threading.Event()
    resume_finished = threading.Event()
    pipelines = []

    class BlockingPausePipeline(DemandPipeline):
        def __init__(self):
            super().__init__()
            self.epoch = 0
            self.pause_blocked = False

        def set_active(self, active):
            if not active and not self.pause_blocked:
                self.pause_blocked = True
                pause_entered.set()
                assert release_pause.wait(2)
                self.epoch += 1
            super().set_active(active)

        def process(self, frame):
            assert self.active
            self.processed += 1
            return frame, {
                "cv": {
                    "state": "ready",
                    "detections": [],
                    "epoch": self.epoch,
                }
            }

    def make_pipeline(name):
        pipeline = BlockingPausePipeline()
        pipelines.append(pipeline)
        return pipeline

    manager = CameraManager(
        [CameraConfig("front", 0, fps=60, pipeline="vision")],
        capture_factory=FakeCapture,
        pipeline_factory=make_pipeline,
        encoder=lambda frame: b"jpeg",
    )
    worker = manager.get_worker("front")

    class ObservedActivityLock:
        def __init__(self):
            self.lock = threading.Lock()

        def __enter__(self):
            if threading.current_thread().name == "resume-demand":
                resume_lock_attempted.set()
            self.lock.acquire()
            return self

        def __exit__(self, exc_type, exc, traceback):
            self.lock.release()

    try:
        manager.set_workflow_vision_cameras({"front"})
        worker.start()
        wait_for(lambda: pipelines and pipelines[0].processed > 0)
        worker._pipeline_activity_lock = ObservedActivityLock()
        pausing = threading.Thread(
            target=lambda: worker.set_workflow_vision_required(False), name="pause-demand"
        )

        def resume():
            worker.set_workflow_vision_required(True)
            resume_finished.set()

        pausing.start()
        assert pause_entered.wait(2)
        resuming = threading.Thread(target=resume, name="resume-demand")
        resuming.start()
        assert resume_lock_attempted.wait(2)
        assert worker._workflow_vision_required is False
        assert not resume_finished.is_set()
        release_pause.set()
        pausing.join(2)
        resuming.join(2)
        assert not pausing.is_alive() and not resuming.is_alive()
        assert resume_finished.is_set()
        assert pipelines[0].active is True
        assert pipelines[0].epoch == 1
        assert pipelines[0].active_changes[-2:] == [False, True]
        wait_for(lambda: worker.status()["metadata"]["cv"].get("epoch") == 1)
    finally:
        release_pause.set()
        manager.close()


@pytest.mark.parametrize("transition", ["stop", "session"])
def test_raw_frame_wait_releases_lock_and_cancels_on_capture_transition(transition):
    import numpy as np

    worker = CameraWorker(CameraConfig("front", 0, pipeline="none"))
    with worker._lock:
        worker._state = "running"
        worker._capture_session = "before"
    result = []
    waiter = threading.Thread(target=lambda: result.append(worker.raw_frame(timeout=2)))
    waiter.start()
    try:
        wait_for(lambda: worker._raw_preview_requested_until > 0)
        if transition == "stop":
            worker.request_stop()
        else:
            with worker._preview_ready:
                worker._capture_session = "after"
                worker._preview_raw = np.ones((2, 2, 3), dtype=np.uint8)
                worker._preview_updated = time.monotonic()
                worker._preview_ready.notify_all()
        waiter.join(0.5)
        assert not waiter.is_alive()
        assert result == [None]
    finally:
        worker.request_stop()
        waiter.join(2)


def test_raw_frame_wait_is_bounded_without_new_frames():
    worker = CameraWorker(CameraConfig("front", 0, pipeline="none"))
    with worker._lock:
        worker._state = "running"
    began = time.monotonic()
    assert worker.raw_frame(timeout=0.05) is None
    assert time.monotonic() - began < 0.5
    worker.request_stop()
