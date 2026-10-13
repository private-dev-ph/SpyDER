"""Capture adapter. A worker owns the backend for its entire lifetime."""

import sys
from typing import Any, Protocol

import cv2


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

    def read(self) -> tuple[bool, Any]:
        return self.capture.read()

    def close(self) -> None:
        self.capture.release()


def encode_jpeg(frame: Any) -> bytes:
    ok, encoded = cv2.imencode(".jpg", frame)
    if not ok:
        raise RuntimeError("Cannot encode frame")
    return encoded.tobytes()
