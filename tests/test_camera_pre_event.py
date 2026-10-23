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


def test_atomic_recording_sample_tracks_exact_pixels_timestamp_and_session():
    manager = make_manager([CameraConfig("front", 1, fps=60)], PreEventBuffer())
    worker = manager.workers["front"]
    try:
        assert worker.recording_sample() is None
        worker.start()
        wait_for(lambda: worker.recording_sample() is not None)
        sample = worker.recording_sample()
        assert sample.jpeg == b"1"
        assert sample.timestamp <= time.monotonic()
        assert sample.capture_session == worker.status()["capture_session"]
        worker.stop()
        assert worker.recording_sample() is None
        # Consumer-held snapshots remain immutable after the capture is released.
        assert sample.jpeg == b"1"
    finally:
        manager.close()


def test_recording_and_pre_event_frames_stay_clean_when_pipeline_annotates_in_place():
    class AnnotatingPipeline:
        def process(self, frame):
            frame.append("bright-box")
            return frame, {"detections": ["person"]}

    buffer = PreEventBuffer()
    buffer.configure({"front": 3})
    manager = CameraManager(
        [CameraConfig("front", 1, fps=60)],
        pre_event_buffer=buffer,
        capture_factory=lambda source: FakeCapture(["clean"]),
        pipeline_factory=lambda name: AnnotatingPipeline(),
        encoder=lambda frame: ",".join(frame).encode(),
    )
    worker = manager.workers["front"]
    try:
        worker.start()
        wait_for(lambda: worker.recording_sample() is not None and buffer.snapshot("front", 3))
        display = worker.jpeg()
        sample = worker.recording_sample()
        buffered = buffer.snapshot("front", 3)
        assert display is not None and b"bright-box" in display
        assert sample is not None and sample.jpeg == b"clean"
        assert buffered and all(frame.jpeg == b"clean" for frame in buffered)
        assert sample.timestamp <= time.monotonic()
        assert sample.capture_session == worker.status()["capture_session"]
        assert worker.status()["metadata"]["detections"] == ["person"]
        worker.stop()
        assert worker.jpeg() is None
        assert worker.recording_sample() is None
        assert buffer.snapshot("front", 3) == ()
    finally:
        manager.close()


def test_camera_publishes_size_matched_detection_annotations_atomically():
    import numpy as np

    buffer = PreEventBuffer()
    buffer.configure({"front": 3})

    class AnnotationPipeline:
        def process(self, frame):
            width, height = frame.shape[1], frame.shape[0]
            return frame, {
                "cv": {
                    "state": "ready",
                    "result_age_seconds": 0.1,
                    "frame_size": [width, height],
                    "detections": [
                        {
                            "label": "person",
                            "bbox": [-2, 1, width + 5, height - 1],
                            "confidence": 0.9,
                            "identity": "alice",
                            "embedding": [1, 2, 3],
                        }
                    ],
                }
            }

    class ArrayCapture(FakeCapture):
        def read(self):
            return True, np.zeros((4, 8, 3), dtype=np.uint8)

    manager = CameraManager(
        [CameraConfig("front", 1, fps=60)],
        pre_event_buffer=buffer,
        capture_factory=ArrayCapture,
        pipeline_factory=lambda name: AnnotationPipeline(),
        encoder=lambda frame: b"clean-jpeg",
    )
    worker = manager.workers["front"]
    try:
        worker.start()
        wait_for(lambda: worker.recording_sample() is not None and buffer.snapshot("front", 3))
        sample = worker.recording_sample()
        buffered = buffer.snapshot("front", 3)[-1]
        assert sample is not None
        expected = (
            {
                "bbox": [0.0, 0.25, 1.0, 0.5],
                "label": "person",
                "kind": "detection",
                "confidence": 0.9,
                "identity": "alice",
            },
        )
        assert sample.annotations == expected
        assert buffered.annotations == expected
        assert sample.jpeg == buffered.jpeg == b"clean-jpeg"
        assert sample.timestamp == buffered.timestamp
        assert sample.capture_session == buffered.capture_session
        sample.annotations[0]["bbox"][0] = 77
        buffered.annotations[0]["label"] = "changed"
        assert worker.recording_sample().annotations == expected
        assert buffer.snapshot("front", 3)[-1].annotations == expected
    finally:
        manager.close()


def test_annotation_normalizer_handles_motion_tracks_stale_and_malformed_results():
    import numpy as np

    from spyder_cctv.recording_detection_metadata import normalize_detection_metadata

    frame = np.zeros((10, 20, 3), dtype=np.uint8)
    metadata = {
        "cv": {
            "state": "ready",
            "result_age_seconds": 1.9,
            "frame_size": [20, 10],
            "detections": [
                {"label": "car", "bbox": [18, 8, 25, 15], "confidence": float("nan")},
                {"label": "bad", "bbox": [0, 0, float("inf"), 1]},
            ],
        },
        "analysis": {
            "state": "ready",
            "result_age_seconds": 0.2,
            "frame_size": [20, 10],
            "regions": [{"bbox": [-2, 2, 5, 8]}],
            "tracks": [{"id": 7, "bbox": [4, 3, 5, 4]}],
        },
    }
    annotations = normalize_detection_metadata(metadata, frame)
    assert [item["kind"] for item in annotations] == ["detection", "motion", "track"]
    assert annotations[0]["bbox"] == [0.9, 0.8, 0.1, 0.2]
    assert "confidence" not in annotations[0]
    assert annotations[1]["bbox"] == [0.0, 0.2, 0.15, 0.8]
    assert annotations[1]["label"] == "motion"
    assert annotations[2]["track_id"] == 7
    assert annotations[2]["bbox"] == [0.2, 0.3, 0.25, 0.4]
    metadata["cv"]["result_age_seconds"] = 2.1
    metadata["analysis"]["frame_size"] = [19, 10]
    assert normalize_detection_metadata(metadata, frame) == ()
