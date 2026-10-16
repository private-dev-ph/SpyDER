import http.client
import json
import socket
import sys
import threading
import time
from dataclasses import replace
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import cv2
import numpy as np
import pytest

import spyder_cctv.web as web_module
from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig
from spyder_cctv.cv.contracts import VisionConfig
from spyder_cctv.web import create_server


def test_model_label_source_selection_is_persisted_and_validated(server, tmp_path, monkeypatch):
    url, _ = server
    source = tmp_path / "ambiguous.onnx"
    source.write_bytes(b"fixture")
    props = {"names": '["First"]', "classes": '["Second"]'}
    monkeypatch.setitem(
        sys.modules,
        "onnx",
        SimpleNamespace(
            load=lambda *_args, **_kwargs: SimpleNamespace(
                metadata_props=[SimpleNamespace(key=k, value=v) for k, v in props.items()]
            )
        ),
    )

    def post(path, data):
        return urlopen(
            Request(
                url + path,
                method="POST",
                data=json.dumps(data).encode(),
                headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
            ),
            timeout=4,
        )

    with post("/api/models/register", {"path": str(source), "engine": "insightface"}) as response:
        descriptor = json.load(response)
    assert descriptor["classes"] == []
    path = f"/api/models/{descriptor['id']}/inspect"
    with post(path, {"label_source": "/classes"}) as response:
        selected = json.load(response)
    assert selected["classes"] == ["Second"]
    assert selected["metadata"]["resolution"] == "selected"
    with post(path, {}) as response:
        assert json.load(response)["classes"] == ["Second"]
    for value in ("/missing", 42, [], ""):
        with pytest.raises(HTTPError) as error:
            post(path, {"label_source": value})
        assert error.value.code == 400
    with post(path, {"label_source": None}) as response:
        assert json.load(response)["metadata"]["resolution"] == "ambiguous"


@pytest.fixture
def server(tmp_path):
    class SyntheticCapture:
        def __init__(self, source):
            pass

        def read(self):
            return True, np.zeros((32, 32, 3), dtype=np.uint8)

        def close(self):
            pass

    manager = CameraManager(
        [CameraConfig("front", 0)],
        config_path=tmp_path / "config.json",
        capture_factory=SyntheticCapture,
    )
    server = create_server(manager, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}", manager
    server.shutdown()
    server.server_close()
    manager.close()
    thread.join(2)
    assert not thread.is_alive()


def test_live_server_exclusively_owns_its_port(server):
    url, _ = server
    address = urlsplit(url)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as duplicate:
        duplicate.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        with pytest.raises(OSError):
            duplicate.bind((address.hostname, address.port))
    with urlopen(url + "/", timeout=2) as response:
        assert response.status == 200


def test_duplicate_server_start_keeps_original_healthy(server, tmp_path):
    url, _ = server
    manager = CameraManager([], config_path=tmp_path / "duplicate" / "config.json")
    duplicate = None
    try:
        with pytest.raises(OSError):
            duplicate = create_server(manager, urlsplit(url).port)
        with urlopen(url + "/", timeout=2) as response:
            assert response.status == 200
    finally:
        if duplicate is not None:
            duplicate.server_close()
        manager.close()


def test_dashboard_assets_and_status(server):
    url, _ = server
    for path, content_type in [
        ("/", "text/html"),
        ("/dashboard.js", "text/javascript"),
        ("/dashboard.css", "text/css"),
        ("/activity.js", "text/javascript"),
        ("/icons.svg", "image/svg+xml"),
        ("/spyder-emblem.png", "image/png"),
        ("/workspaces.js", "text/javascript"),
        ("/workspaces.css", "text/css"),
        ("/layouts.js", "text/javascript"),
        ("/layouts.css", "text/css"),
        ("/fullscreen.js", "text/javascript"),
        ("/fullscreen.css", "text/css"),
        ("/vision-lab.js", "text/javascript"),
        ("/vision-lab.css", "text/css"),
        ("/workflow-editor.js", "text/javascript"),
        ("/workflow-editor.css", "text/css"),
    ]:
        with urlopen(url + path, timeout=2) as response:
            assert response.status == 200
            assert content_type in response.headers["Content-Type"]
            assert len(response.read()) > 0
    with urlopen(url + "/api/cameras", timeout=2) as response:
        assert json.load(response)[0]["state"] == "stopped"
    with pytest.raises(HTTPError) as error:
        urlopen(url + "/api/cameras/front/frame", timeout=2)
    assert error.value.code == 503


def test_control_and_origin_protection(server):
    url, _ = server
    path = url + "/api/cameras/front/stop"
    with pytest.raises(HTTPError) as error:
        urlopen(Request(path, method="POST"), timeout=2)
    assert error.value.code == 403
    for headers in [{"Host": "evil.example"}, {"Origin": "https://evil.example"}]:
        request = Request(path, method="POST", headers=headers | {"X-Spyder-Control": "1"})
        with pytest.raises(HTTPError) as error:
            urlopen(request, timeout=2)
        assert error.value.code == 403
    with urlopen(
        Request(path, method="POST", headers={"X-Spyder-Control": "1"}), timeout=2
    ) as response:
        assert json.load(response)["state"] == "stopped"


