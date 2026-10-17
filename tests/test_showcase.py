from html.parser import HTMLParser

from spyder_cctv.cli import main
from spyder_cctv.showcase import export_showcase


def test_export_is_complete_static_and_config_independent(tmp_path):
    output = tmp_path / "site"
    assert (
        main(
            ["--config", str(tmp_path / "missing.json"), "export-showcase", "--output", str(output)]
        )
        == 0
    )
    assert {p.name for p in output.iterdir()} == {
        "index.html",
        "dashboard.js",
        "dashboard.css",
        "settings.js",
        "settings.css",
        "showcase.js",
        "activity.js",
        "icons.svg",
        "spyder-emblem.png",
        "event-library.js",
        "event-library.css",
        "wall-order.js",
        "layouts.js",
        "layouts.css",
        "workspaces.js",
        "workspaces.css",
        "browser-recording.js",
        "fullscreen.js",
        "fullscreen.css",
        "vision-lab.js",
        "vision-lab.css",
        "workflow-preview.js",
        "workflow-editor.js",
        "workflow-notifications.js",
        "workflow-editor.css",
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
    for path in references:
        assert path.startswith("/") and not path.startswith("//")
        assert (output / path.lstrip("/")).is_file(), path
    assert "/workflow-preview.js" in references
