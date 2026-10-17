# SpyDER documentation

SpyDER is a local Python camera application with a browser interface. These guides
cover installation, daily use, development, and the separate browser showcase.
Start with [Getting started](getting-started.md) for a working local installation.

## User guides

- [Camera setup and Control Room](user-guide/cameras.md): sources, tuning, profiles,
  fullscreen, and camera release behavior.
- [Vision Lab and workflows](user-guide/vision-workflows.md): motion analysis,
  compatible models, connections, previews, and activation.
- [Layouts](layouts.md): saved walls, pins, activity priority, and simulated cameras.
- [Recordings and storage](recording-storage.md): quality, long clips, recovery,
  storage allowances, and protected recordings.
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
