# Recording storage

SpyDER records all selected cameras into one tiled video. The installed Python app
encodes **H.264 in MP4** using a local FFmpeg executable supplied by `imageio-ffmpeg`.
Encoding and storage run entirely on the user's computer. No footage is uploaded.
A normal `pip install` resolves the platform wheel; no separate FFmpeg installation
is needed on supported wheel platforms. Unsupported platforms need a local FFmpeg
build with `libx264`. SpyDER does not download an encoder while recording.

## Choose a profile

Open **Recordings → Storage & quality**, choose a profile and clip length, then
**Save storage settings** before starting a recording. Settings persist in the
active local media directory. They also apply to new workflow recordings and event
clips. Stop an active recording before changing settings.

| Profile | Composite size | Frame rate | Target bitrate | Approximate 24 hours | Approximate 15-minute clip |
| --- | --- | --- | --- | --- | --- |
| Archive | 640 × 360 | 3 fps | 64 kbit/s | 0.69 GB | 7.2 MB |
| Efficient (default) | 1280 × 720 | 8 fps | 256 kbit/s | 2.76 GB | 28.8 MB |
| Detail | 1920 × 1080 | 15 fps | 2,000 kbit/s | 21.60 GB | 225 MB |

These are decimal units and rate-based planning estimates, not file size guarantees.
The target applies to the entire mosaic, regardless of camera count. Container
metadata adds overhead, and actual encoding depends on motion and noise. Archive
can lose faces, plates, fine detail and fast movement. Adding cameras gives each
camera fewer pixels. Review representative day/night footage before choosing a
retention target. No audio is recorded. JPEG frame captures retain their existing
resolution and are unaffected by these settings.

The encoder uses bitrate-controlled H.264, a `veryfast` CPU preset, two encoder
threads and a two-second GOP. HEVC and AV1 are not enabled: this release prioritizes
widely playable files and modest CPU requirements. Hardware encoding can be added
later after capability testing on each supported platform.

## Continuous sessions, manageable files

Choose 5, 15 (default), 30 or 60 minutes per clip. A continuous session produces
sequential, independently playable MP4 files. Camera selection can change without
stopping the session. Completed clips appear in the library while recording
continues. Clip numbering and session IDs persist in the media catalog. Rotating
files reduces each file's size and limits the unfinished portion after a crash;
it does **not** reduce total daily storage. A crash can lose the current unfinished
clip; earlier finalized clips remain available. There is a small processing cost
at each file boundary, and stale sampling uses repeated frames to preserve timing.

Files are written to temporary names, finalized with MP4 playback metadata, renamed
and added to the catalog atomically. A failed encoder stops recording rather than
silently falling back to a much larger MJPEG file. The recorder stops when free
space drops below 64 MiB and attempts to save the current clip. Nothing is deleted
automatically. Keep sufficient free space and an external retention/backup plan.
The recording library can play or download each completed clip.

## Cloudflare showcase

The static demo uses browser `MediaRecorder` with the same resolution, frame rate
and requested bitrate profiles. The browser selects a supported WebM/MP4 codec;
bitrate is a browser hint. Profile choices persist in browser storage. The demo
retains its 128 MiB in-memory limit, requires a visible tab, and has no automatic
clip rotation or persistent recording files. Download recordings before closing
the tab. Use the installed Python application for full-day recording. Cloudflare
never receives or encodes video.

## Updating an existing installation

Use the existing environment, from the repository root:

```powershell
.venv\Scripts\python.exe -m pip install -e ".[dev]"
.venv\Scripts\python.exe -m spyder_cctv gui
```

Stop existing app instances before restarting after an update. Do not create a
second environment. Existing MP4/AVI recordings remain readable; new recordings
use the selected H.264 profile. No existing recording is transcoded or deleted.
The bundled FFmpeg build has its own license and notices; retain those when
redistributing a packaged application.

## Research and sizing references

Storage before overhead is `bitrate × 86,400 / 8` bytes per day. Keeping a full day
below 1 decimal GB requires an average total rate below approximately 92.6 kbit/s.
A codec alone cannot promise high-detail all-day video within that budget.
See [FFmpeg H.264 options](https://ffmpeg.org/ffmpeg-codecs.html#libx264),
[MP4 muxing](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv),
[the bundled local executable](https://github.com/imageio/imageio-ffmpeg), and
[the browser recording specification](https://www.w3.org/TR/mediastream-recording/).
