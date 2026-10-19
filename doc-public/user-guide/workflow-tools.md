# Workflow editor tools

## Copy and paste nodes

Select a node, then choose **Copy node** and **Paste node**. You can also press Ctrl+C and Ctrl+V, or Cmd+C and Cmd+V on macOS, while focus is outside text fields. Paste creates a disabled draft node with a new ID and a small position offset. Coordinates stay within the canvas limits. The copy has no incoming or outgoing connections, and invalid data links are removed. Copying a node does not enable the workflow.

## Label a connection

Open either connected node's settings. In the IN or OUT connection list, enter an optional label of up to 80 characters. Labels appear beside the connection and in workflow exports. The editor escapes label text before display. Labels remain when a connection is moved and support undo and redo.

## Review latest node status

The installed app shows each node's latest run state, input and output counts, timestamp, and error when available. Status refreshes only while the editor page is visible. It does not change the workflow draft or mark it unsaved. Showcase mode has no runtime status data.

Before enabling a workflow, review the validation summary. Select an issue to focus its node when the editor can identify one. Fix all reported issues before enabling.
