const { test } = require("node:test");
const assert = require("node:assert/strict");
const { layout } = require("../src/spyder_cctv/assets/fullscreen.js");
test("wall chooses landscape and portrait layouts without losing cameras", () => {
  assert.deepEqual(layout(2, 1920, 1080), { columns: 2, rows: 1 });
  assert.deepEqual(layout(2, 390, 844), { columns: 1, rows: 2 });
  assert.deepEqual(layout(1, 1920, 1080), { columns: 1, rows: 1 });
  assert.deepEqual(layout(0, 0, 0), { columns: 1, rows: 1 });
});
test("wall fits every tile and maximizes image area within horizontal-first layouts", () => {
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
      for (let columns = 1; columns <= count; columns++) {
        if (width >= height * 0.9 && columns < Math.ceil(count / columns))
          continue;
        assert.ok(
          area(chosen.columns, chosen.rows) + 0.0001 >=
            area(columns, Math.ceil(count / columns)),
        );
      }
    }
  }
});

test("small landscape monitors place two feeds side by side, including square cameras", () => {
  for (const [width, height] of [
    [640, 480],
    [800, 600],
    [1024, 768],
    [1280, 1024],
    [320, 256],
  ]) {
    for (const aspects of [
      [1, 1],
      [1.1, 0.95],
      [4 / 3, 4 / 3],
      [16 / 9, 16 / 9],
      [],
    ])
      assert.deepEqual(layout(2, width, height, aspects), {
        columns: 2,
        rows: 1,
      });
  }
});

test("actual camera aspect changes grid selection and supports mixed aspect feeds", () => {
  assert.deepEqual(layout(3, 1024, 600, [1, 1, 1]), { columns: 3, rows: 1 });
  assert.deepEqual(layout(3, 1024, 600), { columns: 2, rows: 2 });
  for (const aspects of [[1, 16 / 9, 4 / 3, 1], [NaN, 0, -1, Infinity], []]) {
    const grid = layout(4, 800, 600, aspects);
    assert.ok(grid.columns >= grid.rows);
    assert.ok(grid.columns * grid.rows >= 4);
  }
  assert.deepEqual(layout(2, 390, 844, [1, 1]), { columns: 1, rows: 2 });
});
