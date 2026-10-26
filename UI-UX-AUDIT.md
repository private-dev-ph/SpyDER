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

## Models & Workflows rework

The original page placed the canvas roughly 2,087px below the top on a 375px phone. Workflow actions, execution policy, node palette, cameras, events, inline parameters, connection controls and the model library competed in one long page. The rework gives the graph the central workspace and keeps contextual tools in native dialog drawers under the same editor root. The graph schema, validation, persistence, execution and inference contracts are unchanged.

The direction follows the canvas and on-demand settings pattern in the [n8n repository](https://github.com/n8n-io/n8n), [workflow settings documentation](https://github.com/n8n-io/n8n-docs/blob/main/docs/build/manage-workflows/configure-workflow-settings.md), and [node interaction documentation](https://github.com/n8n-io/n8n-docs/blob/main/docs/build/understand-workflows/workflow-components/work-with-nodes.md). UI/UX Pro Max supplied keyboard/focus and touch guidance. Its disclosure query returned no relevant database match; the information architecture uses the primary-source reference and general accessibility guidance rather than an unverified skill result.

| Existing capability | New home |
| --- | --- |
| Current workflow; saved/enabled counts; library search, filters, sort and paging; create/open/rename/duplicate/export/delete; callable creation/publication/calling; saved enable/disable and unsaved guards | Current workflow name opens the existing workflow manager. |
| Save and independent activation/deactivation, camera impact review and error feedback | Primary toolbar actions, with existing confirmation flow preserved. |
| Workflow name, camera assignments, independent/callable/both execution modes, callable interface and immutable publishing, history policy/presets/outcomes/interval/errors | Workflow menu → Workflow settings. |
| Templates and search, setup guidance, disabled draft loading and undo restoration | Workflow menu → Templates. |
| JSON import/export and deletion | Workflow menu. Existing model reference remapping and draft guards remain. |
| Node palette search/groups, click-add and drag-add | Add node drawer. Dragging releases the modal backdrop while retaining the drag source. |
| Camera, Model, Classifier, Detections, Filter, Zone, Count, Cooldown, Code, Call workflow, Workflow input, Workflow output, Preview, Event, Notification, Capture, Record | All 17 node types remain available through their original palette/execution-mode rules. |
| Node parameters, typed/manual connections, edge removal and validation/node review | Inspector drawer. |
| IN/OUT schemas/signals, field bindings and drag-to-bind, connection labels/reconnection, classifier/detector/catalog settings, notification permission controls, Python/JavaScript editor and local code tests, field help/latest status | Existing full node settings dialog: double-click, Enter, or Edit node. |
| Model upload/registration, metadata inspection, label-source selection/editing, search/filter/sort/pages, Model/Classifier insertion, reference guards and confirmed removal | Models drawer. |
| Recent events and execution history, details, replay, exports and deletion | Recent events drawer and existing execution-history tools from Workflow menu. |
| Pan, zoom/reset/center, drag/keyboard graph operations, copy/paste, undo/redo, live preview lifecycle | Canvas with floating viewport controls and compact editing footer. |

Panels preserve draft and canvas state across re-renders, provide focus return and Escape dismissal, and are removed on workspace unmount. Select pickers and help retain their own Escape layer. Delete shortcuts do not delete graph content while focus is in a dialog or on an interactive button. Unsupported native execution/model operations retain their existing showcase gates; no backend or dependency was added.

Validation: 285 JavaScript unit tests and 4 static-export tests pass. The expanded templates browser regression covers drawer search/add/drag-add/undo, draft/canvas preservation, keyboard dismissal/focus, settings/models, all node parameter/help layouts, mobile/short-window bounds, Delete protection and unmount cleanup. Workflow-tools, workflow-manager/editor (1,000 workflows), and workflow-history browser suites pass. The static delivery export is generated locally; nothing is publicly deployed.
