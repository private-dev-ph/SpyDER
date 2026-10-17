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

Choose **5, 15, 30 or 60 minutes, or 3, 6, 12 or 24 hours** per clip.
The default for new settings is **6 hours**; existing saved preferences are retained.
A continuous session produces sequential, independently playable MP4 files. Camera
selection can change without stopping the session. Completed clips appear in the
library while recording continues. Clip numbering and session IDs persist.
Rotating files changes individual file sizes, not total daily storage. A six-hour
clip is approximately 173 MB in Archive, 691 MB in Efficient, or 5.4 GB in Detail,
before container overhead. Choose a storage allowance larger than a normal clip
and shorten clips if continuous cleanup needs to reclaim space sooner.

## Unexpected stops and recovery

New native recordings use **fragmented MP4**, with a two-second fragment target,
zero encoder lookahead and no B frames. Unlike a conventional MP4 that needs its
final playback index, complete fragments can be read after the encoder is killed.
The recorder requests a filesystem flush every five seconds and durably journals
the active clip and encoder identity before sending frames. Completed clips are
flushed, renamed and added to the catalog using recoverable atomic updates.

On startup, SpyDER checks interrupted clips, verifies that their encoder has
exited, and restores decodable footage to Recordings. Recovered clips are marked
**Recovered after interruption** and **Keep forever** automatically, so retention
policies cannot immediately discard them. An OS lock excludes competing recorders
and recovery in the same folder. Run one application instance per output folder;
the lock is not a general multi-instance media-library synchronization service.

Recovery scans MP4 box headers without loading an entire multi-hour clip into
memory. If the last fragment is incomplete, its tail is preserved separately
before trimming. Failed decoding restores the original bytes. Corrupt, legacy,
unconfirmed-launch or unusually large uncertain files remain on disk for review;
they are never silently deleted. Pending recovery is shown in Recordings and
retried on a later restart. Only up to 32 active journals are processed per startup.

This reduces loss; it cannot guarantee every frame survives a power cut. The
newest incomplete fragment and buffered writes may be lost. Five-second flushes
are requests to the filesystem, not proof of hardware power-loss protection. A
flush failure produces a durability warning and is retried; the loss window can
then grow. An unavailable/full drive or damaged filesystem can prevent saving.
Older conventional MP4 partial files cannot always be repaired automatically.

Normal stop, low disk space and storage-allowance stops still attempt to finalize
the current clip, including encoder failures where usable frames remain. The
recorder stops below 64 MiB free instead of silently switching to larger MJPEG.
Automatic cleanup remains off by default. Keep sufficient free space and backups.

The library shows real frame thumbnails spanning each clip's details and action
rows. Select a thumbnail to play the video inline, or download it. Thumbnails are
generated locally on demand and kept in a bounded memory cache.

## Cloudflare showcase

The static demo uses browser `MediaRecorder` with the same resolution, frame rate
and requested bitrate profiles. The browser selects a supported WebM/MP4 codec;
bitrate is a browser hint. Profile choices persist in browser storage. The demo
retains its 128 MiB in-memory limit, requires a visible tab, and has no automatic
clip rotation or persistent recording files. Download recordings before closing
the tab. A closed or crashed tab loses these in-memory recordings; native crash
recovery does not apply to the showcase. Long clip choices do not remove the demo
memory/visibility limits. Use the installed Python application for full-day recording. Cloudflare
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


## Recording storage allowance

In **System → Recording storage allowance**, enter a maximum in decimal GB and
choose what happens when it fills. Zero means unlimited (the default); a finite
allowance must be at least 64 MiB. Saving a policy applies it immediately, including
its selected cleanup action. The allowance counts MP4, AVI and WebM files in the
**active** output folder, including unfinished and unmanaged video files. JPEG
captures, models and previous output folders are excluded. Policies are saved per
active output folder. A corrupt policy blocks recording until repaired in System.

- **Stop & save:** stop the current recording and save its final clip. New manual
  and workflow starts are refused until space becomes available or the allowance
  is raised. Freeing space never automatically restarts a stopped session.
- **Recompress oldest:** try each eligible finalized MP4 once, oldest first, using
  local H.264 at up to 640 × 360, 3 fps and 64 kbit/s (32 kbit/s for Archive clips).
  This is lossy and reduces evidence detail. Recompression uses one encoder thread,
  requires temporary disk space, and can take time. The original is replaced only
  after playback/duration validation and at least 5% size savings. A failed,
  cancelled or unhelpful conversion leaves the original intact. If space remains
  insufficient, recording stays stopped. It never falls back to deleting files.
- **Delete oldest:** permanently remove oldest eligible finalized recordings until
  the allowance has room. Event records remain, but deleted clip attachments become
  unavailable. Choose this policy only if automatic rotation is intended.

In **Recordings**, mark a clip **Keep forever** to exclude it from both automatic
recompression and deletion. This flag persists after restart and also blocks manual
deletion until you choose **allow cleanup**. Protection applies to that clip, not
all past/future clips in its recording session. Previously configured output folders
are read-only in this library and are never cleaned automatically. Unknown video
files count toward usage but are never automatically altered. The current or most
recent clip is excluded from automatic cleanup to preserve the stopped footage.

The recorder keeps a 4 MiB allowance margin for finalization and checks physical
free space independently (64 MiB reserve). This is a software allowance rather
than a filesystem hard quota: buffered encoding, metadata and concurrent external
writes can cause small overshoots. Choose a budget larger than a normal clip for
continuous recycling; shorten clip length in Recordings if needed. Removing a drive,
power loss or external software filling all physical space can prevent a final
save; no application can guarantee persistence when its disk is unavailable.

**Check space / retry cleanup** reevaluates space and retries failed maintenance.
Use it after freeing disk space or repairing permissions. Kept clips are never
unprotected by retry. Completed successful/unhelpful recompression is not repeated.
The System page shows usage, protection totals, maintenance state and recent alerts.

Storage-full notifications are generated automatically and saved locally. An open
SpyDER page displays them in-app; desktop/browser delivery additionally requires
**Enable desktop alerts**, browser permission and an open page. A storage event
never opens a permission prompt. If the page was closed, the pending full alert is
shown on reconnection. Desktop alerts cannot be delivered by a closed browser page.
The Cloudflare showcase retains its separate 128 MiB tab buffer and does not expose
Python filesystem retention controls.
