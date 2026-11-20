import errno

from spyder_cctv.cli import main


def test_init_check_and_no_overwrite(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    config = tmp_path / "config" / "cameras.json"
    args = ["--config", str(config)]
    assert main(args + ["init"]) == 0
    original = config.read_bytes()
    assert main(args + ["check"]) == 0
    assert main(args + ["init"]) == 1
    assert config.read_bytes() == original


def test_missing_config_has_useful_exit(tmp_path):
    assert main(["--config", str(tmp_path / "missing.json"), "check"]) == 1


def test_occupied_port_explains_existing_instance(tmp_path, monkeypatch, caplog):
    def occupied(_manager, _port):
        raise OSError(errno.EADDRINUSE, "Address already in use")

    monkeypatch.setattr("spyder_cctv.cli.create_server", occupied)
    assert main(["--config", str(tmp_path / "config.json"), "gui", "--no-browser"]) == 1
    assert "Another SpyDER instance may already be running" in caplog.text
    assert "different --port" in caplog.text


def test_gui_first_launch_and_default_command(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    opened = []

    class Server:
        server_port = 8765

        def serve_forever(self, **options):
            raise KeyboardInterrupt

        def server_close(self):
            pass

    monkeypatch.setattr("spyder_cctv.cli.default_config_path", lambda: path)
    monkeypatch.setattr("spyder_cctv.cli.create_server", lambda manager, port: Server())
    monkeypatch.setattr("spyder_cctv.cli.webbrowser.open", opened.append)
    assert main([]) == 0
    assert path.exists()
    assert opened == ["http://127.0.0.1:8765"]
    original = path.read_bytes()
    assert main(["gui", "--no-browser"]) == 0
    assert path.read_bytes() == original
    assert len(opened) == 1


def test_complete_backup_cli_dispatch_and_browser_state(tmp_path, monkeypatch, capsys):
    import json
    import sys
    from types import SimpleNamespace

    calls = []

    class Core:
        @staticmethod
        def create(config, output, **options):
            calls.append(("create", config, output, options))
            return {"path": str(output)}

        @staticmethod
        def inspect(archive):
            calls.append(("inspect", archive))
            return {"valid": True}

        @staticmethod
        def restore(archive, destination):
            calls.append(("restore", archive, destination))
            return {"config_path": str(destination / "appdata/config.json")}

    monkeypatch.setitem(
        sys.modules, "spyder_cctv.complete_backup", SimpleNamespace(CompleteBackup=Core)
    )
    config = tmp_path / "custom.json"
    archive = tmp_path / "backup.zip"
    browser = tmp_path / "browser-state.json"
    browser.write_text(json.dumps({"version": 1, "local_storage": {"spyder-theme": "dark"}}))
    assert (
        main(
            [
                "--config",
                str(config),
                "backup",
                "create",
                "--output",
                str(archive),
                "--include-media",
                "--browser-state",
                str(browser),
            ]
        )
        == 0
    )
    assert calls[0][1] == config.resolve()
    assert calls[0][3]["include_media"] is True
    assert calls[0][3]["browser_data"]["local_storage"]["spyder-theme"] == "dark"
    assert main(["backup", "inspect", str(archive)]) == 0
    assert main(["backup", "restore", str(archive), "--destination", str(tmp_path / "new")]) == 0
    assert [call[0] for call in calls] == ["create", "inspect", "restore"]
    assert "config_path" in capsys.readouterr().out


def test_backup_cli_reports_invalid_archive_without_traceback(tmp_path, caplog):
    bad = tmp_path / "broken.zip"
    bad.write_bytes(b"not an archive")
    assert main(["backup", "inspect", str(bad)]) == 1
    assert "zip" in caplog.text.lower()
