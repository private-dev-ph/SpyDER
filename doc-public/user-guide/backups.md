# Configuration backups

SpyDER configuration backups are JSON files capped at 2 MiB. They contain camera settings and profiles, the focus preference, workflows, and recording quality settings. Camera stream URLs can contain usernames or passwords. Treat backup files as secrets and store them securely.

Backups omit model weights and model file paths, model registry data, media and event records, storage output locations, browser layouts, and schedules. Reconfigure local vision models after restoring. Keep the destination computer's model files and media directories in place.

Import first validates the complete file and shows camera, profile, and workflow counts, missing camera references, and warnings. Preview does not write files. Confirming restore stages the validated settings for the next application start. Restore requires an idle recorder, stopped cameras, and disabled workflows. Imported cameras never auto-start. Imported workflows remain disabled. Recording output location stays configured on the destination computer.

Restart SpyDER to apply a staged restore. Startup applies configuration, preferences, workflows, and recording quality settings with rollback if a file write fails. Existing media files remain untouched. If startup reports a restore recovery error, preserve the pending restore and journal files for recovery.
