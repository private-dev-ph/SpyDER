# Timeline playback

Open **Recordings**, then **Timeline playback** below the recording controls. The
Library view remains available for searching, protecting, deleting, and downloading
files. Each saved video also has a **Show on timeline** shortcut.

## Find footage

Choose a local date and camera. Red coverage bars show when saved video is
available. Use the 24-hour, 6-hour, or 1-hour view to inspect a smaller time range.
Drag the playhead, use its keyboard controls, or enter a time in **Jump to local
time**. The timeline maps that clock time to an offset within the selected clip.
Saved clips are listed below the player, with pagination for large histories.

Playback uses the browser's time zone, which may differ from the recording
computer's time zone. Date boundaries follow local calendar days, including daylight
saving changes. Clock times are estimated from the saved clip start and encoded
duration; capture timing changes and recovery can introduce drift.

Blank areas are gaps in saved footage. Seeking into a gap pauses the player.
Finalized clips are available while recording continues; the active, unfinished
clip appears after it is saved. Captures are still available in Library and Events.

## Play across clips

Select **Play clip** or press **Play**. Adjacent clips continue automatically.
Enable **Skip gaps** to continue to the next available clip across a recording gap.
Playback speed supports 0.5×, 1×, 2×, and 4×. Previous/next clip controls navigate
between saved videos. Overlapping recordings are selected deterministically;
choosing a clip directly selects that particular recording.

The player opens the existing recording; it does not start a live camera or run
computer vision. If the installed application's browser cannot decode a video,
SpyDER can display locally decoded frames at up to five frames per second. This
compatibility preview has no audio and does not alter the original file. Download
the original for full-quality playback in another player. Playback pauses when
the page is hidden and stops when leaving the timeline.

## Camera membership and events

New recordings retain the cameras included in their tiled video. Camera filtering
finds whole tiled clips containing that camera; it does not extract an individual
camera stream or guarantee that the camera remained connected throughout the clip.
Older recordings without membership metadata appear under **Unknown camera** and
**All cameras**. SpyDER does not guess historical membership from current settings.

The installed application shows saved event markers alongside the footage. Events
can exist in gaps: an event log does not itself prove that video was recorded.
Markers use the selected date and camera; the timeline limits displayed markers
and coverage elements to keep large histories usable.

## Local application and static showcase

Installed playback reads recordings from the configured local media library,
including registered previous output folders. Deleted files, unavailable drives,
or missing event attachments remain unavailable until their source is restored.

The static showcase uses only videos recorded in the current browser tab. Blob
media stays on the user's computer and the showcase makes no media or event API
requests. Its videos disappear when the tab closes unless downloaded. The local
compatibility decoder requires the installed Python application. Publishing the
static showcase does not publish local recordings.
