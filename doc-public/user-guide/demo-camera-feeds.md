# Demo camera feeds

SpyDER includes eight short residential-camera excerpts. In **Add camera**, choose **Home security demo clip**, select a scene, name the camera, and connect it. Existing cameras are preserved. Multiple clips can run together. Each source loops automatically and retains a distinct camera ID; it is part of the camera system rather than a Layout Studio dummy tile.

## Installed application

Demo sources use `demo://<scene-id>` in configuration. Packaged files are resolved from the installed application, never from the checkout or a user-specific download folder. The usual camera worker owns playback and sends frames through the existing processing pipeline. Motion analysis, workflows, scheduling, tiled recording, captures and enrollment use the same camera IDs and frame paths as physical cameras. Native models and their dependencies must be installed separately.

Zoom, field of view, pan, tilt, brightness, contrast and saturation are **software controls**. They change the actual frame supplied to processing and recording. Pan and tilt crop within a digitally zoomed frame; they cannot reveal areas outside the source. Settings profiles work as for other cameras. Camera Setup keeps its existing preview/apply behavior.

## Cloudflare showcase

The static export bundles all eight MP4s (886,080 bytes combined), their catalog and credits. Only static assets are delivered by Cloudflare. Clips decode, loop, tune, analyze motion, capture and record on the visitor's device. The showcase does not send images, models or recordings to a cloud API, open remote CCTV streams, or require a Worker inference service. Its policy retains `connect-src 'none'` and `worker-src 'none'`; `media-src 'self' blob:` permits the packaged footage and locally created media.

Two sample cameras start on a fresh demo. Add the other scenes through Add camera. Demo camera IDs, source selection, tuning and profiles are saved in this browser. An empty saved sample list stays empty after reload. Files selected from the visitor's disk and recorded/captured media are not uploaded; browser recording/capture buffers remain session-local. Closing the tab ends processing. Keep the tab visible while recording.

The browser uses frame-difference motion analysis, not native MOG2. Browser-compatible workflow nodes can act on these frames; unsupported model/Python/native-only nodes must be rejected when enabling, with an explanation. Native InsightFace/YOLO execution, face-gallery enrollment, ONVIF and physical PTZ require the installed application. Adding a sample source does not install a browser ONNX/InsightFace engine or invent face identities. This source foundation keeps that future adapter work separate from camera playback.

## Try a browser workflow

In Vision Lab, open the template picker and load **Browser clip motion event**. Choose a running sample camera, adjust the Browser motion threshold, then enable the workflow. A Camera → Browser motion → Cooldown → Event chain creates entries in Events. An Event can attach a current-frame capture; Capture and Record nodes can create local media. Notifications appear inside the application. Multiple supported workflows can share one camera's decoded frames.

The browser runtime accepts Camera, Browser motion, Cooldown, Event, Notification, Capture and Record nodes. It validates the graph before enabling it and explains unsupported nodes. Browser motion is a showcase-only source; installed workflows retain the native detection engines. Workflow edits disable the running saved graph until it is enabled again. Event metadata persists in this browser, but attached Blob images and recordings last only for the current tab session. Download media before reloading.

## Bundled approach motion presets

The Cloudflare showcase includes six reviewed approach regions. Add a scene through **Add camera → Home security demo clip** and keep its motion pipeline on. Control Room shows the default approach guide and its motion percentage. The guide is a separate UI layer: recordings, captures and enrollment pixels remain clean.

| Scene | Watched area |
| --- | --- |
| Front porch: person and parcel | Porch entry and parcel pickup area |
| Driveway: person approaching | Sidewalk and upper driveway route |
| Front door: close approach | Walkway and doorstep, excluding the door reflection |
| Covered porch: person at the door | Covered entrance and door approach |
| Ring doorbell: person at the entrance | Right-hand doorstep where the person is visible |
| Front yard: person approaching porch | Sidewalk-to-porch approach path |

The vehicle-only driveway scene and empty patio have no approach preset. The Ring clip keeps its original internal ID for saved-camera compatibility, but its description now correctly mentions the visible person.

Six disabled **Approach** workflows are added to the browser workflow library once. Choose one in Vision Lab and enable it to log motion events with frame captures. If its scene is not loaded, add that scene first or select a camera in its Camera node. Scene-specific copies also appear under **Templates → Home security motion**, so a deleted default can be recreated. Existing edits, disabled workflows and deletions are preserved across reloads.

Each Browser motion node exposes **Motion fraction in region** and **Approach area: left, top, right, bottom**. Coordinates range from 0 to 1 and refer to the tuned image; for example `[0.2, 0.1, 0.8, 0.7]`. The denominator is the region's area, not the full frame. A threshold of `0.025` means 2.5% of that region changed. Workflows can use independent regions on the same camera; the Control Room guide shows the scene default. Review regions after changing zoom, pan or field of view. Presets use a six-second event cooldown and suppress large scene cuts.

This is actual browser pixel-motion analysis, not a person classifier: other movement inside the region can trigger it. No model download or cloud inference is required. Events retain metadata in the browser; attached captures remain session-local until downloaded.

## Source characteristics

Clips are eight seconds, silent, 15fps, 360px high and aspect-ratio preserving. Original camera watermarks and timestamps remain; timestamps are archival, not current. Loops restart at the cut without reversed action or blended ghost frames. On each native loop, motion analysis resets its learned background and tracks in both Control Room and Vision Lab, then observes the configured warm-up period again. This prevents repeated activity from being learned away as permanent background. The browser resets its previous-frame motion reference at the cut. A loop is not a camera disconnection and does not stop an ongoing recording. Some cameras share a source recording and show different views of the same property. They are not eight separate homes.

The source videos document reported parcel/property theft. Preserve that context and do not imply the depicted people are consenting models or ordinary visitors. No identities or face vectors are shipped. A copyright license does not verify public biometric-enrollment consent; use consented volunteers for a public identification demonstration.

## Attribution

All excerpts are adapted under [CC BY 3.0 Unported](https://creativecommons.org/licenses/by/3.0/). Changes: excerpted, resized, frame rate converted, audio removed, and re-encoded as H.264 MP4. Credit the source author, title, license and changes when reusing the clips. No endorsement is implied. The camera picker displays this information, and `demo-cameras.json` retains full provenance and hashes.

- [Mail Theft Caught on Camera - Las Vegas.ogv](https://commons.wikimedia.org/wiki/File:Mail_Theft_Caught_on_Camera_-_Las_Vegas.ogv) — Brandon Ennis. CC BY 3.0.
- [Front Porch Theft 2012 11 17 101117.ogv](https://commons.wikimedia.org/wiki/File:Front_Porch_Theft_2012_11_17_101117.ogv) — Trevor Fiatal. CC BY 3.0.
- [Package Theft from home.ogv](https://commons.wikimedia.org/wiki/File:Package_Theft_from_home.ogv) — DonGar37. CC BY 3.0.
- [Don't Tempt a Thief with Unattended Parcels.ogv](https://commons.wikimedia.org/wiki/File:Don%27t_Tempt_a_Thief_with_Unattended_Parcels.ogv) — Vancouver Police Department / vpdonline. CC BY 3.0.
- [Theft@McKean.ogv](https://commons.wikimedia.org/wiki/File:Theft%40McKean.ogv) — Shikha Bhargava. CC BY 3.0.
