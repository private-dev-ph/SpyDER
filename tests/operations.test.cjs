const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  scheduleSummary,
  validateSchedule,
} = require("../src/spyder_cctv/assets/operations.js");
test("schedule summaries explain overnight day ownership", () => {
  assert.match(
    scheduleSummary({ days: [0, 4], start: "22:00", end: "06:00" }),
    /Mon, Fri.*next day/,
  );
});
test("schedule form requires camera, weekday and distinct times", () => {
  const rule = {
    name: "Workday",
    camera_ids: ["cam"],
    days: [0],
    start: "09:00",
    end: "17:00",
  };
  assert.equal(validateSchedule(rule), rule);
  for (const invalid of [
    { ...rule, name: " " },
    { ...rule, camera_ids: [] },
    { ...rule, days: [] },
    { ...rule, end: "09:00" },
  ])
    assert.throws(() => validateSchedule(invalid));
});
const {
  collectBrowserBackup,
  validateBrowserBackup,
} = require("../src/spyder_cctv/assets/operations.js");
test("complete backups collect only namespaced browser settings and bound their size", () => {
  const rows = new Map([
    ["spyder.layouts.v1", '{"layouts":[]}'],
    ["unrelated.auth", "private"],
    ["spyder-theme", "dark"],
  ]);
  const storage = {
    length: rows.size,
    key: (index) => [...rows.keys()][index],
    getItem: (key) => rows.get(key),
  };
  assert.deepEqual(collectBrowserBackup(storage), {
    version: 1,
    local_storage: {
      "spyder.layouts.v1": '{"layouts":[]}',
      "spyder-theme": "dark",
    },
  });
  for (const invalid of [
    { version: 2, local_storage: {} },
    { version: 1, local_storage: { other: "bad" } },
    { version: 1, local_storage: { "spyder.x": {} } },
    { version: 1, local_storage: [] },
    { version: 1, local_storage: { "spyder.x": "x".repeat(8 * 1024 * 1024) } },
  ])
    assert.throws(
      () => validateBrowserBackup(invalid),
      /Invalid browser settings/,
    );
});
