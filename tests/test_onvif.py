import base64
import hashlib
import socket
import xml.etree.ElementTree as ET

import pytest

from spyder_cctv import onvif


def test_private_address_validation_rejects_public_and_mixed_dns(monkeypatch):
    assert onvif._validated_addresses("192.168.1.8") == ("192.168.1.8",)
    with pytest.raises(onvif.OnvifError, match="private LAN"):
        onvif._validated_addresses("127.0.0.1")
    with pytest.raises(onvif.OnvifError, match="private LAN"):
        onvif._validated_addresses("169.254.169.254")

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.1.8", 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 0)),
        ],
    )
    with pytest.raises(onvif.OnvifError, match="private LAN"):
        onvif._validated_addresses("camera.lan")


def test_safe_xml_rejects_dtd_entities_and_large_documents():
    with pytest.raises(onvif.OnvifError, match="Unsafe XML"):
        onvif._safe_xml(b'<!DOCTYPE x [<!ENTITY e "boom">]><x>&e;</x>')
    with pytest.raises(onvif.OnvifError, match="Unsafe XML"):
        onvif._safe_xml('<!DOCTYPE x><x/>'.encode("utf-16"))
    with pytest.raises(onvif.OnvifError, match="too large"):
        onvif._safe_xml(b" " * (onvif.MAX_XML_BYTES + 1))
    with pytest.raises(onvif.OnvifError, match="Invalid ONVIF response"):
        onvif._safe_xml(b"<not-closed>")


def test_username_token_digest_uses_oasis_types_and_nonce_created_password_formula():
    body = onvif._soap_body("GetProfiles", onvif.MEDIA_NS)
    payload = onvif._soap("GetProfiles", body, "viewer", "secret")
    root = onvif._safe_xml(payload)
    password = onvif._first(root, "Password")
    nonce = onvif._first(root, "Nonce")
    created = onvif._text(root, "Created")

    assert password.attrib["Type"] == onvif.PASSWORD_DIGEST_TYPE
    assert nonce.attrib["EncodingType"] == onvif.NONCE_ENCODING_TYPE
    nonce_bytes = base64.b64decode(nonce.text)
    expected = base64.b64encode(
        hashlib.sha1(nonce_bytes + created.encode() + b"secret").digest()
    ).decode()
    assert password.text == expected


@pytest.mark.parametrize(
    ("operation", "namespace", "field", "value"),
    [
        ("GetCapabilities", onvif.DEVICE_NS, "Category", "All"),
        ("GetPresets", onvif.PTZ_NS, "ProfileToken", "profile-1"),
        ("GetNode", onvif.PTZ_NS, "NodeToken", "node-1"),
    ],
)
def test_soap_operation_fields_are_qualified(operation, namespace, field, value):
    body = onvif._soap_body(operation, namespace, {field: value})
    root = onvif._safe_xml(onvif._soap(operation, body, "user", "secret"))
    operation_node = root.find(f".//{{{onvif.SOAP_NS}}}Body/{{{namespace}}}{operation}")

    assert operation_node is not None
    field_node = operation_node.find(f"{{{namespace}}}{field}")
    assert field_node is not None
    assert field_node.text == value


def test_discovery_uses_onvif_wsa_namespace_literal_private_xaddr_and_skips_bad_first(
    monkeypatch,
):
    packet = (
        b'<Envelope><Body><ProbeMatch>'
        b'<XAddrs>http://8.8.8.8/device http://192.168.1.9/device</XAddrs>'
        b'<Scopes>onvif://www.onvif.org/name/Front%20Door</Scopes>'
        b'</ProbeMatch></Body></Envelope>'
    )

    class FakeSocket:
        def __init__(self):
            self.sent = None
            self.received = False

        def settimeout(self, _timeout):
            pass

        def sendto(self, data, _address):
            self.sent = data

        def recvfrom(self, _size):
            if self.received:
                raise TimeoutError
            self.received = True
            return packet, ("192.168.1.9", onvif.DISCOVERY_PORT)

        def close(self):
            pass

    fake_socket = FakeSocket()
    monkeypatch.setattr(onvif.socket, "socket", lambda *_args: fake_socket)
    monkeypatch.setattr(
        onvif.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: pytest.fail("Discovery must not resolve hostnames"),
    )
    found = onvif.OnvifBackend().discover()

    assert b'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"' in fake_socket.sent
    assert found == [
        {
            "endpoint": "http://192.168.1.9/device",
            "name": "Front Door",
            "scopes": "onvif://www.onvif.org/name/Front%20Door",
        }
    ]


