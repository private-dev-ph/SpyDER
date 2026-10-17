# Events and notifications

[Documentation home](../README.md)

## Create persistent activity records

The Events workspace displays stored motion and workflow activity. Enable and apply
motion analysis for motion records, or connect a workflow branch to an **Event** node
and enable that workflow. Drawing a graph or saving a disabled draft does not start
its actions. Results must be fresh and match the branch conditions.

A Notification node provides an alert; use an Event node when you also want a durable
activity record with a chosen name and media attachment. Connect a cooldown before
repeated actions to avoid an event or alert on every matching frame.

## Name events and attach evidence

Double-click the Event node and set its default name pattern. Available tokens are
`{workflow}`, `{camera}`, `{date}`, `{time}`, `{node}`, `{kind}`, and `{label}`.
Unknown tokens stay literal. For example:

```text
{camera} - {label} - {date} {time}
```

Choose no attachment, a capture, or a timed recording. A recording attachment becomes
available after its clip finishes; failed capture/recording operations cannot provide
an attachment. Recording profiles and storage limits also apply to workflow clips.

## Browse and manage

Search, sort, filter, or group the event list, then use pagination and the scrollable
list to navigate. Rename an event to add context. Select several events for bulk
export or deletion. Select an attachment thumbnail/icon to expand the image or video
viewer without downloading; downloads remain available.

The catalog keeps the latest 10,000 records. Deleting an event does not delete its
underlying recorder-owned media. Conversely, deleting or automatically cleaning a
recording can leave its event attachment unavailable. **Keep forever** protects a
recording from cleanup; it is not a backup. See [recording storage](../recording-storage.md).

## Browser and desktop alerts

Notification access is requested in response to using notification features, rather
than on page load. Allow the browser's permission request when adding or enabling a
Notification node. If permission was denied, change it in the browser's site settings.
An open SpyDER page is required for delivery; a closed browser cannot deliver these
page notifications. Operating-system notification settings can also suppress them.

Storage-full alerts do not open a permission prompt automatically. Enable desktop
alerts explicitly if desired; otherwise the application still reports the condition
in-app and in its local storage alerts. The static showcase does not execute native
workflow actions or share the installed app's event history.
