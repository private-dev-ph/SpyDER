"""Pipeline seam: one fresh pipeline instance per camera and capture session."""

from typing import Any, Protocol

import cv2

from spyder_cctv.cv.contracts import VisionConfig


class Pipeline(Protocol):
    def process(self, frame: Any) -> tuple[Any, dict[str, Any]]: ...


class Passthrough:
    def process(self, frame: Any) -> tuple[Any, dict[str, Any]]:
        return frame, {}


class Motion:
    """Basic motion fraction for a fixed camera; not an object detector."""

    def __init__(self) -> None:
        self.previous: Any = None

    def process(self, frame: Any) -> tuple[Any, dict[str, Any]]:
        gray = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        fraction = 0.0
        if self.previous is not None and self.previous.shape == gray.shape:
            mask = cv2.threshold(cv2.absdiff(self.previous, gray), 25, 255, cv2.THRESH_BINARY)[1]
            fraction = cv2.countNonZero(mask) / mask.size
        self.previous = gray
        return frame, {"motion_fraction": round(fraction, 4)}


def create_pipeline(name: str, vision: VisionConfig | None = None) -> Pipeline:
    if name == "vision":
        from spyder_cctv.cv.runtime import VisionPipeline

        return VisionPipeline(vision or VisionConfig())
    if name == "motion":
        return Motion()
    if name == "none":
        return Passthrough()
    raise ValueError("Unknown pipeline")
