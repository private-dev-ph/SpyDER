# Reusable subflows and execution history

[Documentation home](../README.md) · [Vision Lab and workflows](vision-workflows.md)

## Reusable subflows

A subflow packages a graph behind one detection-stream input and one output. Use it for repeated
conditions and actions, such as filtering unknown faces, applying a cooldown, and
creating an event. Calls reuse the camera results already available to the parent
workflow. They do not create an additional camera capture or inference worker.
Named scalar arguments customize settings; arbitrary named data ports are not part
of this interface. The output bridge takes one upstream connection.

Open **Subflows** in the workflow toolbar. The library shows a graph thumbnail,
node and exposed-setting counts, and available versions. Search by name, description,
or ID, sort the list, and use Previous/Next to browse eight definitions at a time.

Choose **Blank subflow**, **Confidence + cooldown**, or **Filtered event log** to
start a draft. Connect processing nodes between exactly one **Subflow input** and
one **Subflow output**, then publish a named version. Definitions do not run
independently. The event starter logs a matching detection; it does not attach
media until you configure the Event node to do so.

Select a version in the library and choose **Add to workflow**. This inserts a call
node and opens its settings. Connect its IN to the parent's detection stream and
its OUT to the next processing node. Save and enable the parent workflow when ready.
Adding a call never starts a camera, runs a model, or enables the workflow by itself.

Double-click a call to edit its settings or open its pinned definition. Nested
editing keeps a stack of parent drafts; **Return to parent subflow** or **Return to
workflow** restores the appropriate parent and its undo history. Leaving unpublished
changes asks for confirmation. Publish first if those changes should become reusable.

### Parameters and state

Exposed parameters map a named, typed argument to a setting on an internal node.
For example, expose `confidence` on a Filter and `seconds` on a Cooldown. Each call
can override the defaults without duplicating the internal graph. The publishing
form shows each field's current default and lets you give the exposed setting a
unique name and compatible scalar type. Bridge nodes and subflow reference fields
are not offered as exposed settings.

Call settings distinguish **Inherited default** from an **Override for this call**.
Choose **Use default** to remove an override. Advanced JSON contains only explicit
overrides; omitted keys inherit the selected version's defaults. Switching versions
keeps compatible overrides and asks before dropping settings that the new version
cannot accept. A published version's defaults never change in place.

Type and final node-setting validation both apply: a number is not automatically
a valid confidence.

Internal node state belongs to the parent workflow, camera, and call path. Two
calls to the same definition therefore have separate cooldowns. Camera handles and
compatible model workers remain shared. Global action rate limits and the recorder's
ownership rules still apply when several callers request actions simultaneously.

Published versions are immutable. Editing and publishing creates another version;
existing calls keep their pinned version until deliberately updated. Nested calls
allow up to four nested levels and 256 expanded nodes (512 connections).
The catalog allows up to 500 definitions, 100 versions per definition, and 8 MiB
of configuration. Missing versions and invalid or
recursive references are rejected. Referenced definitions cannot be deleted.

### Portability

Workflow bundle export includes the workflow and all pinned subflow dependencies.
It contains configuration, not model weights, camera footage, or the execution
history database. Export includes older pinned versions even when newer releases
exist. Renaming a definition and publishing it creates another version of the same
definition; existing calls keep their original version. Import validates dependencies
before saving them and leaves the imported workflow disabled. An existing, different definition with the same ID and
version is a conflict; imports do not silently replace it.

The general System configuration backup has a separate schema. Use workflow bundle
export for workflows containing subflows, rather than a configuration-only backup.

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

The static showcase keeps subflow configuration in browser-owned storage. It does
not execute native workflows or retain server execution history. History controls
explain this boundary instead of requesting the local API or uploading camera data.
Local application history stays on the user's computer.
