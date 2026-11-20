"""Device API integration without hardware, model weights, or LAN traffic."""

import base64
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import cv2
import numpy as np
import pytest

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig
from spyder_cctv.cv.contracts import VisionUnavailable
from spyder_cctv.device_services import DeviceServices, UnavailableFaceGalleries
from spyder_cctv.face_gallery import FaceEnrollmentService
from spyder_cctv.web import create_server
from spyder_cctv.workflow import WorkflowService


class Models:
    def __init__(self, root):
        self.paths = {}
        for name in ("detector", "recognizer"):
            path = root / (name + ".onnx")
            path.write_bytes(name.encode())
            self.paths[name] = str(path)

    def get(self, ident):
        return {
            "id": ident,
            "engine": "insightface",
            "path": self.paths[ident],
            "classes": [],
            "settings": {},
            "metadata": {},
        }


class Network:
    def __init__(self):
        self.pinned = []
        self.closed = []

    def connect(self, endpoint, username, password):
        return {
            "session_id": "session",
            "device": {"name": "Test camera"},
            "profiles": [{"token": "main", "name": "Main", "ptz": True}],
            "ptz": {"pan_tilt": True, "zoom": False, "presets": False},
        }

    def status(self, session):
        if session in self.closed:
            raise RuntimeError("Closed")
        return {"connected": True}

    def get_stream_uri(self, session, profile):
        return "rtsp://192.168.1.12/live"

    def authenticated_stream_uri(self, session, profile):
        return "rtsp://viewer:secret@192.168.1.12/live"

    def pin_session(self, session):
        self.pinned.append(session)

    def close(self, session):
        self.closed.append(session)

    def close_all(self):
        pass


@pytest.fixture
def services(tmp_path):
    captured = []
    manager = CameraManager(
        [],
        config_path=tmp_path / "config.json",
        capture_factory=lambda source: captured.append(source),
    )
    galleries = FaceEnrollmentService(tmp_path / "galleries")
    models = Models(tmp_path)
    workflows = WorkflowService(
        manager,
        SimpleNamespace(),
        tmp_path / "workflows",
        model_library=models,
        face_galleries=galleries,
    )
    service = DeviceServices(manager, models, workflows, galleries, Network())
    yield service, captured
    service.close()
    workflows.close()
    manager.close()


def create_gallery(service):
    return service.post(
        ["api", "faces", "galleries"],
        {
            "name": "Household",
            "detector_model_id": "detector",
            "recognition_model_id": "recognizer",
        },
    )


def test_gallery_virtual_classifier_and_private_metadata(services):
    service, _ = services
    gallery = create_gallery(service)
    gid = gallery["id"]
    assert service.get(["api", "faces", "galleries", gid])["identities"] == []
    public = service.get(["api", "faces", "classifiers"])["models"][0]
    assert public["id"] == "gallery-" + gid
    assert public["metadata"]["model_type"] == "face_gallery"
    assert "path" not in public and "embedding" not in json.dumps(public)
    descriptor = service.workflows._model_descriptor(public["id"])
    assert descriptor["path"] == service.models.paths["recognizer"]
    assert descriptor["identity_gallery"].endswith("gallery-v1.json")
    assert service.galleries.model_references("detector")[0]["gallery_id"] == gid


def test_multiface_retry_uses_exact_original_frame_and_expires(services, monkeypatch):
    service, _ = services
    gid = create_gallery(service)["id"]
    calls = []

    def enroll(gallery_id, name, image, *, face_index=None):
        calls.append((image, face_index))
        if face_index is None:
            return {
                "needs_face_selection": True,
                "candidates": [{"index": 0, "box": [1, 2, 3, 4], "score": 0.9}, {"index": 1}],
            }
        return {"identity_id": "person", "sample_id": "sample"}

    monkeypatch.setattr(service.galleries, "enroll", enroll)
    parts = ["api", "faces", "galleries", gid, "enroll"]
    first = service.post(
        parts, {"identity_name": "Ada", "image_base64": base64.b64encode(b"original").decode()}
    )
    assert first["requires_selection"] is True
    assert first["faces"][0]["bbox"] == [1, 2, 3, 4]
    assert first["faces"][0]["confidence"] == 0.9
    service.post(
        parts,
        {"identity_name": "Ada", "enrollment_token": first["enrollment_token"], "face_index": 1},
    )
    assert calls == [(b"original", None), (b"original", 1)]
    with pytest.raises(ValueError, match="expired"):
        service.post(
            parts,
            {
                "identity_name": "Ada",
                "enrollment_token": first["enrollment_token"],
                "face_index": 1,
            },
        )
    service._enrollment_frames["expired"] = (0, gid, b"discard me")
    service.expire_enrollments()
    assert not service._enrollment_frames


