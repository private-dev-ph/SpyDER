"""Export a static, browser-only showcase from installed package resources."""

from importlib.resources import files
from pathlib import Path

HEADERS = (
    "/*\n"
    "  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; "
    "img-src 'self' blob: data:; media-src blob:; connect-src 'none'; worker-src 'none'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'\n"
    """
  Permissions-Policy: camera=(self), microphone=(), geolocation=()
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
"""
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
        "dashboard.js",
        "dashboard.css",
        "settings.js",
        "settings.css",
        "showcase.js",
        "activity.js",
        "icons.svg",
        "spyder-emblem.png",
        "workspaces.js",
        "workspaces.css",
        "browser-recording.js",
        "fullscreen.js",
        "fullscreen.css",
        "vision-lab.js",
        "vision-lab.css",
    ):
        (output / name).write_bytes(assets.joinpath(name).read_bytes())
    (output / "_headers").write_text(HEADERS, encoding="utf-8")
