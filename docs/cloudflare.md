# Browser showcase on Cloudflare

The main product remains the installed Python application (`spyder-cctv gui`).
The showcase uses the same camera wall and settings UI with a browser-only
runtime. Cloudflare serves static interface assets, including the supplied emblem;
it never receives camera frames, local files, profiles, or motion analysis.
There is no Worker script,
Pages Function, storage binding, inference service, stream proxy, or analytics
SDK. Initial HTML/CSS/JavaScript downloads necessarily use the host; subsequent
camera work uses the visitor's CPU, memory, camera devices, and browser storage.
Cloudflare still handles normal static asset delivery and access metadata.

## Build and preview (no deployment)

Use the existing environment; do not create another `.venv`:

```powershell
.venv/Scripts/python.exe tools/build_showcase.py
npx.cmd wrangler@4.149.0 dev --local
```

The build needs only Python's standard library. No OpenCV or camera backend is
installed in the Cloudflare build environment. For an installed distribution,
`spyder-cctv export-showcase --output <new-folder>` exports the same packaged
resources even outside the repository. Export refuses to overwrite a directory;
use a new output folder or remove only the old generated `dist/showcase` before
rebuilding. The default output directory is ignored by Git.

`wrangler.jsonc` configures Workers Static Assets without a `main` script. Use
`npx.cmd wrangler@4.149.0 deploy --dry-run` to validate packaging without publishing.
For Pages, use build command `python tools/build_showcase.py`, build output
`dist/showcase`, framework preset None, and no Functions directory. The same
export works on either platform; `_headers` applies the security policy.

## What visitors can try

- Two explicitly labeled generated feeds start immediately, with browser-side
  frame-difference motion analysis. They never access a camera.
- Add, remove, pause, focus, and resize feeds. Light mode is the default.
- Add webcams after clicking Connect/Start and granting permission. HTTPS is
  required in production; localhost is suitable for preview. Device labels and
  selection improve after camera permission is granted.
- Choose a video using a local file picker. The file is a browser Blob URL and
  is never uploaded. Browser codec support determines playable formats.
- Hardware settings use the selected track's reported capabilities and real
  readback. Optional PTZ permission can be requested when adding a webcam.
  Unsupported controls stay disabled. Browsers generally expose fewer controls
  than the installed app's Windows DirectShow backend; FOV is not inferred.
- Profiles persist in this browser's origin-scoped localStorage. They do not
  sync to Cloudflare or the Python app. Camera lists and files last for the tab;
  reloading starts the generated demo again, without requesting webcam access.
  Browser storage can be cleared; do not use showcase profiles as a sole backup.

Camera tracks stop when paused, removed, or the page is left. Permission denial,
device disconnection, and a device busy in another application are recoverable
states. The browser schedules bounded previews and small motion buffers; actual
camera count and performance depend on the visitor's hardware and browser.
RTSP, remote URLs, and arbitrary filesystem paths require the installed local
app. The hosted showcase does not connect to its loopback API or change its CORS
rules. Multiple tabs and native apps may contend for a physical webcam.

The export's CSP uses `connect-src 'none'` and allows only local Blob media, so
accidental API polling, WebSockets, remote media, and uploads are blocked by the
browser. All fonts and interface assets are bundled. Do not enable Cloudflare
Web Analytics, Zaraz, or script injection for this project: third-party scripts
are deliberately excluded by CSP.

## Future `spyder.zachcodes.dev` hostname

No deployment, DNS, or account changes are part of this task. After choosing the
platform, add `spyder.zachcodes.dev` as a custom domain in the Cloudflare dashboard
and verify HTTPS before inviting camera access. Workers custom domains require
the DNS zone in the appropriate Cloudflare account. Pages uses its own custom
domain setup and CNAME workflow. Do not manually set a CNAME without registering
the domain with the selected project. See [primary-source research](cloudflare-research.md).
