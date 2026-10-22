"""Bounded, LAN-only ONVIF discovery and PTZ control."""

from __future__ import annotations

import base64
import hashlib
import http.client
import ipaddress
import os
import re
import socket
import ssl
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

MAX_XML_BYTES = 1_048_576
MAX_DISCOVERED = 64
MAX_PROFILES = 8
MAX_SESSIONS = 32
SESSION_TTL = 24 * 60 * 60
DEFAULT_TIMEOUT = 2.0
MAX_PULSE_MS = 1000
SOAP_NS = "http://www.w3.org/2003/05/soap-envelope"
WSA_NS = "http://www.w3.org/2005/08/addressing"
WSSE_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
WSU_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
DEVICE_NS = "http://www.onvif.org/ver10/device/wsdl"
MEDIA_NS = "http://www.onvif.org/ver10/media/wsdl"
PTZ_NS = "http://www.onvif.org/ver20/ptz/wsdl"
SCHEMA_NS = "http://www.onvif.org/ver10/schema"
DISCOVERY_GROUP = "239.255.255.250"
DISCOVERY_PORT = 3702


class OnvifError(RuntimeError):
    """Safe ONVIF error with no endpoint or credential details."""


def _safe_xml(data: bytes) -> ET.Element:
    if len(data) > MAX_XML_BYTES:
        raise OnvifError("ONVIF response too large")
    if b"\x00" in data or data.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise OnvifError("Unsafe XML rejected")
    try:
        decoded = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise OnvifError("Invalid ONVIF response") from None
    upper = decoded.upper()
    if "<!DOCTYPE" in upper or "<!ENTITY" in upper:
        raise OnvifError("Unsafe XML rejected")
    try:
        return ET.fromstring(data)
    except (ET.ParseError, ValueError):
        raise OnvifError("Invalid ONVIF response") from None


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(element: ET.Element, name: str) -> list[ET.Element]:
    return [item for item in element.iter() if _local(item.tag) == name]


def _first(element: ET.Element, name: str) -> ET.Element | None:
    return next(iter(_children(element, name)), None)


def _text(element: ET.Element, name: str, default: str = "") -> str:
    item = _first(element, name)
    return (item.text or "").strip() if item is not None else default


def _validated_addresses(host: str) -> tuple[str, ...]:
    if not host or "%" in host or host.casefold() in {"localhost", "localhost.localdomain"}:
        raise OnvifError("Device must use a private LAN address")
    try:
        literal = ipaddress.ip_address(host.split("%", 1)[0])
        addresses = [str(literal)]
    except ValueError:
        try:
            addresses = sorted(
                {
                    item[4][0].split("%", 1)[0]
                    for item in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
                }
            )
        except OSError:
            raise OnvifError("Device address could not be resolved") from None
    if not addresses:
        raise OnvifError("Device address could not be resolved")
    safe = []
    for value in addresses:
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            raise OnvifError("Device address is invalid") from None
        lan_private = (
            address.version == 4
            and any(address in network for network in (
                ipaddress.ip_network("10.0.0.0/8"),
                ipaddress.ip_network("172.16.0.0/12"),
                ipaddress.ip_network("192.168.0.0/16"),
            ))
        ) or (address.version == 6 and address in ipaddress.ip_network("fc00::/7"))
        if (
            not lan_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_unspecified
            or address.is_reserved
        ):
            raise OnvifError("Device must use a private LAN address")
        safe.append(str(address))
    return tuple(safe)


def _endpoint(value: str) -> tuple[str, int, str, str, tuple[str, ...]]:
    try:
        if not isinstance(value, str) or len(value) > 4096 or any(ord(char) < 32 for char in value):
            raise ValueError
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError
        if parsed.username is not None or parsed.password is not None:
            raise ValueError
        if parsed.fragment or parsed.query:
            raise ValueError
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if not 1 <= port <= 65535:
            raise ValueError
        addresses = _validated_addresses(parsed.hostname)
    except (ValueError, UnicodeError):
        raise OnvifError("Invalid ONVIF endpoint") from None
    if not parsed.path.startswith("/") or len(parsed.path) > 2048 or "\\" in parsed.path:
        raise OnvifError("Invalid ONVIF endpoint")
    return parsed.scheme, port, parsed.hostname, parsed.path or "/", addresses


