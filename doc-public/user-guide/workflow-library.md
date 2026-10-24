# Workflow library and workflow calls

[Documentation home](../README.md) · [Vision Lab](vision-workflows.md)

SpyDER uses one workflow library and one editor for independent workflows and
reusable workflows. A workflow can run on its own, accept calls from another
workflow, or support both. Published callable versions are immutable snapshots of
the same workflow, rather than a separate kind of editable project.

## Choose how a workflow runs

Open the workflow selector in **Vision Lab -> Models & Workflows**. The manager
includes search, execution-mode/status/camera/engine filters, sorting, and pagination.
**Call workflow** opens this same manager with its Callable filter selected.

| Execution mode | Independent Enable/Disable | Calls from other workflows |
| --- | --- | --- |
| Independent | Available | Not offered for new callable publication |
| Callable only | Unavailable | Available after publishing a callable version |
| Independent + callable | Available | Available after publishing a callable version |

Disabling an independent trigger does not disable calls. Each invocation has its
own cooldown state. A workflow using both modes may create actions from its own
camera runs and from parent calls; global action limits still apply.

Select a mode in the editor's **Execution mode** control. Changes apply on Save.
Choosing Callable only stops independent execution when that draft is saved; it
does not enable a parent workflow or start a camera.

## Create or convert a callable workflow

Use **New callable workflow** in the common manager for a draft with Workflow input
and Workflow output already connected. Insert processing nodes between them.

To reuse part of an existing independent workflow:

1. Open the workflow and choose **Independent + callable**.
2. Under **Callable interface**, choose where the callable branch should start and
   which node should return its result.
3. Choose **Add input / output**. The existing camera/detector path stays connected
   for independent execution.
4. Inspect the connections. A typical result is:

   ```text
   Independent: Camera -> Detections -> Filter -> Event
   Callable:                 Input -> Filter -> Event -> Output
   ```

5. Choose **Save & publish callable version**. Give exposed settings distinct names
   and compatible scalar types, then publish.

Only nodes on paths between Workflow input and Workflow output are included in the
published callable branch. Required model/classifier resources for that branch can
be included; independent camera triggers and unrelated output branches are excluded.
A setting bound to an excluded node must be moved inside the callable branch before
publication. Exactly one input and output are required, with one connection into
Workflow output. Drafts can be saved before this interface is complete.

For a workflow containing only an input/output processing branch, independent
execution uses its selected camera results from the Cameras panel. Configure a
working CV pipeline first. When an independent camera/detector source already
exists, the call input does not bypass that source's validation gates.

Saving edits to an already enabled independent workflow can change its running
behavior. Publishing also saves the editable draft; review its settings first.

## Call another workflow

In a parent workflow, choose **Call workflow**, find a callable workflow, and select
**Use in workflow**. This inserts a Call workflow node and opens its settings.
Connect the parent's detection stream to IN and connect OUT to the next node.

Choose a published version. Exposed input settings appear automatically. Each
setting shows whether it inherits the version's default or is overridden for this
call. **Use default** removes an override. Advanced JSON contains explicit overrides.
Calls execute locally using the caller's detection/camera context; they do not start
another independent trigger or camera capture. Calls return synchronously into the
parent's detection stream. Background/fire-and-forget calls and arbitrary JSON data
ports are not implemented.

**Open workflow** opens the common editable workflow draft. Return controls restore
parent drafts and undo history, including nested navigation. The editable draft may
be newer than the published version selected by a caller. Opening a draft does not
change that caller's pin.

## Versions, references, and migration

- Saving a draft does not publish or upgrade callers.
- Publishing creates another immutable version with the same workflow ID.
- Existing calls keep their pinned version until explicitly changed.
- Version changes retain compatible overrides and ask before dropping incompatible
  settings. Final node-setting validation still applies.
- Workflows referenced by saved callers or published dependencies are protected
  against deletion and against disabling call permission.
- Calls cannot form recursive dependency cycles. Existing nesting and expanded-graph
  bounds continue to apply: four nested levels, 256 nodes, and 512 connections.

Existing independent workflows retain their behavior. Legacy subflow definitions
appear as callable-only workflow records with the same published IDs, versions,
and connections. Migration does not enable them. ID collisions and storage failures
are reported while preserving original data; they are not silently overwritten.
The internal version snapshot store remains available for old pinned references.

Workflow bundle export includes pinned callable dependencies. Import keeps the
parent disabled and makes imported definitions available in the common library.
Model files, camera footage, credentials, and execution history are not included.

## Static showcase

The Cloudflare showcase stores workflow drafts in browser IndexedDB and published
callable snapshots in browser storage. Existing browser subflows are migrated into
the same manager. Configuration import, export, and nested editing stay on the
user's computer. The showcase does not execute native workflows or request the
Python API. Browser storage has quota limits; export important definitions before
clearing site data. Its workflows are separate from the installed app's library.

## Reference design

The interaction takes inspiration from n8n's [Execute Sub-workflow node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/)
and [workflow-call trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflowtrigger/):
a regular workflow declares a callable entry point, and a caller selects it and
supplies its inputs. The [n8n implementation](https://github.com/n8n-io/n8n/tree/master/packages/nodes-base/nodes/ExecuteWorkflow)
was reviewed as a reference. SpyDER keeps its bounded detection-stream contract,
local execution, shared camera resources, and explicit immutable version pins.
