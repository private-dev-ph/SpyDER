"""Local ONNX face classification over InsightFace-aligned crops."""

import math
from pathlib import Path
from typing import Any

import numpy as np

from spyder_cctv.cv.contracts import VisionConfig, VisionUnavailable


class FaceClassifier:
    def __init__(self, config: VisionConfig, path: Path) -> None:
        try:
            import onnxruntime
        except ImportError as error:
            raise VisionUnavailable(
                "dependency_missing", "Install spyder-cctv[insightface] in this environment."
            ) from error
        try:
            self.session = onnxruntime.InferenceSession(
                str(path), providers=["CPUExecutionProvider"]
            )
            inputs = self.session.get_inputs()
            outputs = self.session.get_outputs()
            if len(inputs) != 1:
                raise ValueError("classifier must have one input")
            input_meta = inputs[0]
            shape = input_meta.shape
            if input_meta.type != "tensor(float)" or len(shape) != 4:
                raise ValueError("classifier input must be float32 rank 4")
            if isinstance(shape[0], int) and shape[0] != 1:
                raise ValueError("classifier batch dimension must be 1")
            if shape[1:] == [3, 112, 112] or tuple(shape[1:]) == (3, 112, 112):
                self.layout = "nchw"
            elif shape[1:] == [112, 112, 3] or tuple(shape[1:]) == (112, 112, 3):
                self.layout = "nhwc"
            else:
                raise ValueError("classifier input must have fixed 112x112 RGB shape")
            matching_outputs = [
                output for output in outputs if output.name == config.classifier_output
            ]
            if len(matching_outputs) != 1:
                raise ValueError("classifier output name does not match selected output")
            output_meta = matching_outputs[0]
            if not isinstance(output_meta.name, str) or not output_meta.name:
                raise ValueError("classifier output name is invalid")
            if not isinstance(input_meta.name, str) or not input_meta.name:
                raise ValueError("classifier input name is invalid")
            self.class_count = len(config.classifier_labels)
            output_shape = tuple(output_meta.shape)
            valid_rank_one = output_shape == (self.class_count,)
            valid_rank_two = (
                len(output_shape) == 2
                and output_shape[1] == self.class_count
                and (not isinstance(output_shape[0], int) or output_shape[0] == 1)
            )
            if not (valid_rank_one or valid_rank_two):
                raise ValueError("classifier output shape does not match labels")
            self.input_name = input_meta.name
            self.output_name = output_meta.name
            self.output_type = config.classifier_output
            self.preprocessing = config.classifier_preprocessing
            self.labels = config.classifier_labels
            self.threshold = float(config.classifier_threshold)
            self.min_margin = float(config.classifier_min_margin)
        except VisionUnavailable:
            raise
        except Exception as error:
            raise VisionUnavailable(
                "model_incompatible", "Select a compatible face classifier ONNX model."
            ) from error

    def classify(self, aligned_bgr: Any) -> tuple[str | None, float]:
        rgb = np.asarray(aligned_bgr)
        if rgb.shape != (112, 112, 3) or rgb.dtype != np.uint8:
            raise VisionUnavailable(
                "classification_failed", "Face alignment returned invalid image."
            )
        rgb = rgb[:, :, ::-1].astype(np.float32)
        if self.preprocessing == "arcface":
            rgb = (rgb - 127.5) / 127.5
        if self.layout == "nchw":
            rgb = np.transpose(rgb, (2, 0, 1))
        tensor = np.ascontiguousarray(rgb[None, ...], dtype=np.float32)
        try:
            values = self.session.run([self.output_name], {self.input_name: tensor})
            if len(values) != 1:
                raise ValueError("unexpected output count")
            scores = np.asarray(values[0], dtype=np.float64)
            if scores.shape not in ((self.class_count,), (1, self.class_count)):
                raise ValueError("classifier output shape does not match labels")
            scores = scores.reshape(-1)
            if not np.isfinite(scores).all():
                raise ValueError("classifier scores are not finite")
            if self.output_type == "logits":
                scores -= np.max(scores)
                scores = np.exp(scores)
                total = float(np.sum(scores))
                if not math.isfinite(total) or total <= 0:
                    raise ValueError("classifier logits cannot be normalized")
                scores /= total
            elif (
                np.any(scores < 0)
                or np.any(scores > 1)
                or not math.isclose(float(np.sum(scores)), 1.0, rel_tol=1e-3, abs_tol=1e-3)
            ):
                raise ValueError("classifier probabilities are not normalized")
        except Exception as error:
            raise VisionUnavailable(
                "classification_failed", "Face classifier returned invalid scores."
            ) from error
        index = int(np.argmax(scores))
        probability = float(scores[index])
        runner_up = float(np.partition(scores, -2)[-2]) if self.class_count > 1 else 0.0
        accepted = (
            probability >= self.threshold and probability - runner_up + 1e-7 >= self.min_margin
        )
        return (self.labels[index] if accepted else None, probability)

    def close(self) -> None:
        self.session = None