def test_start_frame_stop_routes(server):
    url, manager = server
    with urlopen(
        Request(url + "/api/cameras/front/start", method="POST", headers={"X-Spyder-Control": "1"}),
        timeout=2,
    ) as response:
        assert response.status == 200
    deadline = time.monotonic() + 2
    while manager.workers["front"].jpeg() is None and time.monotonic() < deadline:
        time.sleep(0.005)
    with urlopen(url + "/api/cameras/front/frame", timeout=2) as response:
        assert response.headers["Content-Type"] == "image/jpeg"
        assert response.read().startswith(b"\xff\xd8")
    deadline = time.monotonic() + 2
    raw_frame = None
    while raw_frame is None and time.monotonic() < deadline:
        try:
            with urlopen(url + "/api/cameras/front/preview-frame", timeout=2) as response:
                raw_frame = response.read()
        except HTTPError as error:
            assert error.code == 503
            time.sleep(0.01)
    assert raw_frame and raw_frame.startswith(b"\xff\xd8")
    with urlopen(
        Request(url + "/api/cameras/front/stop", method="POST", headers={"X-Spyder-Control": "1"}),
        timeout=2,
    ) as response:
        assert json.load(response)["state"] == "stopped"


def test_add_remove_camera_routes(server):
    url, manager = server
    request = Request(
        url + "/api/cameras",
        method="POST",
        headers={"X-Spyder-Control": "1", "Content-Type": "application/json"},
        data=json.dumps({"name": "Back door", "source": 1, "autostart": True}).encode(),
    )
    with urlopen(request, timeout=2) as response:
        assert response.status == 201
        camera = json.load(response)
        assert camera["name"] == "Back door"
    with pytest.raises(HTTPError) as error:
        urlopen(request, timeout=2)
    assert error.value.code == 409
    with urlopen(
        Request(
            url + "/api/cameras/" + camera["id"] + "/remove",
            method="POST",
            headers={"X-Spyder-Control": "1"},
        ),
        timeout=2,
    ) as response:
        assert response.status == 200
    assert len(manager.statuses()) == 1


def test_capture_download_does_not_depend_on_host_mime_registry(server, monkeypatch):
    import mimetypes

    def forbidden_lookup(*_args, **_kwargs):
        pytest.fail("Known local media must not consult the host MIME registry")

    monkeypatch.setattr(mimetypes, "guess_type", forbidden_lookup)
    url, manager = server
    manager.workers["front"].start()
    deadline = time.monotonic() + 3
    while manager.workers["front"].jpeg() is None and time.monotonic() < deadline:
        time.sleep(0.005)
    with urlopen(
        Request(
            url + "/api/captures",
            method="POST",
            data=b'{"camera_ids":["front"]}',
            headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
        ),
        timeout=4,
    ) as response:
        capture = json.load(response)
    with urlopen(url + capture["url"], timeout=2) as response:
        assert response.headers["Content-Type"] == "image/jpeg"
        assert response.read().startswith(b"\xff\xd8")


def test_record_capture_and_download_routes(server, tmp_path):
    url, manager = server

    def post(path, data):
        with urlopen(
            Request(
                url + path,
                method="POST",
                data=json.dumps(data).encode(),
                headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
            ),
            timeout=8,
        ) as response:
            return json.load(response)

    result = post("/api/recordings/start", {"camera_ids": ["front"]})
    assert result["state"] == "recording"
    assert manager.statuses()[0]["recording"] is True
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        with urlopen(url + "/api/recordings", timeout=2) as response:
            if json.load(response)["frames"] >= 2:
                break
        time.sleep(0.01)
    else:
        pytest.fail("Recorder did not write frames")
    with pytest.raises(HTTPError) as error:
        post("/api/cameras/front/stop", {})
    assert error.value.code == 409
    capture = post("/api/captures", {"camera_ids": ["front"]})
    assert capture["kind"] == "capture"
    with urlopen(url + capture["url"], timeout=2) as response:
        assert "attachment" in response.headers["Content-Disposition"]
        assert cv2.imdecode(np.frombuffer(response.read(), np.uint8), cv2.IMREAD_COLOR).shape[
            :2
        ] == (32, 32)
    result = post("/api/recordings/stop", {})
    assert result["state"] == "idle"
    assert manager.statuses()[0]["recording"] is False
    video = next(item for item in result["items"] if item["kind"] == "recording")
    with urlopen(url + f"/api/media/{video['id']}/info", timeout=4) as response:
        info = json.load(response)
    assert info["duration_seconds"] > 0
    assert info["fps"] > 0 and info["frame_count"] > 0
    with urlopen(url + f"/api/media/{video['id']}/frame?time=0", timeout=4) as response:
        assert response.headers["Content-Type"] == "image/jpeg"
        preview = cv2.imdecode(np.frombuffer(response.read(), np.uint8), cv2.IMREAD_COLOR)
        assert preview.shape[1] <= 960
    with pytest.raises(HTTPError) as error:
        urlopen(url + f"/api/media/{video['id']}/frame?time=999999", timeout=4)
    assert error.value.code == 400
    with pytest.raises(HTTPError) as error:
        urlopen(url + "/api/media/not-an-id/info", timeout=4)
    assert error.value.code == 404
    with urlopen(
        Request(url + f"/api/media/{video['id']}", headers={"Range": "bytes=0-15"}), timeout=4
    ) as response:
        assert response.status == 206
        assert response.headers["Content-Range"].startswith("bytes 0-15/")
        assert len(response.read()) == 16
    huge_range = "bytes=" + "9" * 5000 + "-"
    with pytest.raises(HTTPError) as error:
        urlopen(
            Request(url + f"/api/media/{video['id']}", headers={"Range": huge_range}), timeout=4
        )
    assert error.value.code == 416
    with urlopen(url + "/api/events", timeout=4) as response:
        events = json.load(response)
    assert events["events"] == [] and events["retention_limit"] >= 10000
    with pytest.raises(HTTPError) as error:
        urlopen(url + "/api/events/download?ids=invalid", timeout=4)
    assert error.value.code == 400
    with urlopen(url + video["url"], timeout=2) as response:
        video_path = tmp_path / video["filename"]
        video_path.write_bytes(response.read())
    reader = cv2.VideoCapture(str(video_path))
    try:
        ok, frame = reader.read()
        assert ok and frame.shape[:2] == (1080, 1920)
    finally:
        reader.release()


