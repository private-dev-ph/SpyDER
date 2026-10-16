const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function controller({
  legacy = null,
  mirror = null,
  showcase = false,
  configured = true,
  preference = true,
  rejectSave = false,
  rejectGet = false,
  continuous = false,
} = {}) {
  const listeners = { window: {}, document: {} };
  const requests = [];
  const timers = [];
  const intervals = [];
  const activeTimers = new Set();
  const activeIntervals = new Set();
  let nextGet = null;
  const values = new Map();
  if (legacy !== null) values.set("spyder-release-idle", legacy);
  if (mirror !== null) values.set("spyder-pause-unfocused", mirror);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const controls = new Map();
  function control(selector) {
    if (!controls.has(selector))
      controls.set(selector, {
        checked: true,
        disabled: false,
        matches: (query) => query.includes(selector),
      });
    return controls.get(selector);
  }
  const note = { textContent: "", classList: { add() {}, remove() {} } };
  const document = {
    visibilityState: "visible",
    focused: true,
    hasFocus() {
      return this.focused;
    },
    querySelector(selector) {
      if (selector === "#activity-note") return note;
      return control(selector);
    },
    addEventListener(name, fn) {
      listeners.document[name] = fn;
    },
  };
  const window = {
    spyder: { refresh() {} },
    addEventListener(name, fn) {
      listeners.window[name] = fn;
    },
    dispatchEvent() {},
  };
  const server = { preference, configured };
  const context = vm.createContext({
    window,
    document,
    crypto: require("node:crypto").webcrypto,
    AbortController,
    AbortSignal,
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    localStorage: storage,
    setTimeout(fn) {
      timers.push(fn);
      activeTimers.add(timers.length);
      return timers.length;
    },
    clearTimeout(id) {
      activeTimers.delete(id);
    },
    setInterval(fn) {
      intervals.push(fn);
      activeIntervals.add(intervals.length);
      return intervals.length;
    },
    clearInterval(id) {
      activeIntervals.delete(id);
    },
    fetch: async (url, options = {}) => {
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method, body, options });
      if (url === "/api/preferences") {
        if (method === "GET" && rejectGet)
          return { ok: false, json: async () => ({}) };
        if (method === "GET" && nextGet) {
          const held = nextGet;
          nextGet = null;
          const snapshot = {
            pause_when_unfocused: server.preference,
            configured: server.configured,
            storage_error: null,
          };
          return new Promise((resolve) => {
            held(() => resolve({ ok: true, json: async () => snapshot }));
          });
        }
        if (method === "POST") {
          if (rejectSave) return { ok: false, json: async () => ({}) };
          server.preference = body.pause_when_unfocused;
          server.configured = true;
        }
        return {
          ok: true,
          json: async () => ({
            pause_when_unfocused: server.preference,
            configured: server.configured,
            storage_error: null,
          }),
        };
      }
      return { ok: true, json: async () => ({ idle_policy: !continuous }) };
    },
  });
  if (showcase)
    window.spyderShowcase = {
      request: async (url, data) =>
        requests.push({ url, method: "SHOWCASE", body: data }),
    };
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "../src/spyder_cctv/assets/activity.js"),
      "utf8",
    ),
    context,
  );
  return {
    requests,
    listeners,
    document,
    controls,
    note,
    values,
    server,
    timers,
    intervals,
    activeTimers,
    activeIntervals,
    deferNextGet: (callback) => (nextGet = callback),
    activity: window.spyderActivity,
  };
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

test("server preference loads on startup and survives reload over stale mirror", async () => {
  const first = controller({ mirror: "true", preference: false });
  assert.equal(first.controls.get("#release-idle").disabled, true);
  await flush();
  assert.equal(first.activity.getState().pause_when_unfocused, false);
  assert.equal(first.controls.get("#release-idle").checked, false);
  assert.equal(first.values.get("spyder-pause-unfocused"), "false");
  const reload = controller({ mirror: "true", preference: false });
  await flush();
  assert.equal(reload.controls.get("#release-idle").checked, false);
  assert.equal(
    reload.requests.some(
      (r) => r.url === "/api/preferences" && r.method === "POST",
    ),
    false,
  );
});