def _authority(host: str, port: int, scheme: str) -> str:
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    default_port = 443 if scheme == "https" else 80
    return host if port == default_port else f"{host}:{port}"


class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, address: str, timeout: float):
        super().__init__(host, port, timeout=timeout)
        self.address = address

    def connect(self):
        self.sock = socket.create_connection((self.address, self.port), self.timeout)


class _PinnedHTTPS(_PinnedHTTP):
    def __init__(self, host: str, port: int, address: str, timeout: float):
        super().__init__(host, port, address, timeout)
        self.context = ssl.create_default_context()

    def connect(self):
        raw = socket.create_connection((self.address, self.port), self.timeout)
        self.sock = self.context.wrap_socket(raw, server_hostname=self.host)


def _digest_header(challenge: str, username: str, password: str, method: str, uri: str) -> str:
    params = {key: quoted or bare for key, quoted, bare in re.findall(
        r'(\w+)=(?:"([^"]*)"|([^,\s]+))', challenge
    )}
    realm, nonce = params.get("realm"), params.get("nonce")
    algorithm = params.get("algorithm", "MD5").upper()
    qop = [item.strip() for item in params.get("qop", "auth").split(",")]
    supported = {"MD5", "MD5-SESS", "SHA-256", "SHA-256-SESS"}
    if not realm or not nonce or algorithm not in supported or "auth" not in qop:
        raise OnvifError("Camera authentication challenge is unsupported")
    hash_fn = hashlib.sha256 if algorithm.startswith("SHA-256") else hashlib.md5
    cnonce = os.urandom(16).hex()
    nc = "00000001"
    ha1 = hash_fn(f"{username}:{realm}:{password}".encode()).hexdigest()
    if algorithm == "MD5-SESS":
        ha1 = hash_fn(f"{ha1}:{nonce}:{cnonce}".encode()).hexdigest()
    ha2 = hash_fn(f"{method}:{uri}".encode()).hexdigest()
    response = hash_fn(f"{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}".encode()).hexdigest()
    def quote(value: str) -> str:
        return value.replace("\\", "\\\\").replace('"', '\\"')

    fields = [
        f'username="{quote(username)}"',
        f'realm="{quote(realm)}"',
        f'nonce="{quote(nonce)}"',
        f'uri="{quote(uri)}"',
        f'response="{response}"',
        "qop=auth",
        f"nc={nc}",
        f'cnonce="{cnonce}"',
    ]
    if params.get("opaque"):
        fields.append(f'opaque="{params["opaque"]}"')
    fields.append(f"algorithm={algorithm}")
    return "Digest " + ", ".join(fields)


def _http_post(
    endpoint: str,
    payload: bytes,
    username: str,
    password: str,
    action_uri: str,
    approved_addresses: frozenset[str],
) -> bytes:
    scheme, port, host, path, addresses = _endpoint(endpoint)
    if not set(addresses).issubset(approved_addresses):
        raise OnvifError("Camera service address changed")
    address = addresses[0]
    timeout = DEFAULT_TIMEOUT
    connection_type = _PinnedHTTPS if scheme == "https" else _PinnedHTTP
    conn = connection_type(host, port, address, timeout)
    headers = {
        "Content-Type": f'application/soap+xml; charset=utf-8; action="{action_uri}"',
        "Connection": "close",
        "Content-Length": str(len(payload)),
    }
    headers["Host"] = _authority(host, port, scheme)
    try:
        conn.request("POST", path, body=payload, headers=headers)
        response = conn.getresponse()
        data = response.read(MAX_XML_BYTES + 1)
        if len(data) > MAX_XML_BYTES:
            raise OnvifError("ONVIF response too large")
        if response.status == 401:
            challenge = response.getheader("WWW-Authenticate", "")
            conn.close()
            conn = connection_type(host, port, address, timeout)
            headers["Authorization"] = _digest_header(challenge, username, password, "POST", path)
            conn.request("POST", path, body=payload, headers=headers)
            response = conn.getresponse()
            data = response.read(MAX_XML_BYTES + 1)
            if len(data) > MAX_XML_BYTES:
                raise OnvifError("ONVIF response too large")
        if response.status < 200 or response.status >= 300:
            raise OnvifError("ONVIF request failed")
        return data
    except OnvifError:
        raise
    except (OSError, ssl.SSLError, http.client.HTTPException, TimeoutError):
        raise OnvifError("Camera did not respond") from None
    finally:
        conn.close()


