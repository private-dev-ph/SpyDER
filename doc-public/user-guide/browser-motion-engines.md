# Browser motion engines

[Documentation home](../README.md)

## Select an engine

In the Cloudflare showcase or its local static preview, open a camera's **Settings → Browser motion engine**. Select **Frame difference** or **MOG2 background subtraction (OpenCV.js)**, then use **Apply motion engine**. Image tuning's Apply button and saved tuning profiles remain separate. The choice and motion options persist for bundled sample cameras; webcam and visitor-file access remain session-bound.

Frame difference remains the lightweight default. OpenCV is downloaded only when MOG2 is first selected. Loading, warm-up, analysis rate, processing time, region count and shared WebAssembly heap appear in the camera settings. Control Room shows MOG2 foreground-region boxes. Failure keeps the camera video and captures available, reports an error, and offers explicit retry or selection of Frame difference. There is no silent substitution of algorithms.

## What MOG2 runs

The browser uses the real OpenCV 4.12.0 `BackgroundSubtractorMOG2`, compiled to WebAssembly. Each camera has its own background subtractor; all its browser workflows share the resulting mask. One dedicated browser worker hosts up to eight MOG2 cameras and keeps processing off the interface thread. Additional cameras can use Frame difference. Stopping the last active MOG2 camera or switching its engine releases the worker and its heap.

Processing follows the native motion path: resize, grayscale conversion, MOG2, shadow/foreground thresholding, 3×3 morphological opening and closing, ROI-aware connected components, and minimum-area filtering. Warm-up suppresses foreground actions until the configured number of analyzed frames has arrived. Region guides and boxes are UI overlays, not baked into capture/recording pixels.

This implements MOG2 and foreground-region boxes, plus optional MIL tracking on the bundled porch scene. Identity recognition and the Vision Lab draft-mask editor still require the installed application. Browser resize sampling, scheduling, resolution and OpenCV builds can produce different masks or throughput from Python; matching the algorithm does not guarantee identical frame-by-frame output.

## Optional porch MIL tracking

Open **Front porch: person and parcel → Settings → Browser motion engine**, select **MOG2**, enable **MIL tracking · one porch object**, and apply. It starts disabled. The choice persists for the bundled sample camera.

This uses the real OpenCV `TrackerMIL`, seeded from the largest eligible MOG2 foreground region inside the approach ROI. Its red box and temporary track ID appear in Control Room. It tracks an image patch, not a recognized person: shadows, parcels, occlusion and fast motion can cause drift or reacquisition. IDs reset on clip loops and seeks and must not be treated as identities.

The showcase enforces **one tracked object on one porch camera per tab**, even if the same clip is added twice. Other feeds keep their existing motion engines. Disable MIL on the selected porch camera before assigning it to another copy. Tracking updates are capped at **2 FPS** and may run slower on busy devices. MOG2 keeps its separate requested analysis rate. Settings report tracking state, update cost and measured cadence; a tracker failure leaves background subtraction and video available. Reapply to retry.

No additional model or runtime download is required beyond the existing optional OpenCV asset. Loop/reset, stop, removal and engine changes release the tracker; stopping the last MOG2 camera releases the shared worker. The limit is per browser tab, not a cross-tab hardware quota. Tracks are display-only overlays; capture and recording pixels remain clean. Browser workflow motion conditions still use MOG2's foreground mask, not MIL identities or track IDs.

## Settings

| Setting | Meaning |
| --- | --- |
| Analysis rate | Requested inference cadence, 1–15 FPS. Measured cadence may be lower under load. |
| Input width | 320px for lower load, or 480px to match the native default width. Aspect ratio is preserved. |
| History | Number of frames influencing background adaptation, 20–2000. |
| Foreground threshold | MOG2 variance threshold, 4–128. This is distinct from a workflow's motion-fraction threshold. |
| Minimum region area | Component area as a percentage of the entire analysis image, 0.01–25%. It filters displayed regions; workflows still receive the full foreground mask for their own ROIs. |
| Warm-up frames | Initial analyzed frames suppressed after a background reset, 0–120. Frame count is not a fixed wall-clock duration. |
| Learning rate | `-1` selects OpenCV's automatic rate; `0` freezes learning and `1` relearns from the current frame. Values between 0 and 1 are supported. |
| Detect shadows | Excludes pixels identified as shadows. Dark clothing can resemble a shadow in grayscale footage; test the setting against the scene. |

Other sources use native-style defaults: history 300, variance threshold 16, shadows on, region area 0.5%, warm-up 15, analysis rate 5 FPS. Bundled person scenes recommend shadows off, region area 0.1%, and five warm-up frames to retain dark clothing and distant subjects while accommodating the eight-second loops. These values are visible and editable. They are scene tuning, not a person classifier.

