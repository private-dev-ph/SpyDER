const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "../src/spyder_cctv/assets/vision-lab.js"),
  "utf8",
);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup({ showcase = false, fetcher, postRequest, cameras } = {}) {
  const requests = [];
  const listeners = new Map();
  const timerMap = new Map();
  const revoked = [];
  const created = [];
  let sequence = 0;
  const cameraList = cameras || [
    { id: "cam-a", name: "North", state: "running", pipeline: "vision", metadata: {} },
    { id: "cam-b", name: "South", state: "running", pipeline: "motion", metadata: {} },
  ];
  class Element {
    constructor(selector = "") {
      this.selector = selector;
      this.style = {};
      this.dataset = {};
      this.hidden = false;
      this.disabled = false;
      this.value = "";
      this.renderCount = 0;
      this._innerHTML = "";
      this.checked = false;
      this.name = "";
      this.listeners = {};
      this.options = [];
      this.classList = {
        add() {}, remove() {},
        toggle() {},
        contains: (name) => this.className?.split(/\s+/).includes(name) || false,
      };
      this.elements = {};
      if (selector === "form") for (const name of ["enabled", "contours", "components", "tracking", "threshold", "history", "learning_rate", "detect_shadows", "min_area_percent", "inference_fps", "input_width", "warmup_frames", "max_tracks", "overlay", "roi_x", "roi_y", "roi_w", "roi_h"])
        this.elements[name] = new Element("[name=" + name + "]");
      if (this.elements.threshold) {
        this.elements.enabled.checked = false;
        this.elements.contours.checked = true;
        this.elements.components.checked = true;
        this.elements.tracking.checked = false;
        this.elements.threshold.value = "16";
        this.elements.history.value = "300";
        this.elements.learning_rate.value = "auto";
        this.elements.detect_shadows.checked = true;
        this.elements.min_area_percent.value = "0.5";
        this.elements.inference_fps.value = "5";
        this.elements.input_width.value = "480";
        this.elements.warmup_frames.value = "15";
        this.elements.max_tracks.value = "2";
        this.elements.overlay.checked = true;
      }
      this.naturalWidth = 640;
      this.naturalHeight = 360;
      this.src = "";
      this.textContent = "";
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(value) { this._innerHTML = value; this.renderCount++; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    removeEventListener(name) { delete this.listeners[name]; }
    dispatch(name, event) { this.listeners[name]?.({ ...event, type: name }); }
    append() {}
    add(option) { this.options.push(option); }
    replaceChildren(...items) { this.children = items; }
    remove() { this.removed = true; }
    contains() { return false; }
    getBoundingClientRect() { return this.bounds || { left: 0, top: 0, width: 640, height: 480 }; }
    setPointerCapture() {}
    closest(selector) { return selector === ".vl-stage" ? this : selector === "form" ? this : null; }
    matches(selector) { return selector === "form" && this.selector === "form"; }
    preventDefault() {}
    querySelector(selector) {
      if (selector === "form") return this.form;
      if (selector === "#vl-camera") return this.cameraSelect;
      if (selector === ".vl-view-mode") return this.viewSelect;
      if (selector === ".vl-image") return this.image;
      if (selector === ".vl-mask-image") return this.maskImage;
      if (selector === ".vl-image-pair") return this.imagePair;
      if (selector === ".vl-stage") return this.stage;
      if (selector === ".vl-roi-box") return this.roiBox;
      if (selector === ".vl-mask-note") return this.maskNote;
      if (selector === ".vl-preview-state") return this.previewState;
      if (selector === ".vl-pipeline-value") return this.pipelineValue;
      if (selector === ".vl-results") return this.results;
      if (selector === ".vl-runtime-note") return this.runtimeNote;
      if (selector === ".vl-tracking-note") return this.trackingNote;
      if (selector === ".vl-capacity-state") return this.capacityState;
      if (selector === ".vl-capacity-error") return this.capacityError;
      if (selector === ".vl-capacity-body") return this.capacityBody;
      if (selector === ".vl-assess") return this.assess;
      if (selector === 'button[type="submit"]') return this.submitButton;
      const metric = selector.match(/data-metric="([^"]+)/)?.[1];
      if (metric) return this.metrics[metric];
      const name = selector.match(/name=["']?([^\]'" ]+)/)?.[1];
      if (name) return this.form?.elements[name];
      if (selector === ".vl-message") return this.message;
      if (selector === ".vl-dirty") return this.dirty;
      return null;
    }
  }
  const root = new Element("root");
  root.form = new Element("form");
  root.cameraSelect = new Element("#vl-camera");
  root.cameraSelect.id = "vl-camera";
  root.viewSelect = new Element(".vl-view-mode");
  root.viewSelect.className = "vl-view-mode";
  root.viewSelect.value = "original";
  root.image = new Element(".vl-image");
  root.maskImage = new Element(".vl-mask-image");
  root.imagePair = new Element(".vl-image-pair");
  root.stage = new Element(".vl-stage");
  root.roiBox = new Element(".vl-roi-box");
  root.message = new Element(".vl-message");
  root.dirty = new Element(".vl-dirty");
  root.maskNote = new Element(".vl-mask-note");
  root.previewState = new Element(".vl-preview-state");
  root.pipelineValue = new Element(".vl-pipeline-value");
  root.results = new Element(".vl-results");
  root.runtimeNote = new Element(".vl-runtime-note");
  root.trackingNote = new Element(".vl-tracking-note");
  root.capacityState = new Element(".vl-capacity-state");
  root.capacityError = new Element(".vl-capacity-error");
  root.capacityBody = new Element(".vl-capacity-body");
  root.assess = new Element(".vl-assess");
  root.assess.className = "vl-assess";
  root.submitButton = new Element('button[type="submit"]');
  root.metrics = Object.fromEntries(["processing", "age", "dropped", "regions", "tracks"].map((key) => [key, new Element(key)]));
  const document = {
    activeElement: null,
    createElement: () => root,
    addEventListener(name, fn) { listeners.set("document:" + name, fn); },
    removeEventListener(name) { listeners.delete("document:" + name); },
  };
  const window = {
    spyder: {
      cameras: () => cameraList,
      frame: (id) => "blob:frame-" + id,
      request: async (url, data) => { requests.push({ method: "POST", url, data }); return postRequest ? postRequest(url, data) : { state: "running" }; },
    },
    addEventListener(name, fn) { listeners.set("window:" + name, fn); },
    removeEventListener(name) { listeners.delete("window:" + name); },
    dispatchEvent() {},
  };
  if (showcase) window.spyderShowcase = {};
  const context = vm.createContext({
    window, document,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    AbortController, setImmediate, console,
    setTimeout(fn, ms) { const id = ++sequence; timerMap.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timerMap.delete(id); },
    URL: { createObjectURL(blob) { const value = "blob:mask-" + created.length; created.push({ blob, value }); return value; }, revokeObjectURL(url) { revoked.push(url); } },
    fetch: async (url, options = {}) => {
      requests.push({ method: "GET", url, options });
      if (fetcher) return fetcher(url, options);
      if (url.endsWith("/analysis/capacity")) return { ok: true, json: async () => ({ state: "idle" }) };
      if (url.endsWith("/analysis")) return { ok: true, json: async () => ({ pipeline: "vision", settings: { threshold: 16 }, runtime: { state: "running" } }) };
      return { ok: true, blob: async () => new Blob(["mask"]) };
    },
  });
  vm.runInContext(source, context);
  const container = { replaceChildren(node) { this.root = node; } };
  window.spyderVisionLab.mount(container);
  return { root, container, requests, listeners, timerMap, revoked, created, cameraList, window, document };
}

