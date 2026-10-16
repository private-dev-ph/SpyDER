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
    recognition_model: str | None = None
    identity_gallery: str | None = None
    recognition_threshold: float = 0.65
    classifier_model: str | None = None
    classifier_labels: tuple[str, ...] = ()
    classifier_threshold: float = 0.5
    classifier_output: str = "probabilities"
    classifier_preprocessing: str = "arcface"
    classifier_confirmation_frames: int = 3
    classifier_switch_frames: int = 5
    classifier_min_margin: float = 0.15

    def __post_init__(self) -> None:
        if isinstance(self.classifier_labels, list):
            object.__setattr__(self, "classifier_labels", tuple(self.classifier_labels))
        if self.engine not in ("opencv", "yolo", "insightface"):
            raise ValueError("Unknown vision engine")
        if (
            type(self.recognition_threshold) not in (int, float)
            or not math.isfinite(self.recognition_threshold)
            or not -1 <= self.recognition_threshold <= 1
        ):
            raise ValueError("Invalid recognition_threshold")
        if self.engine != "insightface" and (
            self.recognition_model is not None or self.identity_gallery is not None
        ):
            raise ValueError("Recognition model and gallery require InsightFace")
        if self.classifier_model is not None and self.engine != "insightface":
            raise ValueError("Face classifier requires InsightFace")
        if self.classifier_model is not None and (
            self.recognition_model is not None or self.identity_gallery is not None
        ):
            raise ValueError("Face classifier cannot be combined with gallery recognition")
        if self.classifier_model is None and self.classifier_labels:
            raise ValueError("classifier_labels require classifier_model")
        if self.classifier_model is not None:
            if (
                not isinstance(self.classifier_model, str)
                or not self.classifier_model.strip()
                or "://" in self.classifier_model
                or Path(self.classifier_model).suffix.lower() != ".onnx"
            ):
                raise ValueError("classifier_model must be a local .onnx file")
            if (
                not isinstance(self.classifier_labels, tuple)
                or not 1 <= len(self.classifier_labels) <= 1000
                or any(
                    not isinstance(label, str) or not label.strip() or len(label) > 128
                    for label in self.classifier_labels
                )
                or len(set(self.classifier_labels)) != len(self.classifier_labels)
            ):
                raise ValueError("classifier_labels must contain 1 to 1000 unique labels")
        if (
            type(self.classifier_threshold) not in (int, float)
            or not math.isfinite(self.classifier_threshold)
            or not 0 <= self.classifier_threshold <= 1
        ):
            raise ValueError("Invalid classifier_threshold")
        for name, value, maximum in (
            ("classifier_confirmation_frames", self.classifier_confirmation_frames, 15),
            ("classifier_switch_frames", self.classifier_switch_frames, 30),
        ):
            if type(value) is not int or not 1 <= value <= maximum:
                raise ValueError(f"Invalid {name}")
        if self.classifier_switch_frames < self.classifier_confirmation_frames:
            raise ValueError(
                "Switch confirmation count must be at least initial confirmation count"
            )
        if (
            type(self.classifier_min_margin) not in (int, float)
            or not math.isfinite(self.classifier_min_margin)
            or not 0 <= self.classifier_min_margin <= 1
        ):
            raise ValueError("Invalid classifier_min_margin")
        if self.classifier_output not in ("probabilities", "logits"):
            raise ValueError("classifier_output must be probabilities or logits")
        if self.classifier_preprocessing not in ("arcface", "embedded"):
            raise ValueError("classifier_preprocessing must be arcface or embedded")
        if (self.recognition_model is None) != (self.identity_gallery is None):
            raise ValueError("Provide both recognition_model and identity_gallery")
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
        elif Path(self.model).suffix.lower() not in (
            (".pt", ".onnx") if self.engine == "yolo" else (".onnx",)
        ):
            raise ValueError(
                "YOLO expects .pt or .onnx weights; InsightFace expects detection .onnx"
            )
        if self.recognition_model is not None:
            for name, value, suffix in (
                ("recognition_model", self.recognition_model, ".onnx"),
                ("identity_gallery", self.identity_gallery, ".json"),
            ):
                if (
                    not isinstance(value, str)
                    or not value.strip()
                    or "://" in value
                    or Path(value).suffix.lower() != suffix
                ):
                    raise ValueError(f"{name} must be a local {suffix} file")

    def resolve(self, base: Path | None = None) -> "VisionConfig":
        values: dict[str, str] = {}
        for key in ("model", "recognition_model", "identity_gallery", "classifier_model"):
            value = getattr(self, key)
            if value is not None:
                path = Path(value).expanduser()
                path = path if path.is_absolute() else (base or default_model_dir()) / path
                values[key] = str(path.resolve())
        return replace(self, **values) if values else self


@dataclass(frozen=True)
class Detection:
    """Pixel xyxy box in the analyzed source frame; confidence is a probability."""

    label: str
    bbox: tuple[float, float, float, float]
    confidence: float | None = None
    class_id: int | None = None
    score: float | None = None  # Uncalibrated classifier score, e.g. HOG margin.
    identity: str | None = None
    similarity: float | None = None
    identity_confidence: float | None = None

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
        if self.identity is not None and (
            not isinstance(self.identity, str) or not self.identity or len(self.identity) > 128
        ):
            raise ValueError("Invalid detection identity")
        if self.similarity is not None and (
            isinstance(self.similarity, bool)
            or not isinstance(self.similarity, Real)
            or not math.isfinite(self.similarity)
            or not -1 <= self.similarity <= 1
        ):
            raise ValueError("Invalid cosine similarity")
        if self.identity_confidence is not None and (
            isinstance(self.identity_confidence, bool)
            or not isinstance(self.identity_confidence, Real)
            or not math.isfinite(self.identity_confidence)
            or not 0 <= self.identity_confidence <= 1
        ):
            raise ValueError("Invalid identity confidence")
        if self.confidence is not None:
            object.__setattr__(self, "confidence", float(self.confidence))
        if self.score is not None:
            object.__setattr__(self, "score", float(self.score))
        if self.similarity is not None:
            object.__setattr__(self, "similarity", float(self.similarity))
        if self.identity_confidence is not None:
            object.__setattr__(self, "identity_confidence", float(self.identity_confidence))
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
