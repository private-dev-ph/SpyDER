# Face enrollment and ONVIF cameras

These features run in the installed local application. The Cloudflare showcase
shows the interface but cannot scan your network, enroll faces, or move cameras.
No models, face samples, or camera credentials are sent to the showcase server.

## Create a face gallery

1. In **Vision Lab → Models & Workflows**, upload or register a compatible local
   InsightFace detection ONNX model and an ArcFace recognition ONNX model.
   A closed-set identity classifier is a different model type and cannot create
   recognition embeddings. Installed built-in SCRFD detectors also appear in the
   enrollment detector chooser; downloading weights remains an explicit action
   in the Model node. Install the application's `insightface` optional
   dependencies in the same Python environment if they are missing.
2. Open **Vision Lab → Face galleries**. Existing galleries load automatically.
   Choose **Create gallery** to add a collection. Give the
   gallery a name and select its detector and recognition models.
3. Select the gallery and choose **Enroll someone**. All enrollment controls are
   inside the enrollment studio, including the identity name and media source. It
   accepts a running camera, a JPEG/PNG image, or a browser-supported video.
   A camera preview uses the existing capture worker; it does not start or stop
   the camera. Keep the camera running while inspecting it.
4. Drag a focus rectangle over the person you want to enroll. The focus fields
   also accept percentages for keyboard control. Dragging freezes a live camera
   preview or pauses video playback so the picture stays still while you focus.
   Choose **Analyze current frame**
   to freeze and inspect the exact frame used by the detector. Face boxes and
   cropped sample cards show what was found. No samples are selected automatically.
5. For video, choose a 5–10 second range using the start slider. **Play selected
   range** previews that segment. **Inspect range** checks up to ten evenly spaced
   frames within it. The browser decodes the original video and sends only those
   JPEG frames to the local application, never the full video. Browser-extracted
   frames are capped at 3,840 pixels on the longest side and 8 megapixels. Cancel inspection
   to stop processing further frames. Supported formats depend on the browser;
   MP4/H.264 and WebM are common choices. Videos must have a readable duration and
   be at least five seconds long. The viewer accepts files up to 2 GiB.
6. Select face boxes or sample cards belonging to the same person. Review the
   crops across frames before using **Select all**. Enter the identity name and
   choose **Save selected face samples** to save up to twenty samples together.
   Nothing is enrolled merely by previewing or analyzing media. Reviews expire
   after five minutes; inspect the source again if a review expires.
7. Repeat with the same name to add samples under different lighting or angles.
   Identity names are unique within a gallery, ignoring capitalization. Live
   preview can be resumed to inspect another frame without closing the studio.

The focus rectangle restricts where faces are detected; it does not track a person
through the video. A different person entering that rectangle can also be detected.
Check the resulting crops and exclude other people before saving. Each submitted
frame is independently detected and aligned, and the reviewed batch is validated
before a single gallery update is published.

Enrollment stores normalized embeddings, model fingerprints, identity names,
and small cropped JPEG portraits on this computer. Portraits are bounded to
160 pixels on the longest side and 32 KiB each. Full source photographs and
videos are not retained. Source previews stay in the browser until
the review is cleared or the viewer closes. Reviewed face embeddings expire from
local server memory after five minutes. The older single-image API retains a pending multi-face
selection in RAM for up to 60 seconds. Keep enrollment images below
8 MiB; decoded JPEG/PNG images are limited to 24 megapixels.

Search galleries and identities, rename entries, remove individual samples, or
remove identities from the gallery panel. Gallery cards, identities, and sample
rows display their saved portraits. The latest sample with a portrait represents
an identity; removing it falls back to another saved sample. Removing the final
sample removes its identity and its portrait.

Profiles enrolled before portrait storage show a placeholder. Choose **Add sample**
on that identity to open the studio with its name already selected, then enroll
one new sample to add a portrait. Old embeddings cannot reconstruct the original
face photograph. Recognition exports contain no portrait images.
Export downloads a version 1 JSON gallery containing one normalized
centroid per identity; this export contains biometric data and identity names.
Gallery export is a recognition interchange format, not a full sample backup.

## Use a gallery in a workflow

Connect a **Classifier** node to an InsightFace **Detections** node's
**CLASSIFIER IN** input. Select the enrolled gallery in the classifier chooser.
The **Model** node continues to select the face detector through **MODEL IN**.
The gallery selects its own recognition model and supplies identity choices to
connected filters.

For a gallery, the threshold is cosine similarity, not a classifier probability.
Use representative samples and test your threshold against known and unknown
faces. Temporal confirmation settings reduce identity flicker. Renaming or
removing identities updates the running recognizer before its next inference;
old identity tracks clear when the gallery changes. An empty gallery recognizes
no known identities. Editing a gallery does not enable a disabled workflow.

