const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {
  cameraIds,
  previewGraph,
  branchKey,
  drawOverlay,
} = require("../src/spyder_cctv/assets/workflow-preview.js");
const editor = require("../src/spyder_cctv/assets/workflow-editor.js");
const graph = () => ({
  id: "workflow",
  name: "Preview",
  enabled: false,
  camera_ids: [],
  nodes: [
    {
      id: "camera",
      type: "camera",
      x: 0,
      y: 0,
      params: { camera_id: "cam-a" },
    },
    {
      id: "filter",
      type: "filter",
      x: 200,
      y: 0,
      params: {
        label: "face",
        confidence: 0.5,
        identity: "",
        identity_source: "identity",
        rules: [],
        match: "all",
      },
    },
    { id: "preview", type: "preview", x: 400, y: 0, params: {} },
    {
      id: "unrelated",
      type: "camera",
      x: 0,
      y: 200,
      params: { camera_id: "cam-b" },
    },
  ],
  edges: [{ from: "camera", to: "preview", input: "camera" }],
});

test("preview accepts camera and data inputs, has no downstream output, and survives export", () => {
  const g = graph();
  assert.equal(editor.accepts(g.nodes[0], g.nodes[2], "camera"), true);
  assert.equal(editor.accepts(g.nodes[1], g.nodes[2], "detections"), true);
  assert.equal(editor.accepts(g.nodes[2], g.nodes[1]), false);
  assert.equal(
    editor.accepts({ id: "model", type: "model" }, g.nodes[2]),
    false,
  );
  assert.deepEqual(editor.validate(g), []);
  const imported = editor.decodeWorkflow(editor.encodeWorkflow(g), [
    { id: "cam-a" },
    { id: "cam-b" },
  ]);
  assert.equal(
    imported.nodes.find((n) => n.type === "preview").type,
    "preview",
  );
  assert.equal(editor.nodeSize(g.nodes[2]).width, 320);
});
test("camera choices are restricted to branch ancestors, including merged branches", () => {
  const g = graph();
  assert.deepEqual(cameraIds(g, "preview"), ["cam-a"]);
  g.edges.push({ from: "unrelated", to: "preview", input: "camera" });
  assert.deepEqual(cameraIds(g, "preview"), ["cam-a", "cam-b"]);
  g.edges = [];
  g.camera_ids = ["legacy"];
  assert.deepEqual(cameraIds(g, "preview"), ["legacy"]);
});
test("overlay scales bounding boxes and ignores malformed code output", () => {
  const boxes = [],
    labels = [];
  const ctx = {
    measureText: () => ({ width: 40 }),
    strokeRect: (...v) => boxes.push(v),
    fillRect() {},
    fillText: (t) => labels.push(t),
  };
  drawOverlay(
    ctx,
    [
      { bbox: [20, 30, 100, 150], identity: "Alice" },
      { bbox: [NaN, 0, 1, 1] },
      { bbox: [10, 10, 0, 0] },
      null,
    ],
    [200, 200],
    400,
    400,
  );
  assert.deepEqual(boxes, [[40, 60, 160, 240]]);
  assert.deepEqual(labels, ["Alice"]);
});

