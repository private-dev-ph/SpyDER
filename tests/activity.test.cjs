const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function controller(saved = null, showcase = false, continuous = false) {
  const events = {};
  const requests = [];
  const control = {
    checked: true,
    addEventListener(name, fn) {
      events[name] = fn;
    },
  };
  const note = { classList: { add() {}, remove() {} } };
  const document = {
    visibilityState: "visible",
    focused: true,
    hasFocus() {
      return this.focused;
    },
    querySelector(selector) {
      return selector === "#release-idle" ? control : note;
    },
    addEventListener(name, fn) {
      events[name] = fn;
    },
  };
  const window = {
    spyder: { refresh() {} },
    addEventListener(name, fn) {
      events[name] = fn;
    },
  };
  if (showcase)
    window.spyderShowcase = {
      request: async (path, data) => requests.push({ path, data }),
    };
  const context = vm.createContext({
    window,
    document,
    crypto: require("node:crypto").webcrypto,
    AbortController,
    localStorage: { getItem: () => saved, setItem() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    fetch: async (path, options) => {
      assert.equal(showcase, false);
      requests.push({ path, data: JSON.parse(options.body), options });
      return { ok: true, json: async () => ({ idle_policy: !continuous }) };
    },
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "../src/spyder_cctv/assets/activity.js"),
      "utf8",
    ),
    context,
  );
  return { requests, events, document, control };
}
test("presence follows actual focus and visibility using guarded keepalive requests", async () => {
  const c = controller();
  assert.equal(c.requests[0].data.active, true);
  assert.equal(c.requests[0].options.headers["X-Spyder-Control"], "1");
  assert.equal(c.requests[0].options.keepalive, true);
  c.document.focused = false;
  await c.events.blur();
  assert.equal(c.requests.at(-1).data.active, false);
  c.document.focused = true;
  c.document.visibilityState = "hidden";
  await c.events.visibilitychange();
  assert.equal(c.requests.at(-1).data.active, false);
});
test("closing a pinned tab releases its lease and preference syncs across tabs", async () => {
  const c = controller("false");
  assert.equal(c.requests[0].data.release_when_idle, false);
  await c.events.pagehide();
  assert.equal(c.requests.at(-1).data.active, false);
  assert.equal(c.requests.at(-1).data.release_when_idle, true);
  await c.events.storage({ key: "spyder-release-idle", newValue: "true" });
  assert.equal(c.control.checked, true);
});
test("static showcase sends presence only to its in-browser adapter", () => {
  const c = controller(null, true);
  assert.equal(c.requests[0].path, "/api/presence");
  assert.equal(c.requests[0].data.active, true);
});

test("headless mode does not advertise an enabled camera-release control", async () => {
  const c = controller(null, false, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.control.disabled, true);
  assert.equal(c.control.checked, false);
});
