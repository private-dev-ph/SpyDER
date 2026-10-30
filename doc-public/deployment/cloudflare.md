# Cloudflare showcase

[Documentation home](../README.md)

## Hosting model

The main application runs on the user's computer. The Cloudflare version is a
separate **static browser showcase**: HTML, CSS, JavaScript, SVG, and presentation
images and short bundled demo clips. No Python server, Pages Function, model service, media proxy, or cloud
storage binding is required. Camera work uses the visitor's hardware and browser.
Cloudflare handles ordinary asset delivery and web-access metadata.

## Export and preview

From an existing development installation, export into a new directory:

```powershell
.\.venv\Scripts\python.exe -m spyder_cctv export-showcase --output .\dist\showcase-preview
.\.venv\Scripts\python.exe -m http.server 8787 --bind 127.0.0.1 --directory .\dist\showcase-preview
```

Open `http://127.0.0.1:8787`. Export refuses to overwrite an existing directory; use a
fresh output path for each preview. Python's simple HTTP server does **not** apply
Cloudflare's `_headers` file. Use a Cloudflare local preview or verify actual headers
on a staged deployment before treating the policy as enforced.

For a checkout-based Cloudflare build, `python tools/build_showcase.py` creates
`dist/showcase` using only the standard library. The build environment does not need
OpenCV, model weights, or camera dependencies. That output path must not already exist.
For local code changes, use the installed exporter with a fresh path rather than
removing unrelated files to rebuild.

## Static hosting configuration

For Pages, use framework preset **None**, build command
`python tools/build_showcase.py`, and output directory `dist/showcase`. For Workers
Static Assets, the repository's `wrangler.jsonc` points `assets.directory` at that
same folder and declares no Worker entry script. Cloudflare supports the
[static asset hosting model](https://developers.cloudflare.com/workers/static-assets/).
Keep `_headers` in the exported output; Cloudflare applies it to static responses
([Pages headers](https://developers.cloudflare.com/pages/configuration/headers/),
[Workers headers](https://developers.cloudflare.com/workers/static-assets/headers/)).

To use a custom subdomain, register it with the selected Cloudflare project and
complete its domain/HTTPS setup. For Pages, follow the [custom-domain guide](https://developers.cloudflare.com/pages/configuration/custom-domains/)
before configuring DNS. A generated export does not deploy the site or configure DNS.

## Capabilities

| Feature | Installed app | Static showcase |
| --- | --- | --- |
| Sources | OpenCV devices, files, supported streams, bundled looping demo clips | Bundled home-camera loops, generated feeds, permitted webcams, selected local videos. |
| Motion | MOG2, regions, tracking | Lightweight frame difference or optional local OpenCV.js MOG2 with foreground regions; opt-in MIL for one object on the bundled porch feed only. |
| YOLO/InsightFace and native capacity assessment | Local Python engines | Unavailable. |
| Workflow editing and JSON exchange | Supported | Browser-only drafts/import/export. |
| Workflow execution | Full local graph execution | Supported browser-motion, cooldown, event, notification, capture and time-limited recording nodes; native model/code/subflow nodes are refused. |
| Native Code nodes, face enrollment and model inference | Local Python engines | Unavailable; no simulated identities or model detections. |
| Recording and captures | Local filesystem | Canvas/MediaRecorder and local Blob objects. |
| Pre-event recording | Opt-in local RAM buffer for workflow Event clips | Settings editable; native pre-event capture unavailable. |
| Retention and crash recovery | Native storage policy and journals | No durable media recovery. |

Webcam permission is requested after a user action. Production webcam access requires
HTTPS. Local videos use a file picker and Blob URLs; they are not uploaded. RTSP,
remote source URLs, and arbitrary filesystem paths are unavailable. Browser hardware
controls depend on track capabilities and generally offer less than native drivers.

## Privacy and limits

The document policy keeps `connect-src 'none'`, permits only same-origin workers,
and allows same-origin bundled clips plus local Blob media. It does not allow JavaScript evaluation.
The dedicated `/mog2-worker.js` response has a separate policy permitting Emscripten's
generated bindings (`script-src 'self' 'unsafe-eval'`), while blocking all network
connections and nested workers. OpenCV and embedded WebAssembly are bundled locally;
no CDN or browser cross-origin-isolation headers are required. The browser adapter handles its API-shaped operations
in memory; it does not contact the installed Python service. The export contains no
private camera configuration, user media, or uploaded models. The eight approved demo clips total
886,080 bytes, carry source attribution, and are decoded and processed on the visitor's device. See [Demo camera feeds](../user-guide/demo-camera-feeds.md) for licenses and camera setup.

Recordings and their thumbnails share a **128 MiB** tab buffer. Keep the tab visible;
hiding it stops and finalizes recording. Download media before closing/reloading.
A closed or crashed tab loses its in-memory library. Long clip selections do not
remove the buffer limit or add native automatic clip rotation and crash recovery.
Profiles/layouts/drafts use browser storage and can be cleared independently of downloads.

Keep third-party script injection and analytics integrations disabled for this showcase.
They are outside the intended privacy boundary and may conflict with its CSP. Before
publishing, inspect deployed response headers, console errors, and Network activity
while testing capture, recording, model controls, and workflow editing. Local tests
cannot prove account-specific headers, DNS, or injected scripts are configured correctly.


## Optional browser OpenCV

Open **Camera Settings → Browser motion engine** on a motion-enabled camera and select **MOG2 background subtraction (OpenCV.js)**. Apply the engine separately from image tuning. This starts one lazily loaded browser worker shared by up to eight MOG2 cameras, with separate background models. The default Frame difference engine does not download OpenCV.

The pinned OpenCV 4.12.0 runtime is 10,872,779 bytes (about 3.52 MB using gzip in the development check), below [Cloudflare's 25 MiB per-asset limit](https://developers.cloudflare.com/workers/platform/limits/#static-assets). The build needs no npm installation: the verified distribution, embedded WebAssembly, license and provenance are package assets. See `opencv-runtime.json` in the export. Browser downloads are served as static bytes; processing and camera pixels stay on the device.

Do not apply the document policy to every asset indiscriminately: doing so would also restrict the worker's generated bindings. `_headers` assigns CSP separately to `/`, `/index.html`, `/404.html`, and `/mog2-worker.js`. The export includes a 404 page to prevent implicit SPA fallback; keep hash-based workspace navigation and apply the document policy explicitly if adding HTML routes. Verify these responses on the deployed site. A generic Python HTTP preview does not apply `_headers`; the automated browser regression serves and enforces both execution-context policies.

See [Browser motion engines](../user-guide/browser-motion-engines.md) for limits, controls and measured tradeoffs. Native Python inference, InsightFace/YOLO and native draft-mask previews remain installed-app features. Browser MIL is limited to one object on one bundled porch camera per tab, at no more than two tracking updates per second.
