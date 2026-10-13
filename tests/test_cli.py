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
