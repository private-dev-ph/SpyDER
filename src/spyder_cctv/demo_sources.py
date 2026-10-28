"""Allowlisted, package-shipped demo video sources."""

import json
import math
import re
import time
from contextlib import ExitStack, contextmanager, nullcontext
from importlib.resources import as_file, files
from pathlib import Path
from typing import Any

import cv2

from spyder_cctv.controls import CONTROL_LABELS, validate_settings

DEMO_SCHEME = "demo://"
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_DEFAULTS = {
    "zoom": 0.0,
    "fov": 100.0,
    "pan": 50.0,
    "tilt": 50.0,
    "brightness": 50.0,
    "contrast": 50.0,
    "saturation": 50.0,
}
_DEMO_ASSETS = files("spyder_cctv").joinpath("assets")


def demo_catalog_bytes() -> bytes:
    return _DEMO_ASSETS.joinpath("demo-cameras.json").read_bytes()


def demo_media_filenames() -> set[str]:
    data = json.loads(demo_catalog_bytes())
    if (
        not isinstance(data, dict)
        or set(data) != {"version", "cameras"}
        or type(data["version"]) is not int
        or data["version"] != 1
        or not isinstance(data["cameras"], list)
    ):
        raise ValueError("Invalid demo camera catalog")
    filenames = set()
    for entry in data["cameras"]:
        if not isinstance(entry, dict):
            raise ValueError("Invalid demo camera catalog entry")
        filename = entry.get("filename")
        if (
            not isinstance(filename, str)
            or Path(filename).name != filename
            or not filename.startswith("demo-")
            or not filename.lower().endswith(".mp4")
            or filename in filenames
        ):
            raise ValueError("Invalid demo camera media filename")
        filenames.add(filename)
    return filenames


@contextmanager
def demo_media_path(filename: str):
    if filename not in demo_media_filenames():
        raise FileNotFoundError(filename)
    with as_file(_DEMO_ASSETS.joinpath(filename)) as path:
        yield Path(path)


def is_demo_source(source: object) -> bool:
    return isinstance(source, str) and source.casefold().startswith(DEMO_SCHEME)


def _catalog_data(catalog_path: Path | None) -> tuple[dict[str, Any], Path | None]:
    if catalog_path is not None:
        path = Path(catalog_path)
        return json.loads(path.read_text(encoding="utf-8")), path.parent
    resource = files("spyder_cctv").joinpath("assets", "demo-cameras.json")
    return json.loads(resource.read_text(encoding="utf-8")), None


def resolve_demo_source(
    source: str, *, catalog_path: Path | None = None
) -> tuple[dict[str, Any], Any]:
    """Return validated entry and traversable media resource for exact demo URI."""
    if not is_demo_source(source):
        raise ValueError("Demo source must use demo://<catalog-id>")
    camera_id = source.removeprefix(DEMO_SCHEME)
    if not _SLUG.fullmatch(camera_id):
        raise ValueError("Invalid demo camera id")
    try:
        data, catalog_root = _catalog_data(catalog_path)
    except (FileNotFoundError, json.JSONDecodeError) as error:
        raise ValueError("Demo camera catalog is unavailable") from error
    if (
        not isinstance(data, dict)
        or set(data) != {"version", "cameras"}
        or type(data["version"]) is not int
        or data["version"] != 1
        or not isinstance(data["cameras"], list)
    ):
        raise ValueError("Invalid demo camera catalog")
    matches = [
        entry
        for entry in data["cameras"]
        if isinstance(entry, dict) and entry.get("id") == camera_id
    ]
    if len(matches) != 1:
        raise ValueError("Unknown demo camera")
    entry = matches[0]
    filename = entry.get("filename")
    if (
        not isinstance(filename, str)
        or Path(filename).name != filename
        or not filename.lower().endswith(".mp4")
        or not filename.startswith("demo-")
    ):
        raise ValueError("Invalid demo camera media filename")
    if catalog_root is not None:
        media = catalog_root / filename
    else:
        media = files("spyder_cctv").joinpath("assets", filename)
    return entry, media