test("showcase preview never calls native analysis or mask endpoints", async () => {
  const h = setup({ showcase: true });
  h.root.viewSelect.value = "mask";
  h.root.dispatch("change", { target: h.root.viewSelect });
  h.root.dispatch("click", { target: { closest: () => h.root.assess } });
  await flush();
  assert.deepEqual(h.requests, []);
  h.window.spyderVisionLab.unmount();
});

test("camera arriving after mount becomes selected and starts analysis polling", async () => {
  const h = setup({ cameras: [] });
  await flush();
  assert.equal(h.requests.some((r) => r.url?.endsWith("/analysis")), false);
  h.cameraList.push({ id: "cam-late", name: "Late camera", state: "running", pipeline: "vision", metadata: {} });
  h.listeners.get("window:spyder:cameras")();
  await flush();
  assert.equal(h.root.cameraSelect.value, "cam-late");
  assert.equal(h.root.image.src, "blob:frame-cam-late");
  assert.ok(h.requests.some((r) => r.url === "/api/cameras/cam-late/analysis"));
  h.window.spyderVisionLab.unmount();
});

test("unsaved form values survive a server poll", async () => {
  const h = setup();
  await flush();
  h.root.form.elements.threshold.value = "77";
  h.root.dispatch("input", { target: { closest: () => h.root.form } });
  const poll = [...h.timerMap.values()].find((item) => item.ms === 1200);
  assert.ok(poll);
  const renders = h.root.renderCount;
  poll.fn();
  await flush();
  assert.equal(h.root.renderCount, renders, "runtime poll must not rebuild form DOM");
  assert.equal(h.root.form.elements.threshold.value, "77");
  h.root.dispatch("submit", { target: h.root.form, preventDefault() {} });
  await flush();
  const post = h.requests.find((r) => r.method === "POST");
  assert.equal(post.url, "/api/cameras/cam-a/analysis");
  assert.equal(post.data.settings.threshold, 77);
  assert.deepEqual(Object.keys(post.data.settings).sort(), [
    "components", "contours", "detect_shadows", "enabled", "history",
    "inference_fps", "input_width", "learning_rate", "max_tracks",
    "min_area_percent", "overlay", "roi", "threshold", "tracking",
    "warmup_frames",
  ].sort());
  h.window.spyderVisionLab.unmount();
});