@pytest.mark.parametrize(
    "path,data,code",
    [
        ("/api/recordings/start", {"camera_ids": []}, 400),
        ("/api/recordings/start", {"camera_ids": ["missing"]}, 404),
        ("/api/recordings/start", {"camera_ids": "front"}, 400),
        ("/api/captures", {"camera_ids": ["front"]}, 409),
        ("/api/recordings/stop", {"extra": True}, 400),
    ],
)
def test_media_invalid_requests(server, path, data, code):
    url, _ = server
    with pytest.raises(HTTPError) as error:
        urlopen(
            Request(
                url + path,
                method="POST",
                data=json.dumps(data).encode(),
                headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
            ),
            timeout=3,
        )
    assert error.value.code == code


def test_media_rejects_arbitrary_paths_and_cross_origin(server):
    url, _ = server
    for path in ["/api/media/../../config.json", "/api/media/manifest.json", "/api/media/unknown"]:
        with pytest.raises(HTTPError) as error:
            urlopen(url + path, timeout=2)
        assert error.value.code == 404
    with pytest.raises(HTTPError) as error:
        urlopen(
            Request(url + "/api/recordings", headers={"Origin": "https://evil.example"}), timeout=2
        )
    assert error.value.code == 403
    with urlopen(url + "/api/system", timeout=2) as response:
        assert json.load(response)["free_bytes"] > 0


def test_storage_preference_is_guarded_deferred_and_keeps_application_data(server, tmp_path):
    url, manager = server
    before = manager.media_dir
    data_root = manager.app_data_dir
    target = tmp_path / "new-video-output"

    def save(value, guarded=True):
        return urlopen(
            Request(
                url + "/api/system/storage",
                method="POST",
                data=json.dumps({"media_directory": value}).encode(),
                headers={
                    "Content-Type": "application/json",
                    **({"X-Spyder-Control": "1"} if guarded else {}),
                },
            ),
            timeout=4,
        )

    with pytest.raises(HTTPError) as error:
        save(str(target), guarded=False)
    assert error.value.code == 403
    with pytest.raises(HTTPError) as error:
        save("relative/folder")
    assert error.value.code == 400
    with save(str(target)) as response:
        result = json.load(response)
    assert result["restart_required"]
    assert manager.media_dir == before
    assert manager.app_data_dir == data_root
    with urlopen(url + "/api/system", timeout=4) as response:
        result = json.load(response)
    assert result["configured_media_directory"] == str(target)
    assert result["media_directory"] == str(before)
    assert result["camera_count"] == 1
    assert "opencv" in result["engines"]
    assert result["event_retention_limit"] == 10000


