const { test } = require("node:test");
const assert = require("node:assert/strict");
const { layout } = require("../src/spyder_cctv/assets/fullscreen.js");
test("wall chooses landscape and portrait layouts without losing cameras", () => {
  assert.deepEqual(layout(2, 1920, 1080), { columns: 2, rows: 1 });
  assert.deepEqual(layout(2, 390, 844), { columns: 1, rows: 2 });
  assert.deepEqual(layout(1, 1920, 1080), { columns: 1, rows: 1 });
  assert.deepEqual(layout(0, 0, 0), { columns: 1, rows: 1 });
});
test("wall fits every tile and maximizes image area across counts and window sizes", () => {
  for (const [width, height] of [
    [1920, 1080],
    [1280, 300],
    [390, 844],
    [320, 256],
  ]) {
    for (const count of [1, 2, 3, 4, 5, 8, 12, 24]) {
      const chosen = layout(count, width, height);
      assert.ok(chosen.columns * chosen.rows >= count);
      const area = (columns, rows) =>
        Math.min(
          (width - 6 * (columns - 1)) / columns / 16,
          (height - 6 * (rows - 1)) / rows / 9,
        ) ** 2;
      for (let columns = 1; columns <= count; columns++)
        assert.ok(
          area(chosen.columns, chosen.rows) + 0.0001 >=
            area(columns, Math.ceil(count / columns)),
        );
    }
  }
});
