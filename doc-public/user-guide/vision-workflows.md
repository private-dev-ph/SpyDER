# Vision Lab and workflows

[Documentation home](../README.md)

## Motion analysis

Select a running camera in Vision Lab and enable analysis. Motion analysis is
independent per camera and disabled by default. Edits update a temporary preview;
**Apply** makes the draft active in Control Room and saves it. Draft analysis reuses
the existing camera rather than opening another device.

The preview comes first on phones, with motion settings below it. Larger screens
show the preview and settings side by side. The main settings include analysis,
contours, connected components, tracking, overlays, threshold, and minimum region
area. **Advanced tuning**, **Live diagnostics**, and **Hardware capacity** start
closed and expand when needed.

Choose **Draw ROI**, then drag across the preview to select a region. Drawing ends
after the gesture so you can scroll the page normally again. **Cancel drawing** or
Escape exits drawing mode. **Clear ROI** restores full-frame analysis. For keyboard
entry, expand **Precise ROI coordinates** and enter X, Y, width, and height as image
percentages. Letterboxing is excluded; side-by-side coordinates use the source
image. Choose **Original**, **Foreground mask**, or **Side by side** in the View
selector to inspect the draft.

**Apply settings** is the only action that saves the camera configuration.
**More actions → Reset defaults**, **Disable analysis**, and capacity
**Use recommendation** stage changes for preview; apply them when ready. Runtime
errors and tracker warnings remain visible even while diagnostics are closed.
The browser showcase keeps its preview and explanations available; native editing,
mask generation, and hardware assessment require the local Python runtime.

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

Open **Models & Workflows** in Vision Lab, choose **Models**, and use the model library to upload trusted
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

## Manage saved workflows

Click the **Workflow** picker to open the workflow library. Each row shows its name,
ID, enabled state, camera assignments, detection engines, and node/connection counts.
Search by name, ID, camera ID, or engine; combine status, camera, and engine filters.
Sort by name or show enabled workflows first. Results use pages of 25 or 50 rows so
large collections do not fill the editor with thousands of controls.

Use **Open** to edit a workflow. **More** provides Rename, Duplicate, Export, and
Delete. Renaming changes only the saved name and does not restart camera analysis.
Duplicates start disabled. Delete asks for confirmation and stops an enabled
workflow's actions. Opening another workflow, creating one, or duplicating one
asks before discarding unsaved edits; **Keep editing** returns to the Save button.
Save or export an edited workflow before renaming or deleting it from the library.
Use each row's **Enable** or **Disable** button to change the saved workflow
without opening it. Camera motion changes require confirmation in the library;
model conflicts and activation errors appear there. Unsaved editor edits stay
unchanged. Refresh and review again if the saved graph changes during activation.
The editor's activation controls remain available. Execution controls are disabled
in the static showcase.

The local library supports up to 5,000 workflows within a combined 64 MiB workflow
file. These limits describe saved configuration, not how many camera/CV pipelines
your hardware can run simultaneously. Browsing uses cached, paginated summaries;
only the selected graph and its debug data are loaded by the editor. The original
full-list API remains available for integrations.

In the static showcase, saved workflows live in this browser's IndexedDB storage
and execution stays disabled. Existing single-draft data remains editable; choose
**Save workflow** to add it to the new library. Storage is specific to the browser,
profile, and site origin, and can be cleared by browser settings. Export JSON files
for portable backups. No workflow data is sent to the showcase host.

## Inference follows active workflows and previews

The local application runs a camera's detector while at least one enabled workflow
needs detections from that camera. Disabling or deleting the last such workflow
idles inference while the live camera continues. Model settings remain saved;
loaded model weights stay available for resuming without another model load.
An idle camera is not a CV error and its old detection overlays are cleared.

Multiple workflows share the same camera worker and detector. Disabling one
workflow keeps inference running when another enabled workflow still needs it.
Raw video views, recording, status polling, and camera-only preview nodes do not
keep a face/object detector running.

A running workflow preview with an upstream Detections node temporarily keeps that
camera's configured detector active, including when its workflow is disabled.
Pause the preview, leave the editor, or hide its tab to stop renewing this lease;
it expires within five seconds. Previewing does not change saved model settings or
run workflow action nodes. An inference call already in progress may finish, but
its obsolete results are discarded and no further jobs are submitted while idle.
Identity confirmation starts fresh on resume.

Standalone camera workers outside the workflow application retain their explicit
pipeline behavior. The static showcase continues to perform no server inference.

## Build a workflow

The canvas is the main workspace. Tools open only when you need them:

Action buttons use locally bundled SVG icons. Hover over an icon or focus it with
Tab to see its short action name, such as **Undo**, **Save workflow**, or **Inspect
node**. Escape dismisses the helper. Node names, template choices, menu entries,
and confirmation choices keep their visible labels.

