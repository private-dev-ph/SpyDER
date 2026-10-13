"""Inspect installed packages without importing ML libraries or opening cameras."""

from importlib.metadata import PackageNotFoundError, version
from typing import Any

from spyder_cctv.cv.contracts import default_model_dir


def engine_info() -> dict[str, Any]:
    engines = {}
    for name, packages in {
        "opencv": ["opencv-python"],
        "yolo": ["ultralytics", "torch", "opencv-python"],
        "insightface": ["insightface", "onnxruntime", "opencv-python"],
    }.items():
        installed = {}
        for package in packages:
            try:
                installed[package] = version(package)
            except PackageNotFoundError:
                installed[package] = None
        engines[name] = {"packages": installed, "dependencies_present": all(installed.values())}
    return {"model_directory": str(default_model_dir()), "engines": engines}
