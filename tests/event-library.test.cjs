const { test } = require("node:test");
const assert = require("node:assert/strict");
const { eventPage, groupKey, mediaUrl } = require("../src/spyder_cctv/assets/event-library.js");
const events = Array.from({ length: 43 }, (_, i) => ({
  id: "event" + i, name: "Door " + i, kind: i % 2 ? "event" : "motion",
  camera_id: i % 3 ? "front" : "back", camera_name: i % 3 ? "Front door" : "Back yard",
  created_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  message: i % 2 ? "Person recognized" : "Motion started",
  media: i % 2 ? [{ kind: "capture" }] : [],
}));
test("Event pagination clamps after filtering and never mutates input", () => {
  const before = JSON.stringify(events);
  const result = eventPage(events, { page: 99 });
  assert.equal(result.page, 3); assert.equal(result.items.length, 3);
  assert.equal(eventPage(events, { query: "absent", page: 3 }).page, 1);
  assert.equal(JSON.stringify(events), before);
});
test("Event search combines camera, message and name with type and media filters", () => {
  const result = eventPage(events, { query: "front person", kind: "event", media: "capture" });
  assert.ok(result.total > 0);
  assert.ok(result.items.every((event) => event.kind === "event" && event.camera_id === "front"));
  assert.equal(eventPage(events, { query: "front person", media: "none" }).total, 0);
});
test("Event date, sort and group use persisted metadata", () => {
  const result = eventPage(events, { after: events[40].created_at, sort: "oldest" });
  assert.equal(result.total, 3); assert.equal(result.items[0].id, "event40");
  assert.equal(groupKey(events[0], "camera"), "Back yard");
  assert.equal(groupKey(events[0], "kind"), "motion");
});
test("Media viewer allows only local manifest URLs and browser-owned blobs", () => {
  assert.equal(mediaUrl({ url: "/api/media/abc123" }), "/api/media/abc123");
  assert.equal(mediaUrl({ url: "blob:http://localhost/abc" }), "blob:http://localhost/abc");
  for (const url of ["https://other.test/file", "javascript:alert(1)", "/api/media/../secret", "//other.test/"]) assert.equal(mediaUrl({ url }), null);
});
