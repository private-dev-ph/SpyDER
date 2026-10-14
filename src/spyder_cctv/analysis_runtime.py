"""Latest-frame motion analysis that cannot stall camera capture."""

import copy
import threading
import time
from collections.abc import Callable
from dataclasses import replace
from typing import Any

import cv2
import numpy as np

from spyder_cctv.motion import MotionAnalyzer
from spyder_cctv.motion_config import AnalysisConfig


class AnalysisRuntime:
    def __init__(self, config: AnalysisConfig, factory: Callable = MotionAnalyzer) -> None:
        self.config = config
        self._factory = factory
        self._condition = threading.Condition()
        self._stop = False
        self._pending: Any = None
        self._next = 0.0
        self._updated: float | None = None
        self._mask: bytes | None = None
        self._average_ms = 0.0
        self._dropped = 0
        self._result: dict[str, Any] = {"state": "loading", "regions": [], "tracks": []}
        self._thread = threading.Thread(target=self._run, name="motion-analysis", daemon=True)
        self._thread.start()

    @property
    def is_alive(self) -> bool:
        return self._thread.is_alive()

    def process(self, frame: Any) -> dict[str, Any]:
        now = time.monotonic()
        with self._condition:
            if not self._stop and self._result["state"] != "error" and now >= self._next:
                if self._pending is not None:
                    self._dropped += 1
                self._pending = (frame.copy(), now)
                effective = min(self.config.inference_fps, 700 / max(1, self._average_ms))
                self._next = now + 1 / effective
                self._condition.notify()
            result = copy.deepcopy(self._result)
            result["result_age_seconds"] = (
                None if self._updated is None else round(now - self._updated, 3)
            )
            result["dropped_frames"] = self._dropped
            result["effective_fps"] = round(
                min(self.config.inference_fps, 700 / max(1, self._average_ms)), 2
            )
        if result["result_age_seconds"] is not None and result["result_age_seconds"] > 2:
            result.update(state="stale", regions=[], tracks=[])
        return result

    def mask(self) -> bytes | None:
        with self._condition:
            if self._stop or self._updated is None or time.monotonic() - self._updated > 2:
                return None
            return self._mask

    def annotate(self, frame: Any, result: dict[str, Any]) -> Any:
        if not self.config.overlay or result.get("state") != "ready":
            return frame
        if result.get("frame_size") != [frame.shape[1], frame.shape[0]]:
            return frame
        output = frame.copy()
        for region in result.get("regions", [])[:32]:
            x, y, w, h = [int(v) for v in region["bbox"]]
            cv2.rectangle(output, (x, y), (x + w, y + h), (127, 216, 247), 2)
            contour = region.get("contour", [])
            if self.config.contours and contour:
                cv2.polylines(output, [np.asarray(contour, dtype=np.int32)], True, (0, 190, 255), 1)
        for track in result.get("tracks", [])[:4]:
            x, y, w, h = [int(v) for v in track["bbox"]]
            cv2.rectangle(output, (x, y), (x + w, y + h), (30, 49, 208), 2)
            cv2.putText(
                output,
                f"Track {track['id']}",
                (x, max(15, y - 6)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (127, 216, 247),
                1,
            )
        return output

    def _run(self) -> None:
        analyzer = None
        try:
            analyzer = self._factory(replace(self.config, overlay=False))
            while True:
                with self._condition:
                    self._condition.wait_for(lambda: self._stop or self._pending is not None)
                    if self._stop:
                        break
                    frame, captured = self._pending
                    self._pending = None
                began = time.monotonic()
                _, result = analyzer.process(frame)
                mask = getattr(analyzer, "mask", None)
                encoded = None
                if mask is not None:
                    if mask.shape[1] > 320:
                        mask = cv2.resize(
                            mask, (320, max(1, round(mask.shape[0] * 320 / mask.shape[1])))
                        )
                    ok, jpeg = cv2.imencode(".jpg", mask)
                    if ok:
                        encoded = jpeg.tobytes()
                duration = (time.monotonic() - began) * 1000
                with self._condition:
                    if self._stop:
                        break
                    self._average_ms = (
                        duration
                        if not self._average_ms
                        else 0.8 * self._average_ms + 0.2 * duration
                    )
                    self._result = result | {"processing_ms": round(self._average_ms, 2)}
                    self._updated = captured
                    self._mask = encoded
        except Exception:
            with self._condition:
                self._pending = None
                self._mask = None
                self._result = {
                    "state": "error",
                    "regions": [],
                    "tracks": [],
                    "message": "Motion analysis failed; camera preview remains available",
                }
        finally:
            if analyzer is not None:
                analyzer.close()

    def close(self, timeout: float = 0.5) -> None:
        with self._condition:
            self._stop = True
            self._pending = None
            self._condition.notify_all()
        self._thread.join(timeout)
        if self._thread.is_alive():
            raise RuntimeError("Motion analysis is still stopping")
