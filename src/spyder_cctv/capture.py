"""Capture adapter. A worker owns the backend for its entire lifetime."""

import sys
import threading
from collections.abc import Callable
from typing import Any, Protocol

import cv2

from spyder_cctv.controls import apply_settings, unavailable_controls


class Capture(Protocol):
    def read(self) -> tuple[bool, Any]: ...
    def close(self) -> None: ...


# OpenCV's DirectShow backend shares process-global videoInput state. Serialize
# mapping/open/close and reserve physical identities across active capture workers.
_DEVICE_LOCK = threading.RLock()
_DEVICE_CLAIMS: dict[str, Any] = {}
_DEVICE_SLOTS: dict[int, Any] = {}


class CameraIdentityError(RuntimeError):
    """Safe, credential-free reason that a webcam cannot be selected."""


class OpenCVCapture:
    def __init__(
        self,
        source: int | str,
        *,
        device_id: str | None = None,
        on_device_bound: Callable[[str], None] | None = None,
    ) -> None:
        self._on_device_bound = on_device_bound
        self.device_id: str | None = None
        self.device_index: int | None = None
        self._windows_device = sys.platform == "win32" and isinstance(source, int)
        self._controls = None
        self._invalidated = threading.Event()
        self._owns_device = False
        self.capture = None
        if self._windows_device:
            with _DEVICE_LOCK:
                self._open_windows(source, device_id)
        else:
            self.capture = cv2.VideoCapture(source, cv2.CAP_ANY)
            if not self.capture.isOpened():
                self.capture.release()
                raise RuntimeError("Cannot open camera")

    def _open_windows(self, source: int, expected: str | None) -> None:
        from spyder_cctv.directshow import DirectShowControls, enumerate_video_devices

        devices = [value.casefold() if value else None for value in enumerate_video_devices()]
        # DirectShow's global videoInput slots retain their old mapping while
        # open, even when Windows has reordered the device enumeration. Never
        # open a candidate slot until every affected old handle has drained.
        changed = any(
            index >= len(devices) or devices[index] != owner.device_id
            for index, owner in _DEVICE_SLOTS.items()
        )
        if changed:
            for owner in _DEVICE_SLOTS.values():
                owner._invalidated.set()
        if changed or any(owner._invalidated.is_set() for owner in _DEVICE_SLOTS.values()):
            raise CameraIdentityError(
                "Webcam order changed; waiting for existing captures to refresh"
            )
        if expected is None:
            if source >= len(devices) or not devices[source]:
                raise CameraIdentityError(
                    "Webcam identity unavailable; waiting for the original device"
                )
            expected = devices[source]
        expected = expected.casefold()
        matches = [
            i for i, identity in enumerate(devices) if identity and identity.casefold() == expected
        ]
        if len(matches) != 1:
            raise CameraIdentityError("Saved webcam is unavailable; waiting for the same device")
        if self._on_device_bound is not None:
            # Pin intent durably before opening. A failed/hotplugged first open
            # must not silently pick a different device on the next attempt.
            self._on_device_bound(expected)
        if expected in _DEVICE_CLAIMS:
            raise CameraIdentityError("This physical webcam is already in use by another camera")
        if matches[0] in _DEVICE_SLOTS:
            raise CameraIdentityError("Webcam capture slot is already in use")
        self.device_index = matches[0]
        self.device_id = expected
        self._owns_device = True
        _DEVICE_CLAIMS[expected] = self
        _DEVICE_SLOTS[self.device_index] = self
        try:
            self.capture = cv2.VideoCapture(self.device_index, cv2.CAP_DSHOW)
            if not self.capture.isOpened():
                raise RuntimeError("Cannot open camera")
            try:
                self._controls = DirectShowControls(self.device_index)
            except Exception:
                # Unsupported controls must never prevent video capture.
                pass
            # Hotplug can change enumeration during a slow driver open. Discard
            # this attempt before any frames/settings can reach the named view.
            after = [value.casefold() if value else None for value in enumerate_video_devices()]
            if after != devices:
                for owner in _DEVICE_SLOTS.values():
                    owner._invalidated.set()
                raise CameraIdentityError(
                    "Webcam device order changed while connecting; retrying safely"
                )
        except Exception:
            self.close()
            raise

    def get_controls(self) -> dict[str, Any]:
        return self._controls.capabilities() if self._controls else unavailable_controls()

    def apply_controls(self, settings: dict[str, float]) -> dict[str, Any]:
        if self._controls:
            return apply_settings(self._controls, settings)
        return {
            "capabilities": self.get_controls(),
            "results": {
                name: {"status": "unsupported", "requested": value}
                for name, value in settings.items()
            },
        }

    def read(self) -> tuple[bool, Any]:
        if self._invalidated.is_set():
            raise CameraIdentityError("Webcam order changed; refreshing the original device")
        result = self.capture.read()
        if self._invalidated.is_set():
            raise CameraIdentityError("Webcam order changed; discarding obsolete capture frame")
        return result

    def close(self) -> None:
        if self._windows_device:
            with _DEVICE_LOCK:
                self._release_resources()
        else:
            self._release_resources()

    def _release_resources(self) -> None:
        try:
            if self._controls:
                self._controls.close()
                self._controls = None
        finally:
            if self.capture is not None:
                self.capture.release()
                self.capture = None
            if self._owns_device:
                if _DEVICE_CLAIMS.get(self.device_id) is self:
                    _DEVICE_CLAIMS.pop(self.device_id, None)
                if _DEVICE_SLOTS.get(self.device_index) is self:
                    _DEVICE_SLOTS.pop(self.device_index, None)
                self._owns_device = False


def encode_jpeg(frame: Any) -> bytes:
    ok, encoded = cv2.imencode(".jpg", frame)
    if not ok:
        raise RuntimeError("Cannot encode frame")
    return encoded.tobytes()
