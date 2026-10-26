# Workflow editor tools

## Copy and paste nodes

Select a node, then choose **Copy node** and **Paste node**. You can also press Ctrl+C and Ctrl+V, or Cmd+C and Cmd+V on macOS, while focus is outside text fields. Paste creates an unconnected draft node with a new ID and a small position offset. Coordinates stay within the canvas limits. The copy has no incoming or outgoing connections, and invalid data links are removed. Copying a node does not enable the workflow or change its saved execution. The copy buffer lasts for the current editor session.

## Label a connection

Open either connected node's settings. In the IN or OUT connection list, enter an optional label of up to 80 characters. Labels appear beside the connection and in workflow exports. The editor escapes label text before display. Labels remain when a connection is moved and support undo and redo.

## Review latest node status

The installed app shows each node's latest run state, input and output counts, timestamp, and error when available. Status refreshes only while the editor page is visible. It does not change the workflow draft or mark it unsaved. Showcase mode has no runtime status data.

Before enabling a workflow, open **Inspect node** to review the validation summary. Select an issue to focus its node when the editor can identify one. Fix all reported issues before enabling. A validation count also appears beneath the canvas.

Latest status contains counts and errors, not stored frames or a historical input/output log. For workflows with multiple cameras, it reflects the most recent camera evaluation. Status polling updates indicators in place and preserves open settings, typing focus, camera frames, and preview connections. Native status is unavailable in the Cloudflare editor showcase.


## Field help and value controls

Each field in a node's settings has an information icon. Hover over it or focus it
with the keyboard to read the field's purpose, accepted input, units, and limits.
Click or tap to keep the tooltip open; click again or click elsewhere to dismiss it.
Escape dismisses field help before closing the node settings. Guidance that used
to appear below fields is now inside these tooltips. Live status, validation errors,
and model-installation notices remain visible.

Numeric fields retain direct typing and keyboard arrow controls. The themed minus
and plus buttons adjust by the field's step and respect minimum/maximum limits.
Disabled or linked fields cannot be changed through their step controls. Inspect
settings before saving or enabling a workflow; opening help does not apply changes.