Looping or seeking a demo clip resets its learned background and regions. Reconfiguration, tuning changes and source-size changes also invalidate old results. A generation check prevents delayed worker responses from painting a later loop or configuration. Camera and recording sessions continue through motion resets.

## Workflow sensitivity

A Browser motion node has independent **Frame difference fraction** and **MOG2 foreground fraction** fields. Both are normalized fractions inside its ROI, but their meanings differ: inter-frame changes versus foreground against learned background. The selected camera engine determines which threshold is used. There is no hidden scaling of results.

Updated Approach templates include scene-specific thresholds for both engines. Existing saved workflows are preserved. If a saved node has no MOG2 override, it keeps using its original threshold until you edit that field or load an updated template. Different workflows can use different ROIs on the same camera without creating duplicate MOG2 models.

## Static hosting and privacy

The runtime, worker, license and provenance are bundled assets. No npm step, CDN, backend inference service, uploads or remote models are needed. No SharedArrayBuffer or cross-origin-isolation configuration is needed for this single-threaded OpenCV build. Cloudflare serves the files; the visitor's device does the work.

The page permits only a same-origin worker and blocks network connections. The worker has its own restrictive response policy: it permits Emscripten's generated JavaScript bindings and embedded WebAssembly, while blocking network connections and nested workers. The page itself remains eval-free. Preserve the exported `_headers` rules when deploying.

The unmodified `@techstark/opencv-js@4.12.0-release.1` distribution is pinned by registry integrity and SHA-256 in `opencv-runtime.json`; Apache-2.0 license text is included. Its raw size is 10,872,779 bytes; Python gzip compression measured 3,521,844 bytes. The browser worker's initial Wasm heap is 128 MiB shared by all models. Heap size is not total browser RAM and must not be summed across camera diagnostics. This is visitor-device memory, unrelated to Cloudflare Worker memory limits. The heap may grow; the runtime allocation and decoded footage add other memory costs.

## Development verification

The real-browser regression runs six bundled person scenes with their Approach workflows, compares 320px/480px settings, checks camera-setting persistence, simulates worker failure while capturing, and records after explicit fallback. It enforces the exported page and worker policies and checks that no native API requests reach the static host.

```powershell
.\.venv\Scripts\python.exe -m spyder_cctv export-showcase --output .\dist\mog2-check
node tests/browser-mog2-browser.mjs .\dist\mog2-check
node tests/browser-mil-browser.mjs .\dist\mog2-check
```

Use a fresh export path. Node runs the development harness; it does not execute the downloaded OpenCV distribution. OpenCV executes only in the isolated browser worker. Timings are sampled diagnostics, not a hardware capacity guarantee. Keep the page visible while testing.

## Measured tradeoff

A development run on **Intel Core i7-6700, 4 cores / 8 logical processors, Windows, headless Chrome 156** used six person scenes concurrently, plus the existing vehicle view. MOG2 requested 5 FPS. These are illustrative desktop measurements, not minimum specifications or a mobile guarantee.

| Engine | Mean processing time per analyzed frame | Observed analysis FPS per camera | Shared Wasm heap |
| --- | --- | --- | --- |
| Frame difference · 80×45 | 0.23 ms | 4.9–5.1 | 0 MiB |
| MOG2 · 320px wide | 12.35 ms | 3.6–4.9 | 128 MiB |
| MOG2 · 480px wide | 24.32 ms | 4.3–4.8 | 128 MiB |

Frame difference includes its small canvas sample, pixel difference and ROI fraction on the main thread. MOG2 measures grayscale conversion, background subtraction, morphology and ROI/component extraction inside the worker; it excludes main-thread downscaling/transfer, JPEG encoding, rendering and recording. Resolutions and sampled windows differ, so this is a comparison of the shipped modes, not an equal-resolution algorithm benchmark. The reported mean weights each camera by its processed frames.

MOG2 initialization was about 0.53 seconds in this loopback run; an earlier cold smoke test took about 3.3 seconds. Network speed, caches, other work and browser compilation affect startup. The 128 MiB figure is one shared linear heap, not six heaps and not total browser memory.

**Current choice:** keep Frame difference as the default, with MOG2 at 320px / 5 requested FPS as an explicit option. 480px is available for detail at a greater processing cost. All six calibrated MOG2/ROI workflows produced events in the test; video capture and recording remained usable, including after a simulated worker failure and explicit fallback. These measurements exclude optional MIL tracking.

[Recorded measurements and methodology](../reference/browser-mog2-benchmark.json). Re-run the browser test on the target device before choosing its limits.
