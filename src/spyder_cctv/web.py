"""Loopback-only monitoring server. No package-relative filesystem assumptions."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from urllib.parse import urlsplit

from spyder_cctv.cameras import CameraManager


def create_server(manager: CameraManager, port: int = 8765) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def setup(self) -> None:
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, format: str, *args: object) -> None:
            # URLs and camera sources should not become access logs.
            pass

        def send(self, code: int, body: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header(
                "Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'"
            )
            self.end_headers()
            self.wfile.write(body)

        def json(self, code: int, value: object) -> None:
            self.send(code, json.dumps(value).encode(), "application/json")

        def allowed(self) -> bool:
            # Reject hostile Host headers (DNS rebinding) and cross-origin control.
            expected = f"127.0.0.1:{self.server.server_port}"
            if self.headers.get("Host") != expected:
                self.json(403, {"error": "Use the displayed loopback URL"})
                return False
            origin = self.headers.get("Origin")
            if origin is not None and origin != f"http://{expected}":
                self.json(403, {"error": "Cross-origin requests are forbidden"})
                return False
            return True

        def do_GET(self) -> None:
            if not self.allowed():
                return
            path = urlsplit(self.path).path
            if path == "/":
                self.send(
                    200,
                    files("spyder_cctv").joinpath("assets/dashboard.html").read_bytes(),
                    "text/html; charset=utf-8",
                )
            elif path == "/dashboard.js":
                self.send(
                    200,
                    files("spyder_cctv").joinpath("assets/dashboard.js").read_bytes(),
                    "text/javascript; charset=utf-8",
                )
            elif path == "/dashboard.css":
                self.send(
                    200,
                    files("spyder_cctv").joinpath("assets/dashboard.css").read_bytes(),
                    "text/css; charset=utf-8",
                )
            elif path == "/api/cameras":
                self.json(200, manager.statuses())
            else:
                parts = path.strip("/").split("/")
                if len(parts) == 4 and parts[:2] == ["api", "cameras"] and parts[3] == "frame":
                    worker = manager.workers.get(parts[2])
                    if worker is None:
                        self.json(404, {"error": "Unknown camera"})
                    elif (jpeg := worker.jpeg()) is None:
                        self.json(503, {"error": "No fresh frame available"})
                    else:
                        self.send(200, jpeg, "image/jpeg")
                else:
                    self.json(404, {"error": "Unknown route"})

        def do_POST(self) -> None:
            if not self.allowed():
                return
            # A custom header prevents browser form requests from controlling cameras.
            if self.headers.get("X-Spyder-Control") != "1":
                self.json(403, {"error": "Control header required"})
                return
            parts = urlsplit(self.path).path.strip("/").split("/")
            if len(parts) != 4 or parts[:2] != ["api", "cameras"]:
                self.json(404, {"error": "Unknown route"})
                return
            worker = manager.workers.get(parts[2])
            if worker is None or parts[3] not in ("start", "stop"):
                self.json(404, {"error": "Unknown camera or action"})
                return
            try:
                if parts[3] == "start":
                    worker.start()
                else:
                    worker.stop()
                self.json(200, worker.status())
            except RuntimeError as error:
                self.json(409, {"error": str(error)})

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)
