const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { computeSettingsPreview } = require("../src/spyder_cctv/assets/settings.js");

const source = fs.readFileSync(
  path.join(__dirname, "../src/spyder_cctv/assets/settings.js"),
  "utf8",
);
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

function fixture({ desired = {} } = {}) {
  const elements = new Map();
  const timers = new Map();
  const requests = [];
  const reads = [];
  let settingsState = "applied";
  let timerId = 0;
  class Element {
    constructor(selector = "") {
      this.selector = selector;
      this.children = [];
      this.listeners = new Map();
      this.dataset = {};
      this.styleValues = {};
      this.style = {
        setProperty: (name, value) => { this.styleValues[name] = value; },
        removeProperty: (name) => { delete this.styleValues[name]; if (name === "filter") this.style.filter = ""; if (name === "transform") this.style.transform = ""; if (name === "transform-origin") this.style.transformOrigin = ""; },
      };
      this.classList = { toggle() {}, add() {}, remove() {} };
      this.value = "";
      this.checked = false;
      this.hidden = false;
      this.disabled = false;
      this.open = false;
      this.textContent = "";
      this.attributes = {};
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    dispatch(name, event = {}) { this.listeners.get(name)?.({ target: this, preventDefault() {}, ...event }); }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? (name === "src" ? this.src || null : null); }
    removeAttribute(name) { delete this.attributes[name]; if (name === "src") this.src = ""; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatch("close"); }
    querySelector() { return null; }
    getBoundingClientRect() { return { width: 100, height: 100 }; }
  }
  const id = (name) => {
    if (!elements.has(name)) elements.set(name, new Element(name));
    return elements.get(name);
  };
  const dialog = id("#settings-dialog");
  id("#profiles-dialog");
  id("#settings-preview");
  id("#settings-preview-note");
  const capabilities = {
    brightness: { supported: true, value: 50, default_percent: 50, minimum: 0, maximum: 100, step: 1, native_value: 50 },
    contrast: { supported: true, value: 50, default_percent: 50, minimum: 0, maximum: 100, step: 1, native_value: 50 },
    saturation: { supported: true, value: 50, default_percent: 50, minimum: 0, maximum: 100, step: 1, native_value: 50 },
    zoom: { supported: true, value: 10, default_percent: 10, minimum: 0, maximum: 100, step: 1, native_value: 10 },
    fov: { supported: true, value: 80, default_percent: 80, minimum: 0, maximum: 100, step: 1, native_value: 80 },
    pan: { supported: true, value: 50, default_percent: 50, minimum: 0, maximum: 100, step: 1, native_value: 50 },
    tilt: { supported: true, value: 50, default_percent: 50, minimum: 0, maximum: 100, step: 1, native_value: 50 },
  };
  const camera = () => ({ available: true, capabilities: structuredClone(capabilities), desired: { ...desired }, results: {}, settings_state: settingsState });
  const app = {
    cameras: () => [{ id: "cam-a", name: "Camera A" }],
    frame: () => "blob:raw-frame",
    notify() {},
    refresh: async () => {},
    request: async (url, data) => {
      requests.push({ url, data });
      if (url === "/api/profiles") return { id: "p1", name: data.name, settings: data.settings };
      if (url.endsWith("/settings")) { settingsState = "pending"; return { ...camera(), desired: data.settings, settings_state: settingsState }; }
      if (url.endsWith("/profile")) return { ...camera(), desired: { brightness: 50 } };
      return {};
    },
  };
  const documentListeners = new Map();
  const document = {
    querySelector: id,
    querySelectorAll: () => [],
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener: (name, callback) => documentListeners.set(name, callback),
  };
  const window = { spyder: app, spyderShowcase: null };
  const context = vm.createContext({
    window, document, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    AbortController, setImmediate,
    setTimeout(callback, ms) { const token = ++timerId; timers.set(token, { callback, ms }); return token; },
    clearTimeout(token) { timers.delete(token); },
    fetch: async (url) => { reads.push(url); return { ok: true, json: async () => url === "/api/profiles" ? [] : camera() }; },
  });
  vm.runInContext(source, context);
  const opened = documentListeners.get("spyder:camera-settings");
  const open = async () => { opened({ detail: { id: "cam-a" } }); await flush(); };
  const controls = () => id("#camera-controls");
  const findControl = (name, type) => {
    const visit = (node) => {
      if (node?.type === type && (node.id === `control-${name}` || node.getAttribute?.("aria-label") === (name[0].toUpperCase() + name.slice(1)))) return node;
      for (const child of node?.children || []) { const match = visit(child); if (match) return match; }
      return null;
    };
    return visit(controls());
  };
  return { id, dialog, open, controls, findControl, requests, reads, timers, window, capabilities, setSettingsState: (value) => { settingsState = value; } };
}

test("neutral hardware baseline produces neutral filter and crop", () => {
  const capabilities = {
    brightness: { supported: true, value: 40 }, contrast: { supported: true, value: 50 },
    saturation: { supported: true, value: 30 }, zoom: { supported: true, value: 25 },
    fov: { supported: true, value: 70 }, pan: { supported: true, value: 50 }, tilt: { supported: true, value: 50 },
  };
  const preview = computeSettingsPreview(capabilities, { brightness: 40, contrast: 50, saturation: 30, zoom: 25, fov: 70, pan: 50, tilt: 50 });
  assert.equal(preview.filter, "brightness(1) contrast(1) saturate(1)");
  assert.equal(preview.zoom, 1);
  assert.equal(preview.transformOrigin, "50% 50%");
});

