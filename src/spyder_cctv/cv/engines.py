"""Lazy local adapters; never pass camera sources to inference libraries."""

import importlib
import json
import logging
import math
import os
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from spyder_cctv.cv.contracts import Detection, Engine, VisionConfig, VisionUnavailable

logger = logging.getLogger(__name__)


def _local_model(config: VisionConfig) -> Path:
    path = Path(config.resolve().model or "")
    if not path.is_file():
        raise VisionUnavailable("model_missing", "Place the configured model on this computer.")
    return path


class OpenCVPeopleEngine:
    """Built-in HOG person detector. No additional model download is needed."""

    class_names = ["person"]

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
        names = result.names
        self.class_names = list(names.values()) if isinstance(names, dict) else list(names)
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
    """Local InsightFace ONNX detection with optional local identity matching."""

    class_names = ["face"]

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
        self.recognizer = None
        self.classifier = None
        self.identity_stabilizer = None
        self.align = None
        self.gallery: list[tuple[str, np.ndarray]] = []
        if config.recognition_model is not None:
            recognition_path = _local_path(config, "recognition_model")
            gallery_path = _local_path(config, "identity_gallery")
            try:
                self.recognizer = library.get_model(
                    str(recognition_path), providers=["CPUExecutionProvider"], download=False
                )
                self.align = importlib.import_module("insightface.utils.face_align")
            except ImportError as error:
                raise VisionUnavailable(
                    "dependency_missing", "Install spyder-cctv[insightface] in this environment."
                ) from error
            if self.recognizer is None or self.recognizer.taskname != "recognition":
                raise VisionUnavailable(
                    "model_incompatible", "Select an InsightFace recognition ONNX model."
                )
            self.gallery = _load_identity_gallery(gallery_path)
        if config.classifier_model is not None:
            logger.warning(
                "Closed-set face classifier cannot guarantee unknown rejection; "
                "classifier_threshold only rejects low-confidence results."
            )
            classifier_path = _local_path(config, "classifier_model")
            try:
                from spyder_cctv.cv.face_classifier import FaceClassifier

                self.classifier = FaceClassifier(config, classifier_path)
                from spyder_cctv.cv.identity_stability import IdentityStabilizer

                self.identity_stabilizer = IdentityStabilizer(
                    confirmations=getattr(config, "classifier_confirmation_frames", 3),
                    switch_confirmations=getattr(config, "classifier_switch_frames", 5),
                    ttl=max(2.5, 2 / config.inference_fps),
                )
                self.class_names = list(config.classifier_labels)
                self.align = importlib.import_module("insightface.utils.face_align")
            except ImportError as error:
                raise VisionUnavailable(
                    "dependency_missing", "Install spyder-cctv[insightface] in this environment."
                ) from error

    def infer(self, frame: Any) -> list[Detection]:
        boxes, landmarks = self.model.detect(frame, max_num=self.config.max_detections)
        if boxes is None:
            if self.identity_stabilizer is not None:
                self.identity_stabilizer.update([])
            return []
        detections = []
        for index, row in enumerate(boxes[: self.config.max_detections]):
            identity, similarity = None, None
            identity_confidence = None
            if self.classifier is not None:
                if landmarks is None or index >= len(landmarks):
                    raise VisionUnavailable(
                        "alignment_failed", "Face classifier requires five-point face landmarks."
                    )
                try:
                    aligned = self.align.norm_crop(frame, landmarks[index], image_size=112)
                except Exception as error:
                    raise VisionUnavailable(
                        "alignment_failed", "Face classifier could not align detected face."
                    ) from error
                identity, identity_confidence = self.classifier.classify(aligned)
            if (
                self.recognizer is not None
                and index < 16
                and landmarks is not None
                and index < len(landmarks)
            ):
                aligned = self.align.norm_crop(frame, landmarks[index], image_size=112)
                features = np.asarray(
                    self.recognizer.get_feat([aligned]), dtype=np.float32
                ).reshape(-1)
                norm = float(np.linalg.norm(features))
                if features.size == 0 or not math.isfinite(norm) or norm == 0:
                    raise VisionUnavailable(
                        "recognition_failed", "Face recognition returned invalid features."
                    )
                features /= norm
                if features.size != self.gallery[0][1].size:
                    raise VisionUnavailable(
                        "model_incompatible",
                        "Identity gallery dimension does not match recognition model.",
                    )
                identity, similarity = max(
                    (
                        (name, float(np.clip(np.dot(features, embedding), -1, 1)))
                        for name, embedding in self.gallery
                    ),
                    key=lambda candidate: candidate[1],
                )
                if similarity < self.config.recognition_threshold:
                    identity = None
            detections.append(
                Detection(
                    "face",
                    tuple(float(v) for v in row[:4]),
                    float(row[4]),
                    0,
                    identity=identity,
                    similarity=similarity,
                    identity_confidence=identity_confidence,
                )
            )
        if self.identity_stabilizer is not None:
            detections = self.identity_stabilizer.update(detections)
        return detections

    def close(self) -> None:
        self.model = None
        self.recognizer = None
        if self.classifier is not None:
            self.classifier.close()
        self.classifier = None
        if self.identity_stabilizer is not None:
            self.identity_stabilizer.clear()
        self.identity_stabilizer = None
        self.gallery = []


def _local_path(config: VisionConfig, name: str) -> Path:
    path_text = getattr(config.resolve(), name)
    path = Path(path_text or "")
    if not path.is_file():
        raise VisionUnavailable(
            "model_missing", "Place the configured model and gallery on this computer."
        )
    return path


def _load_identity_gallery(path: Path) -> list[tuple[str, np.ndarray]]:
    try:
        if path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("gallery too large")
        with path.open("r", encoding="utf-8") as source:
            data = json.load(
                source, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value))
            )
        if (
            not isinstance(data, dict)
            or set(data) != {"version", "identities"}
            or data["version"] != 1
        ):
            raise ValueError("invalid gallery schema")
        records = data["identities"]
        if not isinstance(records, list) or not 1 <= len(records) <= 1000:
            raise ValueError("invalid identity count")
        gallery, names, dimension = [], set(), None
        for record in records:
            if not isinstance(record, dict) or set(record) != {"name", "embedding"}:
                raise ValueError("invalid identity record")
            name, values = record["name"], record["embedding"]
            if not isinstance(name, str) or not name.strip() or len(name) > 128 or name in names:
                raise ValueError("invalid identity name")
            if not isinstance(values, list) or not values:
                raise ValueError("invalid embedding")
            if any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                for value in values
            ):
                raise ValueError("invalid embedding")
            vector = np.asarray(values, dtype=np.float32)
            if vector.ndim != 1 or not np.isfinite(vector).all():
                raise ValueError("invalid embedding")
            norm = float(np.linalg.norm(vector))
            if not math.isfinite(norm) or norm == 0:
                raise ValueError("invalid embedding norm")
            if dimension is not None and vector.size != dimension:
                raise ValueError("embedding dimensions differ")
            dimension = vector.size
            vector /= norm
            gallery.append((name, vector))
            names.add(name)
        return gallery
    except (
        OSError,
        UnicodeError,
        json.JSONDecodeError,
        TypeError,
        ValueError,
        OverflowError,
    ) as error:
        raise VisionUnavailable(
            "gallery_invalid", "Use a valid local version 1 identity gallery."
        ) from error


def create_engine(config: VisionConfig) -> Engine:
    return {"opencv": OpenCVPeopleEngine, "yolo": YoloEngine, "insightface": InsightFaceEngine}[
        config.engine
    ](config)
