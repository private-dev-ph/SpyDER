# SpyDER documentation

SpyDER is a local Python camera application with a browser interface. These guides
cover installation, daily use, development, and the separate browser showcase.
Start with [Getting started](getting-started.md) for a working local installation.

## User guides

- [Demo camera feeds](user-guide/demo-camera-feeds.md): bundled residential footage, software camera controls, browser automations, licensing and capability boundaries.

- [Face galleries and ONVIF cameras](user-guide/face-galleries-and-onvif.md): local
  enrollment, workflow recognition, LAN discovery, and timed PTZ controls.

- [Camera setup and Control Room](user-guide/cameras.md): sources, tuning, profiles,
  fullscreen, and camera release behavior.
- [Vision Lab and workflows](user-guide/vision-workflows.md): motion analysis,
  compatible models, connections, previews, and activation.
- [Unified workflow library](user-guide/workflow-library.md): independent and callable
  execution, input contracts, version pins, and migration.
- [Three-level nested subflow demo](user-guide/three-level-subflow-demo.md): an
  importable sample and a practical nesting walkthrough.
- [Layouts](layouts.md): saved walls, pins, activity priority, and simulated cameras.
- [Recordings and storage](recording-storage.md): quality, long clips, recovery,
  storage allowances, and protected recordings.
- [Detection replay](user-guide/recording-detection-replay.md): clean video, tiled overlays,
  bounded metadata windows, and local file playback in the static showcase.
- [Timeline playback](user-guide/timeline-playback.md): date/time seeking, camera
  filters, clip navigation, event markers, and playback compatibility.
- [Recording schedules](user-guide/schedules.md): daily/weekly windows, overlapping
  rules, and manual ownership.
- [System health](user-guide/system-health.md): current capture, inference, recording,
  and storage issues.
- [Backup and restore](user-guide/backups.md): complete local archives, verification, portable restores, and configuration-only transfer.
- [Workflow editor tools](user-guide/workflow-tools.md): copy/paste, connection labels,
  validation, and latest node results.
- [Events and notifications](user-guide/events.md): searchable activity, attachments,
  naming patterns, and desktop notification permissions.
- [Troubleshooting](troubleshooting.md): connection resets, stale changes, cameras,
  models, missing events, and interrupted recordings.

## Deployment and reference

- [Cloudflare showcase](deployment/cloudflare.md): export, static hosting, security
  headers, and the differences from the installed application.
- [Data, storage, and privacy](reference/data-and-privacy.md): what persists, where it
  lives, backup boundaries, and local network behavior.
- [Portfolio and presentation assets](portfolio.md): screenshots, emblem, and showcase metadata.

- [Reusable subflows and execution history](user-guide/subflows-and-history.md):
  versioned logic, diagnostic dry runs, local storage, and retention.

## Developer documentation

- [Development guide](development/guide.md): one environment, edit/restart behavior,
  isolated testing, and wheel verification.
- [Architecture](development/architecture.md): module responsibilities, frame ownership,
  model scheduling, persistence, and extension points.
- [Contributing](../CONTRIBUTING.md): contribution and validation conventions.

The [root README](../README.md) provides the project overview and quick start.
SpyDER is an active prototype for local, single-user operation. Hardware support,
model compatibility, and browser capabilities vary; the guides describe those limits
alongside the relevant features.
