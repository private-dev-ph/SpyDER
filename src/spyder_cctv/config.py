"""Validated configuration and installed-application paths."""

import json
import math
import os
import re
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from platformdirs import user_config_path


def default_config_path() -> Path:
    return user_config_path("SpyDER", appauthor=False) / "config.json"


@dataclass(frozen=True)
class CameraConfig:
    id: str
    source: int | str
    fps: float = 10.0
    pipeline: str = "motion"
    autostart: bool = False
    name: str = ""

    def __post_init__(self) -> None:
        if not isinstance(self.id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", self.id):
            raise ValueError("Camera id must contain 1-64 letters, digits, underscores or hyphens")
        if isinstance(self.source, bool) or not isinstance(self.source, (int, str)):
            raise ValueError("Camera source must be a device integer, URL or file path")
        if isinstance(self.source, int) and self.source < 0:
            raise ValueError("Device index cannot be negative")
        if isinstance(self.source, str) and not self.source.strip():
            raise ValueError("Camera source cannot be empty")
        if isinstance(self.fps, bool) or not isinstance(self.fps, (int, float)):
            raise ValueError("fps must be a number")
        if not math.isfinite(self.fps) or not 0 < self.fps <= 60:
            raise ValueError("fps must be greater than 0 and at most 60")
        if self.pipeline not in ("none", "motion"):
            raise ValueError("pipeline must be 'none' or 'motion'")
        if not isinstance(self.autostart, bool):
            raise ValueError("autostart must be a boolean")
        if not isinstance(self.name, str) or len(self.name) > 80:
            raise ValueError("Camera name must be text with at most 80 characters")


def load_config(path: Path) -> list[CameraConfig]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or set(data) != {"cameras"}:
        raise ValueError("Configuration must contain only a cameras array")
    if not isinstance(data["cameras"], list):
        raise ValueError("cameras must be an array")
    cameras = []
    for item in data["cameras"]:
        if not isinstance(item, dict):
            raise ValueError("Each camera must be an object")
        try:
            camera = CameraConfig(**item)
        except TypeError as error:
            raise ValueError("Camera contains missing or unknown fields") from error
        # Resolve file sources relative to the config, never the process working directory.
        if isinstance(camera.source, str) and "://" not in camera.source:
            camera = CameraConfig(
                camera.id,
                str((path.parent / camera.source).resolve()),
                camera.fps,
                camera.pipeline,
                camera.autostart,
                camera.name,
            )
        cameras.append(camera)
    if len({camera.id for camera in cameras}) != len(cameras):
        raise ValueError("Camera ids must be unique")
    return cameras


def save_config(path: Path, cameras: list[CameraConfig]) -> None:
    """Replace configuration atomically, without truncating a working file on failure."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".spyder-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            json.dump({"cameras": [asdict(camera) for camera in cameras]}, target, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
