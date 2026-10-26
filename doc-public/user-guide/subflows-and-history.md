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
Each replay is queued as a separate `replay` record linked to its original run,
subject to the current collection settings, retention limits, and storage availability.
Live and replay records can be filtered separately. They cannot reproduce footage
or detection inputs that were not retained. Code nodes
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

### Monitor and manage retained runs

The toolbar opens history filtered to the current workflow. Choose **All runs / reset filters**
to browse the whole library. The history window includes totals for completed, filtered, and failed evaluations,
plus average duration across the current filters. Counts describe workflow
**evaluations**, not detected people or independent recording clips. A filtered
result is usually an expected rule outcome rather than an application error.

Search by workflow name or camera, filter by workflow/camera ID, state, source,
and local calendar date, then choose newest, oldest, or slowest first. Pagination
and a scrollable list keep the view manageable as history grows. Summary metrics
cover all matching retained runs rather than only the visible page.

Enable **Live updates** to refresh the newest page every five seconds. Updates
pause while the tab is hidden, while records are selected, while a run is open,
or while you are interacting with the list. Older pages and other sort orders
stay still; use Refresh to fetch them explicitly. Closing the window ends updates.

Open **Details**, expand the execution graph, and select a node with the mouse or
keyboard to inspect its recorded IN/OUT data, signals, call path, timing, and archived
configuration. Missing payloads are labelled explicitly. Diagnostic mode must have
been enabled before that run to retain bounded payloads; enabling it later cannot
recover old data. The archived configuration is read-only and does not alter the
current workflow.

Select individual runs or **Select page** for bulk JSON export or deletion, up to
500 records at a time. Selection can span pages and is cleared when filters change.
Exports include archived configuration and retained diagnostic data, which may
contain identity labels or code; treat downloaded files as private. Large exports
are bounded: reduce the selection if the server reports its export allowance.
Deletion requires confirmation and removes history only. It never deletes cameras,
workflow definitions, events, captures, or recordings. Clearing site data in the
Cloudflare showcase does not affect local application history.

### Per-workflow history rules

Open a workflow and expand **History saving** below Execution mode. These settings
apply after **Save workflow**, persist with the workflow, and travel with workflow
imports and exports. Existing workflows continue to save all outcomes by default.

- Turn off **Save execution history for this workflow** to stop collecting its runs.
  Existing history remains available; cameras, workflow actions, and recordings continue.
- Choose **Failed / error executions only**, **All executions**, or select a custom
  combination of completed, filtered, and error outcomes. Keep at least one outcome.
  A filtered result or an unknown face is not an execution error.
- Set **Minimum time between saved runs** from 0 to 86,400 seconds. Zero saves every
  selected outcome. A positive interval is shared across all cameras of that workflow.
- **Always keep selected errors** lets errors bypass that interval, provided error is
  among the selected outcomes. Turn it off to rate limit errors as well.

The interval starts only when a record is accepted into the history queue. Intentional
skips are not reported as dropped records. Interval windows reset when the application
restarts; the rules themselves persist. Global history collection must also be enabled,
and global retention, run-count, and size limits continue to apply.

A saved execution contains the whole expanded call trace. Nested callable workflows
follow the parent execution's history rules rather than creating separate run records.
Safe diagnostic replays follow the workflow's currently saved history rules, so an
archived configuration cannot bypass a newer collection opt-out. If the workflow has
been deleted, its archived rules apply. Disabling history also disables future diagnostic
payload retention; it does not prevent manually inspecting previously retained runs.
