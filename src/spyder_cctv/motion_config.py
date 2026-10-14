"""Validated settings for local motion analysis."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class AnalysisConfig:
    enabled: bool = False
    contours: bool = True
    components: bool = True
    tracking: bool = False
    threshold: float = 16.0
    history: int = 300
    learning_rate: float = -1.0
    detect_shadows: bool = True
    min_area_percent: float = 0.5
    inference_fps: float = 5.0
    input_width: int = 480
    warmup_frames: int = 15
    max_tracks: int = 2
    overlay: bool = True
    roi: tuple[float, float, float, float] | list[float] | None = None

    def __post_init__(self) -> None:
        boolean_fields = (
            "enabled",
            "contours",
            "components",
            "tracking",
            "detect_shadows",
            "overlay",
        )
        for name in boolean_fields:
            if type(getattr(self, name)) is not bool:
                raise ValueError(f"{name} must be a boolean")
        numeric_ranges = {
            "threshold": (0.0, 255.0, False),
            "learning_rate": (-1.0, 1.0, False),
            "min_area_percent": (0.0, 100.0, True),
            "inference_fps": (0.1, 60.0, False),
        }
        for name, (minimum, maximum, exclusive_minimum) in numeric_ranges.items():
            value = getattr(self, name)
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
            ):
                raise ValueError(f"{name} must be a finite number")
            if value > maximum or (value <= minimum if exclusive_minimum else value < minimum):
                raise ValueError(f"{name} is outside its valid range")
        integer_ranges = {
            "history": (1, 10000),
            "input_width": (1, 8192),
            "warmup_frames": (0, 10000),
            "max_tracks": (1, 4),
        }
        for name, (minimum, maximum) in integer_ranges.items():
            value = getattr(self, name)
            if type(value) is not int or not minimum <= value <= maximum:
                raise ValueError(f"{name} must be an integer from {minimum} to {maximum}")
        if not self.contours and not self.components and self.tracking:
            raise ValueError("tracking requires contours or components")
        if self.roi is not None:
            if not isinstance(self.roi, (list, tuple)) or len(self.roi) != 4:
                raise ValueError("roi must be [x, y, width, height]")
            values = tuple(self.roi)
            if any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                for value in values
            ):
                raise ValueError("roi values must be finite numbers")
            x, y, width, height = values
            if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1 or y + height > 1:
                raise ValueError("roi must be a positive normalized rectangle within the frame")
            object.__setattr__(self, "roi", tuple(float(value) for value in values))

    def to_dict(self) -> dict:
        values = asdict(self)
        if self.roi is not None:
            values["roi"] = list(self.roi)
        return values

    @classmethod
    def from_dict(cls, data: dict) -> AnalysisConfig:
        if not isinstance(data, dict):
            raise ValueError("Motion configuration must be an object")
        allowed = cls.__dataclass_fields__.keys()
        if set(data) - set(allowed):
            raise ValueError("Motion configuration contains unknown fields")
        try:
            return cls(**data)
        except TypeError as error:
            raise ValueError("Motion configuration contains invalid fields") from error
