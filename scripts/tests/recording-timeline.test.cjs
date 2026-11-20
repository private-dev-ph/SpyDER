const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const timeline = require("../../src/spyder_cctv/assets/recording-timeline.js");
const timelineSource = fs.readFileSync(path.join(__dirname, "../../src/spyder_cctv/assets/recording-timeline.js"), "utf8");
process.env.TZ = "America/New_York";

function clip(id, start, duration = 60, extra = {}) {
  return {
    id,
    kind: "recording",
    created_at: new Date(start).toISOString(),
    duration_seconds: duration,
    ...extra,
  };
}

test("segments sort valid positive-duration videos and ignore invalid rows and captures", () => {
  const rows = [
    clip("late", 2000),
    clip("capture", 1000, 1, { kind: "capture" }),
    clip("zero", 1000, 0),
    { ...clip("invalid", 0), created_at: "bad-date" },
    clip("early", 0),
  ];
  const before = JSON.stringify(rows);
  assert.deepEqual(
    timeline.segments(rows).map((entry) => entry.item.id),
    ["early", "late"],
  );
  assert.equal(timeline.segments(rows)[0].start_ms, 0);
  assert.equal(timeline.segments(rows)[0].end_ms, 60000);
  assert.equal(JSON.stringify(rows), before);
});

test("timeline enrollment accepts native recordings only", () => {
  const item = clip("0123456789abcdef0123456789abcdef", 0);
  assert.equal(timeline.recordingEnrollmentAvailable(item), true);
  assert.equal(timeline.recordingEnrollmentAvailable({ ...item, kind: "capture" }), false);
  assert.equal(timeline.recordingEnrollmentAvailable({ ...item, id: "browser-local-id" }), false);
  assert.equal(timeline.recordingEnrollmentAvailable({ ...item, id: item.id.toUpperCase() }), false);
  assert.equal(timeline.recordingEnrollmentAvailable(item, true), false);
});

test("timeline enrollment pauses and closes player before opening at selected position", () => {
  assert.match(timelineSource, /video\?\.hidden \? NaN : Number\(video\?\.currentTime\)/);
  assert.match(timelineSource, /playerHandle\?\.pause\(\)[\s\S]*?playerHandle\.destroy\(\)[\s\S]*?spyderFaceEnrollment\?\.fromRecording\?\.\(item, seconds\)/);
});

test("local day boundaries use local midnight and next calendar midnight across DST", () => {
  const spring = timeline.localDayRange("2026-03-08");
  const fall = timeline.localDayRange("2026-11-01");
  assert.equal((spring.end_ms - spring.start_ms) / 3600000, 23);
  assert.equal((fall.end_ms - fall.start_ms) / 3600000, 25);
  assert.equal(new Date(spring.start_ms).getHours(), 0);
  assert.equal(new Date(spring.end_ms).getHours(), 0);
  assert.equal(timeline.localDayRange("2026-02-30"), null);
  assert.equal(timeline.localDayRange("nope"), null);
});

test("findSegment resolves overlap deterministically and honors preferred ID", () => {
  const items = [
    clip("first", 0, 20),
    clip("second", 10000, 20),
    clip("third", 10000, 20),
  ];
  assert.equal(timeline.findSegment(items, 15000).item.id, "second");
  assert.equal(timeline.findSegment(items, 15000, "third").item.id, "third");
  assert.equal(timeline.findSegment(items, 20000).item.id, "second");
  assert.equal(timeline.findSegment(items, 30000), null);
});

test("nextSegment advances monotonically without looping on overlaps or gaps", () => {
  const items = [
    clip("a", 0, 20),
    clip("ended-during-a", 5000, 10),
    clip("overlaps-a", 10000, 30),
    clip("c", 60000, 10),
  ];
  assert.equal(
    timeline.nextSegment(items, { item: items[0] }, 5).item.id,
    "overlaps-a",
  );
  assert.equal(
    timeline.nextSegment(items, { item: items[2] }, 15).item.id,
    "c",
  );
  assert.equal(timeline.nextSegment(items, { item: items[3] }, 1), null);
  assert.equal(timeline.nextSegment(items, null, 20000).item.id, "c");
  assert.equal(
    timeline.nextSegment(items, { item: clip("removed", 0) }, 15000).item.id,
    "c",
  );
});

test("camera membership supports legacy unknown and camera spans", () => {
  const items = [
    clip("legacy", 0),
    clip("known", 1000, 10, { camera_ids: ["cam-a"] }),
    clip("spans", 2000, 10, {
      camera_spans: [{ camera_id: "cam-b", start_seconds: 0, end_seconds: 4 }],
    }),
    clip("span-array", 3000, 10, { camera_spans: ["cam-c"] }),
  ];
  assert.equal(timeline.belongsToCamera(items[0], "__unknown__"), true);
  assert.equal(timeline.belongsToCamera(items[1], "__unknown__"), false);
  assert.equal(timeline.belongsToCamera(items[2], "cam-b"), true);
  assert.equal(timeline.belongsToCamera(items[1], "cam-b"), false);
  assert.equal(timeline.belongsToCamera(items[3], "cam-c"), true);
  assert.equal(timeline.belongsToCamera(items[2], ""), true);
});

test("coverage stays bounded and marks recordings clipped to requested range", () => {
  const rows = [
    clip("before", 0, 90),
    clip("inside", 50_000, 100),
    clip("after", 200_000, 90),
  ];
  const bins = timeline.coverageBins(
    rows,
    { start_ms: 60_000, end_ms: 120_000 },
    10000,
  );
  assert.equal(bins.length, 720);
  assert.ok(bins.every((value) => value === 0 || value === 1));
  assert.ok(bins.some(Boolean));
  assert.equal(
    timeline.coverageBins(rows, { start_ms: 10, end_ms: 10 }).length,
    720,
  );
});

test("clip pagination bounds rendered rows for 5,000 saved clips", () => {
  const history = Array.from({ length: 5000 }, (_, index) =>
    clip(`c-${index}`, index * 1000),
  );
  const page = timeline.clipPage(history, 99_999, 500);
  assert.equal(page.total, 5000);
  assert.equal(page.page, 100);
  assert.equal(page.size, 50);
  assert.equal(page.items.length, 50);
  assert.equal(timeline.clipPage(history, 1, 25).items.length, 25);
});

test("nested event clips can continue into an earlier-starting recording without looping", () => {
  const wall = clip("wall", 0, 100),
    event = clip("event", 10000, 10),
    shorter = clip("shorter", 11000, 5);
  const items = [wall, event, shorter];
  const next = timeline.nextSegment(
    items,
    { item: event, end_ms: 20000 },
    20000,
  );
  assert.equal(next.item.id, "wall");
  assert.equal(timeline.nextSegment(items, next, 100000), null);
});
