"""Lazy local adapters; never pass camera sources to inference libraries."""

import importlib
import os
from pathlib import Path
from typing import Any

import cv2

from spyder_cctv.cv.contracts import Detection, Engine, VisionConfig, VisionUnavailable


def _local_model(config: VisionConfig) -> Path:
    path = Path(config.resolve().model or "")
    if not path.is_file():
        raise VisionUnavailable("model_missing", "Place the configured model on this computer.")
    return path


class OpenCVPeopleEngine:
    """Built-in HOG person detector. No additional model download is needed."""

    def __init__(self, config: VisionConfig) -> None:
        self.config = config
        self.model = cv2.HOGDescriptor()
        self.model.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

    def infer(self, frame: Any) -> list[Detection]:
        h, w = frame.shape[:2]
        ratio = min(1.0, self.config.input_size / max(w, h))
        image = cv2.resize(frame, (round(w * ratio), round(h * ratio))) if ratio < 1 else frame
        if image.shape[0] < 128 or image.shape[1] < 64:
            return []
        boxes, scores = self.model.detectMultiScale(
            image, winStride=(8, 8), padding=(8, 8), scale=1.05
        )
        return [
            Detection(
                "person",
                (
                    float(x / ratio),
                    float(y / ratio),
                    float((x + width) / ratio),
                    float((y + height) / ratio),
                ),
                class_id=0,
                score=float(score),
            )
            for (x, y, width, height), score in zip(boxes, scores, strict=True)
        ][: self.config.max_detections]

    def close(self) -> None:
        self.model = None


class YoloEngine:
    def __init__(self, config: VisionConfig) -> None:
        self.config = config
        path = _local_model(config)
        # Process-wide settings must precede Ultralytics' first import.
        os.environ["YOLO_AUTOINSTALL"] = "false"
        os.environ["YOLO_OFFLINE"] = "true"
        try:
            library = importlib.import_module("ultralytics")
        except ImportError as error:
            raise VisionUnavailable(
                "dependency_missing", "Install spyder-cctv[yolo] in this environment."
            ) from error
        library.settings.update({"sync": False})
        self.model = library.YOLO(str(path), task="detect")

    def infer(self, frame: Any) -> list[Detection]:
        result = self.model.predict(
            source=frame,
            device=self.config.device,
            imgsz=self.config.input_size,
            conf=self.config.confidence,
            max_det=self.config.max_detections,
            verbose=False,
            save=False,
            stream=False,
        )[0]
        if result.boxes is None:
            return []
        boxes = result.boxes.xyxy.cpu().tolist()
        scores = result.boxes.conf.cpu().tolist()
        classes = result.boxes.cls.cpu().tolist()
        return [
            Detection(
                str(result.names[int(cls)]), tuple(float(v) for v in box), float(score), int(cls)
            )
            for box, score, cls in zip(boxes, scores, classes, strict=True)
        ][: self.config.max_detections]

    def close(self) -> None:
        self.model = None


class InsightFaceEngine:
    """Detection-only ONNX model: no pack downloader, identities, or embeddings."""

    def __init__(self, config: VisionConfig) -> None:
        self.config = config
        path = _local_model(config)
        try:
            library = importlib.import_module("insightface.model_zoo")
        except ImportError as error:
            raise VisionUnavailable(
                "dependency_missing", "Install spyder-cctv[insightface] in this environment."
            ) from error
        self.model = library.get_model(
            str(path), providers=["CPUExecutionProvider"], download=False
        )
        if self.model is None or self.model.taskname != "detection":
            raise VisionUnavailable(
                "model_incompatible", "Select an InsightFace detection ONNX model."
            )
        self.model.prepare(
            ctx_id=-1,
            input_size=(config.input_size, config.input_size),
            det_thresh=config.confidence,
        )

    def infer(self, frame: Any) -> list[Detection]:
        boxes, _landmarks = self.model.detect(frame, max_num=self.config.max_detections)
        return [
            Detection("face", tuple(float(v) for v in row[:4]), float(row[4]), 0)
            for row in boxes[: self.config.max_detections]
        ]

    def close(self) -> None:
        self.model = None


def create_engine(config: VisionConfig) -> Engine:
    return {"opencv": OpenCVPeopleEngine, "yolo": YoloEngine, "insightface": InsightFaceEngine}[
        config.engine
    ](config)
