import http.client
import json
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import numpy as np
import pytest

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import CameraConfig
from spyder_cctv.web import create_server


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


def test_dashboard_assets_and_status(server):
    url, _ = server
    for path, content_type in [
        ("/", "text/html"),
        ("/dashboard.js", "text/javascript"),
        ("/dashboard.css", "text/css"),
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
