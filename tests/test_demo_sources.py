import json

import cv2
import numpy as np
import pytest

from spyder_cctv.cameras import CameraWorker
from spyder_cctv.config import CameraConfig
from spyder_cctv.demo_sources import DemoClipCapture, resolve_demo_source


@pytest.fixture
def demo_clip(tmp_path):
    path = tmp_path / "demo-test.mp4"
    writer = cv2.VideoWriter(
        str(path), cv2.VideoWriter_fourcc(*"mp4v"), 5, (32, 24)
    )
    if not writer.isOpened():
        pytest.skip("OpenCV MP4 writer unavailable")
    frames = []
    for index in range(3):
        frame = np.zeros((24, 32, 3), np.uint8)
        frame[:, :, 0] = 40 + index * 30
        frame[:, :, 1] = np.arange(32, dtype=np.uint8)[None, :] * 7
        frame[:, :, 2] = np.arange(24, dtype=np.uint8)[:, None] * 8
        frames.append(frame)
        writer.write(frame)
    writer.release()
    catalog = tmp_path / "demo-cameras.json"
    catalog.write_text(
        json.dumps({"version": 1, "cameras": [{"id": "test", "filename": path.name}]}),
        encoding="utf-8",
    )
    return catalog, frames


def test_demo_uri_requires_exact_catalog_allowlist(demo_clip):
    catalog, _ = demo_clip
    entry, media = resolve_demo_source("demo://test", catalog_path=catalog)
    assert entry["id"] == "test"
    assert media == catalog.parent / "demo-test.mp4"
    for source in ("demo://missing", "demo://../test", "demo://test/extra"):
        with pytest.raises(ValueError):
            resolve_demo_source(source, catalog_path=catalog)


def test_demo_capture_loops_and_software_controls_transform_frames(demo_clip):
    catalog, _ = demo_clip
    capture = DemoClipCapture("demo://test", catalog_path=catalog)
    try:
        originals = [capture.read() for _ in range(4)]
        assert all(ok for ok, _ in originals)
        assert originals[0][1].shape == (24, 32, 3)
        changed = capture.apply_controls({"brightness": 100, "zoom": 100})
        assert changed["results"]["brightness"]["implementation"] == "software"
        assert changed["capabilities"]["zoom"]["mode"] == "software simulation"
        ok, adjusted = capture.read()
        assert ok
        assert adjusted.shape == (24, 32, 3)
        assert not np.array_equal(adjusted, originals[-1][1])
    finally:
        capture.close()


def test_demo_capture_follows_clip_clock_and_skips_late_frames(demo_clip, monkeypatch):
    catalog, _ = demo_clip
    now = [10.0]
    monkeypatch.setattr("spyder_cctv.demo_sources.time.monotonic", lambda: now[0])
    capture = DemoClipCapture("demo://test", catalog_path=catalog)
    try:
        seeks = []
        seek_to_start = capture._seek_to_start
        monkeypatch.setattr(
            capture,
            "_seek_to_start",
            lambda: (seeks.append(now[0]) is None) and seek_to_start(),
        )
        observed = []
        for elapsed in (0.0, 0.12, 0.21, 0.41, 0.61):
            now[0] = 10.0 + elapsed
            ok, frame = capture.read()
            assert ok
            observed.append(float(frame[:, :, 0].mean()))
        assert observed[0] == pytest.approx(observed[1], abs=3)
        assert observed[2] > observed[1] + 15
        assert observed[3] > observed[2] + 15
        assert observed[4] == pytest.approx(observed[0], abs=3)
        assert seeks == [pytest.approx(10.61)]
    finally:
        capture.close()


def test_inaccurate_frame_count_falls_back_without_retry_loop(demo_clip, monkeypatch):
    catalog, _ = demo_clip
    now = [20.0]
    monkeypatch.setattr("spyder_cctv.demo_sources.time.monotonic", lambda: now[0])
    capture = DemoClipCapture("demo://test", catalog_path=catalog)
    try:
        capture._frame_count = 5
        assert capture.read()[0]
        now[0] = 20.8
        ok, wrapped = capture.read()
        assert ok
        assert capture._source_fps is None
        now[0] += 0.01
        ok, following = capture.read()
        assert ok
        assert following[:, :, 0].mean() > wrapped[:, :, 0].mean() + 15
    finally:
        capture.close()


def test_demo_source_label_is_distinct_from_camera_and_network_sources():
    worker = CameraWorker(CameraConfig("demo", "demo://test", pipeline="none"))
    assert worker.status()["source_label"] == "Demo clip"
    assert not worker._can_reconnect()

