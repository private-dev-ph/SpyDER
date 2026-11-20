const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { create } = require("../../src/spyder_cctv/assets/browser-motion-policy.js");
function overload(p, start, cost) {
  let result;
  for (let t = start; t <= start + 6000; t += 500)
    result =
      p.observe(
        { state: "ready", processed_frames: t, processing_ms: cost },
        t,
      ) || result;
  return result;
}
test("auto starts MIL, ignores a spike, then degrades through bounded levels", () => {
  const p = create();
  assert.equal(p.state().tracking, true);
  assert.equal(
    p.observe({ state: "ready", processed_frames: 1, processing_ms: 900 }, 0),
    null,
  );
  p.observe({ state: "ready", processed_frames: 2, processing_ms: 20 }, 500);
  assert.equal(overload(p, 1000, 300).level, 1);
  assert.equal(overload(p, 7500, 300).level, 2);
  assert.equal(overload(p, 14000, 600).level, 3);
  assert.equal(p.state().engine, "frame-difference");
  assert.equal(p.observe({ state: "error" }, 21000), null);
});
test("hidden tabs, warmup, duplicate results and long pauses do not trigger overload", () => {
  const p = create();
  for (let t = 0; t <= 10000; t += 500)
    p.observe(
      { state: "ready", processing_ms: 900, processed_frames: 1 },
      t,
      false,
    );
  assert.equal(p.state().level, 0);
  p.observe({ state: "ready", processing_ms: 900, processed_frames: 2 }, 11000);
  p.observe(
    { state: "warming_up", processing_ms: 900, processed_frames: 3 },
    17000,
  );
  p.observe({ state: "ready", processing_ms: 900, processed_frames: 4 }, 18000);
  assert.equal(p.state().level, 0);
  for (let t = 18500; t <= 25000; t += 500)
    p.observe({ state: "ready", processing_ms: 900, processed_frames: 4 }, t);
  assert.equal(p.state().level, 0);
});
test("tracker failure keeps MOG2; worker failure uses frame difference immediately", () => {
  const p = create();
  assert.equal(
    p.observe({ state: "ready", tracking_error: "lost" }, 0).level,
    1,
  );
  assert.equal(p.observe({ state: "error" }, 1).level, 3);
});
test("normal processing never downgrades; restart creates a fresh session policy", () => {
  const p = create();
  for (let t = 0; t < 20000; t += 200)
    p.observe({ state: "ready", processed_frames: t, processing_ms: 80 }, t);
  assert.equal(p.state().level, 0);
  assert.equal(create().state().level, 0);
});

test("a multi-second analysis stall reduces load without waiting for a streak", () => {
  const p = create();
  assert.equal(
    p.observe(
      { state: "ready", processed_frames: 1, processing_ms: 2000 },
      5000,
    ).level,
    1,
  );
});

test("shared-worker queue delay counts even when individual processing is cheap", () => {
  const p = create();
  for (let t = 0; t <= 6500; t += 500)
    p.observe(
      {
        state: "ready",
        processed_frames: t,
        processing_ms: 10,
        roundtrip_ms: 800,
      },
      t,
    );
  assert.equal(p.state().level, 1);
});
