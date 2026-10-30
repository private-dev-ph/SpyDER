const { test } = require("node:test"),
  assert = require("node:assert/strict");
const codec = require("../src/spyder_cctv/assets/workflow-editor.js");
const motion = require("../src/spyder_cctv/assets/browser-motion.js");
const {
  createWorkflowTemplate,
  validate,
  templateEntries,
} = require("../src/spyder_cctv/assets/workflow-editor.js");
test("six visually reviewed person clips have distinct approach presets; vehicle and empty patio skipped", () => {
  assert.deepEqual(
    motion.clips().map((c) => c.id),
    [
      "porch-parcel",
      "front-walk-approach",
      "front-door-close",
      "covered-porch",
      "ring-doorbell-idle",
      "front-yard-walk",
    ],
  );
  for (const clip of motion.clips()) {
    assert.ok(motion.validRoi(clip.motion_preset.roi));
    const graph = createWorkflowTemplate("demo-approach-" + clip.id, {
      cameras: [
        { id: "selected-camera", demo_clip_id: clip.id },
        { id: "wrong-camera", demo_clip_id: "other" },
      ],
    });
    assert.equal(graph.nodes[0].params.camera_id, "selected-camera");
    assert.deepEqual(validate(graph), []);
    const imported = codec.decodeWorkflow(codec.encodeWorkflow(graph), [
      { id: "selected-camera" },
    ]);
    assert.equal(imported.preset_clip_id, clip.id);
    assert.deepEqual(
      imported.nodes.find((n) => n.type === "browser_motion").params.roi,
      clip.motion_preset.roi,
    );
    assert.equal(graph.enabled, false);
    assert.equal(templateEntries(clip.motion_preset.name, true).length, 1);
    assert.equal(templateEntries(clip.motion_preset.name, false).length, 0);
  }
});
test("ROI measures only pixels inside the region, relative to region area", () => {
  const previous = new Uint8ClampedArray(4 * 4 * 4),
    current = previous.slice();
  current[0] = 255;
  const sample = motion.measure(current, previous, 4, 4);
  assert.equal(motion.fraction(sample, [0.5, 0.5, 1, 1]), 0);
  assert.equal(motion.fraction(sample, [0, 0, 0.5, 0.5]), 0.25);
  assert.equal(motion.fraction(sample), 1 / 16);
  assert.equal(motion.fraction(sample, [0, 0, 0, 1]), 0);
  assert.equal(motion.fraction(null, [0, 0, 1, 1]), 0);
  assert.equal(motion.fraction(motion.measure(current, null, 4, 4)), 0);
  assert.equal(
    motion.fraction(
      motion.measure(new Uint8ClampedArray(64).fill(255), previous, 4, 4),
    ),
    0,
    "scene cuts are not arrivals",
  );
  for (const roi of [
    [],
    [0, 0, 1, NaN],
    [0, 0, 2, 1],
    [0.5, 0, 0.2, 1],
    [0, 0, 1],
  ])
    assert.equal(motion.validRoi(roi), false);
});
test("seeding preserves edits, camera settings and deletion; partial saves retry without duplicates", async () => {
  const graphs = new Map(),
    local = new Map();
  let fail = true;
  const storage = {
    getItem: (k) => local.get(k),
    setItem: (k, v) => local.set(k, v),
  };
  const store = {
    get: async (id) => graphs.get(id),
    save: async (g) => {
      if (fail && graphs.size === 2) throw Error("quota");
      graphs.set(g.id, structuredClone(g));
    },
  };
  const cameras = [
    {
      id: "porch-id",
      demo_clip_id: "porch-parcel",
      settings: { brightness: 78 },
    },
  ];
  await assert.rejects(motion.seed(store, cameras, storage), /quota/);
  graphs.get("demo-approach-porch-parcel").name = "User edit";
  fail = false;
  await motion.seed(store, cameras, storage);
  assert.equal(graphs.size, 6);
  assert.equal(graphs.get("demo-approach-porch-parcel").name, "User edit");
  assert.equal(
    graphs.get("demo-approach-porch-parcel").nodes[0].params.camera_id,
    "porch-id",
  );
  assert.ok([...graphs.values()].every((g) => !g.enabled));
  assert.equal(cameras[0].settings.brightness, 78);
  graphs.delete("demo-approach-covered-porch");
  await motion.seed(store, cameras, storage);
  assert.equal(
    graphs.size,
    5,
    "deleted defaults stay deleted; templates can recreate them",
  );
});

test("pending camera startup cannot block saved enabled workflow restoration", async () => {
  const fs = require("node:fs"),
    vm = require("node:vm");
  const graph = motion.workflow(motion.clips()[0], "saved-camera");
  graph.enabled = true;
  let subscribed = false;
  const window = {
    spyderBrowserMotion: motion,
    spyderShowcase: {
      ready: new Promise(() => {}),
      subscribeFrames() {
        subscribed = true;
        return () => {};
      },
    },
    spyderWorkflowStore: { get: async () => graph },
  };
  const localStorage = {
    getItem: (key) =>
      key === "spyder.workflow.demo.enabled.v1"
        ? JSON.stringify([graph.id])
        : null,
  };
  vm.runInNewContext(
    fs.readFileSync(
      require.resolve("../src/spyder_cctv/assets/browser-demo-workflows.js"),
      "utf8",
    ),
    { window, localStorage, TextEncoder, setTimeout, clearTimeout, Response },
  );
  let timer;
  try {
    const restored = await Promise.race([
      window.spyderDemoWorkflowRuntime.ready.then(() => true),
      new Promise((resolve) => (timer = setTimeout(() => resolve(false), 500))),
    ]);
    assert.equal(restored, true);
    assert.equal(subscribed, true);
    assert.deepEqual(Array.from(window.spyderDemoWorkflowRuntime.active()), [
      graph.id,
    ]);
  } finally {
    clearTimeout(timer);
  }
});