def test_model_and_workflow_routes(server):
    url, manager = server

    def post(path, data, headers=None):
        return urlopen(
            Request(
                url + path,
                method="POST",
                data=json.dumps(data).encode(),
                headers=headers or {"Content-Type": "application/json", "X-Spyder-Control": "1"},
            ),
            timeout=4,
        )

    with urlopen(url + "/api/cameras/front/vision", timeout=3) as response:
        assert json.load(response)["settings"] is None
    with post("/api/cameras/front/vision", {"settings": {"engine": "opencv"}}) as response:
        assert response.status == 202 and json.load(response)["settings"]["engine"] == "opencv"
    assert manager.get_worker("front").config.vision.engine == "opencv"
    graph = {
        "id": "test-rule",
        "name": "Face event",
        "enabled": False,
        "camera_ids": ["front"],
        "nodes": [
            {"id": "source", "type": "detections", "x": 0, "y": 0, "params": {}},
            {
                "id": "event",
                "type": "event",
                "x": 200,
                "y": 0,
                "params": {"message": "Face detected"},
            },
        ],
        "edges": [{"from": "source", "to": "event"}],
    }
    with post("/api/workflows", {"workflow": graph}) as response:
        assert json.load(response)["id"] == "test-rule"
    with urlopen(url + "/api/workflows", timeout=3) as response:
        data = json.load(response)
        assert {item["type"] for item in data["catalog"]} == {
            "camera",
            "model",
            "classifier",
            "detections",
            "filter",
            "zone",
            "count",
            "cooldown",
            "event",
            "notification",
            "capture",
            "record",
            "code",
            "preview",
        }
        assert data["workflows"][0]["enabled"] is False
    with pytest.raises(HTTPError) as error:
        post("/api/workflows", {"workflow": graph}, {"Content-Type": "application/json"})
    assert error.value.code == 403
    graph["edges"].append({"from": "event", "to": "source"})
    with pytest.raises(HTTPError) as error:
        post("/api/workflows", {"workflow": graph})
    assert error.value.code == 400
    with post("/api/workflows/test-rule/remove", {}) as response:
        assert response.status == 200


def test_workflow_preview_route_is_guarded_and_does_not_activate_draft(server):
    url, manager = server
    graph = {
        "id": "draft",
        "name": "Draft preview",
        "enabled": False,
        "camera_ids": ["front"],
        "nodes": [
            {"id": "source", "type": "detections", "x": 0, "y": 0, "params": {}},
            {"id": "preview", "type": "preview", "x": 100, "y": 0, "params": {}},
        ],
        "edges": [{"from": "source", "to": "preview"}],
    }

    def post(body, guarded=True):
        return urlopen(
            Request(
                url + "/api/workflows/preview",
                method="POST",
                data=json.dumps(body).encode(),
                headers={
                    "Content-Type": "application/json",
                    **({"X-Spyder-Control": "1"} if guarded else {}),
                },
            ),
            timeout=4,
        )

    with pytest.raises(HTTPError) as error:
        post({"workflow": graph, "node_id": "preview"}, guarded=False)
    assert error.value.code == 403
    with post({"workflow": graph, "node_id": "preview"}) as response:
        snapshot = json.load(response)
    assert snapshot["camera_id"] == "front"
    assert snapshot["state"] == "stopped"
    assert snapshot["detections"] == []
    assert manager.get_worker("front").config.vision is None
    with urlopen(url + "/api/workflows", timeout=2) as response:
        assert json.load(response)["workflows"] == []


def test_workflow_activation_preview_and_explicit_motion_consent(server):
    url, manager = server
    worker = manager.get_worker("front")
    worker.config = replace(
        worker.config,
        pipeline="vision",
        vision=VisionConfig(engine="insightface", model="face.onnx"),
        analysis={"enabled": True},
    )
    graph = {
        "id": "activation",
        "name": "Face alert",
        "enabled": True,
        "camera_ids": ["front"],
        "nodes": [
            {
                "id": "detect",
                "type": "detections",
                "x": 0,
                "y": 0,
                "params": {"engine": "insightface"},
            },
            {"id": "notify", "type": "notification", "x": 200, "y": 0, "params": {}},
        ],
        "edges": [{"from": "detect", "to": "notify"}],
    }

    def post(path, body, guarded=True):
        return urlopen(
            Request(
                url + path,
                method="POST",
                data=json.dumps(body).encode(),
                headers={
                    "Content-Type": "application/json",
                    **({"X-Spyder-Control": "1"} if guarded else {}),
                },
            ),
            timeout=4,
        )

    with post("/api/workflows/activation-preview", {"workflow": graph}) as response:
        preview = json.load(response)
    assert preview["requires_motion_confirmation"] is True
    assert preview["cameras"][0]["disable_motion"] is True
    assert worker.config.analysis.enabled is True
    with urlopen(url + "/api/workflows", timeout=3) as response:
        assert json.load(response)["workflows"] == []
    for body in ({"workflow": graph}, {"workflow": graph, "disable_motion": "yes"}):
        with pytest.raises(HTTPError) as error:
            post("/api/workflows", body)
        assert error.value.code == 400
        assert worker.config.analysis.enabled is True
    with pytest.raises(HTTPError) as error:
        post("/api/workflows/activation-preview", {"workflow": graph}, guarded=False)
    assert error.value.code == 403
    with post("/api/workflows", {"workflow": graph, "disable_motion": True}) as response:
        assert json.load(response)["enabled"] is True
    assert worker.config.analysis.enabled is False
    assert worker.config.pipeline == "vision"
    with urlopen(url + "/api/models", timeout=3) as response:
        assert json.load(response)["storage_directory"].endswith("models")


