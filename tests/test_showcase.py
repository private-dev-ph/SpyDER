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
