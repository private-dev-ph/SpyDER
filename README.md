# SpyDER CCTV

An installable Python foundation for concurrent webcam/CCTV monitoring and computer vision.
Requires Python 3.11 or newer. The main GUI is a local browser control room with a responsive
camera wall, persistent camera management, independent controls, and motion awareness.

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
spyder-cctv gui
```

The command opens `http://127.0.0.1:8765` in your default browser. Running `spyder-cctv` without
a subcommand also opens the GUI. First launch creates an empty user configuration if needed.
Press **Add camera**, enter a friendly name, and choose a webcam index, stream URL, or video
file. Webcam `0` is usually the first camera and `1` the second. Each source can be connected once.

The **Start now and automatically on launch** checkbox connects the feed and remembers it for
the next launch. **Pause** stops a camera for this session; it does not change that startup setting.
**Remove** stops the feed and removes it from the saved configuration after confirmation.
Add/remove changes are saved atomically; no restart is needed. Use **Start all** / **Pause all**
for bulk control, or a tile's own buttons for independent control.

The wall calculates columns from available width and camera count. **Tile size** offers Auto,
Compact, or Large; **Fit / Fill** preserves the full frame or crops to fill its tile. The focus button
enlarges one camera; **Escape** returns to the wall. Light mode is the default; the top-right theme
button switches to dark mode and remembers your choice. No external fonts or frontend build is
needed: HTML, CSS, and JavaScript are bundled with the installed Python package.

Ctrl+C in the launching terminal stops the server and cameras. Closing the browser alone keeps
the server running. Use `gui --no-browser` to run without opening a tab, or `serve` to require an
existing config. Use `python -m spyder_cctv` if the console command is not on PATH.

## Camera tuning and profiles

Open **Settings** on a camera tile. The app queries the driver's supported controls and reports
current values, limits, and steps. Windows webcams can expose **zoom, pan, tilt, brightness,
contrast, and saturation** through the native DirectShow interface. Unsupported controls are
disabled with an explanation. **FOV** is included in the settings model but is unavailable when
the driver has no standard FOV interface; it is not simulated with a software crop.
Native controls are currently implemented for Windows USB/built-in webcams. Other platforms,
network streams, and video files continue to capture video but report native tuning unavailable.

Select the controls you want to include, move their sliders, and choose **Apply to this camera**.
Changes are saved first, then applied asynchronously by that camera's capture worker. Readbacks
show actual driver values, including quantization, adjustments, or rejected settings. The live
preview shares the camera's existing feed. **Driver defaults** stages the selected controls'
defaults; it does not change the device until you apply. Controls are applied in manual mode
where the driver supports it. Settings not included in a request are left unchanged on the device.

Sliders and profiles use **0–100% of the supported device range**, not absolute degrees, optical
zoom ratios, or a percentage adjustment to the image. This lets the same profile adapt to different
camera ranges. Native device values are displayed below the sliders. A shared percentage does
not guarantee identical images or framing across different camera models.

To reuse a setup, enter a **New profile name** and click **Save as profile**. It saves the checked
controls and assigns the new profile to the current camera. Open **Profiles** above the camera
wall, select that profile, check target cameras, and choose **Assign to selected**. Unchecked
cameras keep their current assignments. You can also select and assign a profile in any camera's
Settings. Assignments made while paused apply on the next camera start.

Profiles are reusable snapshots. Applying custom settings to one camera detaches its profile
without modifying other cameras or the saved profile. Assign **Custom settings** to detach while
keeping the existing desired values. Save a new named profile for a revised setup. An assigned
profile must be detached from its cameras before it can be deleted. Unsupported controls in a
profile are skipped per camera and reported as partial application; supported controls still apply.
Creating a profile and assigning it are separate saves, so a failed assignment can leave a valid
saved profile available for retry.

Camera settings, profiles, and assignments live in the user configuration file and are restored
after restart. Older camera-only configurations are read automatically; the next save upgrades
them to the versioned schema. No configuration is written inside the installed package.

`init` prints the configuration path and refuses to overwrite an existing file. The default
configuration lives in the user's platform config directory (usually `%LOCALAPPDATA%/SpyDER`
on Windows, `~/.config/SpyDER` on Linux, or `~/Library/Application Support/SpyDER` on macOS).
For an explicit location, put the option before the command:

```text
spyder-cctv --config /absolute/path/config.json init
spyder-cctv --config /absolute/path/config.json serve --port 8766
```

You can also edit the JSON directly while the application is stopped:

```json
{
  "cameras": [
    {"id": "front", "name": "Entrance", "source": 0, "fps": 15, "pipeline": "motion", "autostart": true},
    {"id": "back", "name": "Side view", "source": 1, "fps": 15, "pipeline": "none", "autostart": true}
  ]
}
```

Sources can be device integers, RTSP/HTTP URLs, or video file paths. Relative file paths resolve
against the configuration directory. Each camera needs a unique ID and a distinct
source. Camera sources
and credentials are excluded from API status. Treat your configuration file as private.

## Current scope

- One capture thread and independent CV pipeline per camera.
- Responsive light/dark GUI, live counts, focus view, fit/fill, and independent or bulk controls.
- Add/remove camera controls with persistent settings and duplicate-source prevention.
- Driver-supported native Windows camera tuning with confirmed readbacks.
- Portable settings profiles, per-camera assignment, and bulk assignment from the GUI.
- OpenCV capture adapter and replaceable capture/pipeline/encoder interfaces.
- Validated user configuration and bundled dashboard assets that work from a wheel.
- No camera access during import, `init`, or `check`.

This is an application skeleton, not a production surveillance service. Recording, camera discovery,
network-camera ONVIF/PTZ protocols, vendor-specific FOV controls, object detection models,
automatic reconnect, and remote access remain future work.
Motion is a simple changed-pixel fraction, not an alarm or object classifier. Preview polling adapts
to camera count (up to roughly 8 FPS for a small wall), avoids overlapping requests, and pauses in
hidden tabs. Status updates approximately every 750 milliseconds. The
configured `fps` caps capture/processing attempts and does not reconfigure physical device FPS.

The server binds only to IPv4 loopback and rejects cross-origin controls. It has no user accounts
or TLS and should remain local. Camera codec/backend support depends on the installed OpenCV
wheel, OS, driver, and stream. A blocking native camera read/open cannot safely be killed by a
Python thread; shutdown reports a timeout and prevents reopening that worker while it is stopping.
For hard isolation and automatic recovery, add a process-based capture adapter.

See [architecture](docs/architecture.md) and [contributing](CONTRIBUTING.md).
