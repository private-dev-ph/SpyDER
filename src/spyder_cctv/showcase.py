"""Export a static, browser-only showcase from installed package resources."""

from importlib.resources import files
from pathlib import Path

MAIN_CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; "
    "img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'none'; worker-src 'self'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)
WORKER_CSP = (
    "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'; worker-src 'none'"
)
# CSP belongs to the execution context: the document stays eval-free; only the
# dedicated worker permits Emscripten's generated bindings and embedded Wasm.
HEADERS = (
    "/*\n"
    "  Permissions-Policy: camera=(self), microphone=(), geolocation=()\n"
    "  Referrer-Policy: no-referrer\n"
    "  X-Content-Type-Options: nosniff\n"
    "  X-Frame-Options: DENY\n"
    f"/\n  Content-Security-Policy: {MAIN_CSP}\n"
    f"/index.html\n  Content-Security-Policy: {MAIN_CSP}\n"
    f"/404.html\n  Content-Security-Policy: {MAIN_CSP}\n"
    f"/mog2-worker.js\n  Content-Security-Policy: {WORKER_CSP}\n"
)


def export_showcase(output: Path) -> None:
    """Create a new directory; never overwrite existing deployment assets."""
    output.mkdir(parents=True, exist_ok=False)
    assets = files("spyder_cctv").joinpath("assets")
    html = assets.joinpath("dashboard.html").read_text(encoding="utf-8")
    html = html.replace(
        '<script src="/dashboard.js" defer></script>',
        '<script src="/showcase.js" defer></script>\n'
        '    <script src="/browser-recording.js" defer></script>\n'
        '    <script src="/dashboard.js" defer></script>',
    )
    (output / "index.html").write_text(html, encoding="utf-8")
    for name in (
        "face-enrollment-viewer.js",
        "face-enrollment-viewer.css",
        "device-tools.js",
        "device-tools.css",
        "dashboard.js",
        "dashboard.css",
        "settings.js",
        "settings.css",
        "showcase.js",
        "browser-demo-workflows.js",
        "demo-cameras.js",
        "demo-cameras.json",
        "demo-camera-picker.js",
        "browser-motion.js",
        "browser-mog2.js",
        "404.html",
        "mog2-worker.js",
        "opencv-4.12.0.js",
        "opencv-LICENSE.txt",
        "opencv-runtime.json",
        "demo-camera-picker.css",
        "activity.js",
        "icons.svg",
        "spyder-emblem.png",
        "event-library.js",
        "event-library.css",
        "recording-library.js",
        "recording-overlays.js",
        "recording-overlays.css",
        "recording-player.js",
        "recording-player.css",
        "recording-timeline.js",
        "recording-timeline.css",
        "wall-order.js",
        "layouts.js",
        "layouts.css",
        "workspaces.js",
        "workspaces.css",
        "operations.js",
        "operations.css",
        "browser-recording.js",
        "fullscreen.js",
        "fullscreen.css",
        "vision-lab.js",
        "vision-lab.css",
        "workflow-preview.js",
        "workflow-editor.js",
        "workflow-tools.js",
        "workflow-run-view.js",
        "workflow-tools.css",
        "workflow-manager.js",
        "workflow-manager.css",
        "workflow-store.js",
        "workflow-notifications.js",
        "workflow-editor.css",
        "form-controls.js",
        "form-controls.css",
    ):
        (output / name).write_bytes(assets.joinpath(name).read_bytes())
    for asset in assets.iterdir():
        if asset.name.startswith("demo-") and asset.name.endswith(".mp4"):
            (output / asset.name).write_bytes(asset.read_bytes())
    (output / "_headers").write_text(HEADERS, encoding="utf-8")
