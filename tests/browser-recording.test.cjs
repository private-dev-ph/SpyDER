const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

class FakeRecorder {
  static supported = ["video/webm;codecs=vp8"];
  static isTypeSupported(type) {
    return this.supported.includes(type);
  }
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
  start(timeslice) {
    this.timeslice = timeslice;
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.emit("dataavailable", {
      data: new Blob(["video"], { type: this.mimeType }),
    });
    this.emit("stop");
  }
}

function runtime({
  recorder = FakeRecorder,
  sourceState = "running",
  fetchFailure = false,
  sourceWidth = 640,
  sourceHeight = 360,
  captureBlobSize,
} = {}) {
  const listeners = {};
  const revoked = [];
  const stoppedTracks = [];
  let downloadClicks = 0;
  const sourceCanvas = { width: sourceWidth, height: sourceHeight };
  const sourceIds = new Set(["cam-a", "cam-b"]);
  let intervalCallback;
  const canvases = [];
  function makeCanvas() {
    const result = {
      width: 0,
      height: 0,
      draws: [],
      clicks: 0,
      getContext: () => ({
        fillRect() {},
        fillText() {},
        drawImage(...args) {
          result.draws.push(args);
        },
      }),
      captureStream(fps) {
        result.captureFps = fps;
        return { getTracks: () => [{ stop: () => stoppedTracks.push(true) }] };
      },
      toBlob(callback, type) {
        const blob = new Blob(["jpeg"], { type });
        if (captureBlobSize !== undefined)
          Object.defineProperty(blob, "size", { value: captureBlobSize });
        callback(blob);
      },
    };
    canvases.push(result);
    return result;
  }
  const document = {
    hidden: false,
    createElement(tag) {
      if (tag === "canvas") return makeCanvas();
      return {
        click() {
          downloadClicks++;
        },
      };
    },
    addEventListener(name, fn) {
      listeners[`doc:${name}`] = fn;
    },
  };
  const cameraData = [...sourceIds].map((id) => ({ id, state: sourceState }));
  const showcase = {
    async fetch(path) {
      if (fetchFailure) throw new Error("network forbidden");
      assert.equal(path, "/api/cameras");
      return {
        json: async () =>
          cameraData.filter((camera) => sourceIds.has(camera.id)),
      };
    },
    async getFrameSource(id) {
      if (!sourceIds.has(id) || sourceState !== "running")
        throw new Error("offline");
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
    addEventListener(name, fn) {
      listeners[`win:${name}`] = fn;
    },
  };
  const context = vm.createContext({
    window,
    document,
    MediaRecorder: recorder,
    Blob,
    URL: {
      createObjectURL: () => `blob:${Math.random()}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
    crypto: require("node:crypto").webcrypto,
    Date,
    Math,
    Set,
    Promise,
    setInterval: (fn, ms) => {
      intervalCallback = fn;
      return { fn, ms };
    },
    clearInterval() {},
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "../src/spyder_cctv/assets/browser-recording.js"),
      "utf8",
    ),
    context,
  );
  return {
    api: window.spyderBrowserMedia,
    showcase,
    canvas: canvases[0],
    canvases,
    document,
    listeners,
    revoked,
    stoppedTracks,
    recorder: () => recorder?.last,
    sourceIds,
    tick: () => intervalCallback?.(),
    downloadClicks: () => downloadClicks,
  };
}

test("records local tiled canvas with selected cameras and chosen browser MIME", async () => {
  const app = runtime();
  const status = await app.api.request("/api/recordings/start", {
    camera_ids: ["cam-a", "cam-b"],
  });
  assert.equal(status.state, "recording");
  assert.deepEqual(Array.from(status.camera_ids), ["cam-a", "cam-b"]);
  assert.equal(status.width, 1920);
  assert.equal(status.height, 1080);
  assert.equal(status.fps, 15);
  assert.equal(app.canvas.captureFps, 15);
  assert.deepEqual(app.showcase.retention, [
    ["cam-a", true],
    ["cam-b", true],
  ]);
  await app.api.request("/api/recordings/stop");
  const done = await app.api.status();
  assert.equal(done.state, "idle");
  assert.equal(done.items[0].kind, "recording");
  assert.match(done.items[0].filename, /\.webm$/);
  assert.equal(done.items[0].size_bytes, 5);
  assert.deepEqual(app.showcase.retention.slice(-2), [
    ["cam-a", false],
    ["cam-b", false],
  ]);
  assert.equal(app.stoppedTracks.length, 1);
});

test("selection changes release removed retention and zero selection stops recording", async () => {
  const app = runtime();
  await app.api.request("/api/recordings/start", {
    camera_ids: ["cam-a", "cam-b"],
  });
  await app.api.request("/api/recordings/cameras", { camera_ids: ["cam-b"] });
  assert.deepEqual(Array.from((await app.api.status()).camera_ids), ["cam-b"]);
  assert.deepEqual(app.showcase.retention.slice(-1), [["cam-a", false]]);
  const done = await app.api.request("/api/recordings/cameras", {
    camera_ids: [],
  });
  assert.equal(done.state, "idle");
  assert.equal(done.camera_ids.length, 0);
});

test("selection acquisition failure rolls back additions and keeps prior selection", async () => {
  const app = runtime();
  await app.api.request("/api/recordings/start", { camera_ids: ["cam-a"] });
  const setRecording = app.showcase.setRecording;
  app.showcase.setRecording = async (id, active) => {
    if (id === "cam-b" && active) throw new Error("new camera failed");
    return setRecording(id, active);
  };
  await assert.rejects(
    app.api.request("/api/recordings/cameras", { camera_ids: ["cam-b"] }),
    /new camera failed/,
  );
  assert.deepEqual(Array.from((await app.api.status()).camera_ids), ["cam-a"]);
  assert.deepEqual(app.showcase.retention, [["cam-a", true]]);
  await app.api.request("/api/recordings/stop");
});

test("unsupported and failed starts release retained cameras", async () => {
  class Unsupported {
    static isTypeSupported() {
      return false;
    }
  }
  const unsupported = runtime({ recorder: null });
  await assert.rejects(
    unsupported.api.request("/api/recordings/start", { camera_ids: ["cam-a"] }),
    /cannot record/,
  );
  const broken = runtime({
    recorder: class {
      constructor() {
        throw new Error("constructor failed");
      }
    },
  });
  await assert.rejects(
    broken.api.request("/api/recordings/start", { camera_ids: ["cam-a"] }),
    /constructor failed/,
  );
  assert.deepEqual(broken.showcase.retention, [
    ["cam-a", true],
    ["cam-a", false],
  ]);
  assert.ok(Unsupported);
});

test("captures raw JPEG on separate canvas without downloading or touching active recording", async () => {
  const app = runtime();
  await app.api.request("/api/recordings/start", { camera_ids: ["cam-a"] });
  const drawsBefore = app.canvas.draws.length;
  const framesBefore = (await app.api.status()).frames;
  const result = await app.api.request("/api/captures", {
    camera_ids: ["cam-a"],
  });
  assert.equal(result.kind, "capture");
  assert.match(result.filename, /\.jpg$/);
  assert.equal(result.size_bytes, 4);
  assert.equal(app.canvas.width, 1920);
  assert.equal(app.canvases[1].width, 640);
  assert.equal(app.canvases[1].height, 360);
  assert.equal(app.canvas.draws.length, drawsBefore);
  assert.equal((await app.api.status()).frames, framesBefore);
  assert.equal(app.downloadClicks(), 0);
  assert.deepEqual(app.showcase.retention, [["cam-a", true]]);
  await app.api.request("/api/recordings/stop");
  const items = (await app.api.status()).items;
  assert.deepEqual(
    Array.from(items, (item) => item.kind),
    ["recording", "capture"],
  );
});

test("multi-camera capture preserves aspect ratio in 1080p layout", async () => {
  const app = runtime();
  const result = await app.api.request("/api/captures", {
    camera_ids: ["cam-a", "cam-b"],
  });
  assert.equal(result.kind, "capture");
  assert.equal(app.canvases[1].width, 1920);
  assert.equal(app.canvases[1].draws[0][1], 0);
  assert.equal(app.canvases[1].draws[0][2], 270);
  assert.equal(app.canvases[1].draws[0][3], 960);
  assert.equal(app.canvases[1].draws[0][4], 540);
  assert.equal(app.canvases[1].draws[1][1], 960);
  assert.equal(app.canvases[1].draws[1][2], 270);
  assert.equal(app.canvases[1].draws[1][3], 960);
  assert.equal(app.canvases[1].draws[1][4], 540);
});

test("concurrent starts reject duplicate recording and starts during stop", async () => {
  const app = runtime();
  const starts = await Promise.allSettled([
    app.api.request("/api/recordings/start", { camera_ids: ["cam-a"] }),
    app.api.request("/api/recordings/start", { camera_ids: ["cam-b"] }),
  ]);
  assert.equal(
    starts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    starts.filter((result) => result.status === "rejected").length,
    1,
  );
  class DelayedStop extends FakeRecorder {
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      setImmediate(() => {
        this.emit("dataavailable", {
          data: new Blob(["video"], { type: this.mimeType }),
        });
        this.emit("stop");
      });
    }
  }
  const delayed = runtime({ recorder: DelayedStop });
  await delayed.api.request("/api/recordings/start", { camera_ids: ["cam-a"] });
  const stopping = delayed.api.request("/api/recordings/stop");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    delayed.api.request("/api/recordings/start", { camera_ids: ["cam-b"] }),
    /active or stopping/,
  );
  await stopping;
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
  await assert.rejects(
    offline.api.request("/api/captures", { camera_ids: ["cam-a"] }),
    /offline/,
  );
});

test("status starts idle and page visibility ends recording", async () => {
  const app = runtime();
  assert.equal((await app.api.status()).state, "idle");
  await app.api.request("/api/recordings/start", { camera_ids: ["cam-a"] });
  app.document.hidden = true;
  app.listeners["doc:visibilitychange"]();
  for (let i = 0; i < 10 && (await app.api.status()).state === "stopping"; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await app.api.status()).state, "error");
  assert.match((await app.api.status()).error, /visible/);
});

test("buffer cap stops recording and reports clear error", async () => {
  const app = runtime();
  await app.api.request("/api/recordings/start", { camera_ids: ["cam-a"] });
  app.recorder().emit("dataavailable", {
    data: { size: 128 * 1024 * 1024 + 1, type: "video/webm" },
  });
  for (let i = 0; i < 10 && (await app.api.status()).state === "stopping"; i++)
    await new Promise((resolve) => setImmediate(resolve));
  const status = await app.api.status();
  assert.equal(status.state, "error");
  assert.match(status.error, /128 MiB/);
  assert.deepEqual(app.showcase.retention.slice(-1), [["cam-a", false]]);
});

test("capture rejects when estimated blob would exceed local buffer cap", async () => {
  const app = runtime({ sourceWidth: 6000, sourceHeight: 6000 });
  await assert.rejects(
    app.api.request("/api/captures", { camera_ids: ["cam-a"] }),
    /insufficient space/,
  );
  assert.equal((await app.api.status()).items.length, 0);
});

test("saved media items count against shared local buffer cap", async () => {
  const app = runtime({ captureBlobSize: 128 * 1024 * 1024 });
  await app.api.request("/api/captures", {
    camera_ids: ["cam-a"],
  });
  await assert.rejects(
    app.api.request("/api/recordings/start", { camera_ids: ["cam-a"] }),
    /Download items and reload/,
  );
  await assert.rejects(
    app.api.request("/api/captures", { camera_ids: ["cam-a"] }),
    /Download items and reload/,
  );
});

test("visibility change during camera startup rolls back recording retention", async () => {
  const app = runtime();
  const original = app.showcase.setRecording;
  app.showcase.setRecording = async (id, active) => {
    await original(id, active);
    if (active) app.document.hidden = true;
  };
  await assert.rejects(
    app.api.request("/api/recordings/start", { camera_ids: ["cam-a"] }),
    /visible/,
  );
  assert.deepEqual(app.showcase.retention, [
    ["cam-a", true],
    ["cam-a", false],
  ]);
});

test("an overflowing final chunk is reported even during a requested stop", async () => {
  class OverflowStop extends FakeRecorder {
    stop() {
      this.state = "inactive";
      this.emit("dataavailable", {
        data: { size: 128 * 1024 * 1024 + 1, type: this.mimeType },
      });
      this.emit("stop");
    }
  }
  const app = runtime({ recorder: OverflowStop });
  await app.api.request("/api/recordings/start", { camera_ids: ["cam-a"] });
  app
    .recorder()
    .emit("dataavailable", {
      data: new Blob(["partial"], { type: "video/webm" }),
    });
  const result = await app.api.request("/api/recordings/stop");
  assert.equal(result.state, "error");
  assert.match(result.error, /incomplete/);
  assert.equal(result.items.length, 1);
  assert.deepEqual(app.showcase.retention, [
    ["cam-a", true],
    ["cam-a", false],
  ]);
});

test("a late frame from a stopped session cannot overwrite the next recording", async () => {
  const app = runtime();
  await app.api.request("/api/recordings/start", { camera_ids: ["cam-a"] });
  const original = app.showcase.getFrameSource;
  let resolveFrame;
  let first = true;
  app.showcase.getFrameSource = (id) => {
    if (first) {
      first = false;
      return new Promise((resolve) => {
        resolveFrame = resolve;
      });
    }
    return original(id);
  };
  const pending = app.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await app.api.request("/api/recordings/stop");
  await app.api.request("/api/recordings/start", { camera_ids: ["cam-b"] });
  const draws = app.canvas.draws.length;
  resolveFrame({ width: 640, height: 360 });
  await pending;
  assert.equal(app.canvas.draws.length, draws);
  assert.deepEqual(Array.from((await app.api.status()).camera_ids), ["cam-b"]);
  await app.api.request("/api/recordings/stop");
});
