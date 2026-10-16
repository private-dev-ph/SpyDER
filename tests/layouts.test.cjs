const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  defaults,
  validate,
  ordered,
  geometry,
} = require("../src/spyder_cctv/assets/layouts.js");
test("layout import roundtrips settings and rejects unsupported or unsafe documents", () => {
  const layout = {
    ...defaults(),
    name: "Entrance",
    mode: "featured",
    featured: "cam-front",
    order: ["cam-front", "cam-front", "cam-yard"],
    hidden: ["cam-yard"],
    dummies: [{ id: "dummy-square", name: "Square", ratio: "1:1" }],
  };
  const clean = validate(JSON.parse(JSON.stringify(layout)));
  assert.deepEqual(clean.order, ["cam-front", "cam-yard"]);
  assert.equal(clean.dummies[0].ratio, "1:1");
  assert.deepEqual(validate(clean), clean);
  for (const change of [
    { version: 2 },
    { mode: "unknown" },
    { fit: "stretch" },
    { interval: 0 },
    { columns: 7 },
    { gap: Infinity },
    { name: "" },
    { order: ["../secret"] },
    { dummies: [{ id: "cam-real", name: "Fake", ratio: "1:1" }] },
    {
      dummies: [
        { id: "dummy-a", name: "A", ratio: "1:1" },
        { id: "dummy-a", name: "B", ratio: "1:1" },
      ],
    },
  ])
    assert.throws(() => validate({ ...layout, ...change }));
  assert.throws(() =>
    validate({
      ...layout,
      dummies: Array.from({ length: 25 }, (_, i) => ({
        id: "dummy-" + i,
        name: "Test",
        ratio: "16:9",
      })),
    }),
  );
});
test("visible wall order preserves camera registry and handles unavailable and new cameras", () => {
  const cameras = [{ id: "cam-a" }, { id: "cam-b" }, { id: "cam-c" }];
  const config = {
    ...defaults(),
    order: ["cam-missing", "cam-b", "cam-a", "cam-b"],
    hidden: ["cam-a"],
  };
  assert.deepEqual(
    ordered(config, cameras).map((c) => c.id),
    ["cam-b", "cam-c"],
  );
  assert.deepEqual(cameras, [
    { id: "cam-a" },
    { id: "cam-b" },
    { id: "cam-c" },
  ]);
  assert.deepEqual(config.order, ["cam-missing", "cam-b", "cam-a", "cam-b"]);
});
test("responsive geometry preserves capacity, limits narrow columns and makes room for featured spans", () => {
  for (const mode of ["auto", "grid", "featured", "sequence"])
    for (const count of [0, 1, 2, 4, 9, 24])
      for (const width of [280, 390, 800, 1920]) {
        const config = { ...defaults(), mode, columns: 6 };
        const grid = geometry(config, count, width, 900);
        assert.ok(grid.columns >= 1 && grid.rows >= 1);
        if (mode !== "sequence") assert.ok(grid.columns * grid.rows >= count);
        if (width < 360) assert.equal(grid.columns, 1);
      }
  assert.deepEqual(
    geometry({ ...defaults(), mode: "grid", columns: 3 }, 9, 1200, 800),
    { columns: 3, rows: 3 },
  );
  assert.deepEqual(
    geometry({ ...defaults(), mode: "featured" }, 6, 1200, 800),
    { columns: 3, rows: 3 },
  );
  assert.deepEqual(
    geometry({ ...defaults(), mode: "sequence" }, 24, 1200, 800),
    { columns: 1, rows: 1 },
  );
});
