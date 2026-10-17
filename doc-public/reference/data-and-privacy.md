# Data, storage, and privacy

[Documentation home](../README.md)

## Local application data

The CLI chooses its default configuration with `platformdirs.user_config_path("SpyDER",
appauthor=False) / "config.json"`. The exact path is platform-dependent. Use `--config`
to select a different file. In a normal CLI launch, the configuration's parent is the
application data root.

| Data | Location or ownership |
| --- | --- |
| Camera sources, profiles, and active analysis settings | Configuration file. |
| GUI pause preference | `preferences.json` beside the configuration. |
| Workflow graphs | `workflows.json` in the application data root. |
| Persistent event catalog | `events/events.json` in that root. |
| Uploaded model library | `models/` in that root, including its registry and managed weights. |
| Media output preference | `storage.json` in that root. |
| Recordings, captures, media catalog, and recording policy | Active media folder; default is `media/` in that root. |
| Theme, layouts, and editor draft preferences | Browser storage, scoped to the site's origin. |

Built-in detector discovery has a separate shared user-model location reported by
`vision-info`. Registered external model files remain at their original paths; a
registry backup alone does not contain those weights. Changing only the media output
folder does not relocate configuration, models, workflows, or event history.

## Choose a recording folder

In System, choose an absolute local output folder with enough space and write access.
The new location takes effect after restarting. Existing media stays in its original
folder and remains available as archived media; the app does not migrate files.
Archived folders are not automatically cleaned by the active folder's quota policy.
The global `--media-dir` option overrides the saved output choice for that launch.

A dedicated local disk can make capacity planning easier. Removable drives, network
mounts, or cloud-synced folders can disappear, delay writes, or copy recordings outside
the computer. SpyDER's local processing does not override an external folder's sync
behavior. See [storage allowances and recovery](../recording-storage.md).

## Backups

Stop active recordings and the server before taking a consistent backup. Back up the
configuration data root, all active/archived media folders, and any externally
registered weights or identity galleries. Use layout export for browser-owned wall
arrangements. Workflow JSON export contains graph definitions and model references,
not weights, footage, or a complete installation backup.

Restoring on another machine may require remapping camera IDs, source paths, model
references, and output folders. Do not edit catalogs while the application is running.
Keep a copy before repairing corrupt configuration or metadata.

## Network and trust boundaries

The installed server binds to IPv4 loopback and checks Host/Origin plus a control
header for mutations. It is intended for local, single-user use, not direct public
internet exposure. It has no production remote-user authentication service.

Capture, inference, and recording run locally. Configured network cameras still
require network traffic to their sources. Installing dependencies and explicitly
installing a built-in detector require downloads. Local execution is not an OS-level
network sandbox for third-party native/ML libraries or untrusted model files.

The [static showcase](../deployment/cloudflare.md) uses a separate browser runtime.
Cloudflare delivers assets and receives normal web-access metadata; the application
does not send it camera frames, local videos, recordings, or model weights.
