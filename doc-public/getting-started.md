# Getting started

[Documentation home](README.md)

## Requirements

- Python 3.11 or newer.
- A browser and a local camera, supported stream, or video file.
- Write access to the configuration and recording folders.

The interface is bundled HTML, CSS, and JavaScript. Running SpyDER does not require
npm, a Node server, or a frontend build. Optional computer-vision engines need
additional dependencies and compatible model files.

## Install from a checkout

Run these PowerShell commands from the repository root. Reuse the existing `.venv`;
create it only when setting up a checkout that does not have one.

```powershell
if (-not (Test-Path .\.venv\Scripts\python.exe)) {
    python -m venv .venv
}
.\.venv\Scripts\python.exe -m pip install "setuptools>=77,<81" wheel
.\.venv\Scripts\python.exe -m pip install --no-build-isolation -e ".[dev]"
.\.venv\Scripts\python.exe -m spyder_cctv gui
```

On Linux/macOS, use `.venv/bin/python` instead. Some Linux systems also need the
OpenCV runtime libraries `libgl1` and `libglib2.0-0` from their package manager.
An editable installation reads application source and assets from the checkout.
For packaged installations and release checks, see the [development guide](development/guide.md).

## Connect a camera

1. Open the printed address, normally `http://127.0.0.1:8765`.
2. Choose **Add camera**, select a source, and give it a recognizable name.
3. Start the camera and verify its live frame before enabling analysis or recording.
4. Add more cameras to build the tiled wall. Use **Layouts** for a saved arrangement.

The first GUI launch creates an empty configuration without overwriting an existing
one. Configuration uses a platform-specific user folder. To choose a separate
installation data location, provide a configuration path before the command:

```powershell
.\.venv\Scripts\python.exe -m spyder_cctv --config .\.pytest_cache\trial\config.json gui
```

This creates separate configuration, workflows, events, models, and default media
for a trial. It does not isolate physical hardware: another app can still hold the
same camera. See [data and privacy](reference/data-and-privacy.md) before moving data.

## Common commands

| Command | Purpose |
| --- | --- |
| `python -m spyder_cctv gui` | Start the local server and open the browser. |
| `python -m spyder_cctv gui --no-browser` | Start without opening a browser tab. |
| `python -m spyder_cctv gui --port 8766` | Use a different local port. |
| `python -m spyder_cctv --config <file> check` | Validate an existing configuration without opening cameras. |
| `python -m spyder_cctv vision-info` | Report optional CV dependencies and model location. |

Use the environment's Python for these commands. Global options such as `--config`
and `--media-dir` go before `gui`; `--port` and `--no-browser` go after it.
The installed console command `spyder-cctv` exposes the same interface.

## Stop and update

Finish active recordings, then press **Ctrl+C in the launching terminal**. Closing
the browser does not stop the Python server. For editable asset changes, refresh
the page; for Python changes, restart the server. Dependency changes require
reinstalling the editable package. The [development guide](development/guide.md)
explains these cases in detail.

Next: [Camera setup](user-guide/cameras.md), [recording](recording-storage.md), or
[the browser-only showcase](deployment/cloudflare.md).