def test_space_parses_schema_uri_element_and_rejects_ranges_without_zero():
    space = onvif._safe_xml(
        b'<Space><URI>space:pan</URI><XRange><Min>-1</Min><Max>1</Max></XRange>'
        b'<YRange><Min>-2</Min><Max>2</Max></YRange></Space>'
    )
    assert onvif.OnvifBackend._space(space, two_axis=True) == {
        "uri": "space:pan",
        "xmin": -1.0,
        "xmax": 1.0,
        "ymin": -2.0,
        "ymax": 2.0,
    }
    invalid = onvif._safe_xml(
        b'<Space><URI>space:pan</URI><XRange><Min>0.1</Min><Max>1</Max></XRange>'
        b'<YRange><Min>-1</Min><Max>1</Max></YRange></Space>'
    )
    assert onvif.OnvifBackend._space(invalid, two_axis=True) is None


def test_invalid_session_id_type_is_handled_without_type_error():
    backend = onvif.OnvifBackend()
    with pytest.raises(onvif.OnvifError, match="expired"):
        backend.status(["not", "hashable"])
    backend.close(["not", "hashable"])


def test_http_digest_auth_header_uses_supported_auth_qop():
    challenge = 'Digest realm="cam", nonce="abc", qop="auth,auth-int", algorithm=MD5'
    header = onvif._digest_header(challenge, "viewer", "secret", "POST", "/onvif/device_service")
    assert header.startswith("Digest ")
    assert 'username="viewer"' in header
    assert "qop=auth" in header
    ha1 = hashlib.md5(b"viewer:cam:secret").hexdigest()
    ha2 = hashlib.md5(b"POST:/onvif/device_service").hexdigest()
    response = header.split('response="', 1)[1].split('"', 1)[0]
    cnonce = header.split('cnonce="', 1)[1].split('"', 1)[0]
    expected = hashlib.md5(f"{ha1}:abc:00000001:{cnonce}:auth:{ha2}".encode()).hexdigest()
    assert response == expected
    with pytest.raises(onvif.OnvifError, match="unsupported"):
        onvif._digest_header(
            'Digest realm="cam", nonce="abc", qop="auth-int"', "a", "b", "POST", "/"
        )


def test_strip_uri_credentials_and_sensitive_query_values():
    value = onvif._strip_uri_credentials(
        "rtsp://user:secret@192.168.1.8:554/live?username=u&password=p&channel=1#fragment"
    )
    assert value == "rtsp://192.168.1.8:554/live?channel=1"
    with pytest.raises(onvif.OnvifError, match="invalid stream URI"):
        onvif._strip_uri_credentials("file:///etc/passwd")


def test_connect_returns_redacted_session_and_stream_helper_is_internal(monkeypatch):
    backend = onvif.OnvifBackend()
    calls = []
    responses = [
        b'<Envelope><Body><Capabilities><Media><XAddr>http://192.168.1.8:80/media</XAddr></Media>'
        b'<PTZ><XAddr>http://192.168.1.8:80/ptz</XAddr></PTZ></Capabilities></Body></Envelope>',
        b'<Envelope><Body><Profiles token="main"><Name>Main</Name>'
        b'<PTZConfiguration NodeToken="node"/></Profiles></Body></Envelope>',
        b'<Envelope><Body><SupportedPTZSpaces><ContinuousPanTiltVelocitySpace><URI>ptz:pan</URI>'
        b'<XRange><Min>-1</Min><Max>1</Max></XRange><YRange><Min>-1</Min><Max>1</Max></YRange>'
        b'</ContinuousPanTiltVelocitySpace><ContinuousZoomVelocitySpace><URI>ptz:zoom</URI>'
        b'<XRange><Min>-1</Min><Max>1</Max></XRange></ContinuousZoomVelocitySpace>'
        b'</SupportedPTZSpaces></Body></Envelope>',
        b'<Envelope><Body><GetPresetsResponse /></Body></Envelope>',
    ]

    def request(_session, endpoint, operation, body):
        calls.append((endpoint, operation, body))
        return onvif._safe_xml(responses.pop(0))

    monkeypatch.setattr(backend, "_request", request)
    connected = backend.connect("http://192.168.1.8/onvif/device_service", "view user", "p@ss word")
    assert calls[0][1] == "GetCapabilities"
    assert "<t:Category>All</t:Category>" in calls[0][2]
    assert [operation for _endpoint, operation, _body in calls] == [
        "GetCapabilities",
        "GetProfiles",
        "GetNode",
        "GetPresets",
    ]
    assert connected["profiles"] == [
        {
            "token": "main",
            "name": "Main",
            "ptz": True,
            "ptz_caps": {"pan_tilt": True, "zoom": True, "presets": True},
        }
    ]
    assert connected["ptz"] == {"pan_tilt": True, "zoom": True, "presets": True}
    assert "view user" not in repr(connected)
    assert "p@ss word" not in repr(connected)
    session_id = connected["session_id"]
    assert backend.status(session_id)["connected"] is True
    assert backend.status(session_id)["profiles"] == connected["profiles"]

    stream_response = b'<Envelope><Body><Uri>rtsp://cam:pw@192.168.1.8/live?channel=1</Uri></Body></Envelope>'
    monkeypatch.setattr(backend, "_request", lambda *_args: onvif._safe_xml(stream_response))
    uri = backend.get_stream_uri(session_id, "main")
    assert uri == "rtsp://192.168.1.8/live?channel=1"
    assert backend.authenticated_stream_uri(session_id, "main") == (
        "rtsp://view%20user:p%40ss%20word@192.168.1.8/live?channel=1"
    )
    backend.close(session_id)
    with pytest.raises(onvif.OnvifError, match="expired"):
        backend.status(session_id)