function harness({ demo = false, fetcher } = {}) {
  const requests = [],
    timers = new Map(),
    events = new Map(),
    docEvents = new Map(),
    draws = [];
  let seq = 0,
    closes = 0;
  const context = {
    drawImage() {
      draws.push("frame");
    },
    clearRect() {
      draws.push("clear");
    },
    strokeRect() {
      draws.push("box");
    },
    fillRect() {},
    fillText() {},
    measureText: () => ({ width: 10 }),
  };
  const canvas = { width: 640, height: 360, getContext: () => context };
  const button = {
    setAttribute(k, v) {
      this[k] = v;
    },
    closest: () => panel,
  };
  const select = {
    dataset: {},
    replaceChildren() {},
    append() {},
    closest: () => panel,
  };
  const placeholder = {},
    status = {};
  const panel = {
    dataset: { preview: "preview" },
    classList: { toggle() {} },
    querySelector: (s) =>
      ({
        canvas: canvas,
        "[data-preview-toggle]": button,
        "[data-preview-camera]": select,
        ".we-preview-placeholder": placeholder,
        ".we-preview-status": status,
      })[s],
  };
  const root = {
    querySelector: () => panel,
    addEventListener: (k, v) => events.set(k, v),
    removeEventListener: (k) => events.delete(k),
  };
  const doc = {
    hidden: false,
    createElement: () => ({}),
    addEventListener: (k, v) => docEvents.set(k, v),
    removeEventListener: (k) => docEvents.delete(k),
  };
  const g = graph();
  const sandbox = {
    module: { exports: {} },
    AbortController,
    document: doc,
    setTimeout: (fn, ms) => {
      timers.set(++seq, { fn, ms });
      return seq;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (path, options) => {
      requests.push({ path, options });
      if (fetcher) return fetcher(path, options);
      return path.includes("/preview-frame")
        ? { ok: true, blob: async () => ({}) }
        : {
            ok: true,
            json: async () => ({
              camera_id: "cam-a",
              state: "running",
              detections: [{ bbox: [0, 0, 10, 10], label: "face" }],
              frame_size: [100, 100],
              engine: "insightface",
            }),
          };
    },
    createImageBitmap: async () => ({
      width: 640,
      height: 360,
      close() {
        closes++;
      },
    }),
  };
  vm.runInNewContext(
    fs.readFileSync(
      require.resolve("../src/spyder_cctv/assets/workflow-preview.js"),
      "utf8",
    ),
    sandbox,
  );
  const controller = sandbox.module.exports.create(root, {
    graph: () => g,
    cameras: () => [{ id: "cam-a", name: "Desk" }],
    demo,
  });
  controller.sync();
  const click = () =>
    events.get("click")({
      target: {
        closest: (s) => (s === "[data-preview-toggle]" ? button : null),
      },
    });
  const tick = async () => {
    const next = [...timers].find(([, v]) => v.ms === 400);
    if (next) {
      timers.delete(next[0]);
      await next[1].fn();
    }
    await new Promise(setImmediate);
  };
  return {
    controller,
    g,
    click,
    tick,
    requests,
    timers,
    events,
    docEvents,
    doc,
    draws,
    status,
    button,
    get closes() {
      return closes;
    },
  };
}
test("starts paused, streams inline, pauses requests and cleans up on disposal", async () => {
  const h = harness();
  await h.tick();
  assert.equal(h.requests.length, 0);
  h.click();
  await new Promise(setImmediate);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].options.headers["X-Spyder-Control"], "1");
  assert.equal(JSON.parse(h.requests[0].options.body).node_id, "preview");
  assert.match(h.status.textContent, /1 matching detections/);
  assert.deepEqual(h.draws.slice(-2), ["frame", "box"]);
  assert.equal(h.closes, 1);
  h.click();
  await h.tick();
  assert.equal(h.requests.length, 2);
  assert.match(h.status.textContent, /last frame frozen/);
  h.controller.destroy();
  assert.equal(h.timers.size, 0);
  assert.equal(h.events.size, 0);
  assert.equal(h.docEvents.size, 0);
});
test("showcase never requests local camera or workflow endpoints", async () => {
  const h = harness({ demo: true });
  h.click();
  await h.tick();
  assert.equal(h.requests.length, 0);
  assert.equal(h.button.disabled, true);
  h.controller.destroy();
});
test("hidden tabs stop requests and stale async responses cannot paint after pause", async () => {
  let resolve;
  const h = harness({
    fetcher: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  h.doc.hidden = true;
  h.click();
  await h.tick();
  assert.equal(h.requests.length, 0);
  h.doc.hidden = false;
  const pending = h.tick();
  await new Promise(setImmediate);
  assert.equal(h.requests.length, 1);
  const signal = h.requests[0].options.signal;
  h.click();
  assert.equal(signal.aborted, true);
  resolve({
    ok: true,
    json: async () => ({
      camera_id: "cam-a",
      state: "running",
      detections: [],
    }),
  });
  await pending;
  assert.equal(h.draws.includes("frame"), false);
  assert.equal(h.requests.length, 1);
  h.controller.destroy();
});

test("an unassigned explicit Camera does not fall back to unrelated sidebar cameras", () => {
  const g = graph();
  g.nodes[0].params.camera_id = "";
  g.camera_ids = ["cam-b"];
  assert.deepEqual(cameraIds(g, "preview"), []);
});

test("preview signature ignores layout, ordering, workflow metadata and downstream branches", () => {
  const g = graph();
  const key = branchKey(g, "preview");
  for (const n of g.nodes) {
    n.x += 90;
    n.y += 50;
  }
  g.name = "Renamed";
  g.enabled = true;
  g.camera_ids = ["unrelated-camera"];
  g.nodes.push({
    id: "alert",
    type: "notification",
    x: 200,
    y: 200,
    params: { message: "Hello" },
  });
  g.nodes.push({
    id: "other-detect",
    type: "detections",
    x: 0,
    y: 300,
    params: { engine: "any" },
  });
  g.edges.push(
    { from: "camera", to: "other-detect", input: "camera" },
    { from: "other-detect", to: "filter" },
    { from: "filter", to: "alert" },
  );
  g.nodes.find((n) => n.id === "filter").params.confidence = 0.99;
  g.nodes.reverse();
  g.edges.reverse();
  assert.equal(branchKey(g, "preview"), key);
  g.nodes.find((n) => n.id === "camera").params.camera_id = "cam-b";
  assert.notEqual(branchKey(g, "preview"), key);
});

test("preview signature tracks upstream rules, bindings, model selections and edges", () => {
  const g = graph();
  const detect = {
    id: "detect",
    type: "detections",
    params: { engine: "any" },
  };
  const model = { id: "model", type: "model", params: { model_id: "a" } };
  g.nodes.push(detect, model);
  g.edges = [
    { from: "camera", to: "detect", input: "camera" },
    { from: "model", to: "detect", input: "model" },
    { from: "detect", to: "filter" },
    { from: "filter", to: "preview" },
  ];
  let key = branchKey(g, "preview");
  g.nodes.find((n) => n.id === "filter").params.confidence = 0.9;
  assert.notEqual(branchKey(g, "preview"), key);
  key = branchKey(g, "preview");
  model.params.model_id = "b";
  assert.notEqual(branchKey(g, "preview"), key);
  key = branchKey(g, "preview");
  g.nodes.find((n) => n.id === "filter").bindings = {
    identity: { node: "detect", signal: "identities" },
  };
  assert.notEqual(branchKey(g, "preview"), key);
  key = branchKey(g, "preview");
  g.edges = g.edges.filter((e) => e.to !== "preview");
  g.edges.push({ from: "detect", to: "preview" });
  assert.notEqual(branchKey(g, "preview"), key);
});

test("dragging and unrelated edits preserve frozen frames and allow in-flight frames to finish", async () => {
  let resolve;
  const h = harness({
    fetcher: (path) =>
      path.includes("preview-frame")
        ? Promise.resolve({ ok: true, blob: async () => ({}) })
        : new Promise((r) => {
            resolve = r;
          }),
  });
  h.click();
  await new Promise(setImmediate);
  const signal = h.requests[0].options.signal;
  const clearCount = h.draws.filter((v) => v === "clear").length;
  h.g.nodes[0].x = 390;
  h.g.nodes.find((n) => n.id === "unrelated").params.camera_id = "different";
  h.controller.sync();
  assert.equal(signal.aborted, false);
  assert.equal(h.draws.filter((v) => v === "clear").length, clearCount);
  resolve({
    ok: true,
    json: async () => ({
      camera_id: "cam-a",
      state: "running",
      detections: [],
      frame_size: [100, 100],
    }),
  });
  await new Promise(setImmediate);
  assert.equal(h.draws.includes("frame"), true);
  h.click();
  const frozenClearCount = h.draws.filter((v) => v === "clear").length;
  h.g.nodes[0].y = 500;
  h.g.name = "Another name";
  h.controller.sync();
  assert.equal(h.draws.filter((v) => v === "clear").length, frozenClearCount);
  assert.match(h.status.textContent, /last frame frozen/);
  h.controller.destroy();
});

test("changing an upstream camera cancels obsolete responses", async () => {
  let resolve;
  const h = harness({
    fetcher: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  h.click();
  await new Promise(setImmediate);
  const signal = h.requests[0].options.signal;
  h.g.nodes[0].params.camera_id = "cam-b";
  h.controller.sync();
  assert.equal(signal.aborted, true);
  resolve({
    ok: true,
    json: async () => ({
      camera_id: "cam-a",
      state: "running",
      detections: [],
    }),
  });
  await new Promise(setImmediate);
  assert.equal(h.draws.includes("frame"), false);
  h.controller.destroy();
});

test("preview requests isolate upstream validation from invalid unrelated drafts and cosmetic metadata", async () => {
  const h = harness();
  h.g.name = "";
  h.g.enabled = true;
  h.g.nodes[0].x = 900;
  h.g.nodes.push({
    id: "broken-code",
    type: "code",
    x: 0,
    y: 0,
    params: { language: "python", source: "not valid python !!!" },
  });
  h.click();
  await new Promise(setImmediate);
  const payload = JSON.parse(h.requests[0].options.body).workflow;
  assert.equal(payload.name, "Workflow preview");
  assert.equal(payload.enabled, false);
  assert.deepEqual(
    payload.nodes.map((n) => n.id),
    ["camera", "preview"],
  );
  assert.equal(payload.nodes[0].x, 0);
  assert.equal(h.g.nodes[0].x, 900);
  assert.match(h.status.textContent, /matching detections/);
  assert.deepEqual(previewGraph(h.g, "preview"), payload);
  h.controller.destroy();
});
