# Vision Lab motion analysis

Vision Lab configures an independent analysis layer for each camera. MOG2 learns
a background for a stationary camera; connected components filter small blobs,
contours describe their outlines, and MIL follows a bounded number of moving
targets. Tracking IDs belong to the current camera session and are not identities
or recognized object classes. YOLO and InsightFace configuration stays separate.

Analysis is disabled by default. Select a camera, enable the desired features,
and apply the settings. Settings persist beside the existing camera configuration
and take effect without reopening the device. A paused camera keeps its settings
until started. Changes to settings, resolution, or camera position require a new
background warm-up. Shadow filtering excludes MOG2's shadow pixels. A detection
zone is a normalized rectangle; motion outside it is ignored.

Each enabled camera has one analysis worker, one replaceable pending frame, and
one latest result. Slow inference drops pending frames and lowers submission
frequency. Capture and recording keep their existing owners. Old or failed
analysis results do not replace the live feed. Foreground-mask previews are small
JPEGs served by the local application. Overlays on the processed feed also appear
in recordings and frame captures when enabled.

The local capacity assessment benchmarks synthetic OpenCV workloads and reports
conservative simultaneous-camera estimates for motion, regions, and tracking.
It reports hardware information and observed processing costs, not a guaranteed
maximum. Camera resolution, requested analysis frequency, number of trackers,
recording, other applications, and model workloads all change capacity. CPU
estimates do not predict GPU/NPU performance or the cost of your YOLO/InsightFace
models. Run the assessment again after changing the workload.

The Cloudflare showcase remains browser-only. Native MOG2/MIL configuration and
hardware assessment are unavailable there; it retains its existing browser motion
demo and makes no analysis API calls. Native analysis runs on the user's computer
through the installed Python app. No model downloads or new OpenCV distribution
are needed.

Native calls can block. Closing a worker reports a timeout and prevents a second
analysis worker from taking its place while the first is still stopping. Stronger
recovery from a permanently blocked native call would require process isolation.

References: [MOG2](https://docs.opencv.org/4.x/d7/d7b/classcv_1_1BackgroundSubtractorMOG2.html),
[MIL](https://docs.opencv.org/4.x/d0/d26/classcv_1_1TrackerMIL.html), and
[contours/components](https://docs.opencv.org/4.x/d3/dc0/group__imgproc__shape.html).