def test_local_model_library_routes_are_guarded_and_bounded(server, tmp_path):
    url, _ = server
    headers = {"Content-Type": "application/json", "X-Spyder-Control": "1"}
    local = tmp_path / "local.pt"
    local.write_bytes(b"weights")

    def post_json(path, value, *, guarded=True):
        request_headers = {"Content-Type": "application/json"}
        if guarded:
            request_headers["X-Spyder-Control"] = "1"
        return urlopen(
            Request(
                url + path,
                method="POST",
                data=json.dumps(value).encode(),
                headers=request_headers,
            ),
            timeout=3,
        )

    with pytest.raises(HTTPError) as error:
        post_json("/api/models/register", {"path": str(local), "engine": "yolo"}, guarded=False)
    assert error.value.code == 403

    guarded = headers | {"Origin": url}
    with urlopen(
        Request(
            url + "/api/models/register",
            method="POST",
            data=json.dumps({"path": str(local), "engine": "yolo"}).encode(),
            headers=guarded,
        ),
        timeout=3,
    ) as response:
        descriptor = json.load(response)
        assert descriptor["metadata"]["inspection"] == "unverified"
    with urlopen(url + "/api/models", timeout=3) as response:
        listing = json.load(response)
        assert listing["models"][0]["id"] == descriptor["id"]
        assert listing["storage_error"] is None
    with urlopen(
        Request(
            url + "/api/models/upload?filename=..%2Fuploaded.pt&engine=yolo",
            method="POST",
            data=b"weights",
            headers={"Content-Type": "application/octet-stream", "X-Spyder-Control": "1"},
        ),
        timeout=3,
    ) as response:
        uploaded = json.load(response)
    assert uploaded["path"].endswith(".pt") and ".." not in uploaded["path"]
    with pytest.raises(HTTPError) as error:
        urlopen(
            Request(
                url + "/api/models/upload?filename=x.pt&engine=yolo",
                method="POST",
                data=b"x",
                headers={"Content-Type": "application/octet-stream"},
            ),
            timeout=3,
        )
    assert error.value.code == 403


def test_model_removal_requires_control_and_preserves_registered_source(server, tmp_path):
    url, _ = server
    source = tmp_path / "keep.pt"
    source.write_bytes(b"weights")

    def post(path, data, *, guarded=True):
        return urlopen(
            Request(
                url + path,
                method="POST",
                data=json.dumps(data).encode(),
                headers={
                    "Content-Type": "application/json",
                    **({"X-Spyder-Control": "1"} if guarded else {}),
                },
            ),
            timeout=3,
        )

    with post("/api/models/register", {"path": str(source), "engine": "yolo"}) as response:
        model = json.load(response)
    with urlopen(url + "/api/models", timeout=3) as response:
        listed = next(item for item in json.load(response)["models"] if item["id"] == model["id"])
    assert listed["usage"] == {"in_use": False, "references": []}
    with pytest.raises(HTTPError) as error:
        post(f"/api/models/{model['id']}/remove", {}, guarded=False)
    assert error.value.code == 403
    with post(f"/api/models/{model['id']}/remove", {}) as response:
        assert json.load(response) == {
            "removed": True,
            "id": model["id"],
            "deleted_file": False,
        }
    assert source.read_bytes() == b"weights"


def test_models_use_classes_from_matching_active_camera_without_persisting_them(
    server, tmp_path, monkeypatch
):
    url, manager = server
    model_path = tmp_path / "active.pt"
    model_path.write_bytes(b"weights")
    request = Request(
        url + "/api/models/register",
        method="POST",
        data=json.dumps({"path": str(model_path), "engine": "yolo"}).encode(),
        headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
    )
    with urlopen(request, timeout=3) as response:
        descriptor = json.load(response)

    worker = SimpleNamespace(
        config=SimpleNamespace(vision=VisionConfig(engine="yolo", model=str(model_path.resolve()))),
        vision_snapshot=lambda: {"runtime": {"classes": ["person", "forklift"]}},
    )
    monkeypatch.setattr(manager, "get_worker", lambda _camera_id: worker)
    with urlopen(url + "/api/models", timeout=3) as response:
        listing = json.load(response)["models"]
    selected = next(item for item in listing if item["id"] == descriptor["id"])
    assert selected["classes"] == ["person", "forklift"]
    assert selected["metadata"]["inspection"] == "loaded from active camera"


def test_existing_model_metadata_can_be_reinspected_with_control_protection(
    server, tmp_path, monkeypatch
):
    from spyder_cctv.model_library import ModelLibrary

    url, _ = server
    source = tmp_path / "classifier.onnx"
    source.write_bytes(b"metadata fixture")
    monkeypatch.setattr(
        ModelLibrary, "_inspect", staticmethod(lambda *_: ([], {"inspection": "unverified"}))
    )

    def post(path, data, guarded=True):
        return urlopen(
            Request(
                url + path,
                method="POST",
                data=json.dumps(data).encode(),
                headers={
                    "Content-Type": "application/json",
                    **({"X-Spyder-Control": "1"} if guarded else {}),
                },
            ),
            timeout=4,
        )

    with post("/api/models/register", {"path": str(source), "engine": "insightface"}) as response:
        descriptor = json.load(response)
    path = f"/api/models/{descriptor['id']}/inspect"
    with pytest.raises(HTTPError) as error:
        post(path, {}, guarded=False)
    assert error.value.code == 403
    monkeypatch.setattr(
        ModelLibrary,
        "_inspect",
        staticmethod(
            lambda *_: (
                ["identity-one"],
                {
                    "inspection": "metadata inspected",
                    "classes": "available",
                    "model_type": "face_classifier",
                },
            )
        ),
    )
    with post(path, {}) as response:
        assert json.load(response)["classes"] == ["identity-one"]
    with urlopen(url + "/api/models", timeout=3) as response:
        assert json.load(response)["models"][0]["classes"] == ["identity-one"]
    with pytest.raises(HTTPError) as error:
        post(path, {"unexpected": True})
    assert error.value.code == 400


