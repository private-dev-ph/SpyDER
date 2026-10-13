"""Engine-independent configuration, results, and lifecycle contracts."""

import math
import re
from dataclasses import asdict, dataclass, replace
from numbers import Real
from pathlib import Path
from typing import Any, Protocol

from platformdirs import user_data_path


def default_model_dir() -> Path:
    return user_data_path("SpyDER", appauthor=False) / "models"


@dataclass(frozen=True)
class VisionConfig:
    engine: str = "opencv"
    model: str | None = None
    device: str = "cpu"
    inference_fps: float = 3.0
    confidence: float = 0.5
    input_size: int = 640
    max_detections: int = 100

    def __post_init__(self) -> None:
        if self.engine not in ("opencv", "yolo", "insightface"):
            raise ValueError("Unknown vision engine")
        if not isinstance(self.device, str) or not re.fullmatch(
            r"cpu|mps|cuda:[0-9]+", self.device
        ):
            raise ValueError("device must be cpu, mps or cuda:<index>")
        if self.engine != "yolo" and self.device != "cpu":
            raise ValueError("This engine currently supports CPU execution only")
        for key, value, minimum, maximum in (
            ("inference_fps", self.inference_fps, 0.1, 30),
            ("confidence", self.confidence, 0, 1),
        ):
            if (
                type(value) not in (int, float)
                or not math.isfinite(value)
                or not minimum <= value <= maximum
            ):
                raise ValueError(f"Invalid {key}")
        if (
            type(self.input_size) is not int
            or not 128 <= self.input_size <= 1280
            or self.input_size % 32
        ):
            raise ValueError("input_size must be a multiple of 32 between 128 and 1280")
        if type(self.max_detections) is not int or not 1 <= self.max_detections <= 500:
            raise ValueError("max_detections must be between 1 and 500")
        if self.engine == "opencv":
            if self.model is not None:
                raise ValueError("OpenCV HOG uses its bundled detector, not a model path")
        elif not isinstance(self.model, str) or not self.model.strip() or "://" in self.model:
            raise ValueError(
                "Provide a local model file; URLs and automatic downloads are disabled"
            )
        elif Path(self.model).suffix.lower() != (".pt" if self.engine == "yolo" else ".onnx"):
            raise ValueError("YOLO expects .pt weights; InsightFace expects detection .onnx")

    def resolve(self, base: Path | None = None) -> "VisionConfig":
        if self.model is None:
            return self
        path = Path(self.model).expanduser()
        path = path if path.is_absolute() else (base or default_model_dir()) / path
        return replace(self, model=str(path.resolve()))


@dataclass(frozen=True)
class Detection:
    """Pixel xyxy box in the analyzed source frame; confidence is a probability."""

    label: str
    bbox: tuple[float, float, float, float]
    confidence: float | None = None
    class_id: int | None = None
    score: float | None = None  # Uncalibrated classifier score, e.g. HOG margin.

    def __post_init__(self) -> None:
        if not isinstance(self.label, str) or not self.label or len(self.label) > 128:
            raise ValueError("Invalid detection label")
        if len(self.bbox) != 4 or any(
            isinstance(v, bool) or not isinstance(v, Real) or not math.isfinite(float(v))
            for v in self.bbox
        ):
            raise ValueError("Invalid bounding box")
        object.__setattr__(self, "bbox", tuple(float(v) for v in self.bbox))
        if self.bbox[2] < self.bbox[0] or self.bbox[3] < self.bbox[1]:
            raise ValueError("Invalid bounding box ordering")
        if self.confidence is not None and (
            isinstance(self.confidence, bool)
            or not isinstance(self.confidence, Real)
            or not math.isfinite(self.confidence)
            or not 0 <= self.confidence <= 1
        ):
            raise ValueError("Invalid confidence")
        if self.score is not None and (
            isinstance(self.score, bool)
            or not isinstance(self.score, Real)
            or not math.isfinite(self.score)
        ):
            raise ValueError("Invalid classifier score")
        if self.confidence is not None:
            object.__setattr__(self, "confidence", float(self.confidence))
        if self.score is not None:
            object.__setattr__(self, "score", float(self.score))
        if self.class_id is not None and type(self.class_id) is not int:
            raise ValueError("class_id must be an integer")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class Engine(Protocol):
    """One engine owned by one inference thread. Frames are uint8 HWC BGR arrays."""

    def infer(self, frame: Any) -> list[Detection]: ...

    def close(self) -> None: ...


class VisionUnavailable(RuntimeError):
    """Public-safe failure without model paths or library exception text."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