test("digital crop stays bounded and wider requests cannot restore off-frame image", () => {
  const capabilities = {
    zoom: { supported: true, value: 10 }, fov: { supported: true, value: 80 },
    pan: { supported: true, value: 50 }, tilt: { supported: true, value: 50 },
  };
  const zoomed = computeSettingsPreview(capabilities, { zoom: 100, fov: 10, pan: 100, tilt: 0 });
  assert.equal(zoomed.zoom, 4);
  assert.equal(zoomed.panX, 25);
  assert.equal(zoomed.panY, -25);
  assert.equal(zoomed.transformOrigin, "25% 75%");
  const wider = computeSettingsPreview({ zoom: { supported: true, value: 80 }, fov: { supported: true, value: 60 } }, { zoom: 20, fov: 100 });
  assert.equal(wider.zoom, 1);
});

test("unsupported controls do not affect simulated preview", () => {
  const preview = computeSettingsPreview({ brightness: { supported: false, value: 50 }, zoom: { supported: false, value: 0 }, pan: { supported: false, value: 50 } }, { brightness: 100, zoom: 100, pan: 100 });
  assert.equal(preview.filter, "brightness(1) contrast(1) saturate(1)");
  assert.equal(preview.zoom, 1);
  assert.equal(preview.transformOrigin, "50% 50%");
});

test("slider input updates local CSS simulation without hardware request", async () => {
  const h = fixture();
  await h.open();
  const slider = h.findControl("brightness", "range");
  slider.value = "100";
  const reads = h.reads.length;
  slider.dispatch("input");
  assert.match(h.id("#settings-preview").style.filter, /brightness\(2\)/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.reads.length, reads);
  assert.match(h.id("#settings-preview-note").textContent, /Simulated preview/);
});

test("fresh saved draft differing from driver stays neutral until edited", async () => {
  const h = fixture({ desired: { brightness: 100 } });
  h.capabilities.brightness.value = 75;
  await h.open();
  const image = h.id("#settings-preview");
  assert.equal(image.style.filter, "");
  assert.match(h.id("#settings-preview-note").textContent, /Live hardware preview/);
  const slider = h.findControl("brightness", "range");
  slider.value = "90";
  slider.dispatch("input");
  assert.match(image.style.filter, /brightness\(1\.3\)/);
});

test("driver-adjusted Apply readback clears simulation when no late edit remains", async () => {
  const h = fixture();
  await h.open();
  const slider = h.findControl("brightness", "range");
  slider.value = "100";
  slider.dispatch("input");
  h.id("#apply-settings").dispatch("click");
  await flush();
  assert.equal(h.id("#settings-preview").style.filter, "");
  h.capabilities.brightness.value = 75;
  h.setSettingsState("partial");
  const poll = [...h.timers.values()].find((timer) => timer.ms === 900);
  poll.callback();
  await flush();
  assert.equal(h.id("#settings-preview").style.filter, "");
  assert.match(h.id("#settings-preview-note").textContent, /Live hardware preview/);
});

test("Apply clears simulation until hardware readback, then uses new baseline", async () => {
  const h = fixture();
  await h.open();
  const slider = h.findControl("brightness", "range");
  slider.value = "100";
  slider.dispatch("input");
  assert.match(h.id("#settings-preview").style.filter, /brightness\(2\)/);
  h.id("#apply-settings").dispatch("click");
  await flush();
  assert.equal(h.requests[0].url, "/api/cameras/cam-a/settings");
  assert.equal(h.id("#settings-preview").style.filter, "");
  assert.match(h.id("#settings-preview-note").textContent, /applying changes/);
  slider.value = "75";
  slider.dispatch("input");
  assert.equal(h.id("#settings-preview").style.filter, "", "pending hardware effect is not doubled by CSS");
  assert.match(h.id("#settings-result").textContent, /Unsaved changes/);
  h.setSettingsState("applied");
  h.capabilities.brightness.value = 100;
  const poll = [...h.timers.values()].find((timer) => timer.ms === 900);
  poll.callback();
  await flush();
  assert.match(h.id("#settings-preview").style.filter, /brightness\(0\.5\)/);
});

test("saving a profile persists it without assigning or applying to camera", async () => {
  const h = fixture();
  await h.open();
  h.id("#profile-name").value = "Desk";
  h.id("#save-profile-form").dispatch("submit");
  await flush();
  assert.deepEqual(h.requests.map((request) => request.url), ["/api/profiles"]);
  assert.match(h.id("#settings-result").textContent, /Apply settings or Assign & apply/);
});

test("closing settings removes simulated filter and crop styles", async () => {
  const h = fixture();
  await h.open();
  const slider = h.findControl("brightness", "range");
  slider.value = "100";
  slider.dispatch("input");
  const image = h.id("#settings-preview");
  assert.notEqual(image.style.filter, "");
  assert.notEqual(image.style.transform, "");
  h.dialog.close();
  assert.equal(image.style.filter, "");
  assert.equal(image.style.transform, "");
  assert.equal(image.style.transformOrigin, "");
  assert.equal(image.src, "");
});