def test_service_endpoint_must_resolve_to_approved_device_host(monkeypatch):
    backend = onvif.OnvifBackend()
    approved = frozenset({"192.168.1.8"})
    assert backend._approved_service("http://192.168.1.8:8080/media", approved).endswith("/media")
    with pytest.raises(onvif.OnvifError, match="does not match"):
        backend._approved_service("http://192.168.1.9/media", approved)


def test_ptz_pulse_uses_supported_spaces_and_deadman_stop(monkeypatch):
    backend = onvif.OnvifBackend()
    session = onvif._Session(
        "http://192.168.1.8/device", "u", "p", frozenset({"192.168.1.8"}),
        "http://192.168.1.8/media", "http://192.168.1.8/ptz",
        [{"token": "main", "name": "Main", "ptz": True}],
        {"pan_tilt": True, "zoom": True, "presets": True,
         "pan_tilt_space": {"uri": "space:pt", "xmin": -2, "xmax": 2, "ymin": -1, "ymax": 1},
         "zoom_space": {"uri": "space:z", "xmin": -1, "xmax": 1}},
    )
    session.profile_ptz_caps["main"] = dict(session.ptz_caps)
    backend._sessions["sid"] = session
    sent = []
    monkeypatch.setattr(
        backend,
        "_request",
        lambda _session, _endpoint, op, body: sent.append((op, body)) or ET.Element("Root"),
    )

    class Timer:
        def __init__(self, _interval, callback, args):
            self.callback = callback
            self.args = args
            self.cancelled = False

        def start(self):
            pass

        def cancel(self):
            self.cancelled = True

        def fire(self):
            self.callback(*self.args)

    timers = []

    def timer_factory(interval, callback, args):
        timer = Timer(interval, callback, args)
        timers.append(timer)
        return timer

    monkeypatch.setattr(onvif.threading, "Timer", timer_factory)
    result = backend.move("sid", "main", 0.5, -1, 1, duration_ms=300)
    assert result == {"moving": True, "duration_ms": 300}
    assert "x=\"1.000000\"" in sent[0][1]
    assert "y=\"-1.000000\"" in sent[0][1]
    assert "x=\"1.000000\"" in sent[0][1]
    assert "PT0.300S" in sent[0][1]
    timers[0].fire()
    assert [operation for operation, _body in sent] == ["ContinuousMove", "Stop"]
    assert backend.status("sid")["moving"] is False

    with pytest.raises(onvif.OnvifError, match="between -1 and 1"):
        backend.move("sid", "main", 1.1, 0, 0)
    with pytest.raises(onvif.OnvifError, match="50 to 1000"):
        backend.move("sid", "main", 1, 0, 0, 10)
    backend.close_all()


def test_move_uses_selected_profile_capabilities():
    backend = onvif.OnvifBackend()
    session = onvif._Session(
        "http://192.168.1.8/device", "u", "p", frozenset({"192.168.1.8"}),
        "http://192.168.1.8/media", "http://192.168.1.8/ptz",
        [
            {"token": "pan-profile", "name": "Pan", "ptz": True},
            {"token": "zoom-profile", "name": "Zoom", "ptz": True},
        ],
        {"pan_tilt": True, "zoom": True, "presets": False},
    )
    session.profile_ptz_caps = {
        "pan-profile": {
            "pan_tilt": True,
            "zoom": False,
            "presets": False,
            "pan_tilt_space": {"uri": "space:pt", "xmin": -1, "xmax": 1, "ymin": -1, "ymax": 1},
            "zoom_space": None,
        },
        "zoom-profile": {
            "pan_tilt": False,
            "zoom": True,
            "presets": False,
            "pan_tilt_space": None,
            "zoom_space": {"uri": "space:z", "xmin": -1, "xmax": 1},
        },
    }
    backend._sessions["sid"] = session
    with pytest.raises(onvif.OnvifError, match="unsupported"):
        backend.move("sid", "zoom-profile", 1, 0, 0)


