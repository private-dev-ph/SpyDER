# Cloudflare showcase

[Documentation home](../README.md)

## Hosting model

The main application runs on the user's computer. The Cloudflare version is a
separate **static browser showcase**: HTML, CSS, JavaScript, SVG, and presentation
images. No Python server, Pages Function, model service, media proxy, or cloud
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
| Sources | OpenCV devices, files, supported streams | Generated feeds, permitted webcams, selected local videos. |
| Motion | MOG2, regions, tracking | Small browser frame-difference demonstration. |
| YOLO/InsightFace and native capacity assessment | Local Python engines | Unavailable. |
| Workflow editing and JSON exchange | Supported | Browser-only drafts/import/export. |
| Workflow execution, Code nodes, Preview node execution, event actions | Local execution | Disabled. |
| Recording and captures | Local filesystem | Canvas/MediaRecorder and local Blob objects. |
| Retention and crash recovery | Native storage policy and journals | No durable media recovery. |

Webcam permission is requested after a user action. Production webcam access requires
HTTPS. Local videos use a file picker and Blob URLs; they are not uploaded. RTSP,
remote source URLs, and arbitrary filesystem paths are unavailable. Browser hardware
controls depend on track capabilities and generally offer less than native drivers.

## Privacy and limits

The export's Content Security Policy includes `connect-src 'none'`, blocks workers,
and allows only local Blob media. The browser adapter handles its API-shaped operations
in memory; it does not contact the installed Python service. The export contains no
private camera configuration, user media, or uploaded models.

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
