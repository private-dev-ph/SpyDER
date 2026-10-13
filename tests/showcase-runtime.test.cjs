const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function runtime(
  getUserMedia = async () => {
    throw new Error("No device");
  },
  storage = new Map(),
  encode = (callback) => callback(new Blob(["jpeg"], { type: "image/jpeg" })),
) {
  const elements = new Map();
  const idleCallbacks = new Set();
  function element() {
    return {
      value: "demo",
      checked: false,
      options: [],
      nextElementSibling: {},
      after() {},
      append(...items) {
        this.options.push(...items);
      },
      replaceChildren(...items) {
        this.options = items;
      },
      setAttribute() {},
      addEventListener() {},
      pause() {},
      load() {},
      removeAttribute() {},
      remove() {},
      play: async () => {},
      readyState: 2,
      videoWidth: 640,
      videoHeight: 360,
      getContext: () => ({
        fillRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        arc() {},
        fill() {},
        fillText() {},
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(80 * 45 * 4) }),
      }),
      toBlob: encode,
    };
  }
  const window = { addEventListener() {} };
  const context = vm.createContext({
    window,
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
      },
      createElement: element,
      createTextNode: (text) => ({ textContent: text }),
    },
    navigator: {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: async () => [],
        addEventListener() {},
      },
    },
    localStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
    },
    Option: function (text, value) {
      this.text = text;
      this.value = value;
    },
    Response,
    Blob,
    File,
    URL,
    DOMException,
    crypto: require("node:crypto").webcrypto,
    performance,
    setTimeout: (callback) => {
      idleCallbacks.add(callback);
      return callback;
    },
    clearTimeout: (callback) => idleCallbacks.delete(callback),
    Uint8ClampedArray,
    fetch: () => {
      throw new Error("Network access forbidden");
    },
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "../src/spyder_cctv/assets/showcase.js"),
      "utf8",
    ),
    context,
  );
  window.spyderShowcase.flushIdle = async () => {
    for (const callback of idleCallbacks) callback();
    idleCallbacks.clear();
    await Promise.resolve();
  };
  return window.spyderShowcase;
}
const list = async (app) => (await app.fetch("/api/cameras")).json();
const cameraData = {
  name: "Test camera",
  source: "device:one",
  fps: 10,
  pipeline: "motion",
  autostart: true,
};
function track() {
  return {
    stopped: false,
    value: 100,
    stop() {
      this.stopped = true;
    },
    addEventListener() {},
    getCapabilities: () => ({ zoom: { min: 100, max: 500, step: 1 } }),
    getSettings() {
      return { deviceId: "one", zoom: this.value };
    },
    async applyConstraints(value) {
      this.value = value.advanced[0].zoom;
    },
  };
}

test("two generated feeds run, encode locally, and unsupported controls stay disabled", async () => {
  const app = runtime();
  const cameras = await list(app);
  assert.equal(cameras.length, 2);
  assert.ok(cameras.every((c) => c.state === "running"));
  const response = await app.fetch(`/api/cameras/${cameras[0].id}/frame`);
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
  assert.ok((await response.blob()).size > 0);
  const settings = await (
    await app.fetch(`/api/cameras/${cameras[0].id}/settings`)
  ).json();
  assert.equal(settings.capabilities.zoom.supported, false);
  await app.request(`/api/cameras/${cameras[0].id}/remove`);
  assert.equal((await list(app)).length, 1);
});

test("hardware readback, profile persistence, assignment, detach, and cleanup", async () => {
  const device = track();
  const storage = new Map();
  const app = runtime(
    async () => ({ getTracks: () => [device], getVideoTracks: () => [device] }),
    storage,
  );
  const camera = await app.request("/api/cameras", cameraData);
  const profile = await app.request("/api/profiles", {
    name: "Zoom preset",
    settings: { zoom: 25 },
  });
  const settings = await app.request(`/api/cameras/${camera.id}/profile`, {
    profile_id: profile.id,
  });
  assert.equal(device.value, 200);
  assert.equal(settings.results.zoom.status, "applied");
  await assert.rejects(
    app.request(`/api/profiles/${profile.id}/remove`),
    /Detach/,
  );
  const restored = runtime(undefined, storage);
  assert.equal(
    (await (await restored.fetch("/api/profiles")).json())[0].name,
    "Zoom preset",
  );
  await app.request(`/api/cameras/${camera.id}/profile`, { profile_id: null });
  await app.request(`/api/profiles/${profile.id}/remove`);
  await app.request(`/api/cameras/${camera.id}/stop`);
  assert.equal(device.stopped, true);
});

