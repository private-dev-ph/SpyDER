# Camera setup and Control Room

[Documentation home](../README.md)

## Sources and lifecycle

The installed app accepts device indices, local video files, and streams supported
by the installed OpenCV backend. Relative file paths resolve against the configuration
folder rather than the terminal's working directory. Stream codec support depends on
the platform and camera. Keep private stream addresses and credentials out of shared
configuration and screenshots.

Start one camera first, then add others. Each tile reports its state and exposes
controls on hover or keyboard interaction. Pause releases that camera's capture;
remove also removes its saved configuration. An error on one source does not require
restarting every camera. If a camera is busy, close the other application using it.

## Automatic reconnection

Webcams and network streams reconnect automatically after an open or read failure.
The Control Room shows **RECONNECTING**, the attempt number and time until the next
retry. Delays increase from 1 to 2, 4, 8, 16 and at most 30 seconds while the camera
is offline. Thirty seconds of stable capture resets the delay for a later outage.
Other cameras continue operating independently.

Choose **Pause**, **Pause all**, or remove the camera to cancel automatic retries.
The usual unfocused-camera policy also cancels retries unless recording retains
that camera. Resume starts a fresh connection. Local video files stop at their end
rather than restarting automatically. Processing errors and failed backend releases
remain explicit errors rather than triggering repeated camera opens.

After reconnection, SpyDER reapplies saved tuning and starts fresh motion/model
processing. Old frames and detection results are cleared during the outage. An active
composite recording continues with an unavailable-camera tile; the feed rejoins the
same recording when it recovers. Missing footage cannot be reconstructed.

Native webcam indices are assigned by the operating system and can change when
USB devices are unplugged or reordered. Verify the named feeds after hardware
changes. Stable Linux `/dev/v4l/by-id/` and `/dev/v4l/by-path/` sources also support
reconnection.

A driver or stream backend can block while opening or reading. Reconnection begins
when that backend returns; SpyDER never opens a second handle to bypass a blocked
one. If the backend cannot release its handle, restart the application after resolving
the device/driver problem.

The Cloudflare showcase also retries disconnected browser webcams locally, using
the exact saved device ID. Each automatic attempt first checks that camera access
is still granted; PTZ-enabled cameras also require their existing PTZ permission.
If permissions are revoked, awaiting a prompt, or cannot be checked by the browser,
SpyDER leaves the camera offline until you choose **Retry**. It does not request
new permission automatically. Closing the page cancels retries. Browser camera
device IDs can change after permission resets or reconnecting hardware; if the saved
device is no longer available, remove and add that camera again.

PTZ permission is separate from regular camera permission; see the
[browser PTZ API guide](https://web.dev/articles/camera-pan-tilt-zoom).

## Tuning and profiles

Open Camera Setup or a tile's settings. Available controls can include brightness,
contrast, saturation, zoom, pan, and tilt. Support comes from the actual device and
driver; unsupported controls remain unavailable. Native device tuning currently
uses Windows DirectShow for integer camera sources. Field of view has no generic
control in this adapter.

Changing draft tuning updates a **software simulation** in the preview. Choose
**Apply** to commit the settings to the active camera. The simulation approximates
appearance; it cannot prove that a hardware control has the same effect. Readbacks
may report partial support, adjusted values, or a rejected setting.

Save a named profile to reuse desired settings on other cameras. A profile describes
intent, not a guarantee that different devices support identical ranges. Review each
camera's applied results after assignment. Detaching a profile retains the current
desired settings as custom settings.

## Arrange the wall

The Control Room adapts to camera count and window size. **Fullscreen wall** shows
the camera tiles with workspace navigation on the left and Live tools on the right.
Use **Fit** to switch between showing the full image and filling its tile.

Saved arrangements control ordering, pins, activity priority, featured views, and
rotation. They do not change which cameras are recorded. See [Layouts](../layouts.md)
for step-by-step instructions and dummy camera simulation.

## Release cameras when idle

In GUI mode, **Pause cameras when unfocused** controls whether the idle policy releases
camera devices after the focus grace period. The preference persists across sessions.
Disable it when cameras should continue running while another application has focus.
Cameras retained by active recording continue capturing even when the page is away.

The `serve` command runs in continuous server mode rather than the GUI focus policy.
Closing the page releases browser-owned cameras in the static showcase, but does not
terminate an installed Python server. Browser-only recording has stricter visibility
limits; see [Cloudflare showcase](../deployment/cloudflare.md).

## Record or capture

Use a tile's recording control to add or remove that feed from the composite recording.
Use capture for a still frame. Recording membership and wall visibility are separate:
hiding a tile in a layout does not remove it from recording. See
[Recordings and storage](../recording-storage.md) for clip rotation, quotas, and recovery.
