const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
function harness() {
  let now = 0;
  const workers = [],
    handlers = {};
  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.messages = [];
      workers.push(this);
    }
    postMessage(d) {
      this.messages.push(d);
    }
    terminate() {
      this.terminated = true;
    }
    emit(d) {
      this.onmessage({ data: d });
    }
  }
  const window = { addEventListener: (name, fn) => (handlers[name] = fn) };
  vm.runInNewContext(
    fs.readFileSync(
      require.resolve("../src/spyder_cctv/assets/browser-mog2.js"),
      "utf8",
    ),
    {
      window,
      Worker: FakeWorker,
      performance: { now: () => now },
      setTimeout: () => 1,
      clearTimeout() {},
      document: {
        createElement: () => ({
          getContext: () => ({
            drawImage() {},
            getImageData: (_x, _y, w, h) => ({
              data: new Uint8ClampedArray(w * h * 4),
            }),
          }),
        }),
      },
      Uint8Array,
      Uint8ClampedArray,
    },
  );
  return {
    api: window.spyderBrowserMog2,
    workers,
    handlers,
    advance: (v) => (now += v),
  };
}
test("MOG2 settings are bounded; loading is lazy and shared across cameras", () => {
  const h = harness();
  assert.equal(h.workers.length, 0);
  for (const bad of [
    { history: 19 },
    { input_width: 1920 },
    { learning_rate: -0.5 },
    { detect_shadows: 1 },
    { inference_fps: 30 },
    { unknown: 1 },
  ])
    assert.throws(() => h.api.validate(bad));
  h.api.configure("one", {});
  h.api.configure("two", {});
  assert.equal(h.workers.length, 1);
  h.api.release("one");
  assert.ok(!h.workers[0].terminated);
  h.api.release("two");
  assert.ok(h.workers[0].terminated);
  assert.equal(h.api.status("two").state, "idle");
});
test("one pending job per camera, stale epochs rejected, failures survive loops until explicit retry", () => {
  const h = harness(),
    canvas = { width: 640, height: 360 };
  h.api.configure("one", {});
  const w = h.workers[0];
  w.emit({ type: "ready", heap_bytes: 128 * 1024 * 1024, load_ms: 4 });
  h.api.analyze("one", canvas, h.api.defaults, 0, null);
  const first = w.messages.at(-1);
  h.api.analyze("one", canvas, h.api.defaults, 0, null);
  assert.equal(w.messages.filter((d) => d.type === "frame").length, 1);
  h.advance(250);
  h.api.analyze("one", canvas, h.api.defaults, 1, null);
  const next = w.messages.at(-1);
  w.emit({
    type: "result",
    id: "one",
    revision: first.revision,
    sequence: first.sequence,
    mask: new Uint8Array(1).buffer,
    state: "ready",
  });
  assert.equal(h.api.status("one").state, "warming_up");
  w.emit({
    type: "error",
    id: "one",
    revision: next.revision,
    sequence: next.sequence,
    error: "MOG2 unavailable",
  });
  assert.equal(h.api.status("one").state, "error");
  h.api.analyze("one", canvas, h.api.defaults, 2, null);
  assert.equal(h.api.status("one").state, "error");
  h.api.configure("one", {});
  assert.equal(h.api.status("one").state, "loading");
});
test("worker errors and page disposal release resources without a silent engine fallback", () => {
  const h = harness();
  h.api.configure("one", {});
  h.workers[0].onerror();
  assert.equal(h.api.status("one").state, "error");
  assert.ok(h.workers[0].terminated);
  h.api.configure("one", {});
  h.handlers.pagehide();
  assert.equal(h.api.status("one").state, "idle");
  assert.ok(h.workers[1].terminated);
});

test("camera capacity failure returns an empty analysis without throwing or blocking video", () => {
  const h = harness();
  for (let i = 0; i < 9; i++) h.api.configure("cam-" + i, {});
  assert.equal(h.workers.length, 1);
  assert.equal(h.api.status("cam-8").state, "error");
  assert.equal(h.api.analyze("cam-8", {}, h.api.defaults, 0, null), null);
  for (let i = 0; i < 8; i++) h.api.release("cam-" + i);
  assert.ok(
    h.workers[0].terminated,
    "No active models: shared worker memory must be released",
  );
  assert.equal(h.api.status("cam-8").heap_bytes, 0);
});

test("analysis cadence does not halve FPS when video frames arrive just above the requested rate", () => {
  const h = harness(),
    canvas = { width: 640, height: 360 };
  h.api.configure("one", {});
  const w = h.workers[0];
  w.emit({ type: "ready" });
  for (let i = 0; i < 18; i++) {
    h.api.analyze("one", canvas, h.api.defaults, 0, null);
    const job = w.messages.at(-1);
    if (job.type === "frame")
      w.emit({
        type: "result",
        id: "one",
        revision: job.revision,
        sequence: job.sequence,
        mask: new Uint8Array(1).buffer,
        width: 1,
        height: 1,
        state: "ready",
        regions: [],
        processing_ms: 1,
      });
    h.advance(166.67);
  }
  const count = w.messages.filter((d) => d.type === "frame").length;
  assert.ok(
    count >= 14 && count <= 16,
    "5 FPS target should process about 15 frames from 3 seconds of 6 FPS video; got " +
      count,
  );
});

test("MIL requires the porch source, one owner and a fixed track limit", () => {
  const h = harness();
  assert.equal(h.api.defaults.tracking, false);
  assert.throws(
    () => h.api.configure("other", { tracking: true }, "driveway"),
    /available only/,
  );
  assert.throws(() =>
    h.api.configure("other", { tracking: true, max_tracks: 2 }, "porch-parcel"),
  );
  assert.equal(h.workers.length, 0);
  h.api.configure("porch", { tracking: true }, "porch-parcel");
  assert.throws(
    () => h.api.configure("duplicate", { tracking: true }, "porch-parcel"),
    /Only one/,
  );
  h.api.configure("other", { tracking: false }, "driveway");
  h.api.release("porch");
  h.api.configure("duplicate", { tracking: true }, "porch-parcel");
  const w = h.workers[0];
  w.emit({ type: "ready", mil_available: true });
  h.api.analyze(
    "duplicate",
    { width: 640, height: 360 },
    { tracking: true },
    0,
    null,
    "porch-parcel",
  );
  assert.equal(w.messages.at(-1).clip_id, "porch-parcel");
  h.api.configure("duplicate", { tracking: false }, "porch-parcel");
  h.api.configure("porch", { tracking: true }, "porch-parcel");
});
