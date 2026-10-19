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
