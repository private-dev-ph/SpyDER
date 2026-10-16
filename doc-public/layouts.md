# Designing camera walls

Layouts is a browser-owned workspace for arranging the Control Room and fullscreen wall.
It changes the presentation, not camera capture, computer vision or recording membership.

## Create an arrangement

1. Open **Layouts** and choose a preset: automatic grid, fixed columns, featured view or rotation.
2. Give the arrangement a name. Set image fit, spacing and preferred columns.
3. Drag Camera lineup rows to reorder them, or use **Move up / Move down** with a keyboard.
   Uncheck cameras to hide them from this wall. Choose a featured camera when using Featured view.
4. Test desktop, square and portrait screen shapes in the preview.
5. Choose **Save draft** to keep the configuration without changing the active wall.
   Choose **Save & apply** to update both Control Room and fullscreen.

Use the **Arrangement** selector in the Control Room or fullscreen Live tools to switch saved walls.
Choose **Automatic wall** to return to the standard camera wall and tile-size controls.
Rotation supports **Pause rotation**, **Resume rotation** and **Next view** in both modes.
It stops advancing while the tab is hidden or another workspace is open.

## Simulate camera counts

In **Simulation cameras**, choose a name prefix, shape and count, then **Add dummy cameras**.
Create several batches to mix 16:9, 4:3, square and portrait feeds. Up to 24 dummies fit in one
arrangement. The preview updates immediately; **Save & apply** adds them to the wall.

Dummy tiles are generated SVG test patterns. They need no webcam permissions, network streams,
server rendering, CV or model downloads. They never enter the real-camera registry or recordings.
Each tile is labeled **DUMMY / SIMULATED**. Remove individual dummies in Camera lineup or choose
**Remove all dummies**, then save and apply. This works in the static Cloudflare showcase too.

## Backups and sharing

Named layouts and the applied configuration persist in browser storage, separately for the native
app and static showcase. Changing browser, origin or port uses a different storage area. Clearing
site data removes saved layouts. Use **Export layout** for a JSON backup and **Import layout** to
load it as a draft. Files contain view preferences, camera IDs and dummy definitions, not frames,
stream URLs, model files or credentials.

Imported camera IDs may be unavailable on another installation. Use **Assign a camera** in the
unavailable row to map it to a current camera, or remove that row. New cameras automatically join
unless hidden. Layout imports support version 1, up to 128 KiB; at most 50 named layouts can be saved.
A browser storage failure leaves the current wall unchanged and shows an error.

## Development checks

Run `node --test` for the JavaScript suite and `python -m pytest` for native/static asset tests.
For the browser regression, export a new showcase directory and run:

```powershell
.venv/Scripts/python.exe -m spyder_cctv export-showcase --output .pytest_cache/layout-demo
node tests/layouts-browser.mjs .pytest_cache/layout-demo
```

The regression uses a temporary Chrome profile and a local server with the export's actual CSP.
It checks draft/apply behavior, dummy isolation, reload persistence, fullscreen bounds, rotation,
mobile sizing, imports and resetting to Automatic wall. Set `CHROME_PATH` if Chrome is not installed
at the Windows default path. No npm installation or frontend build is required.