test("ROI pointer coordinates exclude preview letterboxing", () => {
  const h = setup();
  const stage = h.root.stage;
  h.root.dispatch("pointerdown", { button: 0, clientX: 64, clientY: 96, pointerId: 1, target: stage });
  h.root.dispatch("pointermove", { clientX: 576, clientY: 384, pointerId: 1, target: stage });
  assert.equal(+h.root.form.elements.roi_x.value, 10);
  assert.equal(+h.root.form.elements.roi_y.value, 10);
  assert.equal(+h.root.form.elements.roi_w.value, 80);
  assert.equal(+h.root.form.elements.roi_h.value, 80);
  h.root.dispatch("submit", { target: h.root.form, preventDefault() {} });
  return flush().then(() => {
    assert.deepEqual(Array.from(h.requests.find((r) => r.method === "POST").data.settings.roi), [0.1, 0.1, 0.8, 0.8]);
    h.window.spyderVisionLab.unmount();
  });
});

test("ROI mapping handles 4:3 source letterboxing in original and side-by-side views", async () => {
  const h = setup();
  h.root.image.naturalWidth = 640;
  h.root.image.naturalHeight = 480;
  h.root.stage.bounds = { left: 0, top: 0, width: 640, height: 360 };
  const draw = (a, b) => {
    h.root.dispatch("pointerdown", { button: 0, clientX: a[0], clientY: a[1], pointerId: 1, target: h.root.stage });
    h.root.dispatch("pointermove", { clientX: b[0], clientY: b[1], pointerId: 1, target: h.root.stage });
  };
  draw([128, 36], [512, 324]);
  assert.deepEqual([+h.root.form.elements.roi_x.value, +h.root.form.elements.roi_y.value, +h.root.form.elements.roi_w.value, +h.root.form.elements.roi_h.value], [10, 10, 80, 80]);
  h.root.viewSelect.value = "side-by-side";
  h.root.dispatch("change", { target: h.root.viewSelect });
  draw([32, 84], [288, 276]);
  assert.deepEqual([+h.root.form.elements.roi_x.value, +h.root.form.elements.roi_y.value, +h.root.form.elements.roi_w.value, +h.root.form.elements.roi_h.value], [10, 10, 80, 80]);
  h.window.spyderVisionLab.unmount();
});

