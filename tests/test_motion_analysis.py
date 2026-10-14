import numpy as np
import pytest

from spyder_cctv.motion import MotionAnalyzer
from spyder_cctv.motion_config import AnalysisConfig


def image(rect=None, size=(120, 160)):
    frame = np.zeros((*size, 3), dtype=np.uint8)
    if rect:
        x, y, width, height = rect
        frame[y : y + height, x : x + width] = 255
    return frame


def test_warmup_moving_regions_and_mask_are_binary():
    analyzer = MotionAnalyzer(
        AnalysisConfig(warmup_frames=2, input_width=320, min_area_percent=0.2, overlay=False)
    )
    try:
        _, first = analyzer.process(image())
        assert first["state"] == "warming_up"
        assert first["regions"] == []
        _, _ = analyzer.process(image())
        _, moving = analyzer.process(image((30, 35, 35, 25)))
        assert moving["state"] == "ready"
        assert moving["region_count"] >= 1
        assert moving["motion_fraction"] > 0
        assert analyzer.mask.dtype == np.uint8
        assert set(np.unique(analyzer.mask)) <= {0, 255}
        box = moving["regions"][0]["bbox"]
        assert box[0] <= 30 and box[1] <= 35
    finally:
        analyzer.close()
    assert analyzer.mask is None


def test_threshold_region_switch_roi_and_shape_reset():
    analyzer = MotionAnalyzer(
        AnalysisConfig(
            warmup_frames=0,
            input_width=320,
            min_area_percent=0.1,
            components=False,
            contours=True,
            roi=(0.5, 0.0, 0.5, 1.0),
        )
    )
    try:
        analyzer.process(image())
        _, result = analyzer.process(image((15, 30, 30, 30)))
        assert result["region_count"] == 0
        _, result = analyzer.process(image((100, 30, 30, 30)))
        assert result["region_count"] >= 1
        analyzer.process(image(size=(90, 100)))
        assert analyzer._frame_count == 1
        assert analyzer._source_size == (100, 90)
    finally:
        analyzer.close()


def test_shadow_values_are_excluded(monkeypatch):
    analyzer = MotionAnalyzer(AnalysisConfig(warmup_frames=0, detect_shadows=True))

    class ShadowSubtractor:
        def apply(self, frame, learningRate=-1.0):
            return np.full(frame.shape, 127, dtype=np.uint8)

    try:
        analyzer.process(image())
        analyzer._subtractor = ShadowSubtractor()
        analyzer.process(image())
        assert np.count_nonzero(analyzer.mask) == 0
    finally:
        analyzer.close()


def test_both_region_methods_disabled_and_validation():
    analyzer = MotionAnalyzer(AnalysisConfig(warmup_frames=0, components=False, contours=False))
    try:
        analyzer.process(image())
        _, result = analyzer.process(image((30, 30, 50, 40)))
        assert result["regions"] == []
    finally:
        analyzer.close()
    with pytest.raises(ValueError, match="requires contours or components"):
        AnalysisConfig(tracking=True, contours=False, components=False)
    for kwargs in (
        {"threshold": True},
        {"threshold": 3.99},
        {"threshold": 128.01},
        {"history": 19},
        {"history": 2001},
        {"learning_rate": -0.5},
        {"min_area_percent": 0.009},
        {"min_area_percent": 25.01},
        {"inference_fps": 0.99},
        {"inference_fps": 15.01},
        {"input_width": 400},
        {"warmup_frames": 121},
        {"history": 2.5},
        {"input_width": False},
        {"min_area_percent": float("nan")},
        {"roi": (0.7, 0.0, 0.4, 0.2)},
        {"roi": (0, 0, 0, 1)},
        {"unknown": 1},
    ):
        with pytest.raises(ValueError):
            AnalysisConfig.from_dict(kwargs)
    config = AnalysisConfig(roi=[0.1, 0.2, 0.3, 0.4])
    assert config.to_dict()["roi"] == [0.1, 0.2, 0.3, 0.4]


def test_regions_cap_at_32_and_contours_can_be_disabled():
    analyzer = MotionAnalyzer(
        AnalysisConfig(components=True, contours=False, min_area_percent=0.01, input_width=320)
    )
    mask = np.zeros((320, 320), dtype=np.uint8)
    for index in range(40):
        x = 5 + (index % 8) * 38
        y = 5 + (index // 8) * 38
        mask[y : y + 8, x : x + 8] = 255
    try:
        regions = analyzer._regions(mask, 320, 320)
        assert len(regions) == 32
        assert all(region["contour"] == [] for region in regions)
    finally:
        analyzer.close()


class FakeTracker:
    def init(self, frame, box):
        self.box = tuple(box)
        return True

    def update(self, frame):
        x, y, w, h = self.box
        self.box = (x + 2, y, w, h)
        return True, self.box


def test_mil_tracker_persists_and_caps_tracks(monkeypatch):
    monkeypatch.setattr(MotionAnalyzer, "_find_tracker_factory", staticmethod(lambda: FakeTracker))
    analyzer = MotionAnalyzer(
        AnalysisConfig(
            warmup_frames=0,
            tracking=True,
            max_tracks=1,
            input_width=320,
            min_area_percent=0.1,
            overlay=False,
        )
    )
    try:
        analyzer.process(image())
        _, first = analyzer.process(image((25, 30, 25, 25)))
        assert first["tracker"] == "MIL"
        assert first["track_count"] == 1
        track_id = first["tracks"][0]["id"]
        _, second = analyzer.process(image((27, 30, 25, 25)))
        assert second["tracks"][0]["id"] == track_id
        assert second["tracks"][0]["bbox"][0] >= first["tracks"][0]["bbox"][0]
        assert second["algorithm"] == "mog2"
        assert second["inference_fps"] == 5.0
    finally:
        analyzer.close()


def test_failed_mil_tracker_drops_track(monkeypatch):
    class FailedTracker(FakeTracker):
        def update(self, frame):
            return False, self.box

    monkeypatch.setattr(
        MotionAnalyzer, "_find_tracker_factory", staticmethod(lambda: FailedTracker)
    )
    analyzer = MotionAnalyzer(
        AnalysisConfig(warmup_frames=0, tracking=True, input_width=320, min_area_percent=0.1)
    )
    try:
        analyzer.process(image())
        analyzer.process(image((25, 30, 25, 25)))

        class EmptySubtractor:
            def apply(self, frame, learningRate=-1.0):
                return np.zeros(frame.shape, dtype=np.uint8)

        analyzer._subtractor = EmptySubtractor()
        _, result = analyzer.process(image((25, 30, 25, 25)))
        assert result["tracks"] == []
    finally:
        analyzer.close()


def test_real_mil_tracker_smoke_when_available():
    analyzer = MotionAnalyzer(AnalysisConfig(tracking=True, warmup_frames=0, min_area_percent=0.1))
    try:
        analyzer.process(image())
        _, result = analyzer.process(image((35, 35, 30, 30)))
        if analyzer.tracking_error:
            assert result["tracker"] == "unavailable"
            assert "MIL tracker is unavailable" in result["tracking_error"]
        else:
            assert result["tracker"] == "MIL"
            assert result["track_count"] <= 2
    finally:
        analyzer.close()
