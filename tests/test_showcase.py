import hashlib
import json
from html.parser import HTMLParser
from importlib.resources import files

from spyder_cctv.cli import main
from spyder_cctv.showcase import MAIN_CSP, WORKER_CSP, export_showcase


def test_export_is_complete_static_and_config_independent(tmp_path):
    output = tmp_path / "site"
    assert (
        main(
            ["--config", str(tmp_path / "missing.json"), "export-showcase", "--output", str(output)]
        )
        == 0
    )
    assert {p.name for p in output.iterdir()} == {
        "face-enrollment-viewer.js",
        "face-enrollment-viewer.css",
        "device-tools.js",
        "device-tools.css",
        "index.html",
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
        "browser-motion-policy.js",
        "404.html",
        "mog2-worker.js",
        "opencv-4.12.0.js",
        "opencv-LICENSE.txt",
        "opencv-runtime.json",
        "demo-camera-picker.css",
        *[
            c["filename"]
            for c in json.loads(
                files("spyder_cctv")
                .joinpath("assets", "demo-cameras.json")
                .read_text(encoding="utf-8")
            )["cameras"]
        ],
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
        "_headers",
    }
    html = (output / "index.html").read_text(encoding="utf-8")
    assert html.index("/showcase.js") < html.index("/dashboard.js")
    assert "connect-src 'none'" in (output / "_headers").read_text()
    assert not (tmp_path / "missing.json").exists()
    assert not list(output.glob("*.py"))


def test_export_never_overwrites_existing_files(tmp_path):
    output = tmp_path / "site"
    output.mkdir()
    (output / "index.html").write_text("user content")
    assert main(["export-showcase", "--output", str(output)]) == 1
    assert (output / "index.html").read_text() == "user content"


def test_export_works_outside_checkout(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    export_showcase(tmp_path / "export")
    assert (tmp_path / "export" / "showcase.js").stat().st_size > 0


def test_exported_html_references_only_bundled_assets(tmp_path):
    output = tmp_path / "site"
    export_showcase(output)
    references = []

    class Assets(HTMLParser):
        def handle_starttag(self, tag, attrs):
            if tag in ("script", "link"):
                attrs = dict(attrs)
                references.append(attrs.get("src") or attrs.get("href"))

    Assets().feed((output / "index.html").read_text(encoding="utf-8"))
    assert references
    assert len(references) == len(set(references)), "Assets must load once"
    for path in references:
        assert path.startswith("/") and not path.startswith("//")
        assert (output / path.lstrip("/")).is_file(), path
    assert "/workflow-preview.js" in references


def test_demo_clips_export_with_verified_credits_and_browser_only_policy(tmp_path):
    export_showcase(tmp_path / "site")
    output = tmp_path / "site"
    catalog = json.loads((output / "demo-cameras.json").read_text(encoding="utf-8"))
    assert len(catalog["cameras"]) == 8
    assert sum(c["bytes"] for c in catalog["cameras"]) < 1_000_000
    for clip in catalog["cameras"]:
        data = (output / clip["filename"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == clip["sha256"]
        assert data.index(b"moov") < data.index(b"mdat")
        assert clip["author"] and clip["source_url"].startswith("https://commons.wikimedia.org/")
        assert clip["license"] == "CC BY 3.0"
    policy = (output / "_headers").read_text(encoding="utf-8")
    assert "media-src 'self' blob:" in policy
    assert "connect-src 'none'" in policy
    assert "worker-src 'self'" in MAIN_CSP
    assert "unsafe-eval" not in MAIN_CSP
    assert "connect-src 'none'" in MAIN_CSP
    assert "script-src 'self' 'unsafe-eval'" in WORKER_CSP
    assert "connect-src 'none'" in WORKER_CSP
    assert f"/mog2-worker.js\n  Content-Security-Policy: {WORKER_CSP}" in policy


def test_pinned_opencv_asset_matches_provenance_and_cloudflare_size_limit():
    import gzip
    import json

    assets = files("spyder_cctv").joinpath("assets")
    provenance = json.loads(assets.joinpath("opencv-runtime.json").read_text(encoding="utf-8"))
    data = assets.joinpath("opencv-4.12.0.js").read_bytes()
    assert hashlib.sha256(data).hexdigest() == provenance["sha256"]
    assert len(data) == provenance["bytes"] < 25 * 1024 * 1024
    assert len(gzip.compress(data)) < 4 * 1024 * 1024
    assert "Apache" in assets.joinpath("opencv-LICENSE.txt").read_text(encoding="utf-8")
