const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

class FakeRecorder {
  static supported = ["video/webm;codecs=vp8"];
  static isTypeSupported(type) { return this.supported.includes(type); }
  constructor(stream, options = {}) {
    FakeRecorder.last = this;
    this.stream = stream;
    this.mimeType = options.mimeType || "video/webm";
    this.state = "inactive";
    this.listeners = new Map();
  }
  addEventListener(name, fn) {
    const list = this.listeners.get(name) || [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  emit(name, event = {}) {
    for (const fn of this.listeners.get(name) || []) fn(event);
  }
  start(timeslice) { this.timeslice = timeslice; this.state = "recording"; }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.emit("dataavailable", { data: new Blob(["video"], { type: this.mimeType }) });
    this.emit("stop");
  }
}

function runtime({ recorder = FakeRecorder, sourceState = "running", fetchFailure = false } = {}) {
  const listeners = {};
  const revoked = [];
  const stoppedTracks = [];
  const sourceCanvas = { width: 640, height: 360 };
  const sourceIds = new Set(["cam-a", "cam-b"]);
  let intervalCallback;
  const canvas = {
    width: 0, height: 0, draws: [],
    getContext: () => ({
      fillRect() {}, fillText() {}, drawImage(...args) { canvas.draws.push(args); },
    }),
    captureStream(fps) {
      canvas.captureFps = fps;
      return { getTracks: () => [{ stop: () => stoppedTracks.push(true) }] };
    },
    toBlob(callback, type) { callback(new Blob(["jpeg"], { type })); },
  };
  const document = {
    hidden: false,
    createElement(tag) {
      if (tag === "canvas") return canvas;
      return { click() { this.clicked = true; } };
    },
    addEventListener(name, fn) { listeners[`doc:${name}`] = fn; },
  };
  const cameraData = [...sourceIds].map((id) => ({ id, state: sourceState }));
  const showcase = {
    async fetch(path) {
      if (fetchFailure) throw new Error("network forbidden");
      assert.equal(path, "/api/cameras");
      return { json: async () => cameraData.filter((camera) => sourceIds.has(camera.id)) };
    },
    async getFrameSource(id) {
      if (!sourceIds.has(id) || sourceState !== "running") throw new Error("offline");
      return sourceCanvas;
    },
    async setRecording(id, active) {
      if (!sourceIds.has(id)) throw new Error("removed");
      showcase.retention.push([id, active]);
    },
    retention: [],
  };
  const window = {
    spyderShowcase: showcase,
    MediaRecorder: recorder,
    addEventListener(name, fn) { listeners[`win:${name}`] = fn; },
  };
  const context = vm.createContext({
    window, document, MediaRecorder: recorder, Blob,
    URL: { createObjectURL: () => `blob:${Math.random()}`, revokeObjectURL: (url) => revoked.push(url) },
    crypto: require("node:crypto").webcrypto,
    Date, Math, Set, Promise,
    setInterval: (fn, ms) => { intervalCallback = fn; return { fn, ms }; }, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/spyder_cctv/assets/browser-recording.js"), "utf8"), context);
  return { api: window.spyderBrowserMedia, showcase, canvas, document, listeners, revoked, stoppedTracks, recorder: () => recorder?.last, sourceIds, tick: () => intervalCallback?.() };
}

test("records local tiled canvas with selected cameras and chosen browser MIME", async () => {
  const app = runtime();
  const status = await app.api.request("/api/recordings/start", { camera_ids: ["cam-a", "cam-b"] });
  assert.equal(status.state, "recording");
  assert.deepEqual(Array.from(status.camera_ids), ["cam-a", "cam-b"]);
  assert.equal(status.width, 1920);
  assert.equal(status.height, 1080);
  assert.equal(status.fps, 15);
  assert.equal(app.canvas.captureFps, 15);
  assert.deepEqual(app.showcase.retention, [["cam-a", true], ["cam-b", true]]);
  await app.api.request("/api/recordings/stop");
  const done = await app.api.status();
  assert.equal(done.state, "idle");
  assert.equal(done.items[0].kind, "video");
  assert.match(done.items[0].filename, /\.webm$/);
  assert.equal(done.items[0].size_bytes, 5);
  assert.deepEqual(app.showcase.retention.slice(-2), [["cam-a", false], ["cam-b", false]]);
  assert.equal(app.stoppedTracks.length, 1);
});

test("selection changes release removed retention and zero selection stops recording", async () => {
  const app = runtime();
  await app.api.request("/api/recordings/start", { camera_ids: ["cam-a", "cam-b"] });
  await app.api.request("/api/recordings/cameras", { camera_ids: ["cam-b"] });
  assert.deepEqual(Array.from((await app.api.status()).camera_ids), ["cam-b"]);
  assert.deepEqual(app.showcase.retention.slice(-1), [["cam-a", false]]);
  const done = await app.api.request("/api/recordings/cameras", { camera_ids: [] });
  assert.equal(done.state, "idle");
  assert.equal(done.camera_ids.length, 0);
});

test("unsupported and failed starts release retained cameras", async () => {
  class Unsupported { static isTypeSupported() { return false; } }
  const unsupported = runtime({ recorder: null });
  await assert.rejects(unsupported.api.request("/api/recordings/start", { camera_ids: ["cam-a"] }), /cannot record/);
  const broken = runtime({ recorder: class { constructor() { throw new Error("constructor failed"); } } });
  await assert.rejects(broken.api.request("/api/recordings/start", { camera_ids: ["cam-a"] }), /constructor failed/);
  assert.deepEqual(broken.showcase.retention, [["cam-a", true], ["cam-a", false]]);
  assert.ok(Unsupported);
});

test("captures one local JPEG and never calls network fetch", async () => {
  const app = runtime();
  const result = await app.api.request("/api/captures", { camera_ids: ["cam-a"] });
  assert.equal(result.items[0].kind, "capture");
  assert.match(result.items[0].filename, /\.jpg$/);
  assert.equal(result.items[0].size_bytes, 4);
  assert.equal(app.canvas.width, 1920);
  assert.equal(app.showcase.retention.length, 0);
});

test("missing cameras drop from selection and failed source draws use offline tile", async () => {
  const app = runtime();
  await app.api.request("/api/recordings/start", { camera_ids: ["cam-a"] });
  app.sourceIds.delete("cam-a");
  await app.tick();
  const status = await app.api.status();
  assert.equal(status.state, "idle");
  assert.equal(status.camera_ids.length, 0);
  const offline = runtime({ sourceState: "stopped" });
  const capture = await offline.api.request("/api/captures", { camera_ids: ["cam-a"] });
  assert.equal(capture.items.length, 1);
});

test("status starts idle and page visibility ends recording", async () => {
  const app = runtime();
  assert.equal((await app.api.status()).state, "idle");
  await app.api.request("/api/recordings/start", { camera_ids: ["cam-a"] });
  app.document.hidden = true;
  app.listeners["doc:visibilitychange"]();
  for (let i = 0; i < 10 && (await app.api.status()).state === "stopping"; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await app.api.status()).state, "error");
  assert.match((await app.api.status()).error, /visible/);
});

test("buffer cap stops recording and reports clear error", async () => {
  const app = runtime();
  await app.api.request("/api/recordings/start", { camera_ids: ["cam-a"] });
  app.recorder().emit("dataavailable", { data: { size: 128 * 1024 * 1024 + 1, type: "video/webm" } });
  for (let i = 0; i < 10 && (await app.api.status()).state === "stopping"; i++) await new Promise((resolve) => setImmediate(resolve));
  const status = await app.api.status();
  assert.equal(status.state, "error");
  assert.match(status.error, /128 MiB/);
  assert.deepEqual(app.showcase.retention.slice(-1), [["cam-a", false]]);
});
