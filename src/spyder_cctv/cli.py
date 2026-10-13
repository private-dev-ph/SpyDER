"""Installed console entry point."""

import argparse
import json
import logging
import webbrowser
from importlib.metadata import version
from importlib.resources import files
from pathlib import Path

from spyder_cctv.cameras import CameraManager
from spyder_cctv.config import default_config_path, load_app_config, save_config
from spyder_cctv.cv.diagnostics import engine_info
from spyder_cctv.showcase import export_showcase
from spyder_cctv.web import create_server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="SpyDER local camera monitoring")
    parser.add_argument("--version", action="version", version=version("spyder-cctv"))
    parser.add_argument("--config", type=Path, default=default_config_path())
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("init", help="Create a safe example configuration; never overwrite")
    commands.add_parser("check", help="Validate configuration without opening cameras")
    commands.add_parser("vision-info", help="Inspect optional CV packages and local model location")
    showcase = commands.add_parser("export-showcase", help="Export a browser-only static showcase")
    showcase.add_argument("--output", type=Path, default=Path("dist/showcase"))
    serve = commands.add_parser("serve", help="Start the local dashboard")
    serve.add_argument("--port", type=int, default=8765)
    gui = commands.add_parser("gui", help="Open the camera control room in your browser")
    gui.add_argument("--port", type=int, default=8765)
    gui.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    if args.command is None:
        args.command, args.port, args.no_browser = "gui", 8765, False
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        if args.command == "vision-info":
            print(json.dumps(engine_info(), indent=2))
            return 0
        if args.command == "export-showcase":
            export_showcase(args.output)
            print(f"Static showcase: {args.output.resolve()}")
            return 0
        if args.command == "init":
            args.config.parent.mkdir(parents=True, exist_ok=True)
            with args.config.open("x", encoding="utf-8") as target:
                target.write(files("spyder_cctv").joinpath("assets/example.json").read_text())
            print(f"Created {args.config}")
            return 0
        args.config = args.config.resolve()
        if args.command == "gui" and not args.config.exists():
            save_config(args.config, [])
        config = load_app_config(args.config)
        cameras = config.cameras
        if args.command == "check":
            print(f"Valid configuration: {len(cameras)} camera(s)")
            return 0
        if not 0 <= args.port <= 65535:
            raise ValueError("port must be between 0 and 65535")
        manager = CameraManager(cameras, config_path=args.config, profiles=config.profiles)
        server = create_server(manager, args.port)
        try:
            manager.start_configured()
            print(f"Dashboard: http://127.0.0.1:{server.server_port}", flush=True)
            print("Press Ctrl+C to stop.", flush=True)
            if args.command == "gui" and not args.no_browser:
                webbrowser.open(f"http://127.0.0.1:{server.server_port}")
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
