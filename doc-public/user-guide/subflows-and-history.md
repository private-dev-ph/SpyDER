# Reusable subflows and execution history

[Documentation home](../README.md) · [Vision Lab and workflows](vision-workflows.md)

## Reusable workflow calls

Reusable branches are now workflows in the common manager. The same workflow can
run independently, accept calls, or do both. See [Workflow library and calls](workflow-library.md)
for the editor, input/output contracts, exposed settings, versioning, and migration.

Existing subflow IDs and immutable versions remain valid. Use **Call workflow**
to open the common manager filtered to callable workflows. Opening a called
workflow uses the same editor and preserves parent navigation. The
[three-level sample](three-level-subflow-demo.md) demonstrates nested calls.

## Execution history

Open **Execution history** from the workflow toolbar. Each retained run records a
workflow evaluation for one camera's fresh detection result. Search and filter by
workflow, camera, completion state, and time range. Results are paginated.

Open a run for node-by-node states, input/output counts, timings, errors, call paths,
and action outcomes. A filtered or empty result is useful information: it explains
why an event was not created. A cooldown or rate limit can suppress an action even
when an upstream detector matched.

Event actions link to their event and media. An event recording may still be pending;
requesting a recording does not mean its file has finished saving. Run details read
the event's current attachment outcome. Deleting an event or its recording can leave
an unavailable reference in older history. History deletion never deletes media.

### Summary and diagnostic modes

**Summary** is the default. It retains node states, counts, timing, configuration
revisions, and action references. It does not retain detection payloads.

**Diagnostic** additionally retains bounded detection inputs and outputs for closer
inspection and a dry run. This can include identity labels. Enable it deliberately
and choose a suitable retention period. Images, raw camera frames, embeddings, and
model weights are excluded from history storage.

Dry runs use the archived graph and retained detections. They do not open cameras,
run models, create events, send notifications, or start recordings. Their cooldown
state starts empty, so results can differ from a live run that had an active cooldown.
They cannot reproduce footage or detection inputs that were not retained. Code nodes
use the existing bounded code runner; external actions remain disabled.

### Retention and local storage

History is stored in the application data directory, separate from recordings.
The history settings control collection, summary/diagnostic mode, retention days,
maximum run count, and storage allowance. The first limit reached evicts older runs.
Workflow graph revisions are shared across runs to reduce repeated storage. Defaults
are seven days, 10,000 runs, and a 64 MiB data budget; the minimum budget is 1 MiB.
SQLite indexes and journals add physical disk overhead, reported separately in the UI.
Configuration snapshots have a 512 KiB allowance. Oversized snapshots are explicitly
marked incomplete and cannot be replayed; node summaries can still be inspected.
Diagnostic payloads retain at most 32 detections per node. Truncated payloads are
identified when running diagnostics.

Writes use a bounded background queue. If storage is unavailable or collection cannot
keep up, history reports its error or dropped-run count; capture and inference keep
running. An accepted queue item becomes durable when written, so the last queued
items can be lost if the process or computer stops unexpectedly. History is an
operational diagnostic record, not a guaranteed audit log.

## Static Cloudflare demonstration

The static showcase keeps workflow definitions and published callable versions in browser-owned storage. It does
not execute native workflows or retain server execution history. History controls
explain this boundary instead of requesting the local API or uploading camera data.
Local application history stays on the user's computer.
