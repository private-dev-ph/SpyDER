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

Recording is not implemented. `CameraManager.set_recording(camera_id, active)`
and showcase `setRecording` are future-recorder integration hooks. Retained recording
cameras are exempt from idle suspension independently of other cameras. These
hooks do not start a recorder or claim footage is saved. Leaving the showcase
page still releases its browser-owned tracks.

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
