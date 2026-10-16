"""Bounded latest-frame inference independent of capture and preview cadence."""

import copy
import threading
import time
from collections.abc import Callable
from typing import Any

import cv2

from spyder_cctv.cv.contracts import Engine, VisionConfig, VisionUnavailable
from spyder_cctv.cv.engines import create_engine


class VisionPipeline:
    def __init__(
        self, config: VisionConfig, engine_factory: Callable[[VisionConfig], Engine] = create_engine
    ) -> None:
        self.config = config
        self._factory = engine_factory
        self._condition = threading.Condition()
        self._stop = False
        self._pending: tuple[int, float, Any] | None = None
        self._next_submission = 0.0
        self._sequence = 0
        self._result_time: float | None = None
        self._result: dict[str, Any] = {
            "engine": config.engine,
            "state": "loading",
            "detections": [],
        }
        self._thread = threading.Thread(
            target=self._run, name=f"vision-{config.engine}", daemon=True
        )
        self._thread.start()

    def process(self, frame: Any) -> tuple[Any, dict[str, Any]]:
        now = time.monotonic()
        with self._condition:
            if not self._stop and self._result["state"] != "error" and now >= self._next_submission:
                self._sequence += 1
                self._pending = (self._sequence, now, frame.copy())
                self._next_submission = now + 1 / self.config.inference_fps
                self._condition.notify()
            result = copy.deepcopy(self._result)
            result["result_age_seconds"] = (
                None if self._result_time is None else round(now - self._result_time, 3)
            )
        if result["result_age_seconds"] is not None and result["result_age_seconds"] > 2:
            result.update(state="stale", detections=[])
        output = frame
        if result.get("state") == "ready" and result.get("frame_size") == [
            frame.shape[1],
            frame.shape[0],
        ]:
            output = frame.copy()
            for detection in result.get("detections", [])[:32]:
                x1, y1, x2, y2 = [
                    int(max(0, min(v, frame.shape[1 if index % 2 == 0 else 0] - 1)))
                    for index, v in enumerate(detection["bbox"])
                ]
                cv2.rectangle(output, (x1, y1), (x2, y2), (30, 49, 208), 2)
                label = detection.get("identity") or detection["label"]
                cv2.putText(
                    output,
                    label[:64],
                    (x1, max(15, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.5,
                    (127, 216, 247),
                    1,
                )
        return output, {"cv": result}

    def _run(self) -> None:
        engine = None
        try:
            engine = self._factory(self.config)
            while True:
                with self._condition:
                    self._condition.wait_for(lambda: self._stop or self._pending is not None)
                    if self._stop:
                        break
                    sequence, captured, frame = self._pending
                    self._pending = None
                began = time.monotonic()
                detections = engine.infer(frame)
                classes = getattr(engine, "class_names", [])
                classes = classes if isinstance(classes, list) else []
                classes = [
                    name
                    for name in classes[:1000]
                    if isinstance(name, str) and 0 < len(name) <= 128
                ]
                result = {
                    "classes": classes,
                    "engine": self.config.engine,
                    "state": "ready",
                    "sequence": sequence,
                    "frame_size": [int(frame.shape[1]), int(frame.shape[0])],
                    "detections": [d.to_dict() for d in detections[: self.config.max_detections]],
                    "inference_ms": round((time.monotonic() - began) * 1000, 2),
                }
                with self._condition:
                    if self._stop:
                        break
                    self._result, self._result_time = result, captured
        except Exception as error:
            with self._condition:
                self._pending = None
                self._result = {
                    "engine": self.config.engine,
                    "state": "error",
                    "detections": [],
                    "error_code": error.code
                    if isinstance(error, VisionUnavailable)
                    else "inference_failed",
                    "message": str(error)
                    if isinstance(error, VisionUnavailable)
                    else "CV initialization or inference failed. Check the local engine and model.",
                }
        finally:
            if engine is not None:
                try:
                    engine.close()
                except Exception:
                    pass

    def close(self, timeout: float = 1.0) -> None:
        with self._condition:
            self._stop = True
            self._pending = None
            self._condition.notify_all()
        self._thread.join(timeout)
        if self._thread.is_alive():
            raise RuntimeError("CV worker did not stop within timeout")

    @property
    def is_alive(self) -> bool:
        return self._thread.is_alive()
