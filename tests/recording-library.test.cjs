const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  recordingPage,
} = require("../src/spyder_cctv/assets/recording-library.js");

const items = Array.from({ length: 53 }, (_, index) => ({
  id: `item-${index}`,
  kind: index % 4 === 0 ? "capture" : "recording",
  filename: `${index % 4 === 0 ? "capture" : "recording"}-${String(index).padStart(2, "0")}.${index % 4 === 0 ? "jpg" : "mp4"}`,
  created_at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  size_bytes: (index + 1) * 1024,
  duration_seconds: index,
  keep_forever: index % 2 === 0,
}));

test("recording library bounds pages, clamps stale page, and preserves source order", () => {
  const before = JSON.stringify(items);
  assert.equal(recordingPage(items, { page: 99 }).page, 3);
  assert.equal(recordingPage(items, { page: 99, size: 100 }).items.length, 3);
  assert.equal(recordingPage(items, { page: 5, query: "missing" }).page, 1);
  assert.equal(JSON.stringify(items), before);
});

test("recording library searches names and filters type and protection", () => {
  const result = recordingPage(items, {
    query: "recording-",
    kind: "recording",
    protection: "protected",
  });
  assert.ok(result.total > 0);
  assert.ok(
    result.items.every(
      (item) =>
        item.kind === "recording" &&
        item.keep_forever &&
        item.filename.includes("recording-"),
    ),
  );
  assert.equal(
    recordingPage(items, { kind: "capture", protection: "unprotected" }).total,
    0,
  );
});

test("recording library sorts newest, oldest, name, size and duration", () => {
  assert.equal(recordingPage(items, { sort: "oldest" }).items[0].id, "item-0");
  assert.equal(recordingPage(items, { sort: "newest" }).items[0].id, "item-52");
  assert.equal(
    recordingPage(items, { sort: "name" }).items[0].filename,
    "capture-00.jpg",
  );
  assert.equal(recordingPage(items, { sort: "size" }).items[0].id, "item-52");
  assert.equal(
    recordingPage(items, { sort: "duration" }).items[0].id,
    "item-52",
  );
});

test("recording library supports date filtering and stays within 50 items per page", () => {
  const selectedDate = new Date(2026, 9, 1);
  const selectedDay = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, "0")}-${String(selectedDate.getDate()).padStart(2, "0")}`;
  const localMorning = new Date(2026, 9, 1, 0, 30);
  const previousEvening = new Date(2026, 8, 30, 23, 59);
  const boundary = [
    { ...items[0], id: "morning", created_at: localMorning.toISOString() },
    { ...items[1], id: "evening", created_at: previousEvening.toISOString() },
  ];
  const filtered = recordingPage(boundary, {
    after: selectedDay,
    sort: "oldest",
    size: 50,
  });
  assert.deepEqual(
    filtered.items.map((item) => item.id),
    ["morning"],
  );
  assert.equal(recordingPage(items, { size: 500 }).items.length, 50);
});

test("large recording history stays paginated and searching clamps stale pages", () => {
  const history = Array.from({ length: 5000 }, (_, i) => ({
    ...items[1],
    id: `entry-${i}`,
    filename: `entry-${i}.mp4`,
    created_at: new Date(1700000000000 + i * 1000).toISOString(),
  }));
  const page = recordingPage(history, { page: 99999, size: 50 });
  assert.equal(page.total, 5000);
  assert.equal(page.pages, 100);
  assert.equal(page.page, 100);
  assert.equal(page.items.length, 50);
  assert.equal(history[0].id, "entry-0");
  const match = recordingPage(history, { page: 99999, query: "entry-4999" });
  assert.equal(match.page, 1);
  assert.deepEqual(
    match.items.map((item) => item.id),
    ["entry-4999"],
  );
});

test("display names take precedence over filenames when sorting and searching", () => {
  const named = [
    { ...items[0], filename: "z.mp4", name: "Alpha door" },
    { ...items[1], filename: "a.mp4", name: "Zulu window" },
  ];
  assert.equal(
    recordingPage(named, { sort: "name" }).items[0].name,
    "Alpha door",
  );
  assert.equal(
    recordingPage(named, { query: "window" }).items[0].filename,
    "a.mp4",
  );
});