| Control | What it opens |
| --- | --- |
| Current workflow name | Saved workflow library: open, create, search, filter, duplicate, publish, enable/disable, rename, export, or delete. |
| **Workflow** menu | Workflow settings, templates, called workflows, execution history, recent events, import/export, and deletion. On phones, use the menu icon. |
| **Add node** | Searchable node palette. Click to add, or drag a node onto the canvas. |
| **Models** | Model registration/upload, search and filters, labels and metadata, usage checks, and removal. |
| **Inspect node** | Selected-node parameters, manual connections, connection removal, and validation review. |
| Double-click a node, press Enter on it, or select **Edit node** | Full node settings, IN/OUT signals, bindings, field help, and local code testing. |
| Canvas corner controls | Zoom in/out, reset zoom, and center the workflow. Drag empty canvas space to pan; arrow keys also pan when the canvas has focus. |

**Workflow → Workflow settings** contains the name, camera assignments, independent/callable execution mode, callable publishing, and history-saving policy. **Save workflow** keeps draft changes; **Enable workflow** is a separate action that can change active camera processing and may ask for confirmation. Opening a panel does not save or enable a workflow. Escape closes a panel and returns focus to its opener; close an open select picker or field-help tooltip first.

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

For manual removal, open **Inspect node** and expand **Connections**. This list starts
collapsed and shows each source, destination, input type, and optional connection
label. **Disconnect** removes that link while keeping both nodes. **Undo last edit**
restores an accidental disconnection. The list stays expanded while you make edits.

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

Choose **Templates** in the workflow toolbar to open the searchable template
picker. Each row includes a miniature graph, a description, suggested use, timing,
node count, and setup requirements. Loading a template creates a new **disabled**
draft. It does not overwrite a saved workflow, start a camera, or install a model.
Use **Undo** to restore the previous draft, including unsaved edits, during the
current editor session. Cancel or Escape closes the picker without changing it.

| Template | Purpose | Setup |
| --- | --- | --- |
| Pre-event unknown face recording | Save 10 seconds before and 20 seconds after an unknown face, with a 45-second cooldown. | Local InsightFace runtime, SCRFD 500MF detector, compatible face classifier, running camera, and idle local recorder. |
| InsightFace detection alert | Notify when a face or selected identity matches. | Local SCRFD 500MF detector and InsightFace runtime; optional compatible classifier; browser notification permission. |
| Face event log | Create named events without video attachments. | Select cameras with an existing InsightFace pipeline. |

The pre-event template connects Camera, the lightweight SCRFD 500MF Model, and a
Classifier to InsightFace Detections, followed by Filter, Cooldown, and Event.
A compatible registered classifier is selected when available; otherwise choose one
in the Classifier node before enabling. Review its labels, preprocessing, threshold,
and stability settings. Missing detector weights require explicit installation.

The Filter uses **Recognized identity → Is unknown**. It requires an explicit
rejection from the classifier or recognizer; detector-only faces and identities
still awaiting stability confirmation do not match. **Is known** matches accepted
identities. These conditions do not take a value or a live value link and cannot
use Model class as their identity source. A closed-set classifier can still assign
an unfamiliar face to a known class; this workflow cannot guarantee stranger detection.

The Event node has **Attachment → Recording** and starts/stops its own bounded clip;
no separate Record node is needed. Save and enable the draft, keep the camera
running, and allow its RAM buffer to warm up. History is best effort within memory
limits. Change clip timing and cooldown for your scene. Existing saved workflows
are unchanged; load the updated template to create a new disabled draft. See [Events and notifications](events.md#include-footage-before-a-trigger)
for buffer limits and recording behavior.

For InsightFace alerts, review the camera/model and intended class or identity
filter, cooldown, and notification message before enabling. A compatible registered
classifier is connected when available. Notification permission is requested when
adding/using notification nodes, not when browsing the template list.

Export workflow JSON for backup or reuse. It includes graph definitions, code, and
model references, not model weights, media, or machine paths. Imports open disabled;
review code and remap missing cameras/models before enabling. A workflow export is
not a full backup of the installation.

The Cloudflare showcase permits editing/import/export of drafts but does not execute
native models, code, previews, or workflow actions. See the [showcase capability
comparison](../deployment/cloudflare.md#capabilities).

## Reusable logic and previous executions

See [subflows and execution history](subflows-and-history.md) for versioned reusable
workflow definitions, run inspection, diagnostic dry runs, and retention settings.

## Enrolled face identities

Use Vision Lab’s Face galleries tab to enroll local identities and manage samples.
Select a gallery in a Classifier node connected to InsightFace Detections. See
[Face galleries and ONVIF cameras](face-galleries-and-onvif.md) for setup and storage details.
