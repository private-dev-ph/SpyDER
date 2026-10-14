# Camera workspace UI and lifecycle audit

The supplied transparent `spyder-emblem.png` is preserved byte-for-byte and bundled
with the installed app and static showcase. It supplies the brand and favicon.
`icons.svg` replaces font-dependent glyphs with consistent outline icons.
Decorative SVGs are hidden from assistive technology; icon-only controls keep
descriptive labels.

Fixed findings:

- Sidebar status-dot baseline alignment: centered flex row, with sticky sidebar
  keeping connection information visible during scrolling.
- Crowded narrow tile actions: container queries stack footers and wrap controls;
  touch targets are enlarged and long camera labels truncate.
- Camera wall accessibility: added the missing group role for its accessible name.
- Scrollbars and range controls: themed tracks, thumbs, progress, hover, keyboard
  focus, and disabled states for light/dark mode. Native range behavior remains.
- Disabled controls: use an unavailable cursor instead of a misleading waiting cursor.

## Camera release

**Release cameras when away** defaults on. A view is active only while visible
and focused. Presence updates follow focus/visibility events and repeat every five
seconds. A two-second grace avoids brief window-switch churn; leases expire after
15 seconds if a view disappears or crashes without a final update.

The installed GUI releases capture and CV workers when no live tab retains them.
Any active tab, or an open tab with release disabled, keeps cameras active.
Returning resumes only policy-suspended cameras; manual pauses/removals remain.
Idle transitions never rewrite camera configuration or profiles. The preference
persists in browser storage and syncs across tabs on that origin. Closing a pinned
tab relinquishes its lease. `serve` remains continuous headless monitoring without
the GUI idle policy.

The showcase applies the policy to streams owned by its own tab: stop webcam
tracks, pause local video, clear preview/motion buffers, and resume policy-paused
feeds on return. Local file playback resumes from its previous position. Presence
requests stay in the browser adapter; Cloudflare receives no camera heartbeat.

`CameraManager.set_recording(camera_id, active)` and showcase `setRecording`
retain cameras used by the tiled recorder. Recorded cameras are exempt from idle
suspension independently of other cameras. Native recording continues while the
browser is away. The showcase finalizes recording when hidden and releases its
tracks when the page is left. See [recording behavior](recording.md).

Native camera/ML calls can block. Suspension retries failures instead of creating
another owner; process isolation remains future work.

## Short-window scrolling

At viewport heights of 700 CSS pixels or less, the header and sidebar join normal
document flow. The sidebar no longer owns a nested scrollbar, so scrolling the
workspace reaches the camera wall. Taller windows retain the sticky navigation.
Focused cameras have an internal vertical scrollbar when necessary, a minimum
120-pixel preview, and non-shrinking header/footer controls. Short windows place
the focused card 12 pixels from the top while preserving the exit toolbar.

Browser checks against the installed 0.6.1 wheel covered actual CSS viewports
1600x300, 1000x320, 487x320, 1600x600, and 1600x1000. The last camera footer was
reachable in normal view, focused-camera controls were reachable, and no horizontal
overflow occurred. An End-key check at 1600x320 reached the last camera. Browser
zoom was 80%, so these are measured CSS sizes rather than emulator dimensions.
These checks cover Chromium; other browser engines remain unverified.

## Workspace and media navigation

The sidebar links to Control Room, Vision Lab, Camera Setup, Recordings, Events,
Layouts, and System. A workspace selector provides the same destinations on
small screens. Hash navigation supports browser Back/Forward without restarting
camera or recorder state. Page titles and focus identify the active workspace.
Shorter desktops hide the decorative sidebar note to make room for navigation.

Recording controls appear on camera cards and in the Recordings workspace.
The top bar shows elapsed recording time. Selected feeds resize within a preview;
checkbox changes apply to the current video. Pause controls protect recorded
cameras. Capture uses a separate browser canvas so it cannot alter a recording.
Library links download finalized files only. Planned workspaces describe their
scope without offering controls that pretend unfinished features already work.

## Fullscreen Control Room

**Fullscreen wall** enters browser fullscreen with all camera feeds tiled to fit
the viewport. The left edge ribbon opens workspace navigation; the right ribbon
opens live tools for camera settings/profiles, adding devices, starting/pausing
unrecorded views, fit/fill, recording, capture, theme, and idle release. Drawers
scroll independently in short windows and collapse when clicking outside them.
Workspace navigation exits fullscreen. Browser fullscreen exit restores the wall.
Unsupported fullscreen requests retain the camera-only window view with a notice.

Tile actions live inside the feed and appear on hover or keyboard focus. Touch
devices keep them visible. Camera names, state, and recording indicators remain
visible. Existing preview nodes and recording owners are reused. Settings and
confirmation dialogs remain available because the document root is fullscreen.
Single-camera focus returns to the tiled fullscreen wall before leaving the wall.

Chromium checks covered real Fullscreen API entry, settings dialog open/close,
two and eight tiled feeds, mobile touch visibility, keyboard control revelation,
quick capture, workspace navigation, and browser/API exit. Layout tests cover up
to 24 cameras in landscape, portrait, and short windows. Other browser engines
remain unverified. See [Fullscreen API behavior](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen).