def test_gallery_cannot_delete_when_saved_workflow_references_it(services):
    service, _ = services
    gid = create_gallery(service)["id"]
    service.workflows.save(
        {
            "id": "saved",
            "name": "Faces",
            "enabled": False,
            "camera_ids": [],
            "nodes": [
                {
                    "id": "classifier",
                    "type": "classifier",
                    "x": 0,
                    "y": 0,
                    "params": {"model_id": "gallery-" + gid},
                }
            ],
            "edges": [],
        }
    )
    with pytest.raises(RuntimeError, match="in use"):
        service.post(["api", "faces", "galleries", gid, "remove"], {})


def test_onvif_capture_credentials_stay_in_memory_and_rebind_existing_camera(services):
    service, captured = services
    service.post(
        ["api", "onvif", "connect"], {"endpoint": "http://192.168.1.12/onvif/device_service"}
    )
    result = service.post(
        ["api", "onvif", "add"], {"session_id": "session", "profile_token": "main"}
    )
    worker = service.manager.get_worker(result["camera"]["id"])
    assert worker.config.source == "rtsp://192.168.1.12/live"
    assert "secret" not in service.manager._config_path.read_text()
    assert "secret" not in json.dumps(result)
    worker._capture_factory(worker.config.source)
    assert captured == ["rtsp://viewer:secret@192.168.1.12/live"]
    again = service.post(
        ["api", "onvif", "add"], {"session_id": "session", "profile_token": "main"}
    )
    assert again["camera"]["id"] == worker.config.id
    assert len(service.manager.workers) == 1
    sessions = service.get(["api", "onvif", "sessions"])["sessions"]
    assert sessions[0]["camera_ids"] == [worker.config.id]
    with pytest.raises(RuntimeError, match="Remove cameras"):
        service.post(["api", "onvif", "disconnect"], {"session_id": "session"})
    service.manager.remove(worker.config.id)
    service.camera_removed(worker.config.id)
    assert service.get(["api", "onvif", "sessions"])["sessions"] == []