def test_draft_preview_routes_do_not_apply_live_settings(server):
    url, manager = server
    path = "/api/analysis/preview/draft-tab"

    def post(route, data, headers=None):
        return urlopen(
            Request(
                url + route,
                method="POST",
                data=json.dumps(data).encode(),
                headers=headers or {"Content-Type": "application/json", "X-Spyder-Control": "1"},
            ),
            timeout=4,
        )

    with pytest.raises(HTTPError) as error:
        post(path, {"camera_id": "front", "settings": {}}, {"Content-Type": "application/json"})
    assert error.value.code == 403
    with post(
        path, {"camera_id": "front", "settings": {"enabled": True, "warmup_frames": 0}}
    ) as response:
        assert response.status == 202
    assert manager.get_worker("front").config.analysis.enabled is False
    assert not manager._config_path.exists()
    manager.control("front", "start")
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        with urlopen(url + path, timeout=3) as response:
            if json.load(response)["runtime"]["state"] == "ready":
                break
        time.sleep(0.02)
    for suffix in ("/frame", "/mask"):
        with urlopen(url + path + suffix, timeout=3) as response:
            assert response.read().startswith(b"\xff\xd8")
    with post(path + "/release", {}) as response:
        assert response.status == 200
    with pytest.raises(HTTPError) as error:
        urlopen(url + path, timeout=3)
    assert error.value.code == 404
    with pytest.raises(HTTPError) as error:
        post(path, {"camera_id": "front", "settings": {}})
    assert error.value.code == 409


def test_analysis_routes_persist_without_replacing_base_pipeline(server):
    url, manager = server

    def post(path, data):
        return urlopen(
            Request(
                url + path,
                method="POST",
                data=json.dumps(data).encode(),
                headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
            ),
            timeout=4,
        )

    with urlopen(url + "/api/cameras/front/analysis", timeout=2) as response:
        assert json.load(response)["settings"]["enabled"] is False
    with post(
        "/api/cameras/front/analysis", {"settings": {"enabled": True, "warmup_frames": 0}}
    ) as response:
        assert response.status == 202
        assert json.load(response)["pipeline"] == "motion"
    manager.control("front", "start")
    deadline = time.monotonic() + 4
    while manager.get_worker("front").analysis_mask() is None and time.monotonic() < deadline:
        time.sleep(0.02)
    with urlopen(url + "/api/cameras/front/analysis/mask", timeout=2) as response:
        assert response.read().startswith(b"\xff\xd8")
    for data in [
        {"settings": {"enabled": "yes"}},
        {"settings": {"pipeline": "vision"}},
        {"settings": {"input_width": 8000}},
        {"settings": {}, "extra": True},
    ]:
        with pytest.raises(HTTPError) as error:
            post("/api/cameras/front/analysis", data)
        assert error.value.code == 400
    assert manager.get_worker("front").config.analysis.enabled
    with pytest.raises(HTTPError) as error:
        urlopen(
            Request(
                url + "/api/cameras/front/analysis",
                method="POST",
                data=b"{}",
                headers={
                    "Content-Type": "application/json",
                    "X-Spyder-Control": "1",
                    "Origin": "https://evil.example",
                },
            ),
            timeout=2,
        )
    assert error.value.code == 403
    with post("/api/cameras/front/analysis", {"settings": {"enabled": False}}):
        pass
    with pytest.raises(HTTPError) as error:
        urlopen(url + "/api/cameras/missing/analysis", timeout=2)
    assert error.value.code == 404


def test_capacity_assessment_uses_guarded_background_job(server):
    url, _ = server
    with urlopen(url + "/api/analysis/capacity", timeout=2) as response:
        assert json.load(response)["state"] == "idle"
    with pytest.raises(HTTPError) as error:
        urlopen(
            Request(
                url + "/api/analysis/assess",
                method="POST",
                data=b"{}",
                headers={"Content-Type": "application/json"},
            ),
            timeout=2,
        )
    assert error.value.code == 403
    with urlopen(
        Request(
            url + "/api/analysis/assess",
            method="POST",
            data=b"{}",
            headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
        ),
        timeout=2,
    ) as response:
        assert response.status == 202
        assert json.load(response)["state"] in ("running", "ready")


