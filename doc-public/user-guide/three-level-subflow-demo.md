# Three-level nested subflow demonstration

[Documentation home](../README.md) · [Subflows and execution history](subflows-and-history.md)

Import [the sample workflow bundle](../../examples/workflows/three-level-nested-subflows.json)
from **Vision Lab -> Models & Workflows -> Import workflow**. It contains one disabled
parent workflow and three version-pinned subflow definitions. The portable file has
no assigned camera, model weights, footage, or credentials.

## Structure

```text
Parent: Camera -> Detections -> Level 1 -> Event
              Camera + Level 1 outputs -> Preview (starts paused)

Level 1: Input -> Face/confidence filter -> Level 2 -> Output
Level 2: Input -> Minimum detection count -> Level 3 -> Output
Level 3: Input -> Cooldown -> Output
```

This is three subflow levels beneath the parent, not three nodes in one subflow.
All calls are pinned to version 1. Legacy definitions appear as callable-only
workflows in the unified manager; their IDs and version pins remain intact. The parent is named **DEMO · Three-level nested
face event**; the definitions are named **DEMO · Level 1 · Face gate**, **DEMO · Level
2 · Minimum count**, and **DEMO · Level 3 · Cooldown**.

- Level 1 keeps `face` detections with confidence at least `0.60`. Its exposed
  settings are `class_label` and `min_confidence`.
- Level 2 requires at least one matching detection in the current result. Its
  exposed setting is `minimum_matches`. This is not a cumulative visitor counter.
- Level 3 passes a matching result at most once every five seconds. Its exposed
  setting is `cooldown_seconds`.
- Event creates an entry without an image or recording attachment. It does not
  send a desktop notification. Preview is optional and starts paused.

## Inspect the nesting without a camera

1. Import the bundle. The workflow stays disabled.
2. Double-click the parent Subflow node and open its workflow.
3. Repeat for Level 2, then Level 3. Inspect the Cooldown node at the deepest level.
4. Return through Level 2 and Level 1 to the parent workflow. Each parent draft is
   restored. Leave the definitions unchanged during the first walkthrough.
5. In the parent call, override `min_confidence`, then choose **Use default** to
   restore `0.60`. Changing a call's setting does not edit the published definition.

## Optional live test

Assign a configured camera in the parent Camera node. The Detections node uses
**Any**, which consumes that camera's existing CV results. This sample does not
install or select a detector. First verify the camera already produces fresh
`face` detections in a working setup. For a detector producing another label,
change the Level 1 call's `class_label` override to that exact label, such as `person`.

Save the parent, review activation changes, enable it, and start the camera.
Keep the app focused if its pause-when-unfocused preference is enabled.

| Input | Expected event behavior |
| --- | --- |
| A `face` at confidence 0.90 | One matching event |
| Only `person` detections with the default label setting | No event |
| A `face` at confidence 0.40 | No event |
| Another qualifying result within five seconds | Suppressed by Level 3 cooldown |
| A qualifying result after the cooldown expires | Another event |

Other workflows and global action rate limits can affect observed event frequency.
Use Execution history, when enabled, to inspect the expanded internal call paths.
The synthetic regression tests evaluate only isolated temporary storage; they do
not enable the installed workflow, open cameras, run inference, or record video.

## Edit inner settings deliberately

The outer call exposes only Level 1's settings. Settings are not automatically
forwarded across nested calls. To change the default cooldown, publish Level 3 v2,
update the Level 2 call to that version and publish Level 2 v2, then update/publish
Level 1 and finally upgrade the parent's call. Existing v1 callers remain unchanged.

## Portability and cleanup

The bundle also imports into the static Cloudflare showcase for editing and nesting
inspection. Native execution and live diagnostic history require the installed app.
Do not expect browser showcase edits to modify the local installed app's catalog.

To remove the demonstration, delete its parent workflow first, then Level 1,
Level 2, and Level 3 in that order. Referenced definitions are protected. Remove
only these demo items; existing cameras, workflows, and recordings are unrelated.
