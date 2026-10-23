# Detection replay on clean recordings

SpyDER saves clean video and can save the detections that were available when each recorded frame was selected. During playback, detections are drawn on a separate layer. They never become part of the video or the face samples used for enrollment.

## Record and view detections

1. Enable the motion or detection workflow for a camera.
2. Record that camera, alone or in a tiled recording. No additional model inference is started by the recorder.
3. Open the saved clip from the recording library or Timeline playback.
4. Turn on **Show detections**. Turn it off to view the original clean footage.

Replay restores recorded observations; it does not re-analyze the clip. If detection was disabled or unavailable at recording time, there are no boxes to replay. Older clips do not gain detection history automatically. Re-running workflows against historical media is a separate future capability.

## Tiled video and timing

Each box includes its camera ID and coordinates normalized to the encoded composite. The recorder applies the same integer tile sizes and letterboxing offsets to pixels and boxes. This supports mixed camera aspect ratios, camera selection changes, and offline tiles without guessing the layout during playback.

Samples use seconds from the beginning of each encoded clip. The timestamp comes from the encoded frame count rather than wall-clock time. Clip rotation resets metadata time to zero; duplicated catch-up frames use the same observations as their duplicated pixels. Pre-event footage uses annotations from its buffered frame, rather than current live detections.

Detection and identity results are asynchronous observations. Replay preserves the results that were available for the selected camera frame; it cannot make the model more accurate or make delayed inference frame-exact. Stale or unavailable results are omitted. Boxes are not interpolated into new identity guesses.

## Storage and long recordings

Sidecars live beside the recording in the selected recording output directory:

```text
<recording-id>.mp4
<recording-id>.overlays-000000.json.gz
<recording-id>.overlays-000001.json.gz
```

Each compressed JSON chunk covers 30 seconds. Identical observations are stored once within a chunk. Empty states explicitly clear old boxes. Chunk memory, decoded file size, record count, and box count are bounded; overloaded chunks are marked incomplete rather than growing without limit.

Playback requests only the current window and keeps a small cache. Seeking near the end of a 24-hour clip does not load its entire detection history. Detection sidecars count toward the recording allowance and are deleted with an unprotected recording. Protected clips retain their sidecars. Resolution-only recompression preserves normalized box placement.

Chunks are checkpointed alongside video durability checkpoints. Following an unexpected stop, already published chunks can remain available with recovered footage; the most recent uncheckpointed observations may be missing. Missing or damaged metadata does not make the clean video unplayable. If metadata writing fails, the recording continues and exposes a detection-metadata warning.

## Static Cloudflare showcase

The static demo does not call the installed Python API or run cloud inference. Use **Open local video** in Recordings to open an original clip from your computer, or open a browser-recorded clip. Then choose its detection sidecar files with the local import control. Multiple chunks from one clip can be selected together and are decoded only as needed. Gzip imports use the browser's [DecompressionStream API](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream/DecompressionStream). Browsers without gzip support can use uncompressed JSON chunks.

In the installed app, the playback controls can download the current detection window as JSON. For a longer clip, select its `.overlays-*.json.gz` files from the recording output directory. Keep sidecars with the matching original video; mixing metadata from different clips is rejected. Imported metadata is decoded in bounded windows for that player session; local videos use file-backed browser URLs rather than being copied into the recording buffer and are never uploaded. Their labels may contain identity names, so treat them with the same care as the recording.

## Format and limits

Version 1 uses `version`, `chunk_seconds`, `index`, `width`, `height`, `fps`, and `samples`. Each sample contains clip-relative `time` and a `boxes` list. Each box has normalized `[left, top, width, height]` coordinates, a label, a kind, and a camera ID; identity, confidence, and track ID may also be present.

The format is portable JSON rather than a server database. The native API decompresses one requested chunk; the static browser reads a user-selected file. The player validates finite coordinates and supported format versions before drawing. Missing windows, malformed data, and geometry mismatches clear the overlay instead of reusing unrelated detections.