@pytest.mark.parametrize(
    "data", [{}, [], {"source": True}, {"source": 1, "name": 123}, {"source": 1, "extra": "bad"}]
)
def test_invalid_add_does_not_change_registry(server, data):
    url, manager = server
    request = Request(
        url + "/api/cameras",
        method="POST",
        headers={"X-Spyder-Control": "1", "Content-Type": "application/json"},
        data=json.dumps(data).encode(),
    )
    with pytest.raises(HTTPError) as error:
        urlopen(request, timeout=2)
    assert error.value.code == 400
    assert len(manager.statuses()) == 1


def test_profile_settings_api_persist_and_validate(server):
    url, manager = server

    def post(path, data):
        return urlopen(
            Request(
                url + path,
                method="POST",
                data=json.dumps(data).encode(),
                headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
            ),
            timeout=2,
        )

    with post("/api/profiles", {"name": "Indoor", "settings": {"brightness": 60}}) as response:
        assert response.status == 201
        profile = json.load(response)
    with post("/api/cameras/front/profile", {"profile_id": profile["id"]}) as response:
        assert response.status == 202
        assert json.load(response)["settings_state"] == "scheduled"
    with urlopen(url + "/api/cameras/front/settings", timeout=2) as response:
        assert json.load(response)["desired"] == {"brightness": 60}
    with pytest.raises(HTTPError) as error:
        post("/api/profiles/" + profile["id"] + "/remove", {})
    assert error.value.code == 409
    with post("/api/cameras/front/settings", {"settings": {"brightness": 20}}) as response:
        assert json.load(response)["profile_id"] is None
    with post("/api/profiles/" + profile["id"] + "/remove", {}) as response:
        assert response.status == 200
    assert manager.profiles() == []
    for path, data in [
        ("/api/cameras/front/settings", {"settings": {"brightness": 101}}),
        ("/api/cameras/front/profile", {"profile_id": []}),
        ("/api/profiles", {"name": "Empty", "settings": {}}),
    ]:
        with pytest.raises(HTTPError) as error:
            post(path, data)
        assert error.value.code == 400


def test_preview_connections_reuse_and_actions_close_unread_bodies(server):
    url, _ = server
    address = urlsplit(url)
    connection = http.client.HTTPConnection(address.hostname, address.port, timeout=2)
    try:
        connection.request("GET", "/api/cameras")
        response = connection.getresponse()
        assert response.status == 200
        response.read()
        socket = connection.sock
        connection.request("GET", "/settings.js")
        response = connection.getresponse()
        assert response.status == 200
        response.read()
        assert connection.sock is socket
        connection.request(
            "POST",
            "/api/cameras/front/stop",
            body="{}",
            headers={"X-Spyder-Control": "1", "Content-Type": "application/json"},
        )
        response = connection.getresponse()
        assert response.status == 200
        assert response.headers["Connection"] == "close"
        response.read()
        assert connection.sock is None
    finally:
        connection.close()


def test_code_preview_is_guarded_bounded_and_has_no_camera_side_effects(server):
    url, manager = server
    before = manager.statuses()
    payload = {
        "source": (
            "output = []\nfor detection in detections:\n"
            "    if (detection.get('confidence') or 0) >= 0.8:\n"
            "        output.append(detection)"
        ),
        "detections": [
            {"label": "person", "confidence": 0.9, "bbox": [0, 0, 10, 10]},
            {"label": "person", "confidence": 0.2, "bbox": [0, 0, 10, 10]},
        ],
        "context": {
            "camera_id": "preview",
            "engine": "opencv",
            "frame_size": [640, 360],
            "sequence": 1,
        },
    }

    def post(data, guarded=True):
        return urlopen(
            Request(
                url + "/api/workflows/code/test",
                method="POST",
                data=json.dumps(data).encode(),
                headers={
                    "Content-Type": "application/json",
                    **({"X-Spyder-Control": "1"} if guarded else {}),
                },
            ),
            timeout=3,
        )

    with pytest.raises(HTTPError) as error:
        post(payload, False)
    assert error.value.code == 403
    with post(payload) as response:
        assert json.load(response)["detections"] == payload["detections"][:1]
    for source in ("import os", "while True: pass", "output = open('private.txt')"):
        with pytest.raises(HTTPError) as error:
            post({**payload, "source": source})
        assert error.value.code == 400
        message = json.load(error.value)["error"]
        assert message and "Traceback" not in message
    assert manager.statuses() == before
    with urlopen(url + "/api/workflows", timeout=2) as response:
        data = json.load(response)
        assert data["workflows"] == [] and data["events"] == []


def test_code_preview_dispatches_optional_javascript_language(server, monkeypatch):
    url, _ = server
    observed = []
    result = [{"label": "person", "bbox": [0, 0, 5, 5]}]

    def dispatch(source, detections, context, *, language="python"):
        observed.append((source, detections, context, language))
        return result

    monkeypatch.setattr(web_module, "run_code", dispatch)
    payload = {
        "source": "output = detections",
        "detections": [],
        "context": {},
        "language": "javascript",
    }
    with urlopen(
        Request(
            url + "/api/workflows/code/test",
            method="POST",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
        ),
        timeout=3,
    ) as response:
        assert json.load(response)["detections"] == result
    assert observed == [(payload["source"], [], {}, "javascript")]


