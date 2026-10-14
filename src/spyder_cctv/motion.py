"""CPU background subtraction, region extraction, and optional MIL tracking."""

from __future__ import annotations

import math

import cv2
import numpy as np

from spyder_cctv.motion_config import AnalysisConfig


def _iou(
    first: tuple[float, float, float, float], second: tuple[float, float, float, float]
) -> float:
    ax, ay, aw, ah = first
    bx, by, bw, bh = second
    intersection = max(0.0, min(ax + aw, bx + bw) - max(ax, bx)) * max(
        0.0, min(ay + ah, by + bh) - max(ay, by)
    )
    union = aw * ah + bw * bh - intersection
    return intersection / union if union else 0.0


class MotionAnalyzer:
    """Analyze frames without owning camera or worker resources."""

    def __init__(self, config: AnalysisConfig | dict | None = None):
        if config is None:
            config = AnalysisConfig()
        elif isinstance(config, dict):
            config = AnalysisConfig.from_dict(config)
        if not isinstance(config, AnalysisConfig):
            raise ValueError("config must be an AnalysisConfig or object")
        self.config = config
        self._subtractor = cv2.createBackgroundSubtractorMOG2(
            history=config.history,
            varThreshold=config.threshold,
            detectShadows=config.detect_shadows,
        )
        self._kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        self.mask: np.ndarray | None = None
        self._source_size: tuple[int, int] | None = None
        self._frame_count = 0
        self._tracks: list[dict] = []
        self._next_id = 1
        self._tracker_factory = self._find_tracker_factory() if config.tracking else None
        self.tracking_error = (
            "OpenCV MIL tracker unavailable; install OpenCV with tracking support"
            if config.tracking and self._tracker_factory is None
            else None
        )
        self._closed = False

    @staticmethod
    def _find_tracker_factory():
        factory = getattr(cv2, "TrackerMIL_create", None)
        if factory is not None:
            return factory
        return getattr(getattr(cv2, "legacy", None), "TrackerMIL_create", None)

    def process(self, frame: np.ndarray) -> tuple[np.ndarray, dict]:
        if self._closed:
            raise RuntimeError("MotionAnalyzer is closed")
        if not isinstance(frame, np.ndarray) or frame.ndim not in (2, 3) or frame.size == 0:
            raise ValueError("frame must be a non-empty image array")
        height, width = frame.shape[:2]
        if self._source_size != (width, height):
            self._reset((width, height))
        scale = min(1.0, self.config.input_width / width)
        analysis_width = max(1, int(round(width * scale)))
        analysis_height = max(1, int(round(height * scale)))
        small = (
            cv2.resize(frame, (analysis_width, analysis_height), interpolation=cv2.INTER_AREA)
            if (analysis_width, analysis_height) != (width, height)
            else frame
        )
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY) if small.ndim == 3 else small
        raw = self._subtractor.apply(gray, learningRate=self.config.learning_rate)
        _, binary = cv2.threshold(
            raw, 200 if self.config.detect_shadows else 1, 255, cv2.THRESH_BINARY
        )
        binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, self._kernel)
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, self._kernel)
        if self.config.roi is not None:
            x, y, rw, rh = self.config.roi
            roi_mask = np.zeros_like(binary)
            left, top = int(x * analysis_width), int(y * analysis_height)
            right, bottom = (
                int(math.ceil((x + rw) * analysis_width)),
                int(math.ceil((y + rh) * analysis_height)),
            )
            roi_mask[top:bottom, left:right] = 255
            binary = cv2.bitwise_and(binary, roi_mask)
        self.mask = binary
        self._frame_count += 1
        warmup_remaining = max(0, self.config.warmup_frames - self._frame_count)
        ready = warmup_remaining == 0
        regions = self._regions(binary, width, height) if ready else []
        motion_fraction = float(cv2.countNonZero(binary)) / binary.size if ready else 0.0
        scale_x, scale_y = analysis_width / width, analysis_height / height
        analysis_regions = [
            {
                **region,
                "bbox": [
                    int(round(region["bbox"][0] * scale_x)),
                    int(round(region["bbox"][1] * scale_y)),
                    int(round(region["bbox"][2] * scale_x)),
                    int(round(region["bbox"][3] * scale_y)),
                ],
            }
            for region in regions
        ]
        tracks = self._update_tracks(small, analysis_regions) if ready else []
        for track in tracks:
            x, y, w, h = track["bbox"]
            track["bbox"] = [
                int(round(x / scale_x)),
                int(round(y / scale_y)),
                int(round(w / scale_x)),
                int(round(h / scale_y)),
            ]
        output = frame.copy()
        if self.config.overlay:
            self._draw(output, regions, tracks, width, height)
        metadata = {
            "state": "ready" if ready else "warming_up",
            "frame_size": [width, height],
            "motion_fraction": motion_fraction,
            "regions": regions,
            "tracks": tracks,
            "tracker": "MIL"
            if self.config.tracking and self._tracker_factory
            else ("unavailable" if self.config.tracking else None),
            "tracking_error": self.tracking_error,
            "track_count": len(tracks),
            "region_count": len(regions),
            "warmup_remaining": warmup_remaining,
        }
        return output, metadata

    def _regions(self, binary: np.ndarray, source_width: int, source_height: int) -> list[dict]:
        analysis_height, analysis_width = binary.shape
        scale_x, scale_y = source_width / analysis_width, source_height / analysis_height
        min_area = analysis_width * analysis_height * self.config.min_area_percent / 100.0
        if self.config.components:
            count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
            candidates = []
            for index in range(1, count):
                x, y, width, height, area = (int(value) for value in stats[index])
                if area < min_area:
                    continue
                component = np.uint8(labels[y : y + height, x : x + width] == index) * 255
                contours, _ = cv2.findContours(
                    component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
                )
                contour = (
                    max(contours, key=cv2.contourArea)
                    if contours
                    else np.empty((0, 1, 2), np.int32)
                )
                points = [
                    [int(round((px + x) * scale_x)), int(round((py + y) * scale_y))]
                    for px, py in contour.reshape(-1, 2)[:32]
                ]
                candidates.append((x, y, width, height, area, points))
        elif self.config.contours:
            contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            candidates = []
            for contour in contours:
                area = int(cv2.contourArea(contour))
                if area < min_area:
                    continue
                x, y, width, height = cv2.boundingRect(contour)
                points = [
                    [int(round(px * scale_x)), int(round(py * scale_y))]
                    for px, py in contour.reshape(-1, 2)[:32]
                ]
                candidates.append((x, y, width, height, area, points))
        else:
            candidates = []
        output = []
        for x, y, width, height, area, points in sorted(
            candidates, key=lambda item: item[4], reverse=True
        ):
            output.append(
                {
                    "bbox": [
                        int(round(x * scale_x)),
                        int(round(y * scale_y)),
                        int(round(width * scale_x)),
                        int(round(height * scale_y)),
                    ],
                    "area_percent": area * 100.0 / (analysis_width * analysis_height),
                    "contour": points,
                }
            )
        return output

    def _update_tracks(self, frame: np.ndarray, regions: list[dict]) -> list[dict]:
        if not self.config.tracking or self._tracker_factory is None:
            self._tracks.clear()
            return []
        matched: set[int] = set()
        for track in list(self._tracks):
            ok, box = track["tracker"].update(frame)
            if ok:
                track["bbox"] = [int(round(value)) for value in box]
            choices = [index for index in range(len(regions)) if index not in matched]
            best = max(
                choices,
                key=lambda index: _iou(tuple(track["bbox"]), tuple(regions[index]["bbox"])),
                default=-1,
            )
            overlap = _iou(tuple(track["bbox"]), tuple(regions[best]["bbox"])) if best >= 0 else 0.0
            if best >= 0 and overlap >= 0.05:
                matched.add(best)
                track["missed"] = 0
                # MIL owns persistent box updates; overlap refreshes activity.
            else:
                track["missed"] += 1
        self._tracks = [track for track in self._tracks if track["missed"] <= 12]
        for index, region in enumerate(regions):
            if index in matched or len(self._tracks) >= self.config.max_tracks:
                continue
            x, y, width, height = region["bbox"]
            tracker = self._tracker_factory()
            try:
                initialized = tracker.init(frame, (x, y, width, height))
                if initialized is False:
                    continue
            except (cv2.error, TypeError):
                continue
            self._tracks.append(
                {
                    "id": self._next_id,
                    "bbox": [x, y, width, height],
                    "tracker": tracker,
                    "missed": 0,
                }
            )
            self._next_id += 1
        return [
            {"id": track["id"], "bbox": list(track["bbox"]), "state": "tracking"}
            for track in self._tracks
        ]

    @staticmethod
    def _draw(
        frame: np.ndarray, regions: list[dict], tracks: list[dict], width: int, height: int
    ) -> None:
        for region in regions:
            x, y, w, h = region["bbox"]
            cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 220, 0), 1)
        for track in tracks:
            x, y, w, h = track["bbox"]
            cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 180, 255), 2)
            cv2.putText(
                frame,
                f"Motion {track['id']}",
                (x, max(14, y - 4)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.45,
                (0, 180, 255),
                1,
            )

    def _reset(self, size: tuple[int, int]) -> None:
        self._source_size = size
        self._frame_count = 0
        self._tracks.clear()
        self.mask = None
        self._subtractor = cv2.createBackgroundSubtractorMOG2(
            history=self.config.history,
            varThreshold=self.config.threshold,
            detectShadows=self.config.detect_shadows,
        )

    def close(self) -> None:
        """Release analyzer-owned references; no camera or worker is owned."""
        self._tracks.clear()
        self.mask = None
        self._closed = True
