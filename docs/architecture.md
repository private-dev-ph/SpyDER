# Architecture

`src/spyder_cctv` is the installed package. `pyproject.toml` defines build metadata, dependencies,
the console script, and package data using the standard [PyPA conventions](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/).
The distribution is called `spyder-cctv` to avoid conflicting with the Spyder IDE package.

## Boundaries

| Module | Responsibility |
| --- | --- |
| `cli.py` | Composition root: parse options, load config, start server, clean up |
| `config.py` | Immutable camera settings, validation, platform config paths, atomic saving |
| `cameras.py` | Camera lifecycle, concurrent workers, dynamic registry, locked snapshots |
| `capture.py` | Capture protocol, OpenCV adapter, JPEG encoder |
| `vision.py` | Pipeline protocol, passthrough and motion implementations |
| `web.py` | Loopback HTTP adapter and independent camera controls |
| `assets/` | Read-only dashboard and example config bundled in wheel/sdist |

The manager creates workers but opens no devices. `start()` creates a daemon worker thread, which
constructs its capture and pipeline, reads/processes frames, and releases its capture in `finally`.
Only this thread touches the OpenCV handle. API handlers read snapshots or signal lifecycle actions.
The worker lock protects state, not slow camera reads or CV processing. Each worker retains only its
latest JPEG and metadata, preventing unbounded queues when clients are slow.

States are `stopped`, `starting`, `running`, `stopping`, and `error`. Start is idempotent while active.
Stop signals first, then waits up to two seconds. Start during an unfinished stop returns a conflict.
Capture/processing failure affects only that camera, clears its preview, and allows manual restart.
Manager shutdown signals every worker before waiting against one shared deadline.
Closing the manager is terminal: late requests cannot restart a worker after shutdown begins.
Lifecycle calls serialize independently of the state lock, and waiting for control ownership
counts against the shutdown deadline.

The manager serializes registry mutations and control requests separately from capture threads.
Add validates unique IDs and sources, saves the proposed list, then publishes the worker. Remove
stops the worker, saves the remaining list, closes the removed worker permanently, then publishes
the list. Failed writes leave the existing registry and configuration intact (a failed removal can
leave that camera paused). Status reads take a registry snapshot to avoid iteration races.
Configuration writes use a temporary file beside the target, flush/fsync, and atomic replacement.

`CameraManager` accepts factories for capture and pipeline objects, plus an encoder. A fresh pipeline
is created on each start to keep temporal CV state isolated. Extend these seams for detectors,
hardware adapters, or tests; keep transport and device code out of pipeline algorithms.

## Installed application contract

Read packaged assets through `importlib.resources`, not paths relative to the checkout or executable.
Configuration belongs in `platformdirs.user_config_path`, or at the explicit `--config` path.
Resolve video files relative to that config directory. Never write to the installed package. Future
recordings, downloaded models, cache, and logs should use the corresponding platformdirs data,
cache, and log directories, with explicit overrides for deployment. No such artifacts are created yet.

The local API provides `GET /api/cameras`, `GET /api/cameras/{id}/frame`, and
`POST /api/cameras` to add, and `POST /api/cameras/{id}/start`, `/stop`, or `/remove`.
Controls require `X-Spyder-Control: 1`. Add accepts JSON camera settings and generates an ID
if omitted; it returns 201. Invalid settings return 400, duplicate IDs/sources return 409,
and configuration write failures return 500 without publishing the changed registry.
Use the printed IPv4 URL so the Host guard accepts requests. Frame routes return 503 when no
fresh frame is available; control conflicts return 409; unknown routes/cameras return 404.

The GUI uses the supplied red/gold palette with neutral cream or charcoal surfaces, light by
default. Theme and density preferences belong to browser localStorage, not the camera config.
The camera grid responds to width and camera count. Each tile fetches at most one frame at a
time, revokes previous blob URLs, and cancels work on removal, disconnection, or hidden tabs.
Preview cadence decreases as more cameras are added. Focus view suspends the other previews
and makes background controls inert; Escape restores focus to the originating button.
Capture uses DirectShow for integer webcam sources on Windows and OpenCV's default backend
for other sources/platforms. Browser assets use package resources from either editable or wheel
installs. `gui` creates empty configuration on first launch; it never overwrites an existing file.

## Limitations and growth

OpenCV's [VideoCapture API](https://docs.opencv.org/4.x/d8/dfe/classcv_1_1VideoCapture.html)
depends on device/backend behavior. Native reads can block beyond the shutdown deadline. Python
threads cannot terminate these calls safely; a subprocess boundary is the next step for untrusted
streams and stronger recovery. No automatic reconnection policy is implemented.

The HTTP server is a small local adapter for this skeleton. Remote deployment requires an
authenticated production server and a separate authorization model. Recording needs a bounded
sink interface and retention policy. PTZ needs a separate device-control protocol; do not call a
capture handle from HTTP threads. Package any future model assets or acquire them into user data
directories; never assume a source-tree `models/` folder exists after installation.
