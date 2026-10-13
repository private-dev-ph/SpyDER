# Local recording

`RecordingService` writes one composite video for each recording session. It samples each selected `CameraWorker` through `jpeg()`, so the service never opens a second camera capture backend. A missing, stopped, or stale sample appears as a labeled placeholder tile.

The video canvas is fixed at 1920 × 1080 and 15 frames per second. Selecting cameras changes the tile grid while preserving each camera image's aspect ratio with letterboxing. OpenCV `mp4v` is the preferred video codec. If that writer cannot open, the service tries Motion JPEG in an AVI container. Recordings contain no audio.

`start(camera_ids)` retains selected cameras through `CameraManager.set_recording`. `select(camera_ids)` updates the grid and retention set. Removing a camera drops its tile; removing the last selected camera finalizes the session. `stop()` and `close()` release and finalize the writer. A stop timeout reports `stopping` while the writer remains active.

`capture(camera_ids)` stores a raw JPEG for one camera or a tiled JPEG for multiple cameras. Finalized recordings and captures appear in `status()["items"]`; `media_path(id)` resolves only cataloged files inside the configured output directory. A local JSON manifest preserves the catalog across service restarts. IDs are opaque UUID hex strings, and stored filenames never come from caller input.
