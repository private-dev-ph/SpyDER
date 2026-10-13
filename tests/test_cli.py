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
