# SpyDER CCTV

An installable Python foundation for concurrent webcam/CCTV monitoring and computer vision.
Requires Python 3.11 or newer. The initial interface is a local browser dashboard with independent
camera start/stop controls, JPEG previews, status, and a basic motion metric.

## Development environment

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -e ".[dev]"
.venv/Scripts/python.exe -m pytest
.venv/Scripts/python.exe -m ruff check .
.venv/Scripts/python.exe -m build
```

On Linux/macOS use `.venv/bin/python` instead. Activation is optional. Reuse an existing `.venv`
when available. Runtime dependencies are declared in `pyproject.toml`; the `dev` extra adds
testing, linting, and build tools. Version ranges support compatible updates; no exact dependency
lock is supplied yet. CI verifies Windows and Linux on Python 3.11 and 3.13.

## Run the installed application

Install the built wheel into a virtual environment with `python -m pip install <wheel-path>`.
Then run these commands from **any working directory**:

```text
spyder-cctv init
spyder-cctv check
spyder-cctv serve
```

Open the printed `http://127.0.0.1:8765` URL. The default example defines device `0`, with
autostart disabled. Press **Start** to open it. Ctrl+C stops the server and signals all cameras.
Use `python -m spyder_cctv` if the console command is not on PATH.

`init` prints the configuration path and refuses to overwrite an existing file. The default
configuration lives in the user's platform config directory (usually `%LOCALAPPDATA%/SpyDER`
on Windows, `~/.config/SpyDER` on Linux, or `~/Library/Application Support/SpyDER` on macOS).
For an explicit location, put the option before the command:

```text
spyder-cctv --config /absolute/path/config.json init
spyder-cctv --config /absolute/path/config.json serve --port 8766
```

Edit the JSON and restart the application to change cameras:

```json
{
  "cameras": [
    {"id": "front", "source": 0, "fps": 10, "pipeline": "motion", "autostart": true},
    {"id": "back", "source": 1, "fps": 10, "pipeline": "none", "autostart": false}
  ]
}
```

Sources can be device integers, RTSP/HTTP URLs, or video file paths. Relative file paths resolve
against the configuration directory. Each camera needs a unique ID and preferably a distinct
source; opening the same physical device twice can fail depending on its driver. Camera sources
and credentials are excluded from API status. Treat your configuration file as private.

## Current scope

- One capture thread and independent CV pipeline per camera.
- Start/stop controls, status, fresh JPEG snapshots, and a polling multi-camera dashboard.
- OpenCV capture adapter and replaceable capture/pipeline/encoder interfaces.
- Validated user configuration and bundled dashboard assets that work from a wheel.
- No camera access during import, `init`, or `check`.

This is an application skeleton, not a production surveillance service. Recording, camera discovery,
PTZ/ONVIF controls, object detection models, automatic reconnect, and remote access remain future work.
Motion is a simple changed-pixel fraction, not an alarm or object classifier. Preview polling is 2 Hz;
configured `fps` caps capture/processing attempts and does not reconfigure physical device FPS.

The server binds only to IPv4 loopback and rejects cross-origin controls. It has no user accounts
or TLS and should remain local. Camera codec/backend support depends on the installed OpenCV
wheel, OS, driver, and stream. A blocking native camera read/open cannot safely be killed by a
Python thread; shutdown reports a timeout and prevents reopening that worker while it is stopping.
For hard isolation and automatic recovery, add a process-based capture adapter.

See [architecture](docs/architecture.md) and [contributing](CONTRIBUTING.md).
