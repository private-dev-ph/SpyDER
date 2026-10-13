# Local recording

`RecordingService` writes one composite video for each recording session. It samples each selected `CameraWorker` through `jpeg()`, so the service never opens a second camera capture backend. A missing, stopped, or stale sample appears as a labeled placeholder tile.

The video canvas is fixed at 1920 × 1080 and 15 frames per second. Selecting cameras changes the tile grid while preserving each camera image's aspect ratio with letterboxing. OpenCV `mp4v` is the preferred video codec. If that writer cannot open, the service tries Motion JPEG in an AVI container. Recordings contain no audio.

`start(camera_ids)` retains selected cameras through `CameraManager.set_recording`. `select(camera_ids)` updates the grid and retention set. Removing a camera drops its tile; removing the last selected camera finalizes the session. `stop()` and `close()` release and finalize the writer. A stop timeout reports `stopping` while the writer remains active.

`capture(camera_ids)` stores a raw JPEG for one camera or a tiled JPEG for multiple cameras. Finalized recordings and captures appear in `status()["items"]`; `media_path(id)` resolves only cataloged files inside the configured output directory. A local JSON manifest preserves the catalog across service restarts. IDs are opaque UUID hex strings, and stored filenames never come from caller input.

Use **Record** on a camera card to start a session or include that camera in the
current session. **End view** removes it; removing the last view saves the video.
The Recordings workspace also provides camera checkboxes, **Stop & save**, tiled
captures, and downloads. The System workspace shows the local media directory.
Single-camera captures preserve source resolution; tiled media includes camera
IDs and a UTC timestamp. Captures require at least one fresh frame.

Recording cameras remain active while the local browser is unfocused. Pause
controls skip cameras in the recording; end their recording first. Removing a
camera drops its tile. Unavailable feeds show placeholders. The recorder checks
free disk space and finalizes the current file when free space falls below 64 MiB.
There is no automatic deletion or retention schedule; manage saved files in the
local folder. Up to 64 cameras can be included in a session. Encoding throughput
depends on local hardware; if it cannot sustain 15 fps, playback can run faster
than wall time. Forced process termination can leave an unfinished partial file.

The static showcase uses browser-supported MediaRecorder codecs, typically WebM.
It uses separate canvases for frame captures and active recordings. Browser media
stays in memory, stops when the tab becomes hidden, and must be downloaded before
closing or reloading. The browser library and recording buffers share a 128 MiB
limit. No video is uploaded to Cloudflare.

References: [OpenCV VideoWriter](https://docs.opencv.org/4.13.0/dd/d9e/classcv_1_1VideoWriter.html)
and [MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder).
