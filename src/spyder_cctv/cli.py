"""Installed console entry point."""

import argparse
import logging
from importlib.metadata import version
from importlib.resources import files
from pathlib import Path

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import default_config_path, load_config
from spyder_cctv.web import create_server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="SpyDER local camera monitoring")
    parser.add_argument("--version", action="version", version=version("spyder-cctv"))
    parser.add_argument("--config", type=Path, default=default_config_path())
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init", help="Create a safe example configuration; never overwrite")
    commands.add_parser("check", help="Validate configuration without opening cameras")
    serve = commands.add_parser("serve", help="Start the local dashboard")
    serve.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        if args.command == "init":
            args.config.parent.mkdir(parents=True, exist_ok=True)
            with args.config.open("x", encoding="utf-8") as target:
                target.write(files("spyder_cctv").joinpath("assets/example.json").read_text())
            print(f"Created {args.config}")
            return 0
        cameras = load_config(args.config.resolve())
        if args.command == "check":
            print(f"Valid configuration: {len(cameras)} camera(s)")
            return 0
        if not 0 <= args.port <= 65535:
            raise ValueError("port must be between 0 and 65535")
        manager = CameraManager(cameras)
        server = create_server(manager, args.port)
        try:
            manager.start_configured()
            print(f"Dashboard: http://127.0.0.1:{server.server_port}", flush=True)
            print("Press Ctrl+C to stop.", flush=True)
            try:
                server.serve_forever(poll_interval=0.2)
            except KeyboardInterrupt:
                pass
        finally:
            server.server_close()
            manager.close()
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        logging.error("%s", error)
        return 1
