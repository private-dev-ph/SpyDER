"""Catalog and explicit installer for supported InsightFace face detectors."""

from __future__ import annotations

import os
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

from spyder_cctv.cv.contracts import default_model_dir

_LICENSE = "InsightFace pretrained models are licensed for non-commercial research only."
_RELEASE = "https://github.com/deepinsight/insightface/releases/download/v0.7"
_MAX_ARCHIVE_BYTES = 600 * 1024 * 1024
_MAX_MODEL_BYTES = 2 * 1024 * 1024 * 1024
_CHUNK_SIZE = 1024 * 1024
_LOCK = threading.Lock()

_DETECTORS: dict[str, dict[str, Any]] = {
    "scrfd-500mf": {
        "name": "SCRFD 500MF (default)",
        "pack": "buffalo_sc",
        "filename": "det_500m.onnx",
        "downloadable": True,
        "hint": f"Smallest bundled SCRFD detector. {_LICENSE}",
    },
    "scrfd-2.5gf": {
        "name": "SCRFD 2.5GF",
        "pack": "buffalo_m",
        "filename": "det_2.5g.onnx",
        "downloadable": True,
        "hint": f"Higher-capacity SCRFD detector. {_LICENSE}",
    },
    "scrfd-10gf": {
        "name": "SCRFD 10GF",
        "pack": "buffalo_l",
        "filename": "det_10g.onnx",
        "downloadable": True,
        "hint": f"Advanced, higher-compute SCRFD detector. {_LICENSE}",
    },
    "retinaface": {
        "name": "RetinaFace (custom model)",
        "pack": None,
        "filename": None,
        "downloadable": False,
        "hint": (
            "Register a licensed RetinaFace ONNX file in Model Library, "
            "then select it as a custom model."
        ),
    },
}


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Permit HTTPS redirects only to GitHub release asset hosts."""

    _HOSTS = {
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
        "github-releases.githubusercontent.com",
    }

    def redirect_request(self, req, fp, code, msg, headers, new_url):
        parsed = urllib.parse.urlsplit(new_url)
        if parsed.scheme != "https" or parsed.hostname not in self._HOSTS:
            raise urllib.error.HTTPError(
                new_url, code, "Untrusted model download redirect", headers, fp
            )
        return super().redirect_request(req, fp, code, msg, headers, new_url)


def _open_download(url: str):
    return urllib.request.build_opener(_SafeRedirectHandler()).open(url, timeout=30)


class DetectorCatalog:
    """Find local detector ONNX files and install allowlisted upstream models."""

    def __init__(self, root: Path | None = None):
        self._include_shared = root is None
        self.root = (
            Path(root).expanduser()
            if root is not None
            else default_model_dir() / "builtin-detectors"
        )

    def _find_local(self, detector_id: str) -> Path | None:
        spec = _DETECTORS[detector_id]
        filename = spec["filename"]
        if filename is None:
            return None
        candidates = (
            self.root / detector_id / filename,
            self.root / filename,
        )
        if self._include_shared:
            candidates += (
                default_model_dir() / spec["pack"] / filename,
                Path.home() / ".insightface" / "models" / spec["pack"] / filename,
            )
        for candidate in candidates:
            if candidate.is_file() and candidate.stat().st_size > 0:
                return candidate.resolve()
        return None

    def list(self) -> list[dict[str, Any]]:
        descriptors = []
        for detector_id, spec in _DETECTORS.items():
            path = self._find_local(detector_id)
            descriptors.append(
                {
                    "id": detector_id,
                    "name": spec["name"],
                    "available": path is not None,
                    "path": str(path) if path else None,
                    "hint": spec["hint"],
                    "downloadable": spec["downloadable"],
                    "license": "non-commercial research only" if spec["downloadable"] else None,
                }
            )
        return descriptors

    def resolve(self, detector_id: str) -> str:
        spec = self._get_spec(detector_id)
        path = self._find_local(detector_id)
        if path is not None:
            return str(path)
        if not spec["downloadable"]:
            raise ValueError(spec["hint"])
        raise ValueError(
            f"Detector '{detector_id}' is not installed. "
            "Install it explicitly from the detector catalog; "
            "InsightFace pretrained models are licensed for non-commercial research only."
        )

    def install(self, detector_id: str) -> dict[str, Any]:
        spec = self._get_spec(detector_id)
        if not spec["downloadable"]:
            raise ValueError(spec["hint"])

        with _LOCK:
            existing = self._find_local(detector_id)
            if existing is not None:
                try:
                    self._validate_model(existing)
                except ValueError:
                    pass
                else:
                    return self._descriptor(detector_id, existing)

            self.root.mkdir(parents=True, exist_ok=True)
            destination = self.root / detector_id / spec["filename"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            archive_url = f"{_RELEASE}/{spec['pack']}.zip"
            archive_path: Path | None = None
            model_path: Path | None = None
            try:
                archive_path = self._download(archive_url)
                model_path = self._extract_expected(
                    archive_path, spec["filename"], destination.parent
                )
                self._validate_model(model_path)

                if destination.is_file():
                    try:
                        self._validate_model(destination)
                    except ValueError:
                        pass
                    else:
                        return self._descriptor(detector_id, destination.resolve())

                os.replace(model_path, destination)
                return self._descriptor(detector_id, destination.resolve())
            finally:
                if archive_path:
                    archive_path.unlink(missing_ok=True)
                if model_path:
                    model_path.unlink(missing_ok=True)

    @staticmethod
    def _get_spec(detector_id: str) -> dict[str, Any]:
        if detector_id not in _DETECTORS:
            raise ValueError(
                f"Unknown detector '{detector_id}'. Choose one of: {', '.join(_DETECTORS)}."
            )
        return _DETECTORS[detector_id]

    def _descriptor(self, detector_id: str, path: Path) -> dict[str, Any]:
        return next(item for item in self.list() if item["id"] == detector_id) | {
            "path": str(path),
            "available": True,
        }

    def _download(self, url: str) -> Path:
        descriptor, name = tempfile.mkstemp(prefix="spyder-detector-", suffix=".zip", dir=self.root)
        path = Path(name)
        total = 0
        try:
            with os.fdopen(descriptor, "wb") as output, _open_download(url) as response:
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > _MAX_ARCHIVE_BYTES:
                    raise ValueError("Model archive exceeds the download size limit.")
                while chunk := response.read(_CHUNK_SIZE):
                    total += len(chunk)
                    if total > _MAX_ARCHIVE_BYTES:
                        raise ValueError("Model archive exceeds the download size limit.")
                    output.write(chunk)
            return path
        except Exception as exc:
            path.unlink(missing_ok=True)
            if isinstance(exc, ValueError):
                raise
            raise ValueError(f"Could not download detector archive: {exc}") from exc

    @staticmethod
    def _extract_expected(archive_path: Path, expected_filename: str, output_dir: Path) -> Path:
        descriptor, name = tempfile.mkstemp(
            prefix=".detector-model-", suffix=".onnx", dir=output_dir
        )
        output_path = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as output, zipfile.ZipFile(archive_path) as archive:
                members = [
                    item
                    for item in archive.infolist()
                    if Path(item.filename).name == expected_filename
                ]
                if len(members) != 1 or members[0].is_dir():
                    raise ValueError(
                        f"Archive must contain exactly one {expected_filename} model file."
                    )
                member = members[0]
                if member.file_size <= 0 or member.file_size > _MAX_MODEL_BYTES:
                    raise ValueError("Model file is empty or exceeds the extraction size limit.")
                extracted = 0
                with archive.open(member) as source:
                    while chunk := source.read(_CHUNK_SIZE):
                        extracted += len(chunk)
                        if extracted > _MAX_MODEL_BYTES:
                            raise ValueError("Model file exceeds the extraction size limit.")
                        output.write(chunk)
                if extracted != member.file_size:
                    raise ValueError("Extracted model size does not match archive metadata.")
            return output_path
        except Exception as exc:
            output_path.unlink(missing_ok=True)
            if isinstance(exc, ValueError):
                raise
            raise ValueError(f"Could not read detector archive: {exc}") from exc

    @staticmethod
    def _validate_model(path: Path) -> None:
        if not path.is_file() or path.stat().st_size <= 0:
            raise ValueError(f"Detector model is empty or missing: {path}")
        try:
            import onnx  # type: ignore[import-not-found]
        except ImportError:
            return
        try:
            model = onnx.load(str(path), load_external_data=False)
            onnx.checker.check_model(model)
        except Exception as exc:
            raise ValueError(f"Detector file is not a valid ONNX model: {exc}") from exc