test("removing a camera during a pending permission prompt releases late tracks", async () => {
  let resolve;
  const device = track();
  const app = runtime(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const adding = app.request("/api/cameras", cameraData);
  const camera = (await list(app)).find((c) => c.name === "Test camera");
  await app.request(`/api/cameras/${camera.id}/remove`);
  resolve({ getTracks: () => [device], getVideoTracks: () => [device] });
  await adding;
  assert.equal(device.stopped, true);
  assert.equal((await list(app)).length, 2);
});

test("permission denial is recoverable and remote sources never open", async () => {
  const app = runtime(async () => {
    throw new DOMException("denied", "NotAllowedError");
  });
  const camera = await app.request("/api/cameras", cameraData);
  assert.equal(camera.state, "error");
  assert.match(camera.error, /permission denied/);
  await assert.rejects(
    app.request("/api/cameras", {
      ...cameraData,
      source: "https://example.com/video",
    }),
    /Remote URLs/,
  );
  await assert.rejects(
    app.request("/api/profiles", { name: "Bad", settings: { zoom: 101 } }),
    /between 0 and 100/,
  );
});

test("pausing during JPEG encoding discards the late frame", async () => {
  let finish;
  const app = runtime(undefined, new Map(), (callback) => {
    finish = callback;
  });
  const camera = (await list(app))[0];
  const frame = app.fetch(`/api/cameras/${camera.id}/frame`);
  await app.request(`/api/cameras/${camera.id}/stop`);
  finish(new Blob(["late jpeg"], { type: "image/jpeg" }));
  await assert.rejects(frame, /stopped while encoding/);
  assert.equal((await list(app))[0].state, "stopped");
});

test("idle presence releases owned tracks and restores only policy-paused cameras", async () => {
  const devices = [];
  const app = runtime(async () => {
    const device = track();
    devices.push(device);
    return { getTracks: () => [device], getVideoTracks: () => [device] };
  });
  const camera = await app.request("/api/cameras", cameraData);
  const manuallyPaused = (await list(app))[0];
  await app.request(`/api/cameras/${manuallyPaused.id}/stop`);
  await app.request("/api/presence", {
    active: false,
    release_when_idle: true,
  });
  await app.flushIdle();
  assert.equal(devices[0].stopped, true);
  assert.equal(
    (await list(app)).find((c) => c.id === camera.id).idle_suspended,
    true,
  );
  await app.request("/api/presence", { active: true, release_when_idle: true });
  assert.equal(
    (await list(app)).find((c) => c.id === camera.id).state,
    "running",
  );
  assert.equal(
    (await list(app)).find((c) => c.id === manuallyPaused.id).state,
    "stopped",
  );
  await app.request(`/api/cameras/${camera.id}/remove`);
});

test("recording retention exempts only its camera and disabling release keeps feeds", async () => {
  const app = runtime();
  const [first, second] = await list(app);
  await app.setRecording(first.id, true);
  await app.request("/api/presence", {
    active: false,
    release_when_idle: true,
  });
  await app.flushIdle();
  assert.equal(
    (await list(app)).find((c) => c.id === first.id).state,
    "running",
  );
  assert.equal(
    (await list(app)).find((c) => c.id === second.id).idle_suspended,
    true,
  );
  await app.setRecording(first.id, false);
  assert.ok((await list(app)).every((c) => c.state === "stopped"));
  await app.request("/api/presence", {
    active: false,
    release_when_idle: false,
  });
  assert.ok((await list(app)).every((c) => c.state === "running"));
});