def test_lost_continuous_move_response_keeps_deadman_stop_armed(monkeypatch):
    backend = onvif.OnvifBackend()
    session = onvif._Session(
        "http://192.168.1.8/device", "u", "p", frozenset({"192.168.1.8"}),
        "http://192.168.1.8/media", "http://192.168.1.8/ptz",
        [{"token": "main", "name": "Main", "ptz": True}],
        {"pan_tilt": True, "zoom": False, "presets": False},
    )
    session.profile_ptz_caps["main"] = {
        "pan_tilt": True,
        "zoom": False,
        "presets": False,
        "pan_tilt_space": {"uri": "space:pt", "xmin": -1, "xmax": 1, "ymin": -1, "ymax": 1},
        "zoom_space": None,
    }
    backend._sessions["sid"] = session
    calls = []

    def request(_session, _endpoint, operation, _body):
        calls.append(operation)
        if operation == "ContinuousMove":
            raise onvif.OnvifError("Camera did not respond")
        return ET.Element("Root")

    monkeypatch.setattr(backend, "_request", request)

    class Timer:
        def __init__(self, _interval, callback, args):
            self.callback = callback
            self.args = args
            self.started = False

        def start(self):
            self.started = True

        def cancel(self):
            pass

        def fire(self):
            self.callback(*self.args)

    timers = []

    def timer_factory(interval, callback, args):
        timer = Timer(interval, callback, args)
        timers.append(timer)
        return timer

    monkeypatch.setattr(onvif.threading, "Timer", timer_factory)
    with pytest.raises(onvif.OnvifError, match="did not respond"):
        backend.move("sid", "main", 1, 0, 0, duration_ms=300)

    assert session.moving is True
    assert session.moving_profile_token == "main"
    assert len(timers) == 1 and timers[0].started
    timers[0].fire()
    assert calls == ["ContinuousMove", "Stop"]
    assert session.moving is False
    assert session.moving_profile_token is None


def test_close_all_stops_profile_that_is_actively_moving(monkeypatch):
    backend = onvif.OnvifBackend()
    session = onvif._Session(
        "http://192.168.1.8/device", "u", "p", frozenset({"192.168.1.8"}),
        "http://192.168.1.8/media", "http://192.168.1.8/ptz",
        [
            {"token": "pan-profile", "name": "Pan", "ptz": True},
            {"token": "zoom-profile", "name": "Zoom", "ptz": True},
        ],
        {"pan_tilt": True, "zoom": True, "presets": False},
        moving=True,
        moving_profile_token="zoom-profile",
    )
    backend._sessions["sid"] = session
    sent = []
    monkeypatch.setattr(
        backend,
        "_request",
        lambda _session, _endpoint, operation, body: sent.append((operation, body)),
    )
    backend.close_all()
    assert sent[0][0] == "Stop"
    assert "zoom-profile" in sent[0][1]


def test_close_all_stops_active_pulse_and_rejects_new_connections(monkeypatch):
    backend = onvif.OnvifBackend()
    session = onvif._Session(
        "http://192.168.1.8/device", "u", "p", frozenset({"192.168.1.8"}),
        "http://192.168.1.8/media", "http://192.168.1.8/ptz",
        [{"token": "main", "name": "Main", "ptz": True}],
        {"pan_tilt": True, "zoom": False, "presets": True}, moving=True,
    )
    backend._sessions["sid"] = session
    sent = []
    monkeypatch.setattr(backend, "_request", lambda _session, _endpoint, op, _body: sent.append(op))
    backend.close_all()
    assert sent == ["Stop"]
    assert session.username == session.password == ""
    assert not backend._sessions
    with pytest.raises(onvif.OnvifError, match="closed"):
        backend.connect("http://192.168.1.8/device", "u", "p")


def test_pinned_session_survives_idle_expiry_until_explicit_close():
    backend = onvif.OnvifBackend()
    session = onvif._Session(
        "http://192.168.1.8/device", "u", "p", frozenset({"192.168.1.8"}),
        "http://192.168.1.8/media", None, [{"token": "main", "name": "Main", "ptz": False}], {},
    )
    backend._sessions["sid"] = session
    backend.pin_session("sid")
    session.expires_at = 0
    with backend._lock:
        backend._expire_locked()
    assert backend.status("sid")["connected"] is True
    backend.close("sid")
    assert not backend._sessions