test("legacy false migrates only when server preference remains unconfigured", async () => {
  const migrate = controller({
    legacy: "false",
    configured: false,
    preference: true,
  });
  await flush();
  assert.equal(
    migrate.requests.filter(
      (r) => r.url === "/api/preferences" && r.method === "POST",
    ).length,
    1,
  );
  assert.equal(migrate.activity.getState().pause_when_unfocused, false);
  const serverWins = controller({
    legacy: "false",
    configured: true,
    preference: true,
  });
  await flush();
  assert.equal(serverWins.activity.getState().pause_when_unfocused, true);
  assert.equal(
    serverWins.requests.some(
      (r) => r.url === "/api/preferences" && r.method === "POST",
    ),
    false,
  );
});

test("focus and visibility publish pause policy; turning pause off sends false", async () => {
  const c = controller();
  await flush();
  assert.equal(
    c.requests.find((r) => r.url === "/api/presence").body.active,
    true,
  );
  c.document.focused = false;
  await c.listeners.window.blur();
  assert.equal(
    c.requests.filter((r) => r.url === "/api/presence").at(-1).body.active,
    false,
  );
  const change = c.listeners.document.change;
  await change({
    target: { matches: (q) => q.includes("#release-idle"), checked: false },
  });
  await flush();
  const save = c.requests.find(
    (r) => r.url === "/api/preferences" && r.method === "POST",
  );
  assert.deepEqual(save.body, { pause_when_unfocused: false });
  assert.equal(
    c.requests.filter((r) => r.url === "/api/presence").at(-1).body
      .release_when_idle,
    false,
  );
});

test("failed save restores prior value and surfaces a message", async () => {
  const c = controller({ rejectSave: true });
  await flush();
  await c.listeners.document.change({
    target: { matches: (q) => q.includes("#release-idle"), checked: false },
  });
  await flush();
  assert.equal(c.controls.get("#release-idle").checked, true);
  assert.match(c.note.textContent, /Could not save/);
  assert.equal(c.controls.get("#release-idle").disabled, false);
});

test("preference poll ignores a response started before local mutation", async () => {
  const c = controller();
  await flush();
  c.server.preference = true;
  let resolve;
  c.deferNextGet((done) => (resolve = done));
  await c.listeners.window.storage({
    key: "spyder-pause-unfocused",
    newValue: "true",
  });
  await Promise.resolve();
  await c.listeners.document.change({
    target: { matches: (q) => q.includes("#release-idle"), checked: false },
  });
  await flush();
  resolve();
  await flush();
  assert.equal(c.activity.getState().pause_when_unfocused, false);
});

test("cross-tab changes refresh authoritative server policy", async () => {
  const c = controller();
  await flush();
  c.server.preference = false;
  await c.listeners.window.storage({
    key: "spyder-pause-unfocused",
    newValue: "true",
  });
  await flush();
  assert.equal(c.activity.getState().pause_when_unfocused, false);
  assert.equal(c.controls.get("#release-idle").checked, false);
});

test("showcase uses browser storage and presence adapter without preference API calls", async () => {
  const c = controller({ showcase: true, legacy: "false" });
  assert.equal(
    c.requests.some((r) => r.url === "/api/preferences"),
    false,
  );
  assert.equal(c.requests[0].url, "/api/presence");
  await c.listeners.document.change({
    target: { matches: (q) => q.includes("#release-idle"), checked: false },
  });
  await flush();
  assert.equal(
    c.requests.some((r) => r.url === "/api/preferences"),
    false,
  );
  assert.equal(c.values.get("spyder-pause-unfocused"), "false");
});

test("pagehide releases lease and schedules no further heartbeat", async () => {
  const c = controller();
  await flush();
  const before = c.requests.filter((r) => r.url === "/api/presence").length;
  await c.listeners.window.pagehide();
  await flush();
  assert.equal(
    c.requests.filter((r) => r.url === "/api/presence").at(-1).body
      .release_when_idle,
    true,
  );
  assert.equal(
    c.requests.filter((r) => r.url === "/api/presence").length,
    before + 1,
  );
  assert.equal(c.activeTimers.size, 0);
  assert.equal(c.activeIntervals.size, 0);
});

test("unavailable preferences keep controls disabled and use safe release default", async () => {
  const c = controller({ rejectGet: true });
  await flush();
  assert.equal(c.controls.get("#release-idle").disabled, true);
  const presence = c.requests.find((r) => r.url === "/api/presence");
  assert.equal(presence.body.release_when_idle, true);
});

test("continuous server mode keeps pause controls disabled and accurately labelled", async () => {
  const c = controller({ continuous: true });
  await flush();
  assert.equal(c.controls.get("#release-idle").disabled, true);
  assert.equal(c.controls.get("#release-idle").checked, false);
  assert.equal(c.activity.getState().continuous, true);
  assert.match(c.note.textContent, /Continuous server mode/);
});
