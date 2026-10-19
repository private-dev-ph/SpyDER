# Configuration backup and restore

[Documentation home](../README.md)

## Download a backup

In **System → Configuration backup & restore**, choose **Download configuration**.
The JSON file contains camera configuration and tuning profiles, the focus preference,
workflow graphs/code, and recording quality settings. The size limit is 2 MiB.

Camera addresses can contain usernames/passwords, and workflow code may contain
private information. Keep backup files private. Exporting does not upload the file
to a cloud service.

Backups exclude model weights, model registry entries and model/gallery paths,
recordings/captures, events, recording schedules, output folder paths, and browser
layouts. Model references in graphs may need reassignment on another installation.
Use separate workflow/layout exports for browser-owned drafts, and make filesystem
backups for footage and model weights.

## Preview and restore

1. Download a current backup before replacing configuration.
2. Select a backup JSON file. The preview validates the complete document and shows
   camera/profile/workflow counts, missing references, and warnings without writing settings.
3. Stop recordings and cameras and wait for processing/finalization to finish.
   Disable workflows and recording schedules. Pending workflow event clips must finish.
4. Confirm that existing settings will be replaced, then choose **Stage restore for restart**.
5. Stop SpyDER and restart `gui` or `serve`. The staged restore is applied before
   configuration and services load. The `check` command does not apply it.

Staging does not mutate running settings. Once staged, configuration/control changes
are locked until restart. Restoring replaces the saved camera/profile/workflow lists;
it does not merge them. Imported cameras have autostart off and workflows remain
disabled. Local vision model paths are omitted, so review model assignments before
reactivating cameras/workflows. Existing output folders, model files, and media remain
in place. Existing schedules are unchanged and must be disabled before restore.

## Interrupted restore

Startup journals the prior bytes of each affected settings file before replacement.
A failed/interrupted transaction can roll back before normal startup, and recovery
refuses mismatched target paths. Restart with the same configuration and media-folder
override when recovering an interrupted restore.

If startup reports a recovery error, preserve `.configuration-restore.json`,
`.configuration-restore-journal.json`, and the current settings. These files can
contain sensitive data. Do not remove them or manually edit catalogs while SpyDER
is running. A successful restore is not an automatic long-term backup of the old
configuration; retain the backup downloaded in the first step.

Native configuration backup is unavailable in the static showcase. See
[Data, storage, and privacy](../reference/data-and-privacy.md) for full backup boundaries.
