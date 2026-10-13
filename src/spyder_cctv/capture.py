"""Capture adapter. A worker owns the backend for its entire lifetime."""

import sys
from typing import Any, Protocol

import cv2

from spyder_cctv.controls import apply_settings, unavailable_controls


class Capture(Protocol):
    def read(self) -> tuple[bool, Any]: ...
    def close(self) -> None: ...


class OpenCVCapture:
    def __init__(self, source: int | str) -> None:
        # DirectShow avoids slow MSMF startup and supports simultaneous USB cameras on Windows.
        backend = (
            cv2.CAP_DSHOW if sys.platform == "win32" and isinstance(source, int) else cv2.CAP_ANY
        )
        self.capture = cv2.VideoCapture(source, backend)
        if not self.capture.isOpened():
            self.capture.release()
            raise RuntimeError("Cannot open camera")
        self._controls = None
        if sys.platform == "win32" and isinstance(source, int):
            from spyder_cctv.directshow import DirectShowControls

            try:
                self._controls = DirectShowControls(source)
            except Exception:
                # Missing native control interfaces must never prevent video capture.
                pass

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
        return self.capture.read()

    def close(self) -> None:
        try:
            if self._controls:
                self._controls.close()
        finally:
            self.capture.release()


def encode_jpeg(frame: Any) -> bytes:
    ok, encoded = cv2.imencode(".jpg", frame)
    if not ok:
        raise RuntimeError("Cannot encode frame")
    return encoded.tobytes()
