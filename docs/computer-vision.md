# Local computer-vision foundation

The installed application supports a `vision` pipeline in addition to `none`
and `motion`. Capture, models, and inference remain on the user's computer.
The Cloudflare export keeps its independent browser motion implementation;
it never imports Python engines or sends frames to an inference server.

## Engines and optional dependencies

OpenCV's built-in HOG person detector works with the base installation and needs
no downloaded weights. Choose **OpenCV person detection** when adding a camera.
It is a baseline detector, not a modern learned object detector. HOG returns an
uncalibrated `score`; the application does not label that score as confidence.

YOLO object detection and InsightFace face detection are optional. Reuse the
existing `.venv` and install only the extras you need:

```powershell
.venv/Scripts/python.exe -m pip install ".[yolo]"
.venv/Scripts/python.exe -m pip install ".[insightface]"
.venv/Scripts/python.exe -m spyder_cctv vision-info
```

For a wheel installation, use `pip install "spyder-cctv[yolo]"` or the wheel path
with its extra. These commands acquire optional software dependencies; model
acquisition is separate and explicit. They are not run automatically by SpyDER.
`vision-info` reports package versions and the user model directory without
importing ML libraries, loading models, or opening cameras. Presence of packages
is not a GPU or model compatibility test.

The project now uses **one `opencv-python` distribution**. Both current Ultralytics
and InsightFace depend on that distribution. Older SpyDER environments used
`opencv-python-headless`; stop the application and uninstall that distribution
before upgrading to avoid two wheels writing the same `cv2` namespace:

```powershell
.venv/Scripts/python.exe -m pip uninstall opencv-python-headless
.venv/Scripts/python.exe -m pip install --upgrade .
.venv/Scripts/python.exe -m pip check
```

Headless Linux machines may need `libgl1` and `libglib2.0-0` to import the standard
OpenCV wheel. The browser UI does not call `cv2.imshow`. InsightFace 2.1 supplies
a Python wheel; older 0.7.3 source builds are deliberately excluded. CPU ONNX
Runtime is the default. CUDA/PyTorch setup is hardware-specific; YOLO can select
`cuda:0` or `mps` when the installed runtime supports it. This InsightFace adapter
currently supports CPU only. Do not install both CPU and GPU ONNX Runtime wheels.
See [upstream compatibility research](cv-compatibility.md) for sources and licenses.

## Models and per-camera configuration

Models are not bundled or downloaded during camera startup. Obtain trusted,
appropriately licensed weights separately. PyTorch `.pt` files can contain
executable serialized code; use weights from a trusted supplier. The default
model directory is `platformdirs.user_data_path("SpyDER") / "models"` (normally
`%LOCALAPPDATA%/SpyDER/models` on Windows). No model directory is created just
by importing the application. Explicit paths can point to existing local files.

Stop the local app before editing its configuration. A camera entry can use:

```json
{
  "id": "entrance",
  "source": 0,
  "name": "Entrance",
  "fps": 15,
  "autostart": true,
  "pipeline": "vision",
  "vision": {
    "engine": "yolo",
    "model": "models/detector.pt",
    "device": "cpu",
    "inference_fps": 3,
    "confidence": 0.5,
    "input_size": 640,
    "max_detections": 100
  }
}
```

Model paths in configuration files resolve relative to that configuration file,
not the shell working directory. Programmatic relative model paths use the user
model directory. `check` validates the configuration schema without loading a
model. Each camera can choose its own engine, weights, and inference rate.

For InsightFace, use `engine: "insightface"` and a local SCRFD/RetinaFace detection
`.onnx` file. The adapter directly opens that file with `download=False` and
`CPUExecutionProvider`, avoiding `FaceAnalysis`'s model-pack downloader. It returns
face boxes and scores; recognition, identity matching, embeddings, age/gender,
and liveness are future extensions. Arbitrary ONNX exports are not interchangeable:
they require an adapter for their input/output format.

YOLO uses a verified existing `.pt` path and BGR NumPy frames, never camera URLs
or hosted endpoints. Before lazy import it sets `YOLO_OFFLINE=true` and
`YOLO_AUTOINSTALL=false`, then disables settings sync. These are process-wide
Ultralytics settings; applications embedding SpyDER should initialize this
adapter before importing Ultralytics. They prevent expected library download/
sync paths, rather than providing an operating-system network sandbox. The
application never passes captured frames to a network service.

## Extension contract and scheduling

`spyder_cctv.cv.contracts.Engine` defines `infer(frame) -> list[Detection]` and
`close()`. Frames are OpenCV-compatible NumPy arrays: HWC, `uint8`, BGR. Detection
boxes are source-frame pixel coordinates in `(x1, y1, x2, y2)` order. Results use
native JSON-safe values, finite probabilities, optional class IDs, and optional
raw classifier scores. Add new adapters through `create_engine`; tests and
embedding applications can inject an engine factory into `VisionPipeline`.

Each enabled camera owns one inference thread and engine instance. Model loading,
inference, and release happen on that thread. Capture retains its own thread.
Only one frame waits for inference; newer submitted frames replace that slot.
Submission rate, model input size, and detection count are bounded. Frames are
copied before handoff, so inference cannot mutate capture's preview. No frame
history or results archive is retained. Per-camera instances simplify ownership
but multiply model memory; start with a small number of cameras and low CV FPS.
Sharing a GPU scheduler/model pool is a future extension.

The existing camera status API exposes `metadata.cv`: engine, state, detections,
frame size, submission sequence, inference time, and result age. Result age is
measured from the analyzed frame's submission. Results can lag current preview;
no boxes are painted on a newer frame. Consumers must check age before acting on
a detection. The GUI shows counts/loading/setup errors while keeping preview live.

Missing dependencies, weights, or inference failures disable CV for that session
without stopping capture. Library exception text is not exposed to the web UI.
Fix the local setup, then pause/restart the camera to retry. Shutdown clears the
pending frame and waits for model release. If native inference remains blocked,
stop reports it and prevents another engine for that camera until the old thread
finishes. Python cannot forcibly terminate native inference safely; full process
isolation and automatic recovery remain future work.