Gallery model fingerprints must match the original detector and recognizer.
Changing embedding models requires a new gallery and new enrollment. Models
referenced by galleries cannot be deleted. Remove gallery assignments from saved
workflows and cameras before deleting an entire gallery.

Galleries live in `face-galleries/` beneath SpyDER's application data directory,
independently of the recordings folder. There are limits of 100 galleries, 1,000
identities and 1,000 samples per gallery, and 16 MiB per gallery catalog.
Configuration backups and workflow exports do not include biometric samples or
model weights. Back up the gallery directory separately while SpyDER is stopped
if full sample recovery is required.

## Discover an ONVIF camera

Open **Camera Setup → ONVIF discovery and PTZ**. Choose **Discover devices** to send one
bounded WS-Discovery probe. Discovery is not continuous. Cameras must be on a
reachable private LAN; router isolation and firewalls can block multicast.

If discovery finds nothing, enter the camera's HTTP/HTTPS ONVIF device-service
endpoint manually, for example `http://192.168.1.20/onvif/device_service`. Enable
ONVIF in the camera's own administration interface first. Enter its ONVIF username
and password, connect, select a media profile, and add that profile as a camera.
Start the feed in Control Room.

SpyDER supports ONVIF Media service profiles, RTSP stream selection,
WS-Security UsernameToken digests, and HTTP Digest authentication. Public hosts,
loopback addresses, redirects, and cross-host service or stream endpoints are
rejected. Media2-only devices and vendor-specific authentication may require
additional adapters. Keep the computer and camera clocks synchronized for
WS-Security authentication.

Credentials stay in server memory. Saved camera configuration contains a
credential-free stream address. Attached sessions remain available during long
recordings, including when the browser closes. After restarting SpyDER, connect
again and add the same profile to restore its credentials to the existing stopped
camera. Stop that camera before replacing its active session. **Refresh
connections** restores session controls after navigating between workspaces.
Remove attached cameras before disconnecting their session.

## Pan, tilt, and zoom

Select a connected profile to use supported PTZ controls. Each direction or zoom
click sends a 250 ms movement pulse. The request includes a camera-side timeout,
and a server timer sends Stop afterward. The camera-side timeout is one second;
normal 250 ms pulses rely on the earlier server Stop. Devices whose timeout range
excludes one second may reject movement. **Stop** is available explicitly.
Unsupported movements stay disabled; read-only cameras can still stream.

PTZ movement depends on the camera advertising continuous velocity spaces for
that profile. Preset listing is available through the local API; preset travel,
patrols, and automatic subject following are not implemented. No movement occurs
on discovery, connection, or adding a camera.

## Protocol references

- [InsightFace recognition implementation](https://github.com/deepinsight/insightface/blob/master/python-package/insightface/model_zoo/arcface_onnx.py)
  describes aligned-face embedding extraction.
- [ONVIF PTZ service](https://www.onvif.org/ver20/ptz/wsdl/) specifies continuous
  movement, timeouts, and Stop behavior.

Model licensing is separate from SpyDER's application license. Check the license
of the weights you select before using or distributing them.

### Enroll a person from a saved recording

In **Recordings**, open a clip from the library or select it in **Timeline playback**. Seek to the person you want to enroll, then choose **Enroll someone**. SpyDER opens **Vision Lab - Face galleries** and asks which gallery should receive the profile. Choose a gallery and open the clip in Enrollment Studio. If you do not have a gallery yet, cancel the picker and create one on the Face galleries page first.

The studio starts its selection at the playback position, adjusted near the end of a recording to keep a complete five-second range. Choose a range of 5-10 seconds, drag a focus area around one person, and use **Inspect range**. Review the detected face crops, select samples of the same person, enter their name, and save. Opening a recording never enrolls anyone automatically.

Saved recordings use a sampled local preview, including formats your browser cannot play directly. The studio reads individual frames through the installed app rather than downloading the entire recording into browser memory. The original clip stays in the recording library; the gallery stores only the selected face vectors and small portrait crops. The Cloudflare showcase does not expose this native enrollment action or send recording frames to a cloud service. Clips must be at least five seconds long and remain available on disk.

### Clean footage for enrollment

New local recordings and frame captures use camera pixels before SpyDER draws motion regions, detection boxes, tracks, or identity labels. Pre-event buffers use the same clean source. Live camera views continue to show their detection overlays. The recorder keeps one video rather than an additional clean copy, so this separation does not double recording storage. Camera labels and timestamps in tiled recordings remain part of the recording layout.

Enrollment Studio draws its review boxes separately from the source image. Those review boxes and the focus-area shading are never submitted as face samples.

This change applies to footage recorded after the update. Boxes already burned into an older recording, an imported clip, or a camera's own stream cannot be reliably removed: they may obscure real facial pixels. Use an original clean clip or take new clean footage where possible. SpyDER does not use image reconstruction to invent missing facial details for enrollment.