def test_workflow_save_accepts_multiple_full_size_code_nodes(server):
    url, _ = server
    source = "output = detections\n#" + "x" * 7700
    graph = {
        "id": "large-code-draft",
        "name": "Large code draft",
        "enabled": False,
        "camera_ids": [],
        "edges": [],
        "nodes": [
            {
                "id": f"code-{i}",
                "type": "code",
                "x": i * 100,
                "y": 0,
                "params": {"language": "python", "source": source},
            }
            for i in range(10)
        ],
    }
    body = json.dumps({"workflow": graph}).encode()
    assert len(body) > 65536
    with urlopen(
        Request(
            url + "/api/workflows",
            method="POST",
            data=body,
            headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
        ),
        timeout=3,
    ) as response:
        assert len(json.load(response)["nodes"]) == 10


def test_notifications_endpoint_is_local_and_asset_is_bundled(server):
    url, _ = server
    with urlopen(url + "/api/workflows/notifications", timeout=3) as response:
        data = json.load(response)
    assert isinstance(data["session_id"], str) and len(data["session_id"]) == 32
    assert data["notifications"] == []
    with urlopen(url + "/workflow-notifications.js", timeout=3) as response:
        assert response.headers["Content-Type"].startswith("text/javascript")
        assert b"/api/workflows/notifications" in response.read()
    with pytest.raises(HTTPError) as error:
        urlopen(
            Request(
                url + "/api/workflows/notifications", headers={"Origin": "https://other.example"}
            ),
            timeout=3,
        )
    assert error.value.code == 403


def test_builtin_detector_catalog_and_explicit_install(server, monkeypatch):
    url, _ = server
    monkeypatch.setattr(
        web_module.DetectorCatalog, "list", lambda _: [{"id": "scrfd-500mf", "available": False}]
    )
    with urlopen(url + "/api/vision/detectors") as response:
        data = json.load(response)
    assert data["default"] == "scrfd-500mf"
    assert data["detectors"][0]["available"] is False
    calls = []

    def install(_, name):
        calls.append(name)
        return {"id": name, "available": True}

    monkeypatch.setattr(web_module.DetectorCatalog, "install", install)
    request = Request(
        url + "/api/vision/detectors/scrfd-500mf/install",
        data=b"{}",
        headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
    )
    with urlopen(request) as response:
        assert json.load(response)["available"]
    assert calls == ["scrfd-500mf"]

    request = Request(
        url + "/api/vision/detectors/scrfd-500mf/install",
        data=b"{}",
        headers={"Content-Type": "application/json"},
    )
    with pytest.raises(HTTPError) as error:
        urlopen(request)
    assert error.value.code == 403
    assert calls == ["scrfd-500mf"]


def test_workflow_configures_builtin_opencv_without_manual_pipeline_panel(server):
    url, manager = server
    workflow = {
        "id": "opencv-workflow",
        "name": "OpenCV person preview",
        "enabled": True,
        "camera_ids": ["front"],
        "nodes": [
            {"id": "detect", "type": "detections", "x": 0, "y": 0, "params": {"engine": "opencv"}},
            {"id": "preview", "type": "preview", "x": 200, "y": 0, "params": {}},
        ],
        "edges": [{"from": "detect", "to": "preview"}],
    }
    request = Request(
        url + "/api/workflows",
        method="POST",
        data=json.dumps({"workflow": workflow}).encode(),
        headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
    )
    with urlopen(request, timeout=4) as response:
        assert json.load(response)["enabled"]
    worker = manager.get_worker("front")
    assert worker.config.pipeline == "vision"
    assert worker.config.vision.engine == "opencv"
    revision = worker._vision_revision
    with urlopen(request, timeout=4):
        pass
    assert worker._vision_revision == revision


def test_model_removal_checks_relative_model_paths_in_latest_saved_camera_config(server, tmp_path):
    from spyder_cctv.config import save_config

    url, manager = server
    source = tmp_path / "relative-model.pt"
    source.write_bytes(b"fixture")
    register = Request(
        url + "/api/models/register",
        method="POST",
        data=json.dumps({"path": str(source), "engine": "yolo"}).encode(),
        headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
    )
    with urlopen(register, timeout=4) as response:
        descriptor = json.load(response)
    save_config(
        manager._config_path,
        [
            CameraConfig(
                "saved-camera",
                1,
                pipeline="vision",
                vision=VisionConfig(engine="yolo", model="relative-model.pt"),
            )
        ],
    )
    with urlopen(url + "/api/models", timeout=4) as response:
        model = next(m for m in json.load(response)["models"] if m["id"] == descriptor["id"])
    assert model["usage"]["in_use"]
    remove = Request(
        url + f"/api/models/{descriptor['id']}/remove",
        method="POST",
        data=b"{}",
        headers={"Content-Type": "application/json", "X-Spyder-Control": "1"},
    )
    with pytest.raises(HTTPError) as error:
        urlopen(remove, timeout=4)
    assert error.value.code == 409
    assert source.exists()
