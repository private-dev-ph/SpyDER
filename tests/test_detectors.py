from __future__ import annotations

import io
import zipfile

import pytest

from spyder_cctv.cv import detectors
from spyder_cctv.cv.detectors import DetectorCatalog


def test_catalog_lists_scrfd_choices_and_custom_retinaface(tmp_path):
    catalog = DetectorCatalog(tmp_path)

    entries = catalog.list()

    assert [item["id"] for item in entries] == [
        "scrfd-500mf",
        "scrfd-2.5gf",
        "scrfd-10gf",
        "retinaface",
    ]
    assert entries[0]["available"] is False
    assert entries[0]["downloadable"] is True
    assert "non-commercial research" in entries[0]["license"]
    assert entries[-1]["downloadable"] is False
    assert "licensed RetinaFace ONNX" in entries[-1]["hint"]


def test_resolve_local_model_and_clear_install_guidance(tmp_path):
    catalog = DetectorCatalog(tmp_path)
    path = tmp_path / "scrfd-500mf" / "det_500m.onnx"
    path.parent.mkdir()
    path.write_bytes(b"local model")

    assert catalog.resolve("scrfd-500mf") == str(path.resolve())
    with pytest.raises(ValueError, match="Install it explicitly"):
        catalog.resolve("scrfd-2.5gf")
    with pytest.raises(ValueError, match="licensed RetinaFace ONNX"):
        catalog.resolve("retinaface")
    with pytest.raises(ValueError, match="Unknown detector"):
        catalog.resolve("other")


def _archive_response(entries: dict[str, bytes]):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    response = io.BytesIO(data.getvalue())
    response.headers = {"Content-Length": str(len(data.getvalue()))}
    response.__enter__ = lambda: response
    response.__exit__ = lambda *args: None
    return response


def test_install_uses_allowlisted_upstream_and_extracts_only_expected_model(tmp_path, monkeypatch):
    catalog = DetectorCatalog(tmp_path)
    archive_response = _archive_response(
        {
            "../../outside.txt": b"must not extract",
            "buffalo_sc/det_500m.onnx": b"valid mocked model",
        }
    )
    urls = []
    monkeypatch.setattr(
        detectors, "_open_download", lambda url: (urls.append(url), archive_response)[1]
    )
    monkeypatch.setattr(catalog, "_validate_model", lambda path: None)

    result = catalog.install("scrfd-500mf")

    assert urls == [
        "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_sc.zip"
    ]
    assert result["available"] is True
    assert result["path"] == str((tmp_path / "scrfd-500mf" / "det_500m.onnx").resolve())
    assert (tmp_path / "scrfd-500mf" / "det_500m.onnx").read_bytes() == b"valid mocked model"
    assert not (tmp_path.parent / "outside.txt").exists()
    assert catalog.resolve("scrfd-500mf") == result["path"]


def test_install_preserves_existing_valid_model_without_downloading(tmp_path, monkeypatch):
    catalog = DetectorCatalog(tmp_path)
    path = tmp_path / "scrfd-500mf" / "det_500m.onnx"
    path.parent.mkdir()
    path.write_bytes(b"existing")
    monkeypatch.setattr(catalog, "_validate_model", lambda model_path: None)
    monkeypatch.setattr(
        detectors, "_open_download", lambda _url: pytest.fail("unexpected download")
    )

    result = catalog.install("scrfd-500mf")

    assert result["path"] == str(path.resolve())
    assert path.read_bytes() == b"existing"


def test_install_reports_missing_archive_model_and_rejects_retinaface(tmp_path, monkeypatch):
    catalog = DetectorCatalog(tmp_path)
    monkeypatch.setattr(
        detectors, "_open_download", lambda _url: _archive_response({"else.onnx": b"x"})
    )

    with pytest.raises(ValueError, match="exactly one det_500m.onnx"):
        catalog.install("scrfd-500mf")
    with pytest.raises(ValueError, match="licensed RetinaFace ONNX"):
        catalog.install("retinaface")
