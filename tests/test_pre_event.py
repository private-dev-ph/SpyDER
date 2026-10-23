from concurrent.futures import ThreadPoolExecutor

import pytest

from spyder_cctv.pre_event import BufferedFrame, PreEventBuffer


class FakeClock:
    def __init__(self, value=100.0):
        self.value = value

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


def test_opt_in_snapshot_and_no_future_frames():
    clock = FakeClock()
    buffer = PreEventBuffer(clock=clock)
    assert not buffer.push("cam", b"ignored", 100, "a")
    buffer.configure({"cam": 10})
    buffer.push("cam", b"old", 95, "a")
    clock.advance(1)
    buffer.push("cam", b"new", 100.2, "a")

    frames = buffer.snapshot("cam", 10, before=100.5)
    assert isinstance(frames, tuple)
    assert [frame.jpeg for frame in frames] == [b"old", b"new"]
    assert buffer.snapshot("cam", 1, before=100.1) == ()
    assert buffer.snapshot("cam", 10, before=101)[-1].timestamp == 100.2
    with pytest.raises(ValueError):
        buffer.push("cam", b"future", 102, "a")


def test_rate_limit_and_session_change_clears_before_throttle():
    clock = FakeClock()
    buffer = PreEventBuffer(clock=clock)
    buffer.configure({"cam": 20})
    assert buffer.push("cam", b"a", 100, "one")
    clock.advance(0.1)
    assert not buffer.push("cam", b"throttled", 100.1, "one")
    assert buffer.push("cam", b"new session", 100.1, "two")
    assert [f.jpeg for f in buffer.snapshot("cam", 20)] == [b"new session"]


def test_retention_window_shrink_clear_and_disabled_camera():
    clock = FakeClock()
    buffer = PreEventBuffer(clock=clock)
    buffer.configure({"cam": 20, "other": 5})
    for timestamp in (90, 95, 100):
        buffer.push("cam", str(timestamp).encode(), timestamp, "s")
        clock.advance(0.2)
    buffer.configure({"cam": 4})
    assert [f.timestamp for f in buffer.snapshot("cam", 30)] == [100]
    buffer.clear("cam")
    assert buffer.status()["cameras"]["cam"]["frames"] == 0
    buffer.configure({})
    assert buffer.push("cam", b"discard", clock(), "s") is False
    assert buffer.status()["total_bytes"] == 0


def test_per_camera_and_global_byte_caps_evict_oldest():
    clock = FakeClock()
    buffer = PreEventBuffer(max_bytes=10, per_camera_bytes=8, max_fps=5, clock=clock)
    buffer.configure({"a": 30, "b": 30})
    buffer.push("a", b"12345678", 100, "s")
    clock.advance(0.2)
    buffer.push("b", b"abcdef", 100.2, "s")
    assert buffer.snapshot("a", 30) == ()
    assert [f.jpeg for f in buffer.snapshot("b", 30)] == [b"abcdef"]
    assert buffer.status()["total_bytes"] == 6
    clock.advance(0.2)
    assert buffer.push("b", b"123456789", 100.4, "s") is False
    assert buffer.status()["total_bytes"] == 6


def test_sixty_four_camera_bound_and_configuration_validation():
    buffer = PreEventBuffer(clock=FakeClock())
    buffer.configure({f"cam-{i}": 30 for i in range(64)})
    assert len(buffer.status()["cameras"]) == 64
    with pytest.raises(ValueError):
        buffer.configure({f"cam-{i}": 1 for i in range(65)})
    for bad in (-1, 31, True, 1.0):
        with pytest.raises(ValueError):
            buffer.configure({"cam": bad})


def test_snapshot_frames_are_immutable_and_share_jpeg_bytes():
    clock = FakeClock()
    buffer = PreEventBuffer(clock=clock)
    buffer.configure({"cam": 2})
    jpeg = b"jpeg"
    buffer.push("cam", jpeg, 100, "session")
    frame = buffer.snapshot("cam", 2)[0]
    assert isinstance(frame, BufferedFrame)
    assert frame.jpeg is jpeg
    with pytest.raises(AttributeError):
        frame.timestamp = 101


def test_annotations_are_defensive_copies_and_count_toward_buffer_limits():
    clock = FakeClock()
    annotations = [{"bbox": [0.1, 0.2, 0.3, 0.4], "label": "person", "kind": "detection"}]
    jpeg = b"jpeg"
    annotation_size = len(b'{"bbox":[0.1,0.2,0.3,0.4],"label":"person","kind":"detection"}')
    buffer = PreEventBuffer(
        max_bytes=len(jpeg) + annotation_size - 1,
        per_camera_bytes=len(jpeg) + annotation_size - 1,
        clock=clock,
    )
    buffer.configure({"cam": 2})
    assert not buffer.push("cam", jpeg, 100, "session", annotations=annotations)
    assert buffer.status()["total_bytes"] == 0

    buffer = PreEventBuffer(
        max_bytes=len(jpeg) + annotation_size,
        per_camera_bytes=len(jpeg) + annotation_size,
        clock=clock,
    )
    buffer.configure({"cam": 2})
    assert buffer.push("cam", jpeg, 100, "session", annotations=annotations)
    annotations[0]["bbox"][0] = 99
    frame = buffer.snapshot("cam", 2)[0]
    assert frame.annotations[0]["bbox"] == [0.1, 0.2, 0.3, 0.4]
    frame.annotations[0]["bbox"][0] = 88
    assert buffer.snapshot("cam", 2)[0].annotations[0]["bbox"] == [0.1, 0.2, 0.3, 0.4]
    assert buffer.status()["total_bytes"] == len(jpeg) + annotation_size


def test_thread_safe_pushes_keep_byte_accounting_consistent():
    clock = FakeClock()
    buffer = PreEventBuffer(max_bytes=10_000, per_camera_bytes=10_000, clock=clock)
    buffer.configure({f"cam-{i}": 30 for i in range(20)})

    def add(index):
        camera = f"cam-{index % 20}"
        buffer.push(camera, b"x", 100, "session")

    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(add, range(2_000)))
    status = buffer.status()
    assert status["total_bytes"] == sum(cam["bytes"] for cam in status["cameras"].values())
    assert status["total_bytes"] <= status["max_bytes"]
    assert sum(cam["frames"] for cam in status["cameras"].values()) == 20


def test_full_camera_wall_eviction_and_clear_keep_index_bounded():
    clock = FakeClock()
    buffer = PreEventBuffer(max_bytes=64 * 2048, per_camera_bytes=2048, clock=clock)
    buffer.configure({f"camera-{i}": 30 for i in range(64)})
    for step in range(160):
        clock.value = 100 + step * 0.21
        for camera in range(64):
            buffer.push(f"camera-{camera}", bytes([camera]) * 1024, clock(), "session")
    status = buffer.status()
    assert status["total_bytes"] <= 64 * 2048
    assert sum(item["frames"] for item in status["cameras"].values()) == 128
    # Secondary eviction bookkeeping must not retain evicted JPEGs.
    assert len(buffer._order) == 128
    for camera in range(64):
        frames = buffer.snapshot(f"camera-{camera}", 30)
        assert len(frames) == 2
        assert all(frame.jpeg == bytes([camera]) * 1024 for frame in frames)
    buffer.configure({})
    assert not buffer._order
    assert buffer.status()["total_bytes"] == 0
