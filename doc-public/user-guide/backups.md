# Backup and restore

[Documentation home](../README.md)

SpyDER supports a portable **complete archive** and a smaller **configuration JSON**
export. Both run on your computer. A complete archive backs up application data;
it does not include Python, the virtual environment, installed packages, or camera
hardware drivers. Install a compatible SpyDER version before restoring on another PC.

## Complete archives

Open **System → Complete backup & restore**. Paths in this panel refer to the
computer running the local server, not a cloud storage service. Use an absolute
archive path outside the application data and footage folders.

The archive includes saved camera settings and profiles, preferences, workflows and
published callable versions, model registrations and available referenced weights,
face galleries and portraits, event metadata, schedules, and execution history.
The GUI can also include this browser's SpyDER layouts, preferences, and editor drafts.
SQLite databases are copied through SQLite's backup API rather than copying an open
WAL file. Each archived file has a SHA-256 checksum in a versioned manifest, which also
records the SpyDER version and creation time.

**Recordings and captures are excluded by default.** Select **Include recordings and
captures** to include finalized footage and its sidecars. Without footage, event and
history attachment references can remain but their videos/images are unavailable in
the restored copy. Temporary files and incomplete recordings are excluded. Camera
addresses and local hardware assignments may need adjustment on a different computer.

### Create and inspect

1. Stop recordings and cameras; wait for finalization and processing to finish.
   Disable workflows and recording schedules. The GUI checks these conditions and
   refuses creation while a resource is active; it does not stop resources for you.
2. Enter a new ZIP path. Choose whether to include footage and browser settings.
3. Choose **Create complete backup**. The background operation reports progress;
   keep SpyDER running until it finishes. You can leave and return to the System page.
4. Choose **Inspect archive** to read the manifest and verify every file checksum.
   Inspection does not change the current installation.

Keep archives private: they can contain camera credentials, workflow code, model
files, face images/embeddings, and identity labels. Only restore archives you trust.
Review missing-asset warnings before relying on an archive. Files already missing
from the source computer cannot be reconstructed; unavailable registered weights can
prevent a validated restore. Archives are not encrypted. Use an encrypted drive or another trusted encryption tool
when storing sensitive backups. Cancel stops the current operation; an archive that
already completed may still exist at the selected path.

### Restore a separate copy

1. Enter the archive path and inspect it successfully.
2. Enter a **new folder that does not already exist** and acknowledge the separate-copy
   restore. Choose **Restore to new folder**.
3. SpyDER verifies the archive, extracts into staging, relocates its managed paths, and
   publishes the destination only after successful validation. Existing data is not
   overwritten. A failed or cancelled operation does not publish a partial restore.
4. Read the returned `config_path`. Stop the old SpyDER server, then start the restored
   copy with that configuration, for example:

   ```powershell
   spyder-cctv --config 'C:\SpyDER-Restored\appdata\config.json' gui
   ```

   Use the actual returned filename if the original configuration had a custom name.
   Imported cameras have autostart off, workflows are disabled, and schedules are
   disabled. Review device/model assignments before turning automation back on.
5. If browser state was included, select the restored `browser-state.json` using
   **Import browser-state.json** after switching to the restored installation. This
   replaces matching SpyDER preferences/layouts/drafts on the current browser origin;
   unrelated site settings remain. Reload afterward. Browser permissions and open
   directory handles cannot be transferred; grant those again when needed.

A restore can be inspected without activating it. Keep the original installation
and archive until the restored copy has been checked. Do not launch two servers
against the same data folder. The GUI never switches the running instance's data root
or restarts it automatically.

### Command-line use

Stop SpyDER before creating a CLI archive to obtain a coherent application snapshot.
Commands stream files and can run without opening cameras or a browser:

```powershell
spyder-cctv backup create --output 'C:\Backups\spyder.zip'
spyder-cctv backup create --output 'C:\Backups\spyder-with-footage.zip' --include-media
spyder-cctv backup inspect 'C:\Backups\spyder.zip'
spyder-cctv backup restore 'C:\Backups\spyder.zip' --destination 'C:\SpyDER-Restored'
```

For a custom installation put `--config 'path\to\config.json'` before `backup`.
Use `--media-dir` before `backup` only when the active installation uses that override.
The GUI's **Export browser settings** creates a separate browser-state JSON; pass it
with `backup create --browser-state 'path\to\browser-state.json'` if desired.

## Configuration-only JSON

**System → Configuration backup & restore → Download configuration** retains the
older, smaller transfer format. It contains camera configuration/tuning profiles,
the focus preference, workflow graphs/code, and recording quality settings, up to
2 MiB. It excludes weights, galleries, events, history, schedules, footage, output
paths, and browser state. Workflows with callable dependencies require workflow
bundle export or a complete archive instead.

Select a configuration JSON to validate and preview its counts/references. Stop all
resources and disable automation, acknowledge replacement, then choose **Stage restore
for restart**. This replaces saved settings on the next normal `gui`/`serve` startup;
it does not merge them. Controls remain locked until restart. Vision paths require
review and restored workflows/cameras stay disabled. Existing media and models remain.

## Interruptions and recovery

Complete archives are published only after their manifest and payload have been
written. Restores use a new destination with staging; do not treat leftover staging
folders from a forced process/computer stop as successful restores. Keep the original
archive and current application data. Starting another restore with a fresh destination
is preferable to manually copying a partial staging folder.

Configuration-only startup restore uses a journal for rollback. If startup reports a
recovery error, preserve `.configuration-restore.json`,
`.configuration-restore-journal.json`, and current settings. Restart with the same
configuration/media override; do not edit catalogs while services are running.

The Cloudflare showcase cannot access native application files or create/restore
native archives. Its controls explain this limit and issue no native backup requests.
Browser-owned layout/workflow exports remain available.
