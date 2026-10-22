const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(
  require("node:path").join(__dirname, "../src/spyder_cctv/assets/device-tools.js"),
  "utf8",
);
function harness(showcase = false) {
  const listeners = {};
  let fetches = 0;
  const buttons = [{ disabled: false }, { disabled: false }];
  function host() {
    return {
      dataset: {},
      classList: { add() {} },
      set innerHTML(value) { this.html = value; },
      get innerHTML() { return this.html; },
      addEventListener(name, fn) { listeners[name] = fn; },
      querySelectorAll() { return buttons; },
      querySelector() { return { textContent: "", dataset: {}, replaceChildren() {} }; },
    };
  }
  const hosts = {
    "face-gallery-tools": host(),
    "onvif-camera-tools": host(),
  };
  const window = { spyderShowcase: showcase, addEventListener() {}, dispatchEvent() {} };
  const context = vm.createContext({
    window,
    document: {
      readyState: "complete",
      documentElement: {},
      getElementById: (id) => hosts[id],
      addEventListener() {},
      createElement: () => ({ className: "", innerHTML: "", addEventListener() {}, showModal() {} }),
      body: { append() {} },
    },
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn(); } },
    fetch: () => { fetches++; throw Error("unexpected network"); },
    CustomEvent: class {},
    URL,
    Blob,
    FormData: class {},
    prompt() {},
    confirm() {},
  });
  vm.runInContext(source, context);
  return { hosts, buttons, get fetches() { return fetches; } };
}

test("mounts face and ONVIF panels without making API requests", () => {
  const app = harness(false);
  assert.match(app.hosts["face-gallery-tools"].innerHTML, /Face enrollment/);
  assert.match(app.hosts["onvif-camera-tools"].innerHTML, /ONVIF discovery and PTZ/);
  assert.equal(app.fetches, 0);
});

test("showcase mode disables actions and never contacts APIs", () => {
  const app = harness(true);
  assert.equal(app.fetches, 0);
  assert.ok(app.buttons.every((button) => button.disabled));
  assert.match(app.hosts["face-gallery-tools"].innerHTML, /no network calls/i);
  assert.match(app.hosts["onvif-camera-tools"].innerHTML, /no network calls/i);
});

test("face gallery refresh, explicit enrollment, and ONVIF actions stay click driven", () => {
  assert.match(source, /\/api\/faces\/galleries/);
  assert.match(source, /\/api\/onvif\/discover/);
  assert.match(source, /duration_ms:250/);
  assert.match(source, /spyder:face-galleries-changed/);
  assert.match(source, /image_base64/);
});