def _action_uri(action: str) -> str:
    ptz_actions = {"GetNode", "ContinuousMove", "Stop", "GetPresets"}
    if action in ptz_actions:
        action_ns = PTZ_NS
    elif action in {"GetProfiles", "GetStreamUri"}:
        action_ns = MEDIA_NS
    else:
        action_ns = DEVICE_NS
    return f"{action_ns}/{action}"


def _soap(action: str, body: str, username: str, password: str) -> bytes:
    action_uri = _action_uri(action)
    created = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    nonce = os.urandom(20)
    digest = base64.b64encode(
        hashlib.sha1(nonce + created.encode() + password.encode()).digest()
    ).decode()
    token = (
        f'<wsse:UsernameToken><wsse:Username>{_xml_escape(username)}</wsse:Username>'
        f'<wsse:Password Type="{WSSE_NS}#PasswordDigest">{digest}</wsse:Password>'
        f'<wsse:Nonce EncodingType="{WSSE_NS}#Base64Binary">'
        f'{base64.b64encode(nonce).decode()}</wsse:Nonce>'
        f'<wsu:Created>{created}</wsu:Created></wsse:UsernameToken>'
    )
    return (
        f'<s:Envelope xmlns:s="{SOAP_NS}" xmlns:wsa="{WSA_NS}" '
        f'xmlns:wsse="{WSSE_NS}" xmlns:wsu="{WSU_NS}"><s:Header>'
        f'<wsa:Action>{action_uri}</wsa:Action><wsse:Security s:mustUnderstand="1">{token}'
        f'</wsse:Security></s:Header><s:Body>{body}</s:Body></s:Envelope>'
    ).encode()


def _xml_escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _soap_body(name: str, namespace: str, fields: dict[str, str] | None = None) -> str:
    inner = "".join(f"<{key}>{_xml_escape(value)}</{key}>" for key, value in (fields or {}).items())
    return f'<t:{name} xmlns:t="{namespace}">{inner}</t:{name}>'


def _strip_uri_credentials(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"rtsp", "rtsps", "http", "https"} or not parsed.hostname:
            raise ValueError
        host = parsed.hostname
        if ":" in host:
            host = f"[{host}]"
        if parsed.port:
            host = f"{host}:{parsed.port}"
        query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        sensitive = ("user", "pass", "credential", "token", "auth")
        query = [(key, item) for key, item in query
                 if not any(part in key.casefold() for part in sensitive)]
        return urllib.parse.urlunsplit((parsed.scheme, host, parsed.path,
                                        urllib.parse.urlencode(query), ""))
    except (ValueError, UnicodeError):
        raise OnvifError("Camera returned an invalid stream URI") from None


@dataclass
class _Session:
    endpoint: str
    username: str
    password: str
    approved_addresses: frozenset[str]
    media_endpoint: str
    ptz_endpoint: str | None
    profiles: list[dict[str, Any]]
    ptz_caps: dict[str, Any]
    profile_ptz_caps: dict[str, dict[str, Any]] = field(default_factory=dict)
    stream_uris: dict[str, str] = field(default_factory=dict)
    expires_at: float = field(default_factory=lambda: time.monotonic() + SESSION_TTL)
    lock: threading.RLock = field(default_factory=threading.RLock)
    timer: threading.Timer | None = None
    moving: bool = False
    move_generation: int = 0
    pinned: bool = False