test("mask image loads as binary blob and cleanup revokes it on unmount", async () => {
  const h = setup();
  h.root.viewSelect.value = "mask";
  h.root.dispatch("change", { target: h.root.viewSelect });
  await flush();
  assert.ok(h.requests.some((r) => r.url === "/api/cameras/cam-a/analysis/mask"));
  assert.equal(h.root.maskImage.src, "blob:mask-0");
  assert.ok([...h.timerMap.values()].some((timer) => timer.ms === 1200), "mask refresh is scheduled while mask view stays open");
  h.window.spyderVisionLab.unmount();
  assert.deepEqual(h.revoked, ["blob:mask-0"]);
});

test("mask refresh keeps prior image visible until replacement arrives", async () => {
  let resolveReplacement;
  let maskCalls = 0;
  const h = setup({ fetcher: async (url) => {
    if (url.endsWith("/analysis/capacity")) return { ok: true, json: async () => ({ state: "idle" }) };
    if (url.endsWith("/analysis")) return { ok: true, json: async () => ({ pipeline: "vision", settings: {}, runtime: {} }) };
    maskCalls++;
    if (maskCalls === 1) return { ok: true, blob: async () => new Blob(["first"]) };
    return new Promise((resolve) => { resolveReplacement = resolve; });
  } });
  h.root.viewSelect.value = "mask";
  h.root.dispatch("change", { target: h.root.viewSelect });
  await flush();
  assert.equal(h.root.maskImage.src, "blob:mask-0");
  h.root.viewSelect.value = "side-by-side";
  h.root.dispatch("change", { target: h.root.viewSelect });
  await flush();
  assert.equal(h.root.maskImage.src, "blob:mask-0");
  assert.deepEqual(h.revoked, []);
  resolveReplacement({ ok: true, blob: async () => new Blob(["second"]) });
  await flush();
  assert.equal(h.root.maskImage.src, "blob:mask-1");
  assert.deepEqual(h.revoked, ["blob:mask-0"]);
  h.window.spyderVisionLab.unmount();
});

test("removing selected camera revokes its mask and moves selection", async () => {
  const h = setup();
  h.root.viewSelect.value = "mask";
  h.root.dispatch("change", { target: h.root.viewSelect });
  await flush();
  h.cameraList.splice(0, 1);
  h.listeners.get("window:spyder:cameras")();
  await flush();
  assert.deepEqual(h.revoked, ["blob:mask-0"]);
  assert.equal(h.root.cameraSelect.value, "cam-b");
  h.window.spyderVisionLab.unmount();
});

test("late mask response after camera switch cannot create stale object URL", async () => {
  const resolveMasks = [];
  const h = setup({ fetcher: async (url) => {
    if (url.endsWith("/analysis/capacity")) return { ok: true, json: async () => ({ state: "idle" }) };
    if (url.endsWith("/analysis/mask")) return new Promise((resolve) => { resolveMasks.push(resolve); });
    return { ok: true, json: async () => ({ pipeline: "vision", settings: {}, runtime: {} }) };
  } });
  h.root.viewSelect.value = "mask";
  h.root.dispatch("change", { target: h.root.viewSelect });
  h.root.cameraSelect.value = "cam-b";
  h.root.dispatch("change", { target: h.root.cameraSelect });
  resolveMasks[0]({ ok: true, blob: async () => new Blob(["stale"]) });
  await flush();
  assert.equal(h.created.length, 0);
  h.window.spyderVisionLab.unmount();
});

