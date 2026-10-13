# Static showcase and browser runtime research

## Hosting choice

Cloudflare Workers Static Assets can serve a static site without a Worker script. Cloudflare's current Workers best-practices page shows a static-site configuration with no Worker script, and Wrangler's configuration schema marks `assets.directory` optional at the general schema level while the Static Assets guide uses it to name the asset folder. For this project, use a small `wrangler.jsonc` with `name`, a fixed `compatibility_date`, and `assets.directory`; omit `main`, `binding`, and any Functions or `_worker.js` file. The asset folder must contain top-level `index.html`. [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), [Static Assets](https://developers.cloudflare.com/workers/static-assets/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)

Example configuration shape:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "spyder-showcase",
  "compatibility_date": "2026-10-13",
  "assets": {
    "directory": "./site"
  }
}
```

Workers Static Assets upload static files to Cloudflare's edge and serve them to browsers. With no Worker script, Cloudflare says unmatched requests return 404 unless configured for SPA fallback or custom 404 behavior. This static setup has no server-side application code to capture or process camera frames. The delivered JavaScript still runs in the visitor's browser and could send data if it contains network-upload code, so the browser adapter must keep frames in memory and make no frame or profile upload requests. [Static Assets](https://developers.cloudflare.com/workers/static-assets/)

Cloudflare Pages also supports static HTML and can deploy a prebuilt output directory; its static HTML guide asks for a top-level `index.html`. Pages remains a valid option if the project wants Pages-specific dashboard workflows. For a new static-only project, Cloudflare currently recommends Workers Static Assets as its primary platform and documents it as supporting static sites without a Worker script. [Pages static HTML](https://developers.cloudflare.com/pages/framework-guides/deploy-anything/), [Cloudflare Pages overview](https://developers.cloudflare.com/pages/), [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

## Local verification commands

`wrangler dev` starts a local preview and does not deploy. From the repository root, run `npx wrangler dev`; then open the printed local URL and confirm `index.html` and the asset routes load. Wrangler's `deploy --dry-run` compiles without deploying, but a local preview is the useful check for a static directory. [Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/), [Get started with Static Assets](https://developers.cloudflare.com/workers/static-assets/get-started/)

The no-`main` configuration shape is supported by Cloudflare's static-site examples. A live CLI validation was attempted with a temporary static config, but no Wrangler executable is installed in this worktree and `npm.cmd exec --yes --package=wrangler` produced no output for 60 seconds under the restricted network environment, so it was stopped. Re-run `npx wrangler dev` after Wrangler is available locally to validate the actual root configuration and asset directory. [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), [Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)

## Browser camera and PTZ

`navigator.mediaDevices.getUserMedia({ video: true, audio: false })` requests a video stream and asks the browser for camera permission. `getUserMedia()` is restricted to secure contexts such as HTTPS (localhost is treated as trustworthy for local development), and the page can fail when permission is denied, a device is unavailable, or the camera is blocked by Permissions Policy. Serve the showcase over HTTPS in production and request camera access only after a clear user action. [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/), [Secure Contexts](https://www.w3.org/TR/secure-contexts/)

After opening a video track, call `track.getCapabilities()` to inspect device-specific supported values and ranges. A capability may be absent; do not infer support from `getSupportedConstraints()` alone because that reports recognized constraint names, not the selected camera's abilities. Check the actual track capabilities for `pan`, `tilt`, and `zoom`; use each reported numeric range to bound the UI. [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/), [MediaStream Image Capture](https://www.w3.org/TR/image-capture/)

Use `track.applyConstraints({ advanced: [{ pan: value, tilt: value, zoom: value }] })` or equivalent valid constraint dictionaries to request hardware movement. PTZ may require camera permission with the `panTiltZoom` permission bit; browser implementations can reject with `OverconstrainedError` or `SecurityError`, and the camera may not implement all three controls. Read `track.getSettings()` after applying constraints and show actual values; treat failures as per-control unsupported or rejected results. The W3C Image Capture document is a Working Draft, so behavior remains dependent on browser, permission UI, driver, and hardware. [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/), [MediaStream Image Capture](https://www.w3.org/TR/image-capture/)

Avoid hard PTZ constraints in the initial device request unless device selection requires them. Acquire the stream first, inspect that selected track, then request PTZ controls as the user enables them. The W3C PTZ extension specifies camera permission for non-false pan, tilt, or zoom constraints and warns that hidden-page PTZ requests may fail. [MediaStream Image Capture](https://www.w3.org/TR/image-capture/)

## Browser-local motion and profiles

The camera stream is a `MediaStream` delivered to page JavaScript. Motion detection can analyze frames from the local video element or canvas without uploading them; keep intermediate frame buffers and motion state in browser memory. Do not add a server endpoint or remote inference dependency. `getUserMedia()` itself grants a local capture stream; it does not send frames to Cloudflare. [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/)

Store small profile settings in `localStorage`, which is scoped to the site's origin and persists across browser sessions until the user or browser clears it. Store larger user-created data in IndexedDB; it is client-side structured storage and follows same-origin rules. Browser storage can be cleared or evicted, so profiles need JSON export/import or another user-controlled backup path if preservation matters. [WHATWG Web Storage](https://html.spec.whatwg.org/multipage/webstorage.html), [IndexedDB specification](https://w3c.github.io/IndexedDB/), [MDN browser storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

Export profiles by creating a JSON `Blob` and triggering a user-initiated download. Import by letting the user select a JSON file and validating it before replacing or merging local profiles. Keep downloaded model/CV assets as ordinary static files; these bootstrap assets necessarily travel from Cloudflare to the visitor, while camera frames and profile data stay in the browser. [File API](https://www.w3.org/TR/FileAPI/)

## Future custom domain

`spyder.zachcodes.dev` is a subdomain. Cloudflare Pages requires adding the custom domain to the Pages project and pointing a DNS CNAME record at `<project>.pages.dev`; if the DNS zone already lives on the same Cloudflare account, Pages can create the CNAME after setup. The custom-domain workflow must be completed in the Pages dashboard; manually creating only the CNAME can leave the domain unresolved. [Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)

Workers custom domains use a separate workflow and should be selected only if the final target is Workers Static Assets. Confirm that `zachcodes.dev` is managed in the intended Cloudflare account before configuring the hostname; the domain was not inspected and no DNS or deployment change was made. [Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

## Boundaries and open checks

- Cloudflare hosting distributes page/bootstrap files. This is unavoidable for a hosted showcase. Runtime capture, motion analysis, and profile use remain in the visitor's browser by design.
- Static hosting cannot prevent client JavaScript from sending data. Keep frame/profile code free of upload calls and review any third-party scripts before including them.
- PTZ support is not uniform. Detect support at runtime and report unsupported controls without blocking video.
- Cloudflare's documentation confirms the no-script static asset configuration, but Wrangler CLI validation remains unverified because package acquisition stalled in this restricted environment.
- Domain ownership, DNS zone placement, and browser/device PTZ combinations remain unverified.
