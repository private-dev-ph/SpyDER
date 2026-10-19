# Recording schedules

Recording schedules start and stop composite recordings at local server time. Each schedule selects cameras and weekdays, then defines a start and end time. Weekdays use Monday `0` through Sunday `6`. A time range that ends before its start continues overnight; for example, Monday `23:00` to `02:00` ends Tuesday morning.

Overlapping schedules share one recording session. The recorder uses the union of their selected cameras and changes that selection as schedules begin and end. Schedule control never takes over an existing manual or workflow recording. A manual change to a schedule-owned session releases schedule control until that active window ends.

The service stores at most 64 rules in a local JSON file. Invalid saved data fails closed and remains in place for recovery. Rules with missing cameras wait until those cameras return. Storage quota or other start failures produce a warning and retry at most once per minute while a schedule remains active.

Times use the server's local timezone. Schedules stay disabled when `enabled` is false. Saving a schedule does not change camera configuration or enable a missing camera.