class DemoClipCapture:
    """Loop one allowlisted clip and apply simulated controls to clean frames."""

    def __init__(self, source: str, *, catalog_path: Path | None = None) -> None:
        entry, media = resolve_demo_source(source, catalog_path=catalog_path)
        self.entry = entry
        self._resources = ExitStack()
        try:
            path_context = as_file(media) if catalog_path is None else nullcontext(media)
            self.path = Path(self._resources.enter_context(path_context))
            self.capture = cv2.VideoCapture(str(self.path), cv2.CAP_ANY)
            if not self.capture.isOpened():
                self.capture.release()
                raise RuntimeError("Cannot open demo clip")
        except Exception:
            self._resources.close()
            raise
        self._closed = False
        self._settings = _DEFAULTS.copy()
        self._playback_started: float | None = None
        self._next_frame_index = 0
        self._last_target_index: int | None = None
        self._cached_frame: Any = None
        self._source_fps, self._frame_count = self._playback_metadata()

    def _playback_metadata(self) -> tuple[float | None, int | None]:
        try:
            fps = float(self.capture.get(cv2.CAP_PROP_FPS))
            count_value = float(self.capture.get(cv2.CAP_PROP_FRAME_COUNT))
            count = int(count_value)
        except (AttributeError, OverflowError, TypeError, ValueError, cv2.error):
            return None, None
        if (
            not math.isfinite(fps)
            or fps <= 0
            or not math.isfinite(count_value)
            or count <= 0
            or not math.isfinite(count / fps)
        ):
            return None, None
        return fps, count

    def get_controls(self) -> dict[str, Any]:
        return {
            name: {
                "label": label,
                "supported": True,
                "value": self._settings[name],
                "minimum": 0,
                "maximum": 100,
                "step": 1,
                "default": _DEFAULTS[name],
                "default_percent": _DEFAULTS[name],
                "mode": "software simulation",
                "implementation": "software",
            }
            for name, label in CONTROL_LABELS.items()
        }

    def apply_controls(self, settings: dict[str, float]) -> dict[str, Any]:
        desired = validate_settings(settings)
        self._settings.update(desired)
        return {
            "capabilities": self.get_controls(),
            "results": {
                name: {
                    "status": "applied",
                    "requested": value,
                    "value": value,
                    "implementation": "software",
                }
                for name, value in desired.items()
            },
        }

    def _transform(self, frame: Any) -> Any:
        height, width = frame.shape[:2]
        zoom = self._settings["zoom"]
        fov = self._settings["fov"]
        factor = min(4.0, max(1.0, (1 + 3 * zoom / 100) * (1 + 3 * (100 - fov) / 100)))
        crop_width = max(1, round(width / factor))
        crop_height = max(1, round(height / factor))
        left = round((width - crop_width) * self._settings["pan"] / 100)
        top = round((height - crop_height) * self._settings["tilt"] / 100)
        if crop_width != width or crop_height != height:
            frame = cv2.resize(
                frame[top : top + crop_height, left : left + crop_width],
                (width, height),
                interpolation=cv2.INTER_LINEAR,
            )

        brightness = 2 ** ((self._settings["brightness"] - 50) / 50)
        contrast = 2 ** ((self._settings["contrast"] - 50) / 50)
        frame = cv2.addWeighted(
            frame,
            contrast * brightness,
            frame,
            0,
            127.5 * (1 - contrast) * brightness,
        )
        saturation = self._settings["saturation"] / 50
        if not math.isclose(saturation, 1.0):
            hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
            hsv[:, :, 1] = cv2.convertScaleAbs(hsv[:, :, 1], alpha=saturation)
            frame = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
        return frame

    def _seek_to_start(self) -> bool:
        return bool(self.capture.set(cv2.CAP_PROP_POS_FRAMES, 0))

    def _read_timed_frame(self, now: float) -> tuple[bool, Any]:
        assert self._source_fps is not None and self._frame_count is not None
        if self._playback_started is None:
            self._playback_started = now
            target = 0
        else:
            duration = self._frame_count / self._source_fps
            elapsed = max(0.0, now - self._playback_started) % duration
            target = min(self._frame_count - 1, int(elapsed * self._source_fps))

        if target == self._last_target_index and self._cached_frame is not None:
            return True, self._transform(self._cached_frame.copy())
        if self._last_target_index is not None and target < self._last_target_index:
            # Clock wrap only. Duplicate target reads reuse cached raw pixels above.
            if not self._seek_to_start():
                return False, None
            self._next_frame_index = 0

        frame = None
        while self._next_frame_index <= target:
            ok, frame = self.capture.read()
            if not ok:
                # Catalog metadata can overstate clip length. Rewind once, then use
                # sequential EOF looping instead of chasing an unreachable index.
                if not self._seek_to_start():
                    return False, None
                ok, frame = self.capture.read()
                if not ok or frame is None:
                    return False, None
                self._source_fps = self._frame_count = None
                self._playback_started = None
                self._next_frame_index = 1
                self._last_target_index = None
                self._cached_frame = None
                return True, self._transform(frame)
            self._next_frame_index += 1

        if frame is None:
            return False, None
        self._last_target_index = target
        self._cached_frame = frame.copy()
        return True, self._transform(frame)

    def read(self) -> tuple[bool, Any]:
        if self._closed:
            return False, None
        if self._source_fps is not None and self._frame_count is not None:
            return self._read_timed_frame(time.monotonic())
        ok, frame = self.capture.read()
        if not ok:
            # Unknown metadata keeps the original EOF loop behavior.
            if not self._seek_to_start():
                return False, None
            ok, frame = self.capture.read()
        if not ok or frame is None:
            return False, None
        return True, self._transform(frame)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self.capture.release()
        finally:
            self._resources.close()
