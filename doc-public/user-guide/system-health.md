# System health

[Documentation home](../README.md)

Open **System → Overview** to view a combined snapshot of camera capture,
inference, workflow execution, recording, and storage. It refreshes about every
five seconds while the page is visible. It uses existing status snapshots and does
not open another camera or run a benchmark.

System groups its tools into four sections. **Overview** contains health and camera
focus behavior. **Storage** contains the media folder, usage, allowance editing,
and storage alerts. **Backups** contains complete ZIP backups, browser preferences,
and configuration JSON tools. **Diagnostics** contains runtime and dependency details.
Switching sections preserves unsaved form values. Use the arrow keys, Home, and
End to navigate the section tabs.

Allowance editing starts collapsed; the selected policy explains its consequences
before saving. Backup creation opens first, with **Verify & restore** available as
a separate expandable task. Restoring still requires archive verification and
explicit acknowledgment before creating a separate restored folder.

The summary reports configured/running camera counts and recorder state. Issues can
include failed cameras, frames/results older than three seconds, inference errors,
recording failures, exhausted allowances, low physical disk space, pending recording
recovery, disk-checkpoint warnings, and errors in enabled workflow nodes. A paused
camera is not classified as an outage.

Use the relevant workspace to resolve an issue: camera controls for capture errors,
Vision Lab for inference/model settings, Recordings for recovery, and System's
storage controls for allowances. The health panel does not silently restart cameras,
clear errors, remove footage, or override recording ownership.

The panel shows current conditions, not an uptime history or background notification
service. It cannot report a crashed Python server while that server is offline.
Closed-page alerts and remote monitoring are outside its scope. Browser-showcase
health is limited to its browser-owned cameras; native diagnostics and persistent
configuration backup remain unavailable there.
