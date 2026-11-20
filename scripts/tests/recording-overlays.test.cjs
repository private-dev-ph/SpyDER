const { test } = require("node:test");
const assert = require("node:assert/strict");
const overlays = require("../../src/spyder_cctv/assets/recording-overlays.js");

const sample = (index, width = 640) => ({
  version: 1, chunk_seconds: 30, index, width, height: 360, fps: 25,
  truncated: false,
  samples: [{ time: index * 30 + 1, boxes: [{ bbox: [0.1, 0.2, 0.3, 0.4], camera_id: "cam", kind: "person", label: "Person", confidence: 0.9, identity: null }] }],
});

class Element {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = ownerDocument; this.children = [];
    this.listeners = new Map(); this.style = {}; this.attrs = {}; this.classList = { add() {}, remove() {} };
    this.clientWidth = 640; this.clientHeight = 360; this.width = 0; this.height = 0; this.checked = false;
    this.context = { setTransform() {}, clearRect() {}, strokeRect(...rect) { this.rects = [...(this.rects || []), rect]; this.drawn = (this.drawn || 0) + 1; }, measureText: () => ({ width: 40 }), fillRect() {}, fillText() {} };
  }
  append(...items) { this.children.push(...items); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { const entries = this.listeners.get(k) || []; entries.push(fn); this.listeners.set(k, entries); }
  removeEventListener(k) { this.listeners.delete(k); }
  dispatch(k) { for (const fn of this.listeners.get(k) || []) fn({ target: this }); }
  getContext() { return this.context; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 360 }; }
  remove() { this.removed = true; }
  click() {}
}
function harness({ demo = false, fetcher } = {}) {
  const doc = { createElement(tag) { return new Element(tag, doc); }, createTextNode(text) { return { textContent: text }; } };
  const surface = new Element("div", doc), media = new Element("video", doc);
  media.videoWidth = 640; media.videoHeight = 360;
  const originalFetch = global.fetch, originalRaf = global.requestAnimationFrame, originalCancel = global.cancelAnimationFrame;
  let requests = 0;
  global.fetch = async (...args) => { requests++; return fetcher ? fetcher(...args) : { ok: true, text: async () => JSON.stringify(sample(Number(new URL("http://local" + args[0]).searchParams.get("chunk")))) }; };
  global.requestAnimationFrame = () => 1; global.cancelAnimationFrame = () => {};
  global.spyderShowcase = demo ? {} : undefined;
  const controller = overlays.attach(surface, { item: { id: "a".repeat(32) }, media, time: () => 1, demo });
  const controls = surface.children.find((child) => child.className === "recording-overlay-controls");
  const toggle = controls.children[0].children[0], download = controls.children.find((child) => child.className === "button secondary recording-overlay-download"), status = controls.children.at(-1);
  return { controller, surface, media, toggle, download, status, requests: () => requests, restore() { controller.destroy(); global.fetch = originalFetch; global.requestAnimationFrame = originalRaf; global.cancelAnimationFrame = originalCancel; delete global.spyderShowcase; } };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("chunk indexing and schema validation reject wrong chunk, invalid geometry, and oversized boxes", () => {
  assert.equal(overlays.chunkNumber(59.99), 1);
  assert.equal(overlays.chunkNumber(-4), 0);
  assert.equal(overlays.validate(sample(2), 2).samples.length, 1);
  assert.throws(() => overlays.validate(sample(1), 2), /invalid/);
  const bad = sample(0); bad.samples[0].boxes[0].bbox = [0.9, 0, 0.2, 0.1];
  assert.throws(() => overlays.validate(bad, 0), /invalid/);
});

test("toggle fetches only active chunk, paints matching boxes, and reuses bounded chunk cache", async () => {
  const h = harness();
  try {
    assert.equal(h.requests(), 0, "detections stay opt-in");
    h.toggle.checked = true; h.toggle.dispatch("change"); await flush();
    assert.equal(h.requests(), 1);
    const canvas = h.surface.children.find((child) => child.className === "recording-overlay-canvas");
    assert.equal(canvas.context.drawn, 1);
    await h.controller.update(2); await flush();
    assert.equal(h.requests(), 1, "same chunk uses cache");
    await h.controller.update(31); await flush();
    assert.equal(h.requests(), 2, "seek loads only requested chunk");
    assert.match(h.status.textContent, /loaded/);
  } finally { h.restore(); }
});

test("sample selection never paints future detections and missing chunks are cached", async () => {
  const h = harness({ fetcher: (...args) => {
    const index = Number(new URL("http://local" + args[0]).searchParams.get("chunk"));
    return { ok: true, text: async () => JSON.stringify(index === 0 ? {
      ...sample(0), samples: [
        { time: 1, boxes: [{ bbox: [0.1, 0.2, 0.1, 0.1], camera_id: "cam", kind: "person", label: "past" }] },
        { time: 2, boxes: [{ bbox: [0.7, 0.2, 0.1, 0.1], camera_id: "cam", kind: "person", label: "future" }] },
      ],
    } : { ...sample(index), available: false, samples: [] }) };
  } });
  try {
    h.toggle.checked = true; h.toggle.dispatch("change"); await flush();
    const canvas = h.surface.children.find((child) => child.className === "recording-overlay-canvas");
    assert.equal(canvas.context.rects.length, 1);
    assert.equal(canvas.context.rects[0][0], 64, "time 1 shows the past sample, not the sample at time 2");
    await h.controller.update(31); await flush();
    assert.equal(canvas.context.rects.length, 1, "empty chunk clears previous boxes");
    await h.controller.update(32); await flush();
    assert.equal(h.requests(), 2, "cached no-data chunk is not fetched again on every frame");
  } finally { h.restore(); }
});

test("native download fetches current chunk without enabling overlay toggle", async () => {
  const h = harness();
  try {
    assert.equal(h.toggle.checked, false);
    h.download.dispatch("click"); await flush();
    assert.equal(h.requests(), 1);
    assert.equal(h.toggle.checked, false);
  } finally { h.restore(); }
});

test("showcase mode never calls local APIs and invalid metadata paints no boxes", async () => {
  const h = harness({ demo: true, fetcher: () => { throw Error("must not fetch"); } });
  try {
    h.toggle.checked = true; h.toggle.dispatch("change"); await flush();
    assert.equal(h.requests(), 0);
    assert.match(h.status.textContent, /No saved detections/);
  } finally { h.restore(); }
  const bad = harness({ fetcher: () => ({ ok: true, text: async () => JSON.stringify({ ...sample(0), index: 1 }) }) });
  try {
    bad.toggle.checked = true; bad.toggle.dispatch("change"); await flush();
    assert.match(bad.status.textContent, /invalid/);
    await bad.controller.update(2); await flush();
    assert.equal(bad.requests(), 1, "invalid chunks are not retried on every frame");
    assert.match(bad.status.textContent, /invalid/);
    assert.equal(bad.surface.children.find((child) => child.className === "recording-overlay-canvas").context.drawn || 0, 0);
  } finally { bad.restore(); }
  const aspect = harness({ fetcher: () => ({ ok: true, text: async () => JSON.stringify({ ...sample(0), height: 480 }) }) });
  try {
    aspect.toggle.checked = true; aspect.toggle.dispatch("change"); await flush();
    assert.match(aspect.status.textContent, /geometry/);
    assert.equal(aspect.surface.children.find((child) => child.className === "recording-overlay-canvas").context.drawn || 0, 0);
  } finally { aspect.restore(); }
  const scaled = harness({ fetcher: () => ({ ok: true, text: async () => JSON.stringify({ ...sample(0), width: 1280, height: 720 }) }) });
  try {
    scaled.toggle.checked = true; scaled.toggle.dispatch("change"); await flush();
    assert.equal(scaled.surface.children.find((child) => child.className === "recording-overlay-canvas").context.drawn, 1, "aspect-preserving transcode remains valid");
  } finally { scaled.restore(); }
});


test("missing detection download never produces an invalid JSON file", async () => {
  const create = URL.createObjectURL; let downloads = 0;
  URL.createObjectURL = () => { downloads++; return "blob:test"; };
  const h = harness({ fetcher: () => ({ ok: true, text: async () => JSON.stringify({ available: false }) }) });
  try {
    h.download.dispatch("click"); await flush();
    assert.equal(downloads, 0);
    assert.match(h.status.textContent, /No saved detections/);
  } finally { h.restore(); URL.createObjectURL = create; }
});


test("seeking across a day keeps only three decoded windows", async () => {
  const h = harness();
  try {
    h.toggle.checked = true; h.toggle.dispatch("change"); await flush();
    for (let index = 1; index < 100; index++) await h.controller.update(index * 30 + 2);
    assert.equal(h.requests(), 100);
    for (const index of [97, 98, 99]) await h.controller.update(index * 30 + 2);
    assert.equal(h.requests(), 100, "three recent windows stay cached");
    await h.controller.update(2);
    assert.equal(h.requests(), 101, "old windows were evicted");
    await h.controller.update(86399);
    assert.equal(h.requests(), 102, "end of a day loads one window, not the whole history");
  } finally { h.restore(); }
});
