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
2. Open **Vision Lab → Face galleries** and choose **Create gallery**. Give the
   gallery a name and select its detector and recognition models.
3. Select the gallery, enter an identity name, and choose either a running camera
   or a JPEG/PNG image. Choose **Process enrollment**.
4. If several faces are detected, select the intended face. This uses the same
   captured image, even if the live camera changes. Selection expires after
   60 seconds. The application never opens a second camera for enrollment.
5. Repeat with the same name to add samples under different lighting or angles.
   Identity names are unique within a gallery, ignoring capitalization.

Enrollment stores normalized embeddings, model fingerprints, and identity names.
It does not save source photographs. A pending multi-face selection temporarily
holds its source image in RAM for up to 60 seconds. Keep enrollment images below
8 MiB; decoded JPEG/PNG images are limited to 24 megapixels.

Search galleries and identities, rename entries, remove individual samples, or
remove identities from the gallery panel. Removing the final sample removes its
identity. Export downloads a version 1 JSON gallery containing one normalized
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
and a server timer sends Stop afterward. **Stop** is available explicitly.
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