class OnvifBackend:
    """ONVIF sessions with short PTZ pulses and in-memory credentials."""

    def __init__(self, max_sessions: int = MAX_SESSIONS):
        self._sessions: dict[str, _Session] = {}
        self._lock = threading.RLock()
        self._max_sessions = max(1, min(int(max_sessions), MAX_SESSIONS))
        self._closed = False

    def discover(self, timeout: float = 3.0) -> list[dict[str, str]]:
        timeout = min(3.0, max(0.1, float(timeout)))
        message_id = f"urn:uuid:{uuid4()}"
        probe = (
            f'<e:Envelope xmlns:e="{SOAP_NS}" xmlns:w="{WSA_NS}" '
            'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">'
            f'<e:Header><w:MessageID>{message_id}</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>'
            '<w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>'
            '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>'
        ).encode()
        # Include namespace used by the QName in Probe/Types.
        probe = probe.replace(b'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"',
                              b'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"')
        found: dict[str, dict[str, str]] = {}
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        try:
            sock.settimeout(timeout)
            sock.sendto(probe, (DISCOVERY_GROUP, DISCOVERY_PORT))
            end = time.monotonic() + timeout
            while len(found) < MAX_DISCOVERED:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    break
                sock.settimeout(remaining)
                try:
                    packet, _ = sock.recvfrom(MAX_XML_BYTES + 1)
                except TimeoutError:
                    break
                if len(packet) > MAX_XML_BYTES:
                    continue
                try:
                    root = _safe_xml(packet)
                    xaddrs = _text(root, "XAddrs").split()
                    scopes = _text(root, "Scopes")
                    endpoint = None
                    for item in xaddrs:
                        try:
                            _endpoint(item)
                            endpoint = item
                            break
                        except OnvifError:
                            continue
                    if endpoint is None:
                        continue
                    name = next((urllib.parse.unquote(s.rsplit("/", 1)[-1]) for s in scopes.split()
                                 if "/name/" in s), "ONVIF camera")
                    _scheme, _port, host, _path, _addresses = _endpoint(endpoint)
                    key = host.casefold()
                    found.setdefault(
                        key, {"endpoint": endpoint, "name": name[:80], "scopes": scopes[:512]}
                    )
                except (OnvifError, ValueError):
                    continue
        except OSError:
            return []
        finally:
            sock.close()
        return list(found.values())[:MAX_DISCOVERED]

    def connect(self, endpoint: str, username: str, password: str) -> dict[str, Any]:
        if (not isinstance(username, str) or not isinstance(password, str) or len(username) > 256
                or len(password) > 1024 or any(ord(char) < 32 for char in username + password)):
            raise OnvifError("Invalid camera credentials")
        with self._lock:
            self._expire_locked()
            if self._closed:
                raise OnvifError("ONVIF backend is closed")
            if len(self._sessions) >= self._max_sessions:
                raise OnvifError("ONVIF session limit reached")
        scheme, port, host, path, addresses = _endpoint(endpoint)
        normalized = f"{scheme}://{_authority(host, port, scheme)}{path}"
        session = _Session(normalized, username, password, frozenset(addresses), "", None, [], {})
        root = self._request(
            session,
            normalized,
            "GetCapabilities",
            _soap_body("GetCapabilities", DEVICE_NS, {"Category": "All"}),
        )
        capabilities = _first(root, "Capabilities") or root
        media = _first(capabilities, "Media")
        if media is None:
            raise OnvifError("Camera has no Media service")
        media_endpoint = _text(media, "XAddr")
        session.media_endpoint = self._approved_service(media_endpoint, session.approved_addresses)
        ptz = _first(capabilities, "PTZ")
        if ptz is not None:
            ptz_endpoint = _text(ptz, "XAddr")
            if ptz_endpoint:
                session.ptz_endpoint = self._approved_service(
                    ptz_endpoint, session.approved_addresses
                )
        root = self._request(session, session.media_endpoint, "GetProfiles",
                             _soap_body("GetProfiles", MEDIA_NS))
        profiles = []
        for profile in _children(root, "Profiles"):
            token = profile.attrib.get("token", "")
            if not token:
                continue
            config = _first(profile, "PTZConfiguration")
            profiles.append(
                {
                    "token": token[:256],
                    "name": _text(profile, "Name", "Profile")[:80],
                    "ptz": config is not None,
                    "node_token": (
                        config.attrib.get("NodeToken", config.attrib.get("nodeToken", ""))
                        if config is not None
                        else ""
                    ),
                }
            )
            if len(profiles) == MAX_PROFILES:
                break
        if not profiles:
            raise OnvifError("Camera has no media profiles")
        empty_caps = {
            "pan_tilt": False,
            "zoom": False,
            "presets": False,
            "pan_tilt_space": None,
            "zoom_space": None,
        }
        caps = dict(empty_caps)
        profile_ptz_caps = {item["token"]: dict(empty_caps) for item in profiles}
        node_cache: dict[str, dict[str, Any]] = {}
        for profile in profiles:
            if not session.ptz_endpoint or not profile["ptz"]:
                continue
            try:
                profile_ptz_caps[profile["token"]] = self._ptz_capabilities(
                    session, profile, node_cache
                )
            except OnvifError:
                # PTZ capability probing is read-only and optional; retain stream access on failure.
                continue
        preset_profile = next((item for item in profiles if item["ptz"]), None)
        if session.ptz_endpoint and preset_profile:
            try:
                self._request(
                    session,
                    session.ptz_endpoint,
                    "GetPresets",
                    _soap_body("GetPresets", PTZ_NS, {"ProfileToken": preset_profile["token"]}),
                )
                for profile in profiles:
                    if profile["ptz"]:
                        profile_ptz_caps[profile["token"]]["presets"] = True
            except OnvifError:
                pass
        caps["pan_tilt"] = any(item["pan_tilt"] for item in profile_ptz_caps.values())
        caps["zoom"] = any(item["zoom"] for item in profile_ptz_caps.values())
        caps["presets"] = any(item["presets"] for item in profile_ptz_caps.values())
        session.profiles = profiles
        session.ptz_caps = caps
        session.profile_ptz_caps = profile_ptz_caps
        session_id = uuid4().hex
        with self._lock:
            self._expire_locked()
            if self._closed or len(self._sessions) >= self._max_sessions:
                raise OnvifError("ONVIF session limit reached")
            self._sessions[session_id] = session
        return {
            "session_id": session_id,
            "device": {"endpoint": normalized, "name": "ONVIF camera"},
            "profiles": [
                {key: item[key] for key in ("token", "name", "ptz")} for item in profiles
            ],
            "ptz": {
                key: value
                for key, value in caps.items()
                if key in {"pan_tilt", "zoom", "presets"}
            },
        }

    @staticmethod
    def _approved_service(endpoint: str, approved: frozenset[str]) -> str:
        scheme, port, host, path, addresses = _endpoint(endpoint)
        if not set(addresses).issubset(approved):
            raise OnvifError("Camera service address does not match device")
        return f"{scheme}://{_authority(host, port, scheme)}{path}"

    def _request(self, session: _Session, endpoint: str, operation: str, body: str) -> ET.Element:
        # Re-resolve each request and pin the socket to an approved address.
        _scheme, _port, _host, _path, addresses = _endpoint(endpoint)
        if not set(addresses).issubset(session.approved_addresses):
            raise OnvifError("Camera service address changed")
        data = _http_post(
            endpoint,
            _soap(operation, body, session.username, session.password),
            session.username,
            session.password,
            _action_uri(operation),
            session.approved_addresses,
        )
        root = _safe_xml(data)
        fault = _first(root, "Fault")
        if fault is not None:
            raise OnvifError("Camera rejected ONVIF request")
        return root

    def _ptz_capabilities(
        self,
        session: _Session,
        profile: dict[str, Any],
        node_cache: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        node_token = profile.get("node_token", "")
        caps: dict[str, Any] = {"pan_tilt": False, "zoom": False, "presets": False,
                                "pan_tilt_space": None, "zoom_space": None}
        if node_token:
            cached = node_cache.get(node_token)
            if cached is None:
                cached = dict(caps)
                root = self._request(
                    session,
                    session.ptz_endpoint,
                    "GetNode",
                    _soap_body("GetNode", PTZ_NS, {"NodeToken": node_token}),
                )
                for node in _children(root, "SupportedPTZSpaces"):
                    pan = _first(node, "ContinuousPanTiltVelocitySpace")
                    zoom = _first(node, "ContinuousZoomVelocitySpace")
                    if pan is not None:
                        cached["pan_tilt_space"] = self._space(pan, two_axis=True)
                        cached["pan_tilt"] = cached["pan_tilt_space"] is not None
                    if zoom is not None:
                        cached["zoom_space"] = self._space(zoom, two_axis=False)
                        cached["zoom"] = cached["zoom_space"] is not None
                node_cache[node_token] = cached
            caps.update(cached)
        caps["presets"] = False
        return caps

    @staticmethod
    def _space(space: ET.Element, two_axis: bool) -> dict[str, float] | None:
        uri = space.attrib.get("URI", "")
        x = _first(space, "XRange")
        y = _first(space, "YRange") if two_axis else None
        if not uri or x is None:
            return None
        try:
            xmin, xmax = float(_text(x, "Min")), float(_text(x, "Max"))
            ymin, ymax = (
                (float(_text(y, "Min")), float(_text(y, "Max")))
                if y is not None
                else (0.0, 0.0)
            )
            if not all(
                map(lambda value: value == value and abs(value) < 1e6, (xmin, xmax, ymin, ymax))
            ):
                return None
            return {"uri": uri[:512], "xmin": xmin, "xmax": xmax, "ymin": ymin, "ymax": ymax}
        except (ValueError, TypeError):
            return None

    def _session(self, session_id: str) -> _Session:
        with self._lock:
            self._expire_locked()
            session = self._sessions.get(session_id)
            if session is None:
                raise OnvifError("ONVIF session expired")
            session.expires_at = time.monotonic() + SESSION_TTL
            return session

    def _expire_locked(self):
        now = time.monotonic()
        expired = [key for key, value in self._sessions.items()
                   if not value.pinned and value.expires_at <= now]
        for key in expired:
            session = self._sessions.pop(key)
            self._stop_session(session)

    def get_stream_uri(self, session_id: str, profile_token: str) -> str:
        session = self._session(session_id)
        profile = self._profile(session, profile_token)
        if profile_token in session.stream_uris:
            return session.stream_uris[profile_token]
        root = self._request(session, session.media_endpoint, "GetStreamUri",
                             f'<t:GetStreamUri xmlns:t="{MEDIA_NS}" xmlns:tt="{SCHEMA_NS}">'
                             '<t:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>'
                             '<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></t:StreamSetup>'
                             f'<t:ProfileToken>{_xml_escape(profile["token"])}</t:ProfileToken></t:GetStreamUri>')
        # Camera credentials in returned URI never leave this backend.
        uri = _strip_uri_credentials(_text(root, "Uri"))
        parsed = urllib.parse.urlsplit(uri)
        addresses = _validated_addresses(parsed.hostname or "")
        if not set(addresses).issubset(session.approved_addresses):
            raise OnvifError("Camera stream address does not match device")
        pinned_host = addresses[0]
        if ":" in pinned_host:
            pinned_host = f"[{pinned_host}]"
        netloc = pinned_host + (f":{parsed.port}" if parsed.port else "")
        uri = urllib.parse.urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, ""))
        session.stream_uris[profile_token] = uri
        return uri

    def authenticated_stream_uri(self, session_id: str, profile_token: str) -> str:
        """Return credential-bearing URI for trusted capture code, never an HTTP response."""
        session = self._session(session_id)
        uri = self.get_stream_uri(session_id, profile_token)
        parsed = urllib.parse.urlsplit(uri)
        host = parsed.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        if parsed.port:
            host = f"{host}:{parsed.port}"
        credentials = urllib.parse.quote(session.username, safe="")
        if session.password:
            credentials += ":" + urllib.parse.quote(session.password, safe="")
        netloc = f"{credentials}@{host}" if credentials else host
        return urllib.parse.urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, ""))

    def pin_session(self, session_id: str) -> dict[str, bool]:
        """Keep session credentials alive for an attached camera until explicit close."""
        session = self._session(session_id)
        session.pinned = True
        return {"pinned": True}

    @staticmethod
    def _profile(session: _Session, token: str) -> dict[str, Any]:
        if not isinstance(token, str) or len(token) > 256:
            raise OnvifError("Unknown media profile")
        profile = next((item for item in session.profiles if item["token"] == token), None)
        if profile is None:
            raise OnvifError("Unknown media profile")
        return profile

    def move(self, session_id: str, profile_token: str, pan: float, tilt: float, zoom: float,
             duration_ms: int = 250) -> dict[str, Any]:
        session = self._session(session_id)
        self._profile(session, profile_token)
        try:
            pan, tilt, zoom = float(pan), float(tilt), float(zoom)
            duration_ms = int(duration_ms)
        except (TypeError, ValueError, OverflowError):
            raise OnvifError("Invalid PTZ movement") from None
        if not all(map(lambda x: x == x and abs(x) <= 1, (pan, tilt, zoom))):
            raise OnvifError("PTZ speed must be between -1 and 1")
        if not 50 <= duration_ms <= MAX_PULSE_MS:
            raise OnvifError("PTZ pulse duration must be 50 to 1000 ms")
        caps = session.profile_ptz_caps.get(profile_token, {})
        if (
            not session.ptz_endpoint
            or (pan or tilt) and not caps["pan_tilt"]
            or zoom and not caps["zoom"]
        ):
            raise OnvifError("Requested PTZ movement is unsupported")
        if not (pan or tilt or zoom):
            return self.stop(session_id)
        with session.lock:
            if session.moving:
                self._cancel_timer(session)
                try:
                    self._send_stop(session, profile_token)
                except OnvifError:
                    session.timer = threading.Timer(
                        0.5,
                        self._deadman_stop,
                        args=(session, profile_token, session.move_generation),
                    )
                    session.timer.daemon = True
                    session.timer.start()
                    raise
            else:
                self._cancel_timer(session)
            session.move_generation += 1
            velocity = ""
            if pan or tilt:
                space = caps["pan_tilt_space"]
                x = self._map_speed(pan, space["xmin"], space["xmax"])
                y = self._map_speed(tilt, space["ymin"], space["ymax"])
                velocity += (
                    f'<tt:PanTilt x="{x:.6f}" y="{y:.6f}" '
                    f'space="{_xml_escape(space["uri"])}"/>'
                )
            if zoom:
                space = caps["zoom_space"]
                z = self._map_speed(zoom, space["xmin"], space["xmax"])
                velocity += f'<tt:Zoom x="{z:.6f}" space="{_xml_escape(space["uri"])}"/>'
            body = (
                f'<t:ContinuousMove xmlns:t="{PTZ_NS}" xmlns:tt="{SCHEMA_NS}">'
                f'<t:ProfileToken>{_xml_escape(profile_token)}</t:ProfileToken>'
                f'<t:Velocity>{velocity}</t:Velocity>'
                f'<t:Timeout>PT{duration_ms / 1000:.3f}S</t:Timeout>'
                "</t:ContinuousMove>"
            )
            self._request(session, session.ptz_endpoint, "ContinuousMove", body)
            session.moving = True
            timer = threading.Timer(
                duration_ms / 1000,
                self._deadman_stop,
                args=(session, profile_token, session.move_generation),
            )
            timer.daemon = True
            session.timer = timer
            timer.start()
        return {"moving": True, "duration_ms": duration_ms}

    @staticmethod
    def _map_speed(value: float, low: float, high: float) -> float:
        if value < 0:
            return low * abs(value)
        if value > 0:
            return high * value
        return 0.0

    @staticmethod
    def _cancel_timer(session: _Session):
        if session.timer:
            session.timer.cancel()
            session.timer = None

    def _deadman_stop(
        self, session: _Session, profile_token: str, generation: int, retry: int = 0
    ):
        with session.lock:
            if generation != session.move_generation:
                return
            session.timer = None
            if session.moving:
                try:
                    self._send_stop(session, profile_token)
                except OnvifError:
                    if retry < 2:
                        session.timer = threading.Timer(
                            0.5,
                            self._deadman_stop,
                            args=(session, profile_token, generation, retry + 1),
                        )
                        session.timer.daemon = True
                        session.timer.start()

    def _send_stop(self, session: _Session, profile_token: str):
        if not session.ptz_endpoint:
            return
        body = (
            f'<t:Stop xmlns:t="{PTZ_NS}">'
            f'<t:ProfileToken>{_xml_escape(profile_token)}</t:ProfileToken>'
            "<t:PanTilt>true</t:PanTilt><t:Zoom>true</t:Zoom></t:Stop>"
        )
        self._request(session, session.ptz_endpoint, "Stop", body)
        session.moving = False

    def stop(self, session_id: str) -> dict[str, bool]:
        session = self._session(session_id)
        with session.lock:
            if session.ptz_endpoint:
                profile = next(
                    (item for item in session.profiles if item["ptz"]), session.profiles[0]
                )
                self._send_stop(session, profile["token"])
            session.move_generation += 1
            self._cancel_timer(session)
        return {"moving": False}

    def presets(self, session_id: str, profile_token: str) -> list[dict[str, str]]:
        session = self._session(session_id)
        self._profile(session, profile_token)
        profile_caps = session.profile_ptz_caps.get(profile_token, {})
        if not session.ptz_endpoint or not profile_caps.get("presets"):
            return []
        root = self._request(session, session.ptz_endpoint, "GetPresets",
                             _soap_body("GetPresets", PTZ_NS, {"ProfileToken": profile_token}))
        return [
            {
                "token": item.attrib.get("token", "")[:256],
                "name": _text(item, "Name", "Preset")[:80],
            }
            for item in _children(root, "Preset")
            if item.attrib.get("token")
        ][:64]

    def status(self, session_id: str) -> dict[str, Any]:
        session = self._session(session_id)
        return {"connected": True, "expires_in": max(0, int(session.expires_at - time.monotonic())),
                "profiles": [
                    {key: item[key] for key in ("token", "name", "ptz")}
                    for item in session.profiles
                ],
                "ptz": {key: value for key, value in session.ptz_caps.items()
                        if key in {"pan_tilt", "zoom", "presets"}},
                "moving": bool(session.moving)}

    def close(self, session_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session:
            self._stop_session(session)

    def _stop_session(self, session: _Session):
        with session.lock:
            self._cancel_timer(session)
            session.move_generation += 1
            if session.moving:
                try:
                    profile = next(
                        (item for item in session.profiles if item["ptz"]), session.profiles[0]
                    )
                    self._send_stop(session, profile["token"])
                except (OnvifError, IndexError):
                    session.moving = False
            session.username = ""
            session.password = ""

    def close_all(self) -> None:
        with self._lock:
            self._closed = True
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            self._stop_session(session)

