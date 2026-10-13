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
| `controls.py` | Validated normalized settings, native range conversion, per-control readbacks |
| `directshow.py` | Worker-owned Windows control-only COM interfaces and capability ranges |
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

## Settings and profiles

Configuration schema version 1 contains `cameras` and `profiles`. Legacy `{ "cameras": [...] }`
documents migrate in memory and are upgraded on the next save. A camera has either its own
`settings` dictionary or a `profile_id`, never both. Named profiles hold normalized settings
snapshots and stable IDs. Profile IDs/names are unique; camera references must resolve. The
composition root reads `load_app_config()` and passes both cameras and profiles to the manager.

The manager persists a proposed assignment/settings change atomically before publishing it to
the worker. It increments the worker's desired-settings revision without waiting on device I/O.
Between reads, the worker applies the latest revision, records per-control readbacks, and marks
that revision applied. If intent changes during an operation, the next loop applies the newer
revision. Capture continues independently for other cameras. No driver get/set call runs on an
HTTP thread, and no state lock is held during hardware operations. Settings states distinguish
`pending`, `scheduled`, `applied`, and `partial`; unsupported, failed, rejected, or adjusted
controls are reported individually. Profile assignments survive stopped cameras and restarts.

Windows integer sources use a control-only DirectShow device binding alongside the existing
OpenCV stream. This creates no second video stream or capture graph. All COM interfaces are
created, queried, set, and released on the capture thread. `WinDLL` permits explicit HRESULT
handling when OpenCV already initialized a different COM apartment. Range and manual-mode
support come from [IAMVideoProcAmp::GetRange](https://learn.microsoft.com/en-us/windows/win32/api/strmif/nf-strmif-iamvideoprocamp-getrange)
and [IAMCameraControl::GetRange](https://learn.microsoft.com/en-us/windows/win32/api/strmif/nf-strmif-iamcameracontrol-getrange).
Discovery reads only; it never writes a test value to infer support. The driver binding uses the
same device enumeration category/index as OpenCV DirectShow.

Settings are percentages of each supported native range, rounded to the reported step without
exceeding that range. Set results are verified with Get readbacks; accepted but different values
are reported as adjusted. One failure does not roll back successful device changes or stop video.
Profiles store desired intent, not a guarantee that every camera applied every control. The
standard [OpenCV property API](https://docs.opencv.org/4.x/d4/d15/group__videoio__flags__base.html)
does not supply a generic FOV property. FOV remains a supported schema key for future native
adapters but is disabled by this standard DirectShow adapter. Other platforms/source types
currently report native controls unavailable. Extend the `DeviceControls` seam for additional
platforms or vendor interfaces; do not substitute software image transforms for hardware control.

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

`GET /api/cameras/{id}/settings` returns cached capabilities, desired settings, readbacks, and
application state. `POST /api/cameras/{id}/settings` accepts `{ "settings": { "brightness": 50 } }`.
`GET /api/profiles` lists profiles/assignments; `POST /api/profiles` accepts a name and settings.
`POST /api/cameras/{id}/profile` accepts `{ "profile_id": "..." }`, or null to detach and retain
desired values. Settings/assignment writes return 202 because hardware applies asynchronously.
`POST /api/profiles/{id}/remove` rejects assigned profiles with 409. All mutations use the same
control header, loopback Host, and Origin guards. GET preview/status requests use HTTP/1.1
connection reuse; POST action requests close their connection to discard any unused request body.

The GUI uses the supplied red/gold palette with neutral cream or charcoal surfaces, light by
default. Theme and density preferences belong to browser localStorage, not the camera config.
The camera grid responds to width and camera count. Each tile fetches at most one frame at a
time, revokes previous blob URLs, and cancels work on removal, disconnection, or hidden tabs.
Preview cadence decreases as more cameras are added. Focus view suspends the other previews
and makes background controls inert; Escape restores focus to the originating button.
Capture uses DirectShow for integer webcam sources on Windows and OpenCV's default backend
for other sources/platforms. Browser assets use package resources from either editable or wheel
installs. `gui` creates empty configuration on first launch; it never overwrites an existing file.

## Computer vision engines

`cv/contracts.py` defines validated per-camera model options, standard pixel-box
detections, and the engine lifecycle. `cv/engines.py` lazily adapts OpenCV HOG,
Ultralytics YOLO, and InsightFace ONNX detection. `cv/runtime.py` separates model
loading/inference from capture with one replaceable pending frame per camera.
Engine errors become bounded metadata instead of stopping preview. Engines stay
thread-owned; pipeline cleanup runs when capture stops. A hung inference worker
blocks duplicate engine startup for that camera. See [CV guide](computer-vision.md).

## Static showcase runtime

`showcase.py` exports packaged assets into a new static directory. `showcase.js`
implements the dashboard's camera/profile contract entirely in the browser,
without calling the loopback API. The installed GUI continues to use Python.
The showcase uses MediaStream tracks for webcams, Blob URLs for chosen files,
Canvas for bounded preview/motion buffers, and origin-scoped localStorage for
profiles. Camera state belongs to the current tab; it never requests webcam
permission on page load. Generated feeds make the wall immediately usable.
Track capabilities gate hardware controls; real settings readback determines
whether constraints applied. Pause/removal/page exit releases owned tracks.
The static CSP forbids network connections. Cloudflare serves assets only;
there are no server functions or storage bindings. See [hosting guide](cloudflare.md).

## Recording and frame captures

`recording.py` owns one writer thread per active composite session. It samples
fresh JPEGs from existing camera workers; it never opens another device backend.
Frames are letterboxed into a fixed 1080p grid whose dimensions respond to selected
camera count. Recording membership retains capture across GUI idle transitions.
The writer performs native I/O outside its state lock so status and stop timeouts
remain responsive. Close finalizes recording before camera-manager shutdown.

Finalized videos and captures live in the user media directory, never package
resources or the current working directory. A validated, atomic local manifest
indexes opaque media IDs. The HTTP adapter streams cataloged downloads in bounded
chunks with the existing loopback and Origin protections. See [recording](recording.md).

`browser-recording.js` provides the same recording/capture contract in the static
showcase using Canvas and MediaRecorder. It uses a separate capture canvas,
serialized mutations, recording-retention rollback, and a bounded Blob library.
`workspaces.js` uses the Python API locally and the browser media adapter in the
showcase. Both use packaged assets and keep media on the user's computer.

## Local backend limitations and growth

OpenCV's [VideoCapture API](https://docs.opencv.org/4.x/d8/dfe/classcv_1_1VideoCapture.html)
depends on device/backend behavior. Native reads can block beyond the shutdown deadline. Python
threads cannot terminate these calls safely; a subprocess boundary is the next step for untrusted
streams and stronger recovery. No automatic reconnection policy is implemented.

The HTTP server is a small local adapter for this skeleton. Remote deployment requires an
authenticated production server and a separate authorization model. Automatic media retention
and process isolation for native encoders remain future work. Network-camera ONVIF/PTZ and vendor-specific FOV need
additional device-control adapters; retain worker ownership. Package future model assets in the
application or acquire them into user data
directories; never assume a source-tree `models/` folder exists after installation.
