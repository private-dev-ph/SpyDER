"""Regression for repeated demo footage becoming learned background."""

import json
import time
from importlib.resources import files
from types import SimpleNamespace

import cv2
import pytest

from spyder_cctv import analysis_runtime, demo_sources
from spyder_cctv.analysis_runtime import AnalysisRuntime
from spyder_cctv.motion_config import AnalysisConfig

CLIPS = json.loads(
    files("spyder_cctv").joinpath("assets/demo-cameras.json").read_text(encoding="utf-8")
)["cameras"]


@pytest.fixture(autouse=True)
def bounded_opencv_threads():
    previous = cv2.getNumThreads()
    cv2.setNumThreads(1)
    try:
        yield
    finally:
        cv2.setNumThreads(previous)


@pytest.mark.parametrize("clip", CLIPS, ids=lambda clip: clip["id"])
def test_motion_regions_repeat_across_demo_loops(clip, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(demo_sources, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(analysis_runtime, "time", SimpleNamespace(monotonic=time.perf_counter))
    capture = demo_sources.DemoClipCapture("demo://" + clip["id"])
    assert capture.read()[0]  # Anchor the media clock before sampling inside frame intervals.
    config = AnalysisConfig(
        enabled=True,
        overlay=False,
        input_width=320,
        roi=(0.242, 0.158, 0.301, 0.385) if clip["id"] == "porch-parcel" else None,
    )
    # Exercise the real asynchronous analyzer while advancing only the media clock.
    runtime = AnalysisRuntime(config)
    counts = []
    try:
        for lap in range(5):
            hits = 0
            for index in range(40):
                clock[0] = 100 + lap * 8 + index * 0.2 + 0.001
                ok, frame = capture.read()
                assert ok
                # Reset notification is supplied by the camera's capture adapter.
                epoch = getattr(capture, "playback_epoch", None)
                with runtime._condition:
                    runtime._next = 0
                options = {"source_epoch": epoch} if epoch is not None else {}
                submitted = time.perf_counter()
                runtime.process(frame, **options)
                deadline = submitted + 3
                while time.perf_counter() < deadline:
                    with runtime._condition:
                        result = dict(runtime._result)
                        if runtime._updated is not None and runtime._updated >= submitted:
                            break
                    time.sleep(0.001)
                else:
                    pytest.fail("Motion analysis did not finish the submitted frame")
                hits += bool(result.get("region_count"))
            counts.append(hits)
        assert counts[1:] == [counts[0]] * 4, f"Motion-region frames per loop: {counts}"
        if clip["id"] == "porch-parcel":
            assert counts[0] > 0, "The person's movement must produce motion regions inside the ROI"
    finally:
        runtime.close(5)
        capture.close()
