"""Validated configuration and installed-application paths."""

import json
import math
import os
import re
import tempfile
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path

from platformdirs import user_config_path

from spyder_cctv.controls import validate_settings


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
    settings: dict[str, float] = field(default_factory=dict)
    profile_id: str | None = None

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
        object.__setattr__(self, "settings", validate_settings(self.settings))
        if self.profile_id is not None and (
            not isinstance(self.profile_id, str)
            or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", self.profile_id)
        ):
            raise ValueError("Invalid profile id")
        if self.profile_id is not None and self.settings:
            raise ValueError("Choose either a profile or custom camera settings")


@dataclass(frozen=True)
class SettingsProfile:
    id: str
    name: str
    settings: dict[str, float]

    def __post_init__(self) -> None:
        if not isinstance(self.id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", self.id):
            raise ValueError("Invalid profile id")
        if not isinstance(self.name, str) or not self.name.strip() or len(self.name) > 80:
            raise ValueError("Profile name must contain 1-80 characters")
        object.__setattr__(self, "name", self.name.strip())
        object.__setattr__(self, "settings", validate_settings(self.settings))
        if not self.settings:
            raise ValueError("A profile must contain at least one setting")


@dataclass(frozen=True)
class AppConfig:
    cameras: list[CameraConfig]
    profiles: list[SettingsProfile]


def load_app_config(path: Path) -> AppConfig:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "cameras" not in data:
        raise ValueError("Configuration must contain a cameras array")
    if set(data) != {"cameras"} and (
        set(data) != {"version", "cameras", "profiles"}
        or type(data["version"]) is not int
        or data["version"] != 1
    ):
        raise ValueError("Unknown configuration fields or version")
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
            camera = replace(
                camera,
                source=str((path.parent / camera.source).resolve()),
            )
        cameras.append(camera)
    if len({camera.id for camera in cameras}) != len(cameras):
        raise ValueError("Camera ids must be unique")
    profile_data = data.get("profiles", [])
    if not isinstance(profile_data, list):
        raise ValueError("Profiles must be an array")
    profiles = []
    for item in profile_data:
        if not isinstance(item, dict):
            raise ValueError("Each profile must be an object")
        try:
            profiles.append(SettingsProfile(**item))
        except TypeError as error:
            raise ValueError("Profile contains missing or unknown fields") from error
    ids = {profile.id for profile in profiles}
    if len(ids) != len(profiles) or len({p.name.casefold() for p in profiles}) != len(profiles):
        raise ValueError("Profile ids and names must be unique")
    if any(camera.profile_id is not None and camera.profile_id not in ids for camera in cameras):
        raise ValueError("Camera references an unknown profile")
    return AppConfig(cameras, profiles)


def load_config(path: Path) -> list[CameraConfig]:
    return load_app_config(path).cameras


def save_config(
    path: Path,
    cameras: list[CameraConfig],
    profiles: list[SettingsProfile] | None = None,
) -> None:
    """Replace configuration atomically, without truncating a working file on failure."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".spyder-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            json.dump(
                {
                    "version": 1,
                    "cameras": [asdict(camera) for camera in cameras],
                    "profiles": [asdict(profile) for profile in profiles or []],
                },
                target,
                indent=2,
            )
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