test("camera switch serializes polls and unmount aborts active requests", async () => {
  const pending = [];
  const h = setup({ fetcher: (url, options) => new Promise((resolve) => pending.push({ url, options, resolve })) });
  assert.equal(pending.length, 2, "initial capacity and camera reads start together");
  h.root.cameraSelect.value = "cam-b";
  h.root.dispatch("change", { target: h.root.cameraSelect });
  assert.equal(pending.length, 2, "switch waits for aborted camera read to settle");
  for (const request of pending)
    request.resolve({ ok: true, json: async () => request.url.endsWith("/analysis/capacity") ? { state: "idle" } : { pipeline: "vision", settings: {}, runtime: {} } });
  await flush();
  assert.equal(pending.length, 4, "one poll starts for newly selected camera");
  const active = pending.slice(2);
  h.window.spyderVisionLab.unmount();
  assert.ok(active.every((request) => request.options.signal.aborted));
  active.forEach((request) => request.resolve({ ok: true, json: async () => ({ state: "idle" }) }));
  await flush();
  assert.equal(pending.length, 4, "unmounted workspace does not schedule another poll");
});

test("mask warming status is shown without reporting a request error", async () => {
  const h = setup({ fetcher: async (url) => {
    if (url.endsWith("/analysis/capacity")) return { ok: true, json: async () => ({ state: "idle" }) };
    if (url.endsWith("/analysis/mask")) return { status: 503, ok: false };
    return { ok: true, json: async () => ({ pipeline: "vision", settings: {}, runtime: {} }) };
  } });
  h.root.viewSelect.value = "mask";
  h.root.dispatch("change", { target: h.root.viewSelect });
  await flush();
  assert.match(h.root.maskNote.textContent, /Foreground mask warming up/);
  assert.equal(h.root.message.classList.contains("vl-error"), false);
  h.window.spyderVisionLab.unmount();
});

test("runtime and tracking diagnostics stay visible after polling", async () => {
  const h = setup({ fetcher: async (url) => {
    if (url.endsWith("/analysis/capacity")) return { ok: true, json: async () => ({ state: "idle" }) };
    return { ok: true, json: async () => ({ pipeline: "vision", settings: {}, runtime: { state: "warming_up", message: "Model warmup", tracking_error: "MIL tracker unavailable" } }) };
  } });
  await flush();
  assert.equal(h.root.runtimeNote.textContent, "Model warmup");
  assert.equal(h.root.trackingNote.textContent, "MIL tracker unavailable");
  h.window.spyderVisionLab.unmount();
});

test("capacity result from prior camera cannot overwrite current workspace", async () => {
  let resolveAssessment;
  const h = setup({ postRequest: () => new Promise((resolve) => { resolveAssessment = resolve; }) });
  const assess = h.root.assess;
  h.root.dispatch("click", { target: { closest: () => assess } });
  const before = h.root.capacityBody.innerHTML;
  h.root.cameraSelect.value = "cam-b";
  h.root.dispatch("change", { target: h.root.cameraSelect });
  resolveAssessment({ state: "ready", report: { active_analysis: 99, profiles: [{ name: "stale" }] } });
  await flush();
  assert.equal(h.root.capacityBody.innerHTML, before);
  h.window.spyderVisionLab.unmount();
});

test("capacity completion after unmount cannot update removed workspace", async () => {
  let resolveAssessment;
  const h = setup({ postRequest: () => new Promise((resolve) => { resolveAssessment = resolve; }) });
  h.root.dispatch("click", { target: { closest: () => h.root.assess } });
  const before = h.root.capacityBody.innerHTML;
  h.window.spyderVisionLab.unmount();
  resolveAssessment({ state: "ready", report: { active_analysis: 42 } });
  await flush();
  assert.equal(h.root.capacityBody.innerHTML, before);
});
