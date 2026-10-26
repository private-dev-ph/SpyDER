"""A portable archive must reopen through actual installed-application services."""

import json
from pathlib import Path
from types import SimpleNamespace

from spyder_cctv.cameras import CameraManager
from spyder_cctv.complete_backup import CompleteBackup
from spyder_cctv.config import CameraConfig, load_app_config, save_config
from spyder_cctv.events import EventService
from spyder_cctv.face_gallery import FaceEnrollmentService
from spyder_cctv.model_library import ModelLibrary
from spyder_cctv.web import create_server
from spyder_cctv.workflow import _validate_graph
from spyder_cctv.workflow_history import ExecutionHistory
from spyder_cctv.workflow_subflows import SubflowCatalog


def test_restored_data_reopens_with_models_nested_calls_events_and_history(tmp_path, monkeypatch):
    monkeypatch.setattr("spyder_cctv.cv.detectors.DetectorCatalog.list", lambda self: [])
    source = tmp_path / "source"
    source.mkdir()
    config = source / "custom-config.json"
    save_config(config, [CameraConfig("front", 0, autostart=True)])
    model_folder = source / "custom-model-location"
    model_folder.mkdir()
    (model_folder / "private-neighbor.txt").write_text("exclude unrelated files")
    weights = model_folder / "external.pt"
    weights.write_bytes(b"weights are copied without deserializing")
    library = ModelLibrary(source / "media")
    registered = library.register(str(weights), engine="yolo")
    library.update_metadata(registered["id"], classes=["person"], name="Portable detector")
    face_detector = tmp_path / "face-detector.onnx"
    face_detector.write_bytes(b"detector weights")
    face_recognizer = tmp_path / "face-recognizer.onnx"
    face_recognizer.write_bytes(b"recognizer weights")
    face_service = FaceEnrollmentService(source / "face-galleries")
    gallery = face_service.create_gallery("Portable people", face_detector, face_recognizer)
    bundle = json.loads(
        (
            Path(__file__).parent.parent / "examples/workflows/three-level-nested-subflows.json"
        ).read_text(encoding="utf-8")
    )
    catalog = SubflowCatalog(
        source / "subflows.json", lambda raw: _validate_graph(raw, allow_bridges=True)
    )
    catalog.import_definitions(bundle["subflows"], graph=bundle["workflow"])
    (source / "workflows.json").write_text(
        json.dumps({"workflows": [bundle["workflow"]]}), encoding="utf-8"
    )
    history = ExecutionHistory(source / "workflow-history.sqlite3")
    assert history.record(
        {
            "id": "original-run",
            "workflow_id": bundle["workflow"]["id"],
            "graph": bundle["workflow"],
            "state": "completed",
        }
    )
    assert history.flush()
    history.close()
    event = EventService(source, SimpleNamespace()).create(
        name="Before backup",
        kind="workflow",
        camera_id="front",
        camera_name="Front",
        message="Preserve me",
    )
    media = source / "media"
    media.mkdir(exist_ok=True)
    (media / "recording-settings.json").write_text(
        json.dumps({"profile": "archive", "segment_minutes": 180})
    )
    (media / "recording-allowance.json").write_text(
        json.dumps({"max_bytes": 1073741824, "action": "stop"})
    )
    (source / "private-unrelated.txt").write_text("never part of an application backup")
    archive = tmp_path / "portable.zip"
    CompleteBackup.create(
        config, archive, browser_data={"version": 1, "local_storage": {"spyder-theme": "dark"}}
    )
    result = CompleteBackup.restore(archive, tmp_path / "restored")
    restored_config = Path(result["config_path"])
    assert not (restored_config.parent / "private-unrelated.txt").exists()
    assert load_app_config(restored_config).cameras[0].autostart is False
    restored_library = ModelLibrary(restored_config.parent / "media")
    assert restored_library.storage_error is None
    model = restored_library.get(registered["id"])
    assert Path(model["path"]).read_bytes() == weights.read_bytes()
    assert Path(model["path"]).is_relative_to(tmp_path / "restored")
    assert model["classes"] == ["person"]
    restored_faces = FaceEnrollmentService(restored_config.parent / "face-galleries")
    assert restored_faces.list_galleries()["galleries"][0]["id"] == gallery["id"]
    face_catalog = json.loads(
        (restored_config.parent / "face-galleries" / gallery["id"] / "catalog.json").read_text()
    )
    assert Path(face_catalog["recognition"]["path"]).read_bytes() == face_recognizer.read_bytes()
    assert Path(face_catalog["recognition"]["path"]).is_relative_to(tmp_path / "restored")
    restored_history = ExecutionHistory(restored_config.parent / "workflow-history.sqlite3")
    try:
        assert restored_history.get("original-run") is not None
    finally:
        restored_history.close()
    assert (
        EventService(restored_config.parent, SimpleNamespace()).list()["events"][0]["id"]
        == event["id"]
    )
    restored_catalog = SubflowCatalog(
        restored_config.parent / "subflows.json",
        lambda raw: _validate_graph(raw, allow_bridges=True),
    )
    assert restored_catalog.storage_error is None
    assert len(restored_catalog.export_definitions()) == 3
    manager = CameraManager(load_app_config(restored_config).cameras, config_path=restored_config)
    server = create_server(manager, 0)
    try:
        assert manager.media_dir == tmp_path / "restored" / "media"
        assert manager.statuses()[0]["state"] == "stopped"
        assert (
            json.loads((manager.media_dir / "recording-settings.json").read_text())["profile"]
            == "archive"
        )
        assert (
            json.loads((manager.media_dir / "recording-allowance.json").read_text())["max_bytes"]
            == 1073741824
        )
    finally:
        server.server_close()
        manager.close()


def test_populated_face_gallery_retains_identity_thumbnail_and_embeddings(tmp_path, monkeypatch):
    from test_face_gallery import _setup

    monkeypatch.setattr("spyder_cctv.cv.detectors.DetectorCatalog.list", lambda self: [])
    source = tmp_path / "app"
    source.mkdir()
    service, gallery, detector, recognition, image = _setup(source, monkeypatch)
    enrolled = service.enroll(gallery["id"], "Ada", image, face_index=1)
    original = service.export_gallery(gallery["id"])
    original_thumbnail = enrolled["identity"].get("thumbnail") or enrolled["sample"]["thumbnail"]
    (source / "galleries").rename(source / "face-galleries")
    save_config(source / "config.json", [])
    archive = tmp_path / "faces.zip"
    CompleteBackup.create(source / "config.json", archive)
    restored = CompleteBackup.restore(archive, tmp_path / "copy")
    faces = FaceEnrollmentService(Path(restored["config_path"]).parent / "face-galleries")
    assert faces.export_gallery(gallery["id"]) == original
    person = faces.list_identities(gallery["id"])["identities"][0]
    assert person["name"] == "Ada"
    assert person["thumbnail"] == original_thumbnail