def test_gallery_workflow_prepares_recognition_and_matches_runtime(services):
    service, _ = services
    gid = create_gallery(service)["id"]
    service.manager.add(CameraConfig("front", 0, pipeline="none"))
    detector = service.models.paths["detector"]
    service.workflows.detector_catalog = SimpleNamespace(resolve=lambda _: detector)
    graph = {
        "id": "gallery-flow",
        "name": "Recognize",
        "enabled": False,
        "camera_ids": ["front"],
        "nodes": [
            {"id": "cam", "type": "camera", "x": 0, "y": 0, "params": {"camera_id": "front"}},
            {
                "id": "identity",
                "type": "classifier",
                "x": 0,
                "y": 1,
                "params": {"model_id": "gallery-" + gid, "threshold": 0.65},
            },
            {
                "id": "detect",
                "type": "detections",
                "x": 1,
                "y": 0,
                "params": {"engine": "insightface", "detector": "scrfd-500mf"},
            },
        ],
        "edges": [
            {"from": "cam", "to": "detect", "input": "camera"},
            {"from": "identity", "to": "detect", "input": "classifier"},
        ],
    }
    graph = service.workflows.save(graph)
    options = service.workflows._prepare_model_bindings(graph)["front"]
    assert options["recognition_model"] == service.models.paths["recognizer"]
    assert options["identity_gallery"] == str(service.galleries.gallery_path(gid))
    assert options["recognition_threshold"] == 0.65
    assert "classifier_model" not in options
    # Even an in-place replacement with preserved timestamps must be rehashed
    # at workflow preparation, without adding hashing to every frame evaluation.
    import os
    from pathlib import Path

    recognizer = Path(service.models.paths["recognizer"])
    original_stat = recognizer.stat()
    recognizer.write_bytes(b"newweights")
    assert recognizer.stat().st_size == original_stat.st_size
    os.utime(recognizer, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    with pytest.raises(VisionUnavailable, match="changed or is unavailable"):
        service.workflows._prepare_model_bindings(graph)


def test_face_api_requires_control_header_and_serves_bundled_assets(tmp_path):
    manager = CameraManager([], config_path=tmp_path / "config.json")
    server = create_server(manager, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = "http://127.0.0.1:" + str(server.server_port)
    try:
        for path in ("/api/faces/galleries", "/api/faces/classifiers", "/api/onvif/sessions"):
            with urlopen(url + path, timeout=4) as response:
                assert response.status == 200
        request = Request(
            url + "/api/onvif/discover", data=b"{}", headers={"Content-Type": "application/json"}
        )
        with pytest.raises(HTTPError) as denied:
            urlopen(request, timeout=4)
        assert denied.value.code == 403
        for path in ("/device-tools.js", "/device-tools.css"):
            with urlopen(url + path, timeout=4) as response:
                assert response.status == 200
    finally:
        server.shutdown()
        server.server_close()
        manager.close()
        thread.join(2)


def test_gallery_cannot_be_used_as_a_detector_and_accepts_cosine_threshold(services):
    service, _ = services
    gid = create_gallery(service)["id"]
    service.manager.add(CameraConfig("front", 0, pipeline="none"))
    raw = {
        "id": "invalid-role",
        "name": "Invalid detector",
        "enabled": False,
        "camera_ids": ["front"],
        "nodes": [
            {
                "id": "model",
                "type": "model",
                "x": 0,
                "y": 0,
                "params": {"model_id": "gallery-" + gid},
            },
            {
                "id": "detect",
                "type": "detections",
                "x": 1,
                "y": 0,
                "params": {"engine": "insightface"},
            },
        ],
        "edges": [{"from": "model", "to": "detect", "input": "model"}],
    }
    graph = service.workflows.save(raw)
    with pytest.raises(ValueError, match="Classifier node"):
        service.workflows._prepare_model_bindings(graph)
    raw["nodes"][0]["type"] = "classifier"
    raw["nodes"][0]["params"]["threshold"] = -0.1
    raw["edges"][0]["input"] = "classifier"
    assert service.workflows.save(raw)["nodes"][0]["params"]["threshold"] == -0.1


def test_device_actions_reject_non_text_ids_without_request_failure(services):
    service, _ = services
    with pytest.raises(ValueError, match="text"):
        service.post(["api", "onvif", "stop"], {"session_id": []})
    gid = create_gallery(service)["id"]
    with pytest.raises(ValueError, match="text"):
        service.post(
            ["api", "faces", "galleries", gid, "enroll"], {"identity_name": "Ada", "camera_id": []}
        )


def test_visual_review_stages_faces_and_enrolls_validated_batch_once(services, monkeypatch):
    service, _ = services
    gid = create_gallery(service)["id"]
    calls = []

    def analyze(gallery_id, image, roi):
        calls.append((gallery_id, image, roi))
        return {
            "preview": "data:image/jpeg;base64,cHJldmlldw==",
            "width": 640,
            "height": 480,
            "_provenance": (
                service.galleries.get_gallery(gallery_id)["detector_model_id"],
                service.galleries.get_gallery(gallery_id)["recognition_model_id"],
                service.galleries.get_gallery(gallery_id)["detector_sha256"],
                service.galleries.get_gallery(gallery_id)["recognition_sha256"],
            ),
            "faces": [
                {
                    "index": 0,
                    "bbox": [0.1, 0.2, 0.3, 0.4],
                    "confidence": 0.9,
                    "thumbnail": "data:image/jpeg;base64,dGh1bWI=",
                    "embedding": [1.0, 0.0],
                },
                {
                    "index": 1,
                    "bbox": [0.5, 0.2, 0.7, 0.4],
                    "confidence": 0.8,
                    "thumbnail": "data:image/jpeg;base64,dGh1bWI=",
                    "embedding": [0.0, 1.0],
                },
            ],
        }

    monkeypatch.setattr(service.galleries, "analyze", analyze)
    writes = []

    fail_save = {"enabled": False}

    def save_batch(gallery_id, name, embeddings, *, thumbnails=None):
        if fail_save["enabled"]:
            raise RuntimeError("mock atomic save failure")
        writes.append((gallery_id, name, embeddings, thumbnails))
        return {"saved": len(embeddings)}

    monkeypatch.setattr(
        service.galleries,
        "enroll_embeddings",
        save_batch,
    )
    path = ["api", "faces", "galleries", gid, "analyze"]
    reviewed = service.post(
        path, {"image_base64": base64.b64encode(b"frame").decode(), "roi": [0.1, 0.2, 0.5, 0.6]}
    )
    assert calls == [(gid, b"frame", [0.1, 0.2, 0.5, 0.6])]
    assert len(reviewed["faces"]) == 2
    assert all("embedding" not in face for face in reviewed["faces"])
    assert writes == []

    refs = [
        {"review_token": reviewed["review_token"], "face_index": 0},
        {"review_token": reviewed["review_token"], "face_index": 1},
    ]
    enroll = ["api", "faces", "galleries", gid, "enroll-reviewed"]
    too_many = [{"review_token": f"unused-{index}", "face_index": 0} for index in range(21)]
    with pytest.raises(ValueError, match="1 and 20"):
        service.post(enroll, {"identity_name": "Ada", "selections": too_many})
    with pytest.raises(ValueError, match="Duplicate"):
        service.post(enroll, {"identity_name": "Ada", "selections": [refs[0], refs[0]]})
    assert writes == []
    other_gid = create_gallery(service)["id"]
    with pytest.raises(ValueError, match="another gallery"):
        service.post(
            ["api", "faces", "galleries", other_gid, "enroll-reviewed"],
            {"identity_name": "Ada", "selections": refs[:1]},
        )
    fail_save["enabled"] = True
    with pytest.raises(RuntimeError, match="atomic save failure"):
        service.post(enroll, {"identity_name": "Ada", "selections": refs})
    fail_save["enabled"] = False
    assert service.post(enroll, {"identity_name": "Ada", "selections": refs}) == {"saved": 2}
    assert writes == [
        (
            gid,
            "Ada",
            [[1.0, 0.0], [0.0, 1.0]],
            ["data:image/jpeg;base64,dGh1bWI=", "data:image/jpeg;base64,dGh1bWI="],
        )
    ]
    with pytest.raises(ValueError, match="expired"):
        service.post(enroll, {"identity_name": "Ada", "selections": refs})

    expiring = service.post(path, {"image_base64": base64.b64encode(b"frame").decode()})
    service._reviews[expiring["review_token"]]["expires"] = time.monotonic() - 1
    with pytest.raises(ValueError, match="expired"):
        service.post(
            enroll,
            {
                "identity_name": "Ada",
                "selections": [{"review_token": expiring["review_token"], "face_index": 0}],
            },
        )
    reviews = [
        service.post(path, {"image_base64": base64.b64encode(b"frame").decode()})["review_token"]
        for _ in range(65)
    ]
    assert len(service._reviews) == 64
    evicted = next(token for token in reviews if token not in service._reviews)
    with pytest.raises(ValueError, match="expired"):
        service.post(
            enroll,
            {
                "identity_name": "Ada",
                "selections": [{"review_token": evicted, "face_index": 0}],
            },
        )


def test_shutdown_succeeds_when_face_gallery_storage_is_unavailable(services):
    service, _ = services
    service.galleries = UnavailableFaceGalleries()
    service.close()


def test_review_token_survives_model_change_and_can_retry(services, monkeypatch):
    service, _ = services
    gallery = create_gallery(service)
    gid = gallery["id"]
    metadata = service.galleries.get_gallery(gid)

    def analyze(gallery_id, image, roi):
        return {
            "preview": "data:image/jpeg;base64,cA==",
            "width": 32,
            "height": 24,
            "_provenance": (
                metadata["detector_model_id"],
                metadata["recognition_model_id"],
                metadata["detector_sha256"],
                metadata["recognition_sha256"],
            ),
            "faces": [{"index": 0, "bbox": [0, 0, 1, 1], "embedding": [1.0, 0.0]}],
        }

    monkeypatch.setattr(service.galleries, "analyze", analyze)
    review = service.post(
        ["api", "faces", "galleries", gid, "analyze"],
        {"image_base64": base64.b64encode(b"image").decode()},
    )
    detector = Path(service.models.paths["detector"])
    original = detector.read_bytes()
    detector.write_bytes(b"changed detector weights")
    enroll = ["api", "faces", "galleries", gid, "enroll-reviewed"]
    selection = [{"review_token": review["review_token"], "face_index": 0}]
    with pytest.raises(VisionUnavailable, match="changed or is unavailable"):
        service.post(enroll, {"identity_name": "Ada", "selections": selection})
    assert review["review_token"] in service._reviews
    detector.write_bytes(original)
    result = service.post(enroll, {"identity_name": "Ada", "selections": selection})
    assert result["identity"]["sample_count"] == 1
    assert review["review_token"] not in service._reviews


def test_empty_face_review_is_successful(services, monkeypatch):
    service, _ = services
    gid = create_gallery(service)["id"]
    metadata = service.galleries.get_gallery(gid)
    monkeypatch.setattr(
        service.galleries,
        "analyze",
        lambda *_args: {
            "preview": "data:image/jpeg;base64,cA==",
            "width": 4,
            "height": 3,
            "_provenance": (
                metadata["detector_model_id"],
                metadata["recognition_model_id"],
                metadata["detector_sha256"],
                metadata["recognition_sha256"],
            ),
            "faces": [],
        },
    )
    result = service.post(
        ["api", "faces", "galleries", gid, "analyze"],
        {"image_base64": base64.b64encode(b"image").decode()},
    )
    assert result["faces"] == []
    assert result["review_token"] in service._reviews


def test_running_camera_enrollment_waits_for_first_raw_preview_frame(services, monkeypatch):
    service, _ = services
    gid = create_gallery(service)["id"]
    captures = []

    class LiveCapture:
        def __init__(self, source):
            captures.append(self)

        def read(self):
            return True, np.full((32, 48, 3), (0, 200, 0), dtype=np.uint8)

        def close(self):
            pass

    service.manager._worker_options["capture_factory"] = LiveCapture
    service.manager.add(CameraConfig("front", 0, fps=30, pipeline="none"))
    worker = service.manager.get_worker("front")
    worker.start()
    deadline = time.monotonic() + 2
    while worker.jpeg() is None and time.monotonic() < deadline:
        time.sleep(0.005)
    assert worker.status()["state"] == "running"
    assert worker.jpeg() is not None
    calls = []

    def enroll(gallery_id, identity_name, image_bytes, *, face_index=None):
        decoded = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
        assert decoded is not None
        assert abs(float(decoded[:, :, 1].mean()) - 200) < 3
        calls.append(gallery_id)
        return {"identity_id": "enrolled"}

    monkeypatch.setattr(service.galleries, "enroll", enroll)
    parts = ["api", "faces", "galleries", gid, "enroll"]
    result = service.post(parts, {"identity_name": "Ada", "camera_id": "front"})
    assert result["identity_id"] == "enrolled"
    assert calls == [gid]
    assert len(captures) == 1
    # A later enrollment must warm an expired preview lease as well.
    with worker._lock:
        worker._raw_preview_requested_until = 0
        worker._preview_raw = None
    result = service.post(parts, {"identity_name": "Ada", "camera_id": "front"})
    assert result["identity_id"] == "enrolled"
    assert len(captures) == 1
    worker.stop()
    with pytest.raises(ValueError, match="Start the selected camera"):
        service.post(parts, {"identity_name": "Ada", "camera_id": "front"})
    assert len(captures) == 1
    assert calls == [gid, gid]


@pytest.mark.parametrize(
    "failure", [ValueError("Invalid face index"), RuntimeError("Enrollment is busy")]
)
def test_face_selection_can_retry_after_validation_or_busy_failure(services, monkeypatch, failure):
    service, _ = services
    gid = create_gallery(service)["id"]
    count = 0

    def enroll(gallery_id, name, image, *, face_index=None):
        nonlocal count
        count += 1
        if count == 1:
            return {"needs_face_selection": True, "candidates": [{"index": 0}]}
        if count == 2:
            raise failure
        assert image == b"original"
        return {"identity_id": "saved"}

    monkeypatch.setattr(service.galleries, "enroll", enroll)
    parts = ["api", "faces", "galleries", gid, "enroll"]
    first = service.post(
        parts, {"identity_name": "Ada", "image_base64": base64.b64encode(b"original").decode()}
    )
    retry = {"identity_name": "Ada", "enrollment_token": first["enrollment_token"], "face_index": 0}
    with pytest.raises(type(failure), match=str(failure)):
        service.post(parts, retry)
    assert service.post(parts, retry)["identity_id"] == "saved"


def test_wrong_gallery_does_not_consume_another_gallery_face_selection(services, monkeypatch):
    service, _ = services
    gid = create_gallery(service)["id"]
    other_gid = create_gallery(service)["id"]

    def enroll(gallery_id, name, image, *, face_index=None):
        if face_index is None:
            return {"needs_face_selection": True, "candidates": [{"index": 0}]}
        return {"identity_id": "saved"}

    monkeypatch.setattr(service.galleries, "enroll", enroll)
    parts = ["api", "faces", "galleries", gid, "enroll"]
    first = service.post(
        parts, {"identity_name": "Ada", "image_base64": base64.b64encode(b"original").decode()}
    )
    retry = {"identity_name": "Ada", "enrollment_token": first["enrollment_token"], "face_index": 0}
    with pytest.raises(ValueError, match="selection"):
        service.post(["api", "faces", "galleries", other_gid, "enroll"], retry)
    assert service.post(parts, retry)["identity_id"] == "saved"


def test_face_selection_has_one_concurrent_owner(services, monkeypatch):
    service, _ = services
    gid = create_gallery(service)["id"]
    entered, release = threading.Event(), threading.Event()
    writes = []

    def enroll(gallery_id, name, image, *, face_index=None):
        if face_index is None:
            return {"needs_face_selection": True, "candidates": [{"index": 0}]}
        entered.set()
        assert release.wait(2)
        writes.append(name)
        return {"identity_id": "saved"}

    monkeypatch.setattr(service.galleries, "enroll", enroll)
    parts = ["api", "faces", "galleries", gid, "enroll"]
    first = service.post(
        parts, {"identity_name": "Ada", "image_base64": base64.b64encode(b"original").decode()}
    )
    retry = {"identity_name": "Ada", "enrollment_token": first["enrollment_token"], "face_index": 0}
    results = []
    owner = threading.Thread(target=lambda: results.append(service.post(parts, retry)))
    owner.start()
    try:
        assert entered.wait(1)
        with pytest.raises(RuntimeError, match="already being processed"):
            service.post(parts, retry)
    finally:
        release.set()
        owner.join(2)
    assert not owner.is_alive()
    assert results == [{"identity_id": "saved"}]
    assert writes == ["Ada"]
    with pytest.raises(ValueError, match="selection"):
        service.post(parts, retry)


def test_first_camera_enrollment_over_http_uses_shared_capture(tmp_path, monkeypatch):
    import spyder_cctv.web as web

    captures = []

    class LiveCapture:
        def __init__(self, source):
            captures.append(self)

        def read(self):
            return True, np.full((32, 48, 3), (0, 200, 0), dtype=np.uint8)

        def close(self):
            pass

    monkeypatch.setattr(web, "ModelLibrary", lambda _: Models(tmp_path))
    received = []

    def enroll(self, gallery_id, name, image, *, face_index=None):
        decoded = cv2.imdecode(np.frombuffer(image, dtype=np.uint8), cv2.IMREAD_COLOR)
        assert decoded is not None and decoded.shape == (32, 48, 3)
        received.append(name)
        return {"identity_id": "saved"}

    monkeypatch.setattr(FaceEnrollmentService, "enroll", enroll)
    manager = CameraManager(
        [CameraConfig("front", 0, fps=30, pipeline="none")],
        config_path=tmp_path / "config.json",
        capture_factory=LiveCapture,
    )
    server = create_server(manager, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = "http://127.0.0.1:" + str(server.server_port)

    def post(path, data):
        request = Request(
            url + path,
            data=json.dumps(data).encode(),
            headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
        )
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    try:
        manager.get_worker("front").start()
        deadline = time.monotonic() + 2
        while manager.get_worker("front").jpeg() is None and time.monotonic() < deadline:
            time.sleep(0.005)
        gallery = post(
            "/api/faces/galleries",
            {
                "name": "Fixture",
                "detector_model_id": "detector",
                "recognition_model_id": "recognizer",
            },
        )
        result = post(
            "/api/faces/galleries/" + gallery["id"] + "/enroll",
            {"identity_name": "Ada", "camera_id": "front"},
        )
        assert result == {"identity_id": "saved"}
        assert received == ["Ada"]
        assert len(captures) == 1
    finally:
        server.shutdown()
        server.server_close()
        manager.close()
        thread.join(2)


def test_reviewed_face_api_over_http_stages_then_enrolls(tmp_path, monkeypatch):
    import spyder_cctv.web as web

    monkeypatch.setattr(web, "ModelLibrary", lambda _: Models(tmp_path))
    staged = []
    saved = []

    def analyze(self, gallery_id, image, roi=None):
        staged.append((gallery_id, image, roi))
        return {
            "preview": "data:image/jpeg;base64,cA==",
            "width": 32,
            "height": 24,
            "_provenance": (
                self.get_gallery(gallery_id)["detector_model_id"],
                self.get_gallery(gallery_id)["recognition_model_id"],
                self.get_gallery(gallery_id)["detector_sha256"],
                self.get_gallery(gallery_id)["recognition_sha256"],
            ),
            "faces": [
                {
                    "index": 0,
                    "bbox": [0.1, 0.2, 0.8, 0.9],
                    "confidence": 0.9,
                    "thumbnail": "data:image/jpeg;base64,dA==",
                    "embedding": [1.0, 0.0],
                }
            ],
        }

    monkeypatch.setattr(FaceEnrollmentService, "analyze", analyze)
    monkeypatch.setattr(
        FaceEnrollmentService,
        "enroll_embeddings",
        lambda self, gid, name, vectors, *, thumbnails=None: (
            saved.append((gid, name, vectors, thumbnails)) or {"saved": True}
        ),
    )
    manager = CameraManager([], config_path=tmp_path / "http-config.json")
    server = create_server(manager, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = "http://127.0.0.1:" + str(server.server_port)

    def post(path, data):
        request = Request(
            url + path,
            data=json.dumps(data).encode(),
            headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
        )
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    try:
        gallery = post(
            "/api/faces/galleries",
            {
                "name": "Fixture",
                "detector_model_id": "detector",
                "recognition_model_id": "recognizer",
            },
        )
        path = "/api/faces/galleries/" + gallery["id"]
        review = post(
            path + "/analyze",
            {"image_base64": base64.b64encode(b"image").decode(), "roi": [0.1, 0.2, 0.5, 0.6]},
        )
        assert review["faces"] == [
            {
                "index": 0,
                "bbox": [0.1, 0.2, 0.8, 0.9],
                "confidence": 0.9,
                "thumbnail": "data:image/jpeg;base64,dA==",
            }
        ]
        assert staged == [(gallery["id"], b"image", [0.1, 0.2, 0.5, 0.6])]
        assert saved == []
        result = post(
            path + "/enroll-reviewed",
            {
                "identity_name": "Ada",
                "selections": [{"review_token": review["review_token"], "face_index": 0}],
            },
        )
        assert result == {"saved": True}
        assert saved == [(gallery["id"], "Ada", [[1.0, 0.0]], ["data:image/jpeg;base64,dA=="])]
    finally:
        server.shutdown()
        server.server_close()
        manager.close()
        thread.join(2)
