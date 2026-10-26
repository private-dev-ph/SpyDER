# SpyDER UI/UX audit — 26 October 2026

## Scope and baseline

Changes use `codex/mobile-first-ui-ux` from local `fix/enrollment-focus-controls` at `dcf72b1`. After refreshing GitHub refs, that baseline contains the remote tip plus 16 commits. `main` is behind the integrated feature branch. Work lives in an isolated checkout; existing worktrees are untouched.

## Improvements

- Group arrangement selection, layout editing, camera reordering and activity priority under a native **Arrange wall** disclosure. Playback, tile size and fullscreen remain available directly. Rotation controls remain visible when relevant.
- Use a two-column mobile toolbar with wrapping labels, a full-width workspace selector and consistent page gutters. Reduce secondary summary text on phones and align metric labels.
- Standardize shared icon, camera action and number stepper targets at 44px. Increase phone input text to 16px to avoid automatic field zoom.
- Add a keyboard skip link that preserves the active workspace; reserve scroll clearance for the sticky header. Preserve reduced-motion and forced-color behavior.
- Theme dark-mode select indicators, camera recovery state, number-control hover, operations accents and video-action states using the existing red/gold palette and semantic tokens. Video canvases retain their intentional dark backgrounds.
- Theme open dropdown pickers in browsers supporting customizable native selects, including red hover/keyboard focus, gold selection and the native checkmark. Unsupported browsers and forced-color mode retain native pickers. Chrome regressions cover light/dark themes, hover, keyboard acceptance/cancellation, disabled groups, dialog dropdowns and mobile bounds.
- Let camera settings actions wrap and stack dialog fields on narrow screens. Improve settings checkbox spacing and system/schedule form spacing.
- Bound workflow dialogs to the dynamic viewport, improve narrow filter/pagination layouts and retain scrolling in short landscape windows.
- Remove duplicate Vision Lab panel margins where the parent grid already provides a gap. Events already has a single outer panel; System and operations sections are siblings. Their semantic groups were retained.

## Deployment compatibility

No dependency, server endpoint or backend requirement was added. The standard-library static exporter still packages the complete browser app. Existing browser/local-runtime capability messages are preserved: native camera tuning, OpenCV/InsightFace/YOLO execution and persistent local system operations require the installed Python app. Browser-supported camera/file, recording, layout and workflow showcase paths remain available.

## Validation

- JavaScript unit suite: 285 passed, 0 failed.
- Python static export suite: 4 passed.
- Chrome number-control regression: passed, including updated 44px targets.
- Layout, camera-priority, workflow-manager and workflow-tools browser regressions passed. Camera-priority initially timed out during parallel Chrome runs, then passed in isolation; the timeout cause was not established.
- Added Chrome regressions for keyboard opening/closing of Arrange wall, direct playback controls and skip-link route preservation. Layout and fullscreen regressions passed sequentially against the updated export.
- All seven workspaces had no document-level horizontal overflow at 320px, 375px, 767px tablet, 812px landscape and 1440px desktop. Light and dark themes and reduced-motion were inspected in Chrome.
- git diff --check passed.

## Limits

Verification uses generated showcase cameras and Chrome viewport emulation. Real mobile Safari/Android devices, physical camera drivers, native dialogs, CV models and deployment on a public Cloudflare subdomain were not exercised. No public deployment was made.
