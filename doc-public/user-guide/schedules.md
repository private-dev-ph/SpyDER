# Recording schedules

[Documentation home](../README.md)

## Create a schedule

Open **Recordings → Recording schedules → Add or edit a schedule**. Enter a name,
start/end times, weekdays, and cameras. Select **Enable schedule** when ready, then
save. Disabled rules are saved without recording. Edit, enable/disable, or delete
rules from the list. Saving an enabled rule during its active window can start
recording immediately.

Times follow the **computer running the Python server**, whose timezone is shown
above the list. A range ending before its start continues overnight: Monday 23:00
to 02:00 ends Tuesday morning. Equal start/end times are rejected. The app and
computer must remain running; schedules cannot wake a powered-off computer or
recover footage from a missed interval. A restart during an active window can
resume recording, subject to available cameras and storage.

## Overlap and manual control

Overlapping rules share one composite recording using the union of their cameras.
As rules begin/end, camera membership changes inside that tiled video. Quality and
clip rotation use the settings in [Recording storage](../recording-storage.md).
A schedule can retain/start its selected cameras without changing saved autostart
preferences.

Schedules do not take over a manual or workflow session. A manual/workflow change
to a scheduled recording relinquishes schedule ownership for that active window,
including an overnight window. Atomic recorder revision checks prevent a stale
scheduled stop from stopping a session after manual takeover. Saving rules again
explicitly reevaluates their eligibility.

## Errors and persistence

At most 64 rules persist in `schedules.json` beside configuration. Missing cameras
produce a waiting status; corrupt saved schedules fail closed and are not overwritten
by a normal save. Repair a preserved copy while the app is stopped.

Start failures retry at most once per minute. If storage or another fault stops an
already-started scheduled recording, it is not restarted repeatedly in that window.
Resolve the issue, then explicitly save/re-enable rules or wait for a later window.
The current clip follows normal stop-and-save and recovery safeguards.

Persistent scheduling is native-only. The Cloudflare showcase explains this limit
and makes no scheduling API requests. Schedules are excluded from configuration
backups; disable them before staging a restore.
