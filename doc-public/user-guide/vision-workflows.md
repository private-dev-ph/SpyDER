# Vision Lab and workflows

[Documentation home](../README.md)

## Motion analysis

Select a running camera in Vision Lab and enable analysis. Motion analysis is
independent per camera and disabled by default. Edits update a temporary preview;
**Apply** makes the draft active in Control Room and saves it. Draft analysis reuses
the existing camera rather than opening another device.

| Feature | Purpose |
| --- | --- |
| MOG2 background subtraction | Separate foreground changes from a learned stationary background. |
| Connected components | Find and filter moving regions by area. |
| Contours | Describe region outlines. |
| MIL tracking | Follow a small bounded set of targets across frames. |
| Region of interest (ROI) | Restrict analysis to a selected rectangle. |

Start with defaults: 480-pixel analysis width, 5 analysis FPS, threshold 16, history
300, 0.5% minimum area, 15 warm-up frames, shadow detection on, and at most two tracks.
Let the background settle before judging motion. A moved camera or resolution change
needs another warm-up. Increase minimum area to reject small disturbances; reduce
analysis width/FPS or tracker count to reduce CPU work. Tracking IDs belong to the
session; they are neither recognized people nor semantic object classes.

Applied overlays appear in Control Room and can be included in recordings/captures.
Use the capacity assessment to compare estimated motion/region/tracking costs. Its
synthetic benchmark is guidance, not a guarantee for a particular camera count or
for YOLO/InsightFace workloads.

## Install optional engines

Stop the app and use the existing environment. These commands retain editable mode:

```powershell
.\.venv\Scripts\python.exe -m pip install --no-build-isolation -e ".[dev,yolo]"
.\.venv\Scripts\python.exe -m pip install --no-build-isolation -e ".[dev,insightface]"
.\.venv\Scripts\python.exe -m spyder_cctv vision-info
```

Install only the extras you need. Dependency installation can download packages;
inference runs on the user's computer. The base installation includes OpenCV HOG
person detection without model weights. HOG is a baseline person detector and its
score is not a calibrated probability.

The project uses `opencv-python`. Avoid installing competing OpenCV distributions
into the same environment because they share `cv2`. GPU support depends on the
engine and installed runtime; the current InsightFace adapter uses CPU ONNX Runtime.
Dependency diagnostics do not prove model compatibility or hardware acceleration.

## Add a model

Open **Models & Workflows** in Vision Lab and use the model library to upload trusted
weights or register an existing local file. Uploads are copied into managed storage;
registration records a path, so the original file must remain accessible. The library
persists across restarts with the same application data root. Its current limits are
64 entries and 256 MiB per upload. Changing only the recording output does not move it.

| Model role | Expected input |
| --- | --- |
| YOLO detection | A supported local Ultralytics `.pt` or `.onnx` export. |
| InsightFace face detection | A supported SCRFD/RetinaFace detection ONNX model. |
| InsightFace recognition | A compatible separate recognition ONNX model and identity gallery. |
| InsightFace classification | A compatible classifier ONNX model with output labels. |

The Model node contains the built-in detector chooser. **SCRFD 500MF** is the default;
2.5GF and 10GF offer other compute/quality tradeoffs. Missing built-in detector files
are acquired only through an explicit installation action. Read the displayed license
notice before installing upstream weights. RetinaFace uses a separately supplied model.

An arbitrary ONNX file or training checkpoint is not interchangeable with these
roles. The current classifier expects a single 112 × 112 float RGB input and matching
output/class labels. Select the preprocessing expected by the model: ArcFace
normalization or embedded model preprocessing. It is not the detector and does not
combine with gallery recognition in the same configuration. Inspect metadata, then
validate actual inference with representative inputs.

The library reads supported metadata aliases and lets users supply labels when
necessary. Class metadata enables dropdowns; it does not prove correct preprocessing,
compatible outputs, accuracy, or unknown-person rejection. A closed-set classifier
can assign an unfamiliar face to a known class. Thresholds and stability settings can
reduce noisy changes but cannot guarantee rejection. Use trusted `.pt` files: serialized
PyTorch weights may contain executable content. Remove unused entries through the
library; referenced models must first be detached from their users.

## Build a workflow

1. Create a workflow and add a **Camera** node for a configured source.
2. Add a **Model** node and choose the uploaded model or built-in detector.
3. Add a **Detections** node and select the matching detection engine.
4. Connect Camera to its camera input and Model to its model input.
5. For InsightFace classification, add an **InsightFace classifier** node. Select
   its labeled classifier model, match the output mode and preprocessing, and review
   the threshold, confirmation counts, and score margin. Connect its output to the
   Detections node's CLASSIFIER input.
6. Connect detections to filters, regions, counts, or code, followed by an action
   such as Event, Notification, Capture, or Record. Add a cooldown for repeated matches.
7. Save the draft, start the camera separately, and choose **Enable workflow**.
   Review camera/model changes and confirm activation.

Double-click a node to edit it. Nodes accept multiple compatible connections, but
port types still constrain what can connect. Pan and zoom the canvas to navigate.
Hover a connection and use its delete control to remove the edge without deleting
nodes. Drag a connected input end to reconnect the existing edge.

The input/output panels show available signals. Drag an upstream signal into a
supported setting to create a live binding; fixed class choices remain available.
A live binding follows upstream data rather than copying one displayed value.

One camera has one active model pipeline. Conflicting model assignments to the same
camera are rejected. InsightFace activation can disable MOG2 and replace the camera's
motion pipeline; the activation review makes that change explicit. **Disable workflow**
stops workflow actions but does not restore the previous model or motion settings.

## Filters, code, and previews

Choose **Model class** to filter labels reported by a model, or **Recognized identity**
to compare recognized names from recognition/gallery results. Add multiple rules
inside one filter and choose positive or negative conditions. When class metadata is
available, choose labels from the dropdown; otherwise enter the expected value.

Code nodes support restricted Python or JavaScript transformations. They receive
`detections` and read-only `context` and assign the result list to `output`. For example:

```javascript
output = detections.filter(d => (d.confidence || 0) >= 0.8);
```

```python
output = [d for d in detections if (d.get("confidence") or 0) >= 0.8]
```

Execution is bounded and does not provide general file, import, or network access.
Treat imported graph code as something to review before enabling, not a general
plugin system.

Connect a **Preview** node to the camera and desired result branch. Its CAM input
supplies frames; its DATA input supplies workflow results for overlays. Start/pause
the live view inside the node. Moving nodes or editing an unrelated branch should
preserve that preview; changing its upstream processing can invalidate it.

## Templates and exchange

The **InsightFace notification template** creates a disabled starting graph. Select
the camera/model, configure the intended class or identity filter, review the cooldown
and notification message, then enable it. For durable records or evidence, add/configure
an Event node as described in [Events and notifications](events.md).

Export workflow JSON for backup or reuse. It includes graph definitions, code, and
model references, not model weights, media, or machine paths. Imports open disabled;
review code and remap missing cameras/models before enabling. A workflow export is
not a full backup of the installation.

The Cloudflare showcase permits editing/import/export of drafts but does not execute
native models, code, previews, or workflow actions. See the [showcase capability
comparison](../deployment/cloudflare.md#capabilities).
