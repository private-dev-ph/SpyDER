import json
from dataclasses import asdict

from spyder_cctv.cli import main
from spyder_cctv.config import CameraConfig, save_config


def test_cli_applies_pending_restore_before_loading_cameras(tmp_path, monkeypatch):
    import spyder_cctv.cli as cli

    config = tmp_path / "config.json"
    save_config(config, [])
    payload = {
        "version": 1,
        "config": {
            "version": 1,
            "cameras": [asdict(CameraConfig("restored", 0, autostart=True))],
            "profiles": [],
        },
        "preferences": {"version": 1, "pause_when_unfocused": True},
        "workflows": {"workflows": []},
        "recording_settings": {"profile": "archive", "segment_minutes": 360},
    }
    (tmp_path / ".configuration-restore.json").write_text(json.dumps(payload), encoding="utf-8")

    class Server:
        server_port = 8765

        def serve_forever(self, **kwargs):
            raise KeyboardInterrupt

        def server_close(self):
            pass

    def create_server(manager, _port):
        assert list(manager.workers) == ["restored"]
        assert not manager.get_worker("restored").config.autostart
        return Server()

    monkeypatch.setattr(cli, "create_server", create_server)
    assert main(["--config", str(config), "gui", "--no-browser"]) == 0
    assert not (tmp_path / ".configuration-restore.json").exists()
    assert json.loads(config.read_text())["cameras"][0]["id"] == "restored"
