const { test } = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const {
  order,
  moveAndPin,
  ActivityRanks,
  ActivityFeed,
  hasActivity,
} = require("../src/spyder_cctv/assets/wall-order.js");
const {
  defaults,
  validate,
  geometry,
} = require("../src/spyder_cctv/assets/layouts.js");
const camera = (id, metadata = {}) => ({
  id,
  state: "running",
  frame_age_seconds: 0,
  metadata,
});
test("old layouts migrate to disabled activity priority and empty pins; imports validate new fields", () => {
  const old = defaults();
  for (const key of [
    "pinned",
    "autoPriority",
    "activitySources",
    "activityHold",
  ])
    delete old[key];
  assert.deepEqual(validate(old).pinned, []);
  assert.equal(validate(old).autoPriority, false);
  for (const change of [
    { pinned: ["../bad"] },
    { pinned: Array(257).fill("cam") },
    { autoPriority: 1 },
    { activitySources: ["gpu"] },
    { activityHold: 0 },
  ])
    assert.throws(() => validate({ ...defaults(), ...change }));
  const pinned = validate({
    ...defaults(),
    pinned: ["cam-a"],
    hidden: ["cam-a"],
  });
  assert.deepEqual(pinned.hidden, []);
});
test("pins retain fixed slots while activity fills only unpinned positions and pinned hidden cameras remain visible", () => {
  const cameras = ["a", "b", "c", "d", "e"].map((id) => camera(id));
  const config = {
    ...defaults(),
    order: ["a", "b", "c", "d", "e"],
    pinned: ["b", "d"],
    hidden: ["b"],
    autoPriority: true,
  };
  assert.deepEqual(
    order(
      config,
      cameras,
      new Map([
        ["e", 9],
        ["c", 5],
      ]),
    ).map((c) => c.id),
    ["e", "b", "c", "d", "a"],
  );
  assert.deepEqual(config.order, ["a", "b", "c", "d", "e"]);
});
test("rotating views always contain pins and cycle only unpinned cameras, including all-pinned and missing pins", () => {
  const cameras = ["a", "b", "c", "d"].map((id) => camera(id));
  const config = {
    ...defaults(),
    mode: "sequence",
    pinned: ["b", "d", "missing"],
  };
  for (let i = 0; i < 20; i++)
    assert.deepEqual(
      order(config, cameras, new Map(), i).map((c) => c.id),
      ["b", "d", i % 2 ? "c" : "a"],
    );
  assert.deepEqual(
    order(
      { ...config, pinned: ["a", "b", "c", "d"] },
      cameras,
      new Map(),
      9,
    ).map((c) => c.id),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(order(config, [], new Map(), 0), []);
  assert.ok(geometry(config, 3, 1280, 720, true).columns > 1);
});
test("manual camera moves auto-pin the moved camera without mutating the saved draft", () => {
  const config = {
    ...defaults(),
    order: ["a", "b", "c", "d"],
    pinned: ["b"],
    hidden: ["d"],
  };
  const moved = moveAndPin(config, "d", "a");
  assert.deepEqual(moved.order, ["d", "a", "b", "c"]);
  assert.deepEqual(moved.pinned, ["b", "d"]);
  assert.deepEqual(moved.hidden, []);
  assert.deepEqual(config.hidden, ["d"]);
  assert.deepEqual(moveAndPin(moved, "d", "c", true).order, [
    "a",
    "b",
    "c",
    "d",
  ]);
  assert.throws(() => moveAndPin(config, "missing", "a"));
});
test("activity respects freshness, selected sources, running state, hold expiry and simultaneous stable order", () => {
  const ranks = new ActivityRanks();
  const config = { ...defaults(), autoPriority: true, activityHold: 3 };
  let cameras = [
    camera("a", { motion_fraction: 0.3 }),
    camera("b", { motion_fraction: 0.5 }),
  ];
  let result = ranks.update(cameras, config, 1000);
  assert.equal(result.get("a"), result.get("b"));
  assert.deepEqual(
    order(config, cameras, result).map((c) => c.id),
    ["a", "b"],
  );
  cameras = [camera("a"), camera("b")];
  result = ranks.update(cameras, config, 2000);
  assert.equal(result.size, 2);
  result = ranks.update(cameras, config, 4001);
  assert.equal(result.size, 0);
  assert.equal(
    hasActivity(
      { ...camera("a", { motion_fraction: 1 }), frame_age_seconds: 3 },
      ["motion"],
    ),
    false,
  );
  assert.equal(
    hasActivity({ ...camera("a", { motion_fraction: 1 }), state: "stopped" }, [
      "motion",
    ]),
    false,
  );
  assert.equal(
    hasActivity(
      camera("a", {
        cv: { state: "ready", result_age_seconds: 3, detections: [{}] },
      }),
      ["cv"],
    ),
    false,
  );
  assert.equal(
    hasActivity(
      camera("a", {
        cv: { state: "ready", result_age_seconds: 0, detections: [{}] },
      }),
      ["cv"],
    ),
    true,
  );
  assert.equal(
    hasActivity(
      camera("a", {
        analysis: { state: "ready", result_age_seconds: 0, region_count: 2 },
      }),
      ["motion"],
    ),
    true,
  );
  assert.equal(hasActivity(camera("a", { motion_fraction: 1 }), ["cv"]), false);
  ranks.event("b", 5000);
  assert.ok(ranks.update(cameras, config, 5500).has("b"));
  assert.equal(ranks.update(cameras, config, 8001).has("b"), false);
});
test("activity snapshots ignore historical data, deduplicate, reject stale events and reset across server sessions", () => {
  const feed = new ActivityFeed();
  const event = (id, time) => ({ id, camera_id: "a", created_at: time });
  assert.deepEqual(
    feed.accept({ session_id: "one", activities: [event("old", 100)] }, 100000),
    [],
  );
  assert.equal(
    feed.accept(
      { session_id: "one", activities: [event("old", 100), event("new", 101)] },
      102000,
    ).length,
    1,
  );
  assert.deepEqual(
    feed.accept(
      {
        session_id: "one",
        activities: [event("new", 101), event("stale", 50)],
      },
      102000,
    ),
    [],
  );
  assert.deepEqual(
    feed.accept({ session_id: "two", activities: [event("new", 101)] }, 102000),
    [],
  );
});
test("128 and 256 camera walls preserve every ID, fixed pins and deterministic ordering over changing activity", () => {
  for (const count of [128, 256]) {
    const cameras = Array.from({ length: count }, (_, i) => camera("cam-" + i));
    const config = {
      ...defaults(),
      order: cameras.map((c) => c.id),
      pinned: cameras.filter((_, i) => i % 17 === 0).map((c) => c.id),
      autoPriority: true,
    };
    const pins = new Set(config.pinned);
    const started = performance.now();
    for (let round = 0; round < 200; round++) {
      const priorities = new Map(
        cameras
          .filter((_, i) => (i + round) % 7 === 0)
          .map((c, i) => [c.id, i + 1]),
      );
      const sorted = order(config, cameras, priorities);
      assert.equal(sorted.length, count);
      assert.equal(new Set(sorted.map((c) => c.id)).size, count);
      cameras.forEach((c, i) => {
        if (pins.has(c.id)) assert.equal(sorted[i].id, c.id);
      });
    }
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 5000, `${count} camera ordering took ${elapsed}ms`);
    console.log(
      `${count} cameras: 200 ordering rounds in ${elapsed.toFixed(1)} ms`,
    );
  }
});
test("featured layouts account for a pinned featured camera placed late in the wall", () => {
  assert.deepEqual(
    geometry(
      { ...defaults(), mode: "featured", featuredIndex: 5 },
      6,
      1280,
      720,
      true,
    ),
    { columns: 3, rows: 4 },
  );
});

test("brief activity dropouts do not re-promote a camera within its hold period", () => {
  const ranks = new ActivityRanks(),
    config = { ...defaults(), autoPriority: true, activityHold: 10 };
  const a = camera("a", { motion_fraction: 0.5 }),
    b = camera("b", { motion_fraction: 0.5 });
  ranks.update([a, camera("b")], config, 1000);
  const second = ranks.update([a, b], config, 2000);
  assert.ok(second.get("b") > second.get("a"));
  ranks.update([camera("a"), b], config, 2500);
  const recovered = ranks.update([a, b], config, 3000);
  assert.equal(recovered.get("a"), second.get("a"));
  assert.deepEqual(
    order(config, [a, b], recovered).map((camera) => camera.id),
    ["b", "a"],
  );
});
