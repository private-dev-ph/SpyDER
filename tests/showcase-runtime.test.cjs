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
  {
    omitRoomLabel = false,
    permissionState = "granted",
    permissionQuery,
    ptz = false,
  } = {},
) {
  const elements = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let now = 0;
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
        if (omitRoomLabel && selector === ".room-label") return null;
        if (!elements.has(selector)) elements.set(selector, element());
        if (selector === "#browser-ptz") elements.get(selector).checked = ptz;
        return elements.get(selector);
      },
      createElement: element,
      createTextNode: (text) => ({ textContent: text }),
    },
    navigator: {
      permissions: {
        query: async (...args) =>
          permissionQuery
            ? permissionQuery(...args)
            : { state: permissionState },
      },
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
    performance: { now: () => now },
    setTimeout: (callback, delay = 0) => {
      const id = ++nextTimer;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
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
  window.spyderShowcase.advanceTimers = async (milliseconds) => {
    now += milliseconds;
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.due <= now)
      .sort((a, b) => a[1].due - b[1].due);
    for (const [id, timer] of due) {
      timers.delete(id);
      await timer.callback();
    }
    await Promise.resolve();
  };
  window.spyderShowcase.flushMicrotasks = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  window.spyderShowcase.setPermissionState = (state) => {
    permissionState = state;
  };
  window.spyderShowcase.flushIdle = async () => {
    await window.spyderShowcase.advanceTimers(2000);
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
  const listeners = new Map();
  return {
    stopped: false,
    value: 100,
    stop() {
      this.stopped = true;
    },
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    emit(name) {
      listeners.get(name)?.();
    },
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

test("showcase initializes with current markup that has no room label", async () => {
  const app = runtime(undefined, new Map(), undefined, { omitRoomLabel: true });
  const cameras = await list(app);
  assert.equal(cameras.length, 2);
  assert.ok(cameras.every((camera) => camera.state === "running"));
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

test("disconnected webcam reacquires only granted saved device and publishes a fresh capture session", async () => {
  const devices = [track(), track()];
  const constraints = [];
  let opens = 0;
  const app = runtime(async (options) => {
    constraints.push(options.video.deviceId);
    const device = devices[opens++];
    return { getTracks: () => [device], getVideoTracks: () => [device] };
  });
  const camera = await app.request("/api/cameras", cameraData);
  const first = (await list(app))[0];
  devices[0].emit("ended");
  await app.flushMicrotasks();
  let current = (await list(app)).find((entry) => entry.id === camera.id);
  assert.equal(current.state, "reconnecting");
  assert.deepEqual(current.reconnection, {
    enabled: true,
    attempt: 1,
    retry_in_seconds: 1,
    recoveries: 0,
  });
  await app.advanceTimers(1000);
  current = (await list(app)).find((entry) => entry.id === camera.id);
  assert.equal(current.state, "running");
  assert.equal(current.reconnection.recoveries, 1);
  assert.notEqual(current.capture_session, first.capture_session);
  assert.equal(devices[0].stopped, true);
  assert.deepEqual(JSON.parse(JSON.stringify(constraints)), [
    { exact: "one" },
    { exact: "one" },
  ]);
  await app.request(`/api/cameras/${camera.id}/stop`);
});

test("webcam reconnect backoff grows to thirty seconds and resets after stable frames", async () => {
  const devices = [track(), track(), track()];
  let opens = 0;
  const app = runtime(async () => {
    const index = opens++;
    if (index > 0 && index < 6)
      throw new DOMException("busy", "NotReadableError");
    return {
      getTracks: () => [devices[Math.min(index, 2)]],
      getVideoTracks: () => [devices[Math.min(index, 2)]],
    };
  });
  const camera = await app.request("/api/cameras", cameraData);
  devices[0].emit("ended");
  await app.flushMicrotasks();
  const delays = [1, 2, 4, 8, 16, 30];
  for (let i = 0; i < delays.length; i++) {
    const delay = delays[i];
    const pending = (await list(app)).find((entry) => entry.id === camera.id);
    assert.equal(pending.state, "reconnecting");
    assert.equal(pending.reconnection.retry_in_seconds, delay);
    if (delay === 2) {
      await app.advanceTimers(1000);
      const countdown = (await list(app)).find(
        (entry) => entry.id === camera.id,
      );
      assert.equal(countdown.reconnection.retry_in_seconds, 1);
      await app.advanceTimers(1000);
    } else await app.advanceTimers(delay * 1000);
    const after = (await list(app)).find((entry) => entry.id === camera.id);
    if (i + 1 < delays.length)
      assert.equal(after.reconnection.retry_in_seconds, delays[i + 1]);
  }
  let current = (await list(app)).find((entry) => entry.id === camera.id);
  assert.equal(current.state, "running");
  assert.equal(current.reconnection.recoveries, 1);
  await app.fetch(`/api/cameras/${camera.id}/frame`);
  await app.advanceTimers(30000);
  await app.fetch(`/api/cameras/${camera.id}/frame`);
  current = (await list(app)).find((entry) => entry.id === camera.id);
  assert.equal(current.reconnection.attempt, 0);
  await app.request(`/api/cameras/${camera.id}/stop`);
});

test("showcase does not retry when camera permission is not confirmed and stop cancels pending retry", async () => {
  const device = track();
  let opens = 0;
  const denied = runtime(
    async () => {
      opens++;
      return { getTracks: () => [device], getVideoTracks: () => [device] };
    },
    new Map(),
    undefined,
    { permissionState: "prompt" },
  );
  const camera = await denied.request("/api/cameras", cameraData);
  device.emit("ended");
  await denied.flushMicrotasks();
  const status = (await list(denied)).find((entry) => entry.id === camera.id);
  assert.equal(status.state, "error");
  await denied.advanceTimers(60000);
  assert.equal(opens, 1);

  const secondDevice = track();
  opens = 0;
  const allowed = runtime(async () => {
    opens++;
    return {
      getTracks: () => [secondDevice],
      getVideoTracks: () => [secondDevice],
    };
  });
  const second = await allowed.request("/api/cameras", cameraData);
  secondDevice.emit("ended");
  await allowed.flushMicrotasks();
  await allowed.request(`/api/cameras/${second.id}/stop`);
  await allowed.advanceTimers(60000);
  assert.equal(opens, 1);
  assert.equal(
    (await list(allowed)).find((entry) => entry.id === second.id).state,
    "stopped",
  );
});

test("permanent permission denial ends automatic retries", async () => {
  const device = track();
  let opens = 0;
  const app = runtime(async () => {
    if (opens++ === 0)
      return { getTracks: () => [device], getVideoTracks: () => [device] };
    throw new DOMException("revoked", "NotAllowedError");
  });
  const camera = await app.request("/api/cameras", cameraData);
  device.emit("ended");
  await app.flushMicrotasks();
  await app.advanceTimers(1000);
  const current = (await list(app)).find((entry) => entry.id === camera.id);
  assert.equal(current.state, "error");
  assert.equal(current.reconnection.enabled, false);
  assert.equal(current.reconnection.retry_in_seconds, null);
  await app.advanceTimers(60000);
  assert.equal(opens, 2);
});

test("revoked permission during backoff prevents automatic getUserMedia", async () => {
  const device = track();
  let opens = 0;
  const app = runtime(async () => {
    opens++;
    return { getTracks: () => [device], getVideoTracks: () => [device] };
  });
  const camera = await app.request("/api/cameras", cameraData);
  device.emit("ended");
  await app.flushMicrotasks();
  app.setPermissionState("prompt");
  await app.advanceTimers(1000);
  const current = (await list(app)).find((entry) => entry.id === camera.id);
  assert.equal(opens, 1);
  assert.equal(current.state, "error");
  assert.equal(current.reconnection.enabled, false);
});

test("manual stop during pending ended permission check stays stopped", async () => {
  const device = track();
  let resolvePermission;
  const app = runtime(
    async () => ({ getTracks: () => [device], getVideoTracks: () => [device] }),
    new Map(),
    undefined,
    {
      permissionQuery: () =>
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
    },
  );
  const camera = await app.request("/api/cameras", cameraData);
  device.emit("ended");
  await app.flushMicrotasks();
  assert.equal(typeof resolvePermission, "function");
  await app.request(`/api/cameras/${camera.id}/stop`);
  resolvePermission({ state: "prompt" });
  await app.flushMicrotasks();
  const current = (await list(app)).find((entry) => entry.id === camera.id);
  assert.equal(current.state, "stopped");
  assert.equal(current.error, null);
  assert.equal(current.reconnection.enabled, false);
});

test("pending automatic permission check blocks duplicate opens and cancels after removal", async () => {
  const device = track();
  let opens = 0;
  let permissionCalls = 0;
  let resolveRetryPermission;
  const app = runtime(
    async () => {
      opens++;
      return { getTracks: () => [device], getVideoTracks: () => [device] };
    },
    new Map(),
    undefined,
    {
      permissionQuery: () => {
        permissionCalls++;
        if (permissionCalls === 1) return { state: "granted" };
        return new Promise((resolve) => {
          resolveRetryPermission = resolve;
        });
      },
    },
  );
  const camera = await app.request("/api/cameras", cameraData);
  device.emit("ended");
  await app.flushMicrotasks();
  const opening = app.advanceTimers(1000);
  await app.flushMicrotasks();
  assert.equal(permissionCalls, 2);
  await app.request(`/api/cameras/${camera.id}/start`);
  assert.equal(opens, 1);
  await app.request(`/api/cameras/${camera.id}/remove`);
  resolveRetryPermission({ state: "granted" });
  await opening;
  await app.flushMicrotasks();
  assert.equal(opens, 1);
  assert.equal(
    (await list(app)).some((entry) => entry.id === camera.id),
    false,
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

test("recording state appears in camera status and manual pause is blocked until release", async () => {
  const app = runtime();
  const camera = (await list(app))[0];
  await app.setRecording(camera.id, true);
  assert.equal(
    (await list(app)).find((entry) => entry.id === camera.id).recording,
    true,
  );
  await assert.rejects(
    app.request(`/api/cameras/${camera.id}/stop`),
    /Remove this camera from recording/,
  );
  await app.setRecording(camera.id, false);
  assert.equal(
    (await list(app)).find((entry) => entry.id === camera.id).recording,
    false,
  );
  await app.request(`/api/cameras/${camera.id}/stop`);
});

test("failed recording start rolls back the recording flag", async () => {
  const app = runtime(async () => {
    throw new DOMException("denied", "NotAllowedError");
  });
  const camera = await app.request("/api/cameras", cameraData);
  assert.equal(camera.state, "error");
  await assert.rejects(app.setRecording(camera.id, true), /permission denied/);
  assert.equal(
    (await list(app)).find((entry) => entry.id === camera.id).recording,
    false,
  );
});

test("frame source shares pending and cached JPEG work", async () => {
  let encodes = 0;
  let finish;
  const app = runtime(undefined, new Map(), (callback) => {
    encodes++;
    finish = callback;
  });
  const camera = (await list(app))[0];
  const one = app.getFrameSource(camera.id);
  const two = app.getFrameSource(camera.id);
  await Promise.resolve();
  assert.equal(encodes, 1);
  finish(new Blob(["jpeg"], { type: "image/jpeg" }));
  assert.equal(await one, await two);
  await app.getFrameSource(camera.id);
  assert.equal(encodes, 1);
});

test("PTZ reconnect checks PTZ permission without requesting access again", async () => {
  const device = track();
  const descriptors = [];
  let opens = 0;
  const app = runtime(
    async () => {
      opens++;
      return { getTracks: () => [device], getVideoTracks: () => [device] };
    },
    new Map(),
    undefined,
    {
      ptz: true,
      permissionQuery: (descriptor) => {
        descriptors.push(JSON.parse(JSON.stringify(descriptor)));
        return { state: descriptor.panTiltZoom ? "prompt" : "granted" };
      },
    },
  );
  const camera = await app.request("/api/cameras", {
    ...cameraData,
    ptz: true,
  });
  device.emit("ended");
  await app.flushMicrotasks();
  await app.advanceTimers(60000);
  assert.deepEqual(descriptors, [{ name: "camera", panTiltZoom: true }]);
  assert.equal(opens, 1);
  assert.equal(
    (await list(app)).find((c) => c.id === camera.id).state,
    "error",
  );
});
