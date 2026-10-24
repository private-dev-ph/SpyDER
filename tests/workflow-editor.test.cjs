const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  TYPES,
  FIELD_HELP,
  fieldHelpMarkup,
  paletteGroups,
  modelPage,
  faceTemplate,
  insightfaceTemplate,
  preEventTemplate,
  TEMPLATE_CATALOG,
  templateEntries,
  createWorkflowTemplate,
  validate,
  node,
  duplicateNode,
  clamp,
  edgeFor,
  accepts,
  encodeWorkflow,
  decodeWorkflow,
  migrateDetectorNodes,
  clampViewScale,
  canvasDelta,
  canvasPoint,
} = require("../src/spyder_cctv/assets/workflow-editor.js");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(
  require.resolve("../src/spyder_cctv/assets/workflow-editor.js"),
  "utf8",
);

test("Face template stages disabled detection, filter, cooldown, and event chain", () => {
  const graph = faceTemplate();
  assert.equal(graph.enabled, false);
  assert.deepEqual(
    graph.nodes.map((item) => item.type),
    ["detections", "filter", "cooldown", "event"],
  );
  assert.deepEqual(
    graph.edges,
    graph.nodes
      .slice(1)
      .map((item, index) => ({ from: graph.nodes[index].id, to: item.id })),
  );
  assert.equal(graph.nodes[0].params.engine, "insightface");
  assert.equal(graph.nodes[1].params.label, "face");
  assert.equal(graph.nodes[2].params.seconds, 10);
});

test("workflow validation detects unknown nodes, missing edges, and cycles", () => {
  const graph = {
    nodes: [
      { id: "a", type: "detections" },
      { id: "b", type: "filter" },
    ],
    edges: [{ from: "a", to: "b" }],
  };
  assert.deepEqual(validate(graph), []);
  graph.edges.push({ from: "b", to: "a" }, { from: "b", to: "missing" });
  graph.nodes.push({ id: "c", type: "mystery" });
  assert.match(validate(graph).join(" "), /Unknown node type/);
  assert.match(validate(graph).join(" "), /missing node/);
  assert.match(validate(graph).join(" "), /cycle/);
});

test("workflow validation rejects self links, duplicate links, and excess edges", () => {
  const nodes = [
    { id: "a", type: "detections" },
    { id: "b", type: "filter" },
  ];
  assert.match(
    validate({ nodes, edges: [{ from: "a", to: "a" }] }).join(" "),
    /cannot connect to itself/,
  );
  assert.match(
    validate({
      nodes,
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "b" },
      ],
    }).join(" "),
    /Duplicate connections/,
  );
  const edges = Array.from({ length: 129 }, (_, i) => ({
    from: "a",
    to: i % 2 ? "b" : "missing",
  }));
  assert.match(validate({ nodes, edges }).join(" "), /at most 128/);
});

test("new node parameters are independent and coordinates stay bounded", () => {
  const one = node("zone", -40, 9000),
    two = node("zone", 20, 20);
  one.params.roi[0] = 0.4;
  assert.equal(two.params.roi[0], 0);
  assert.equal(one.x, 0);
  assert.equal(one.y, 5000);
  assert.equal(clamp(NaN), 0);
});

test("copying a node creates independent bounded draft without connections", () => {
  const original = node("filter", 4990, 4990);
  original.params.label = "person";
  const graph = {
    nodes: [original, node("cooldown")],
    edges: [{ from: original.id, to: "other" }],
  };
  const copy = duplicateNode(graph, original.id);
  assert.ok(copy);
  assert.notEqual(copy.id, original.id);
  assert.deepEqual([copy.x, copy.y], [5000, 5000]);
  assert.notEqual(copy.params, original.params);
  assert.deepEqual(graph.edges, [{ from: original.id, to: "other" }]);
  assert.equal(duplicateNode(graph, "missing"), null);
});

test("connection labels survive export and import, while unsupported edge fields are stripped", () => {
  const graph = faceTemplate();
  graph.edges[0].label = "Primary detection branch";
  graph.edges[0].internal_debug = "discard me";
  const restored = decodeWorkflow(encodeWorkflow(graph));
  assert.equal(restored.edges[0].label, "Primary detection branch");
  assert.equal(restored.edges[0].internal_debug, undefined);
  const invalid = faceTemplate();
  invalid.edges[0].label = "x".repeat(81);
  assert.throws(
    () => decodeWorkflow(encodeWorkflow(invalid)),
    /Invalid workflow connection/,
  );
});

test("workflow viewport clamps zoom and converts pointer coordinates to canvas units", () => {
  assert.equal(clampViewScale(0.01), 0.25);
  assert.equal(clampViewScale(3), 2);
  assert.equal(canvasDelta(80, 0.5), 160);
  assert.equal(canvasPoint(140, 100, 2), 20);
});

test("event nodes expose safe defaults, attachment, and trigger timing settings", () => {
  assert.equal(TYPES.event.params.attachment, "none");
  assert.equal(TYPES.event.params.duration_seconds, 10);
  assert.equal(TYPES.event.params.pre_event_seconds, 0);
  assert.match(TYPES.event.params.name_pattern, /\{workflow\}/);
  assert.match(
    source,
    /\{workflow\}, \{camera\}, \{date\}, \{time\}, \{node\}, \{kind\}, \{label\}/,
  );
  assert.match(source, /data-param="attachment"/);
  assert.match(
    source,
    /data-param="duration_seconds" type="number" min="1" max="300"/,
  );
  assert.match(
    source,
    /data-param="pre_event_seconds" type="number" min="0" max="30" step="1"/,
  );
  assert.match(source, /Requires installed local app/);
  assert.match(source, /Cloudflare showcase cannot record pre-trigger video/);
});

test("pre-event seconds default on legacy imports, round-trip, and validate range", () => {
  const graph = faceTemplate(),
    event = graph.nodes.find((item) => item.type === "event");
  event.params.pre_event_seconds = 14;
  assert.equal(
    decodeWorkflow(encodeWorkflow(graph)).nodes.find(
      (item) => item.type === "event",
    ).params.pre_event_seconds,
    14,
  );
  delete event.params.pre_event_seconds;
  assert.equal(
    decodeWorkflow(encodeWorkflow(graph)).nodes.find(
      (item) => item.type === "event",
    ).params.pre_event_seconds,
    0,
  );
  for (const invalid of [-1, 31, 1.5, "2", true, null]) {
    const candidate = faceTemplate();
    candidate.nodes.find(
      (item) => item.type === "event",
    ).params.pre_event_seconds = invalid;
    assert.match(
      validate(candidate).join(" "),
      /Event name, attachment, or duration is invalid/,
    );
  }
});

test("pre-event control appears only for recording and preserves value while hidden", async () => {
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "event" }));
  const id = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)][0][1];
  h.root.dispatch("dblclick", h.target("[data-node]", { node: id }));
  assert.doesNotMatch(h.root.innerHTML, /data-param="pre_event_seconds"/);
  const attachment = h.target("[data-param]", { param: "attachment" });
  attachment.value = "recording";
  h.root.dispatch("change", attachment);
  assert.match(h.root.innerHTML, /Before trigger \(seconds\)/);
  assert.match(h.root.innerHTML, /After trigger \(seconds\)/);
  const before = h.target("[data-param]", { param: "pre_event_seconds" });
  before.value = "7";
  h.root.dispatch("change", before);
  attachment.value = "none";
  h.root.dispatch("change", attachment);
  assert.doesNotMatch(h.root.innerHTML, /data-param="pre_event_seconds"/);
  attachment.value = "recording";
  h.root.dispatch("change", attachment);
  assert.match(
    h.root.innerHTML,
    /data-param="pre_event_seconds"[^>]*value="7"/,
  );
  h.window.spyderWorkflows.unmount();
});

test("toolbar node copy and paste stays a disabled draft", async () => {
  const h = mountHarness();
  await h.flush();
  addNode(h, "filter");
  const before = (h.root.innerHTML.match(/data-node="/g) || []).length;
  h.root.dispatch("click", h.target("button", { copyNode: "" }));
  h.root.dispatch("click", h.target("button", { pasteNode: "" }));
  assert.equal(
    (h.root.innerHTML.match(/data-node="/g) || []).length,
    before + 1,
  );
  assert.match(h.root.innerHTML, /Independent execution disabled/);
  assert.equal(
    h.calls.some((call) => call.options?.method === "POST"),
    false,
  );
  h.window.spyderWorkflows.unmount();
});

test("latest status endpoint polls in editor and showcase explains status is unavailable", async () => {
  const editor = mountHarness();
  await editor.flush();
  assert.ok(
    editor.calls.some((call) => call.url.startsWith("/api/workflows/debug?")),
  );
  editor.window.spyderWorkflows.unmount();
  const showcase = mountHarness({ showcase: true });
  await showcase.flush();
  const showcaseNode = addNode(showcase, "filter");
  showcase.root.dispatch(
    "dblclick",
    showcase.target("[data-node]", { node: showcaseNode }),
  );
  assert.match(
    showcase.root.innerHTML,
    /Latest node status unavailable in showcase/,
  );
  assert.equal(
    showcase.calls.some((call) => call.url.startsWith("/api/workflows/debug?")),
    false,
  );
  showcase.window.spyderWorkflows.unmount();
});

test("zoom controls change canvas scale in place and clamp supported range", async () => {
  const h = mountHarness();
  await h.flush();
  const canvas = h.root.querySelector("[data-canvas]");
  const assignments = h.root.assignments;
  h.root.dispatch("click", h.target("button", { zoomIn: "" }));
  assert.equal(canvas.style.zoom, "1.1");
  assert.equal(h.root.querySelector("[data-zoom-level]").textContent, "110%");
  assert.equal(
    h.root.assignments,
    assignments,
    "zoom must not rerender preview canvas",
  );
  for (let i = 0; i < 30; i++)
    h.root.dispatch("click", h.target("button", { zoomIn: "" }));
  assert.equal(canvas.style.zoom, "2");
  for (let i = 0; i < 40; i++)
    h.root.dispatch("click", h.target("button", { zoomOut: "" }));
  assert.equal(canvas.style.zoom, "0.25");
  h.root.dispatch("click", h.target("button", { zoomReset: "" }));
  assert.equal(canvas.style.zoom, "1");
  h.window.spyderWorkflows.unmount();
});

function loadTemplate(h, id) {
  h.root.dispatch("click", h.target("button", { openTemplates: "" }));
  h.root.dispatch("click", h.target("button", { loadTemplate: id }));
}

function mountHarness({
  showcase = false,
  fetcher,
  initialCameras,
  initialModels = [],
} = {}) {
  const pendingTimers = new Map(),
    calls = [],
    local = new Map(),
    listeners = new Map();
  let sequence = 0;
  let hitTarget = null;
  const captured = new Set();
  class Element {
    constructor() {
      this.dataset = {};
      this.value = "";
      this.checked = false;
      this.hidden = false;
      this.disabled = false;
      this.innerHTML = "";
      this.assignments = 0;
      this.handlers = new Map();
      this.style = {};
      this.classList = { toggle() {}, add() {}, remove() {} };
    }
    set innerHTML(value) {
      this._html = value;
      this.assignments++;
    }
    get innerHTML() {
      return this._html || "";
    }
    insertAdjacentHTML(_position, value) {
      this._html = (this._html || "") + value;
    }
    addEventListener(name, fn) {
      this.handlers.set(name, [...(this.handlers.get(name) || []), fn]);
    }
    removeEventListener(name, fn) {
      this.handlers.set(
        name,
        (this.handlers.get(name) || []).filter((item) => item !== fn),
      );
    }
    querySelector(selector) {
      if (!this.children) this.children = new Map();
      if (!this.children.has(selector))
        this.children.set(selector, Object.assign(new Element(), { selector }));
      return this.children.get(selector);
    }
    querySelectorAll() {
      if (!this.focusables) this.focusables = [new Element(), new Element()];
      this.focusables.forEach((x) => (x.parentElement = this));
      return this.focusables;
    }
    replaceWith() {}
    setAttribute(name, value) {
      this[name] = value;
    }
    focus() {
      this.focused = true;
    }
    setRangeText() {}
    setPointerCapture(id) {
      captured.add(id);
    }
    hasPointerCapture(id) {
      return captured.has(id);
    }
    releasePointerCapture(id) {
      captured.delete(id);
    }
    replaceChildren(...items) {
      this.children = items;
    }
    remove() {
      this.removed = true;
    }
    matches(selector) {
      return (
        selector.split(",").some((item) => this.selector === item.trim()) ||
        (selector.startsWith("[") && this.selector === selector)
      );
    }
    closest(selector) {
      for (let item = this; item; item = item.parentElement)
        if (item.matches(selector)) return item;
      return null;
    }
    getBoundingClientRect() {
      return { left: 0, top: 0 };
    }
    dispatch(name, target, props = {}) {
      for (const fn of this.handlers.get(name) || [])
        fn({
          type: name,
          target,
          preventDefault() {},
          clientX: 0,
          clientY: 0,
          button: 0,
          pointerId: 1,
          ...props,
        });
    }
  }
  const root = new Element();
  const docHandlers = new Map();
  const document = {
    createElement: () => root,
    elementFromPoint: () => hitTarget,
    addEventListener: (name, fn) => docHandlers.set(name, fn),
    removeEventListener: (name) => docHandlers.delete(name),
    dispatch(name, target, props = {}) {
      docHandlers.get(name)?.({
        type: name,
        target,
        preventDefault() {},
        clientX: 0,
        clientY: 0,
        button: 0,
        pointerId: 1,
        ...props,
      });
    },
  };
  const cameras = initialCameras || [{ id: "cam-1", name: "Camera one" }];
  const window = {
    spyder: { cameras: () => cameras },
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    dispatchEvent: (event) => listeners.get(event.type)?.(event),
    ...(showcase ? { spyderShowcase: {} } : {}),
  };
  const context = vm.createContext({
    window,
    document,
    AbortController,
    console,
    Event,
    TextEncoder,
    URLSearchParams,
    localStorage: {
      getItem: (key) => local.get(key) ?? null,
      setItem: (key, value) => local.set(key, value),
    },
    setTimeout(fn, ms) {
      const token = ++sequence;
      pendingTimers.set(token, { fn, ms });
      return token;
    },
    clearTimeout(token) {
      pendingTimers.delete(token);
    },
    fetch: async (url, options = {}) => {
      calls.push({
        url,
        options,
        body: options.body ? JSON.parse(options.body) : undefined,
      });
      return fetcher
        ? fetcher(
            url.startsWith("/api/workflows?current=")
              ? "/api/workflows"
              : url.startsWith("/api/workflows/debug?")
                ? "/api/workflows/debug"
                : url,
            options,
          )
        : {
            ok: true,
            status: 200,
            json: async () =>
              url === "/api/models"
                ? { models: initialModels }
                : url.endsWith("/vision")
                  ? {
                      id: "cam-1",
                      pipeline: "opencv",
                      settings: { engine: "opencv" },
                      runtime: { state: "ready" },
                    }
                  : { workflows: [], events: [] },
          };
    },
  });
  vm.runInContext(source, context);
  const container = { replaceChildren() {} };
  window.spyderWorkflows.mount(container);
  const target = (selector, dataset = {}, parentElement = null) =>
    Object.assign(new Element(), { selector, dataset, parentElement });
  const flush = async () => {
    for (let i = 0; i < 6; i++)
      await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    root,
    document,
    window,
    calls,
    local,
    pendingTimers,
    listeners,
    target,
    setHitTarget: (target) => {
      hitTarget = target;
    },
    captured,
    flush,
  };
}

test("save posts the graph contract without a separate camera model editor", async () => {
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "detections" }));
  h.root.dispatch("click", h.target("button", { add: "filter" }));
  const nodeIds = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)].map(
    (match) => match[1],
  );
  h.root.querySelector("[data-from]").value = nodeIds[0];
  h.root.querySelector("[data-to]").value = nodeIds[1];
  h.root.dispatch("click", h.target("button", { connect: "" }));
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const save = h.calls.find(
    (call) => call.options.method === "POST" && call.url === "/api/workflows",
  );
  assert.ok(
    save,
    JSON.stringify(h.calls.map((call) => [call.url, call.options.method])),
  );
  assert.equal(save.options.headers["X-Spyder-Control"], "1");
  assert.deepEqual(Object.keys(save.body).sort(), ["workflow"]);
  assert.deepEqual(
    Object.keys(save.body.workflow).sort(),
    ["camera_ids", "edges", "enabled", "id", "name", "nodes"].sort(),
  );
  assert.equal(save.body.workflow.nodes.length, 2);
  assert.deepEqual(save.body.workflow.edges, [
    { from: nodeIds[0], to: nodeIds[1] },
  ]);
  assert.doesNotMatch(
    h.root.innerHTML,
    /Camera model pipeline|data-apply-model/,
  );
  assert.equal(
    h.calls.some((call) => call.url.endsWith("/vision")),
    false,
  );
  h.window.spyderWorkflows.unmount();
});

test("showcase loads local draft, makes no requests, and unmount clears handlers", async () => {
  const h = mountHarness({ showcase: true });
  await h.flush();
  assert.equal(h.calls.length, 0);
  assert.match(h.root.innerHTML, /Demo editing only/);
  loadTemplate(h, "face-event");
  h.root.dispatch("click", h.target("button", { save: "" }));
  assert.ok(h.local.has("spyder.workflow-editor.draft"));
  assert.equal(h.calls.length, 0);
  h.window.spyderWorkflows.unmount();
  assert.equal(h.root.removed, true);
  assert.ok([...h.root.handlers.values()].every((items) => items.length === 0));
});

test("snapshot polling preserves unsaved name edit and unmount aborts requests", async () => {
  let workflowCalls = 0;
  const h = mountHarness({
    fetcher: (url, options) => {
      if (url === "/api/workflows" && ++workflowCalls > 2)
        return new Promise((resolve) =>
          options.signal.addEventListener(
            "abort",
            () => resolve({ ok: false, status: 499, json: async () => ({}) }),
            { once: true },
          ),
        );
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith("/vision")
            ? { id: "cam-1", pipeline: "opencv", settings: {}, runtime: {} }
            : { workflows: [], events: [] },
      };
    },
  });
  await h.flush();
  const before = h.root.assignments;
  let poll = [...h.pendingTimers.entries()].find(
    ([, item]) => item.ms === 5000,
  );
  h.pendingTimers.delete(poll[0]);
  poll[1].fn();
  await h.flush();
  assert.equal(
    h.root.assignments,
    before,
    "clean polling updates snapshot areas without replacing form DOM",
  );
  const name = h.target("[data-name]");
  name.value = "Draft name";
  h.root.dispatch("input", name);
  poll = [...h.pendingTimers.entries()].find(([, item]) => item.ms === 5000);
  assert.ok(poll);
  h.pendingTimers.delete(poll[0]);
  poll[1].fn();
  await h.flush();
  assert.equal(
    h.root.assignments,
    before,
    "poll does not replace edited form DOM",
  );
  h.window.spyderWorkflows.unmount();
  assert.ok(h.calls.some((call) => call.options.signal?.aborted));
});

test("camera updates stay within the sidebar and do not request camera model settings", async () => {
  const h = mountHarness({ initialCameras: [] });
  await h.flush();
  h.window.spyder.cameras = () => [{ id: "cam-late", name: "Late camera" }];
  h.listeners.get("spyder:cameras")();
  await h.flush();
  assert.match(
    h.root.innerHTML,
    /<section class="we-camera-panel"><h3>Cameras<\/h3><div class="we-cameras">/,
  );
  assert.match(h.root.innerHTML, /Late camera/);
  assert.equal(
    h.calls.some((call) => call.url.endsWith("/vision")),
    false,
  );
  h.root.dispatch("click", h.target("button", { applyModel: "" }));
  await h.flush();
  assert.equal(
    h.calls.some((call) => call.url.endsWith("/vision")),
    false,
  );
  h.window.spyderWorkflows.unmount();
});

test("graph edits during save remain dirty and survive server polling", async () => {
  let finish;
  const h = mountHarness({
    fetcher: async (url, options) => {
      if (options.method === "POST")
        return new Promise((resolve) => {
          finish = () => resolve({ ok: true, json: async () => ({}) });
        });
      return {
        ok: true,
        json: async () =>
          url.endsWith("/vision")
            ? { pipeline: "none", settings: null }
            : { workflows: [], events: [] },
      };
    },
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "event" }));
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const name = h.target("[data-name]");
  name.value = "Edited while saving";
  h.root.dispatch("input", name);
  finish();
  await h.flush();
  assert.match(h.root.innerHTML, /Edited while saving/);
  assert.match(h.root.innerHTML, /Workflow saved/);
  h.window.spyderWorkflows.unmount();
});

test("code node exposes local Python editor and uses local test endpoint contract", async () => {
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "code" }));
  assert.match(h.root.innerHTML, /data-param="source"/);
  assert.match(h.root.innerHTML, /No imports or file access/);
  const codeCard = h.target("[data-node]", {
    node: [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)][0][1],
  });
  h.root.dispatch("dblclick", codeCard);
  assert.match(h.root.innerHTML, /data-code-test/);
  h.root.dispatch("click", h.target("button", { codeTest: "" }));
  h.root.querySelector("[data-test-input]").value =
    '[{"label":"person","confidence":null}]';
  h.root.dispatch("click", h.target("button", { runTest: "" }));
  await h.flush();
  const call = h.calls.find((item) => item.url === "/api/workflows/code/test");
  assert.ok(call);
  assert.equal(call.options.headers["X-Spyder-Control"], "1");
  assert.deepEqual(call.body.context, {
    camera_id: "preview",
    engine: "opencv",
    frame_size: [640, 360],
    sequence: 1,
  });
  assert.equal(call.body.source, "output = detections");
  assert.deepEqual(call.body.detections, [
    { label: "person", confidence: null },
  ]);
  h.window.spyderWorkflows.unmount();
});

test("pointer wiring uses hit-tested opposite port after capture retargeting", async () => {
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "detections" }));
  h.root.dispatch("click", h.target("button", { add: "filter" }));
  const ids = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)].map(
    (x) => x[1],
  );
  const from = h.target("[data-node]", { node: ids[0] }),
    to = h.target("[data-node]", { node: ids[1] });
  const out = h.target("[data-port]", { port: "out" }, from),
    input = h.target("[data-port]", { port: "in" }, to);
  h.root.dispatch("pointerdown", out, { pointerId: 12 });
  assert.ok(h.captured.has(12));
  h.document.dispatch("pointermove", h.root, {
    pointerId: 12,
    clientX: 220,
    clientY: 80,
  });
  h.setHitTarget(input);
  h.document.dispatch("pointerup", h.root, {
    pointerId: 12,
    clientX: 220,
    clientY: 80,
  });
  assert.equal(h.captured.has(12), false);
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const save = h.calls.find(
    (x) => x.url === "/api/workflows" && x.options.method === "POST",
  );
  assert.ok(
    save,
    JSON.stringify(h.calls.map((x) => [x.url, x.options.method])),
  );
  assert.deepEqual(save.body.workflow.edges, [{ from: ids[0], to: ids[1] }]);
  h.window.spyderWorkflows.unmount();
});

test("pointer cancel rolls node movement back and same-direction port drop adds no edge", async () => {
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "detections" }));
  h.root.dispatch("click", h.target("button", { add: "filter" }));
  const ids = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)].map(
    (x) => x[1],
  );
  const card = h.target("[data-node]", { node: ids[0] });
  h.root.dispatch("pointerdown", card, {
    pointerId: 5,
    clientX: 20,
    clientY: 20,
  });
  h.document.dispatch("pointermove", h.root, {
    pointerId: 5,
    clientX: 120,
    clientY: 120,
  });
  h.document.dispatch("pointercancel", h.root, {
    pointerId: 5,
    clientX: 120,
    clientY: 120,
  });
  const to = h.target("[data-node]", { node: ids[1] }),
    out = h.target("[data-port]", { port: "out" }, to);
  h.root.dispatch("pointerdown", out, { pointerId: 6 });
  h.setHitTarget(out);
  h.document.dispatch("pointerup", h.root, { pointerId: 6 });
  h.root.dispatch("click", h.target("button", { undo: "" }));
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const save = h.calls.find(
    (x) => x.url === "/api/workflows" && x.options.method === "POST",
  );
  assert.equal(save.body.workflow.nodes[0].x, 40);
  assert.equal(save.body.workflow.edges.length, 0);
  h.window.spyderWorkflows.unmount();
});

test("pointer node move commits once and undo restores original coordinates", async () => {
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "filter" }));
  const card = h.target("[data-node]", {
    node: [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)][0][1],
  });
  h.root.dispatch("pointerdown", card, {
    pointerId: 31,
    clientX: 10,
    clientY: 20,
  });
  h.document.dispatch("pointermove", h.root, {
    pointerId: 31,
    clientX: 100,
    clientY: 80,
  });
  h.document.dispatch("pointerup", h.root, {
    pointerId: 31,
    clientX: 100,
    clientY: 80,
  });
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  let saves = h.calls.filter(
    (x) => x.url === "/api/workflows" && x.options.method === "POST",
  );
  assert.equal(saves.at(-1).body.workflow.nodes[0].x, 130);
  h.root.dispatch("click", h.target("button", { undo: "" }));
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  saves = h.calls.filter(
    (x) => x.url === "/api/workflows" && x.options.method === "POST",
  );
  assert.equal(saves.at(-1).body.workflow.nodes[0].x, 40);
  h.window.spyderWorkflows.unmount();
});

test("closing code test ignores late response and modal uses one parameter form", async () => {
  let finish;
  const h = mountHarness({
    fetcher: (url) =>
      url === "/api/workflows/code/test"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : {
            ok: true,
            status: 200,
            json: async () =>
              url === "/api/models"
                ? { models: [] }
                : url.endsWith("/vision")
                  ? { id: "cam-1", pipeline: "none", settings: {}, runtime: {} }
                  : { workflows: [], events: [] },
          },
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "code" }));
  const id = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)][0][1];
  h.root.dispatch("dblclick", h.target("[data-node]", { node: id }));
  assert.equal(
    (h.root.innerHTML.match(/data-param="source"/g) || []).length,
    1,
  );
  h.root.dispatch("click", h.target("button", { codeTest: "" }));
  h.root.querySelector("[data-test-input]").value = "[]";
  h.root.dispatch("click", h.target("button", { runTest: "" }));
  await h.flush();
  assert.ok(finish);
  h.root.dispatch("click", h.target("button", { closeSettings: "" }));
  const renders = h.root.assignments;
  finish({ ok: true, status: 200, json: async () => ({ detections: [] }) });
  await h.flush();
  assert.equal(h.root.assignments, renders);
  h.window.spyderWorkflows.unmount();
});

test("undo restores code parameter edits", async () => {
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "code" }));
  const field = h.target("[data-param]", { param: "source" });
  h.root.dispatch("focusin", field);
  field.value = "output = []";
  h.root.dispatch("input", field);
  h.root.dispatch("click", h.target("button", { undo: "" }));
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const save = h.calls.find(
    (x) => x.url === "/api/workflows" && x.options.method === "POST",
  );
  assert.equal(
    save.body.workflow.nodes[0].params.source,
    "output = detections",
  );
  h.window.spyderWorkflows.unmount();
});

test("single selection preserves card for double-click and traps modal focus", async () => {
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "filter" }));
  const id = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)][0][1],
    card = h.target("[data-node]", { node: id });
  for (let i = 0; i < 2; i++) {
    h.root.dispatch("pointerdown", card, { pointerId: 50 + i });
    h.document.dispatch("pointerup", card, { pointerId: 50 + i });
    assert.equal(h.captured.has(50 + i), false);
    h.root.dispatch("click", card);
  }
  h.root.dispatch("dblclick", card);
  assert.match(h.root.innerHTML, /role="dialog"/);
  const dialog = h.root.querySelector("[data-settings-modal] .we-modal"),
    [first, last] = dialog.querySelectorAll("button");
  h.root.dispatch("keydown", first, { key: "Tab", shiftKey: true });
  assert.equal(last.focused, true);
  h.root.dispatch("keydown", first, { key: "Escape" });
  assert.equal(card.focused, true);
  h.window.spyderWorkflows.unmount();
});

test("node deletion and template replacement both undo", async () => {
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "filter" }));
  h.root.dispatch("click", h.target("button", { deleteNode: "" }));
  h.root.dispatch("click", h.target("button", { undo: "" }));
  loadTemplate(h, "face-event");
  h.root.dispatch("click", h.target("button", { undo: "" }));
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const save = h.calls.find(
    (x) => x.url === "/api/workflows" && x.options.method === "POST",
  );
  assert.equal(save.body.workflow.nodes.length, 1);
  assert.equal(save.body.workflow.nodes[0].type, "filter");
  h.window.spyderWorkflows.unmount();
});

test("node layout uses CSSOM so strict local and showcase CSP accepts positions", async () => {
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "detections" }));
  const id = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)][0][1];
  const canvas = h.root.querySelector("[data-canvas]");
  const card = canvas.querySelector(`[data-node="${id}"]`);
  assert.equal(card.style.left, "1040px");
  assert.equal(card.style.top, "1060px");
  assert.ok(canvas.style.width.endsWith("px"));
  assert.doesNotMatch(h.root.innerHTML, /style="(?:left|width):/);
  h.window.spyderWorkflows.unmount();
});

test("selecting a node without moving preserves redo history", async () => {
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "filter" }));
  const id = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)][0][1];
  const card = h.target("[data-node]", { node: id });
  h.root.dispatch("pointerdown", card, {
    pointerId: 42,
    clientX: 10,
    clientY: 10,
  });
  h.document.dispatch("pointermove", h.root, {
    pointerId: 42,
    clientX: 90,
    clientY: 10,
  });
  h.document.dispatch("pointerup", h.root, {
    pointerId: 42,
    clientX: 90,
    clientY: 10,
  });
  h.root.dispatch("click", h.target("button", { undo: "" }));
  h.root.dispatch("pointerdown", card, {
    pointerId: 43,
    clientX: 10,
    clientY: 10,
  });
  h.document.dispatch("pointerup", h.root, {
    pointerId: 43,
    clientX: 10,
    clientY: 10,
  });
  h.root.dispatch("click", h.target("button", { redo: "" }));
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const saved = h.calls.find(
    (x) => x.url === "/api/workflows" && x.options.method === "POST",
  );
  assert.equal(saved.body.workflow.nodes[0].x, 120);
  h.window.spyderWorkflows.unmount();
});
const addNode = (h, type = "detections") => {
  h.root.dispatch("click", h.target("button", { add: type }));
  return [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)][0][1];
};

test("first node and template starting node center in viewport; Center frames graph", async () => {
  const h = mountHarness();
  await h.flush();
  const wrap = h.root.querySelector(".we-canvas-wrap");
  wrap.clientWidth = 640;
  wrap.clientHeight = 240;
  // First insertion after navigating the empty canvas uses the visible center.
  wrap.scrollLeft = 1300;
  wrap.scrollTop = 1200;
  const id = addNode(h);
  const card = h.root
    .querySelector("[data-canvas]")
    .querySelector(`[data-node="${id}"]`);
  assert.equal(parseFloat(card.style.left) + 82 - wrap.scrollLeft, 320);
  assert.equal(parseFloat(card.style.top) + 38 - wrap.scrollTop, 120);
  loadTemplate(h, "face-event");
  assert.equal(wrap.scrollLeft, 802); // Starting detection node, not the whole chain.
  h.root.dispatch("click", h.target("button", { center: "" }));
  assert.equal(wrap.scrollLeft, 1162); // Padding + midpoint of x=40..924 - width/2.
  assert.equal(wrap.scrollTop, 1008);
  h.window.spyderWorkflows.unmount();
});

test("background panning changes viewport only, preserves it through edits, and centers on demand", async () => {
  const h = mountHarness();
  await h.flush();
  addNode(h);
  const wrap = h.root.querySelector(".we-canvas-wrap");
  const left = wrap.scrollLeft,
    top = wrap.scrollTop;
  const canvas = h.target("[data-canvas]");
  h.root.dispatch("pointerdown", canvas, { clientX: 300, clientY: 200 });
  h.document.dispatch("pointermove", canvas, { clientX: 220, clientY: 150 });
  assert.equal(wrap.scrollLeft, left + 80);
  assert.equal(wrap.scrollTop, top + 50);
  assert.ok(h.captured.has(1));
  h.document.dispatch("pointerup", canvas);
  assert.equal(h.captured.size, 0);
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const save = h.calls.find(
    (x) => x.url === "/api/workflows" && x.options.method === "POST",
  );
  assert.equal(save.body.workflow.nodes[0].x, 40);
  assert.equal(save.body.workflow.nodes[0].y, 60);
  assert.equal(wrap.scrollLeft, left + 80);
  h.root.dispatch("click", h.target("button", { center: "" }));
  assert.equal(wrap.scrollLeft, left);
  assert.equal(wrap.scrollTop, top);
  h.window.spyderWorkflows.unmount();
});

test("panning ignores another pointer, releases capture on cancellation and unmount", async () => {
  const h = mountHarness();
  await h.flush();
  const wrap = h.root.querySelector(".we-canvas-wrap"),
    canvas = h.target("[data-canvas]");
  const left = wrap.scrollLeft;
  h.root.dispatch("pointerdown", canvas, { button: 1 });
  h.document.dispatch("pointermove", canvas, { pointerId: 2, clientX: 80 });
  h.document.dispatch("pointerup", canvas, { pointerId: 2 });
  assert.equal(wrap.scrollLeft, left);
  assert.ok(h.captured.has(1));
  h.document.dispatch("pointercancel", canvas);
  assert.equal(h.captured.size, 0);
  h.root.dispatch("pointerdown", canvas, { button: 1 });
  h.window.spyderWorkflows.unmount();
  assert.equal(h.captured.size, 0);
});

test("arrow keys pan focused canvas without editing the graph", async () => {
  const h = mountHarness();
  await h.flush();
  const wrap = h.root.querySelector(".we-canvas-wrap");
  const left = wrap.scrollLeft,
    top = wrap.scrollTop;
  h.root.dispatch("keydown", h.target(".we-canvas-wrap"), {
    key: "ArrowRight",
  });
  h.root.dispatch("keydown", h.target(".we-canvas-wrap"), { key: "ArrowDown" });
  assert.equal(wrap.scrollLeft, left + 60);
  assert.equal(wrap.scrollTop, top + 60);
  h.window.spyderWorkflows.unmount();
});

test("typed source ports accept multiple camera/model inputs and processing fan-out", () => {
  const camera = node("camera"),
    model = node("model"),
    detect = node("detections"),
    filter = node("filter"),
    code = node("code");
  const nodes = [camera, model, detect, filter, code];
  const edges = [
    edgeFor(camera.id, detect.id, nodes),
    edgeFor(model.id, detect.id, nodes),
    edgeFor(detect.id, filter.id, nodes),
    edgeFor(detect.id, code.id, nodes),
    edgeFor(filter.id, code.id, nodes),
  ];
  assert.equal(edges[0].input, "camera");
  assert.equal(edges[1].input, "model");
  assert.deepEqual(validate({ nodes, edges }), []);
  assert.equal(accepts(model, filter), false);
  assert.equal(accepts(camera, model), false);
  assert.match(
    validate({
      nodes,
      edges: [{ from: model.id, to: filter.id, input: "model" }],
    }).join(),
    /Incompatible/,
  );
});

test("InsightFace classifier uses typed input and detector defaults preserve legacy camera pipeline", () => {
  const classifier = node("classifier"),
    detections = node("detections");
  detections.params.engine = "insightface";
  assert.deepEqual(classifier.params, {
    model_id: "",
    threshold: 0.5,
    output: "probabilities",
    preprocessing: "arcface",
    confirmations: 3,
    switch_confirmations: 5,
    margin: 0.15,
  });
  assert.equal(detections.params.detector, undefined);
  const edge = edgeFor(classifier.id, detections.id, [classifier, detections]);
  assert.equal(edge.input, "classifier");
  assert.equal(accepts(classifier, detections), true);
  assert.equal(accepts(classifier, node("filter")), false);
  assert.deepEqual(
    validate({ nodes: [classifier, detections], edges: [edge] }),
    [],
  );

  detections.params.engine = "any";
  assert.match(
    validate({ nodes: [classifier, detections], edges: [edge] }).join(" "),
    /only to InsightFace Detections/,
  );

  const legacy = faceTemplate();
  delete legacy.nodes[0].params.detector;
  const imported = decodeWorkflow(encodeWorkflow(legacy));
  assert.equal(imported.nodes[0].params.detector, undefined);

  const oldCustom = insightfaceTemplate({ modelId: "old-detector" }),
    oldDetections = oldCustom.nodes.find((item) => item.type === "detections");
  delete oldDetections.params.detector;
  const oldCustomImport = decodeWorkflow(encodeWorkflow(oldCustom));
  assert.equal(
    oldCustomImport.nodes.find((item) => item.type === "detections").params
      .detector,
    undefined,
  );
  assert.deepEqual(validate(oldCustomImport), []);
});

test("InsightFace custom detector needs Model IN; distinct classifiers cannot share one detector", () => {
  const model = node("model"),
    first = node("classifier"),
    second = node("classifier"),
    detections = node("detections");
  detections.params.engine = "insightface";
  detections.params.detector = "custom";
  assert.match(
    validate({ nodes: [detections], edges: [] }).join(" "),
    /requires a connected Model node/,
  );
  const modelEdge = edgeFor(model.id, detections.id, [model, detections]);
  assert.deepEqual(
    validate({ nodes: [model, detections], edges: [modelEdge] }),
    [],
  );
  detections.params.detector = "scrfd-500mf";
  assert.match(
    validate({ nodes: [model, detections], edges: [modelEdge] }).join(" "),
    /Custom InsightFace detector/,
  );

  detections.params.detector = "scrfd-500mf";
  const classifierEdges = [
    edgeFor(first.id, detections.id, [first, second, detections]),
    edgeFor(second.id, detections.id, [first, second, detections]),
  ];
  assert.match(
    validate({
      nodes: [first, second, detections],
      edges: classifierEdges,
    }).join(" "),
    /accepts one Classifier/,
  );
});

test("classifier node exposes model and inference controls; detector install is explicit and local", async () => {
  let installed = false;
  const h = mountHarness({
    initialModels: [
      {
        id: "cbe100",
        name: "CBE100",
        engine: "insightface",
        classes: ["staff"],
        metadata: {
          model_type: "face_classifier",
          label_semantics: "identity",
        },
      },
    ],
    fetcher: async (url, options = {}) => ({
      ok: true,
      status: 200,
      json: async () =>
        url === "/api/vision/detectors"
          ? {
              detectors: [
                {
                  id: "scrfd-500mf",
                  name: "SCRFD 500MF",
                  available: installed,
                  downloadable: true,
                  license: "User weights are noncommercial.",
                },
              ],
            }
          : url.endsWith("/install")
            ? ((installed = true),
              {
                id: "scrfd-500mf",
                available: true,
                path: "models/scrfd_500mf.onnx",
              })
            : url === "/api/models"
              ? {
                  models: [
                    {
                      id: "cbe100",
                      name: "CBE100",
                      engine: "insightface",
                      classes: ["staff"],
                      metadata: {
                        model_type: "face_classifier",
                        label_semantics: "identity",
                      },
                    },
                  ],
                }
              : url.endsWith("/vision")
                ? { settings: {}, runtime: {} }
                : { workflows: [], events: [] },
    }),
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "classifier" }));
  assert.match(h.root.innerHTML, /Choose classifier/);
  assert.match(h.root.innerHTML, /Classifier threshold/);
  assert.match(h.root.innerHTML, /Embedded model preprocessing/);
  assert.match(h.root.innerHTML, /value="cbe100"/);

  h.root.dispatch("click", h.target("button", { add: "detections" }));
  const engine = h.target("[data-param]", { param: "engine" });
  engine.value = "insightface";
  h.root.dispatch("change", engine);
  assert.doesNotMatch(h.root.innerHTML, /data-param="detector"/);
  h.root.dispatch("click", h.target("button", { add: "model" }));
  const selectedModel = h.target("[data-param]", { param: "model_id" });
  selectedModel.value = "builtin-scrfd-500mf";
  h.root.dispatch("change", selectedModel);
  assert.match(h.root.innerHTML, /SCRFD 500MF · light default/);
  assert.match(h.root.innerHTML, /User weights are noncommercial/);
  assert.match(h.root.innerHTML, /Install detector locally/);
  h.root.dispatch(
    "click",
    h.target("button", { installDetector: "scrfd-500mf" }),
  );
  await h.flush();
  assert.equal(
    h.calls.filter(
      (call) => call.url === "/api/vision/detectors/scrfd-500mf/install",
    ).length,
    1,
  );
  assert.match(h.root.innerHTML, /is ready locally/);
  h.window.spyderWorkflows.unmount();
});

test("workflow export includes model manifest and import remaps models into a disabled new draft", () => {
  const graph = faceTemplate(),
    camera = node("camera"),
    model = node("model");
  camera.params.camera_id = "old-camera";
  model.params.model_id = "old-model";
  graph.nodes.push(camera, model);
  graph.nodes[0].params.detector = "custom";
  graph.enabled = true;
  graph.camera_ids = ["old-camera"];
  graph.edges.push(
    { from: camera.id, to: graph.nodes[0].id, input: "camera" },
    { from: model.id, to: graph.nodes[0].id, input: "model" },
  );
  const text = encodeWorkflow(graph, [
    {
      id: "old-model",
      name: "Faces",
      engine: "insightface",
      classes: ["face"],
      path: "C:/private/weights.onnx",
    },
  ]);
  assert.doesNotMatch(text, /private/);
  const imported = decodeWorkflow(
    text,
    [],
    [
      {
        id: "new-model",
        name: "Faces",
        engine: "insightface",
        classes: ["face"],
      },
    ],
  );
  assert.notEqual(imported.id, graph.id);
  assert.equal(imported.enabled, false);
  assert.deepEqual(imported.camera_ids, []);
  assert.equal(
    imported.nodes.find((n) => n.type === "camera").params.camera_id,
    "",
  );
  assert.equal(
    imported.nodes.find((n) => n.type === "model").params.model_id,
    "new-model",
  );
  assert.equal(imported.edges.length, graph.edges.length);
});

test("workflow import rejects oversized, duplicate and incompatible graphs before replacing draft", () => {
  assert.throws(() => decodeWorkflow(" ".repeat(1048577)), /1 MiB/);
  const graph = faceTemplate();
  graph.nodes[1].id = graph.nodes[0].id;
  assert.throws(
    () => decodeWorkflow(JSON.stringify(graph)),
    /Invalid workflow node/,
  );
  const graph2 = faceTemplate();
  graph2.nodes[0].params.unsafe = "oops";
  assert.throws(() => decodeWorkflow(JSON.stringify(graph2)), /parameter/);
  assert.throws(
    () =>
      decodeWorkflow(
        JSON.stringify({
          format: "spyder-workflow",
          version: 42,
          workflow: faceTemplate(),
        }),
      ),
    /version/,
  );
});

test("model-connected filters list classes and support multiple rules plus IN/OUT settings", async () => {
  const h = mountHarness({
    initialModels: [
      {
        id: "model-1",
        name: "Objects",
        engine: "yolo",
        classes: ["person", "car"],
      },
    ],
  });
  await h.flush();
  addNode(h, "camera");
  addNode(h, "model");
  addNode(h, "detections");
  addNode(h, "filter");
  addNode(h, "event");
  const ids = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)].map(
    (m) => m[1],
  );
  const connect = (a, b) => {
    h.root.querySelector("[data-from]").value = ids[a];
    h.root.querySelector("[data-to]").value = ids[b];
    h.root.dispatch("click", h.target("button", { connect: "" }));
  };
  h.root.dispatch("click", h.target("[data-node]", { node: ids[1] }));
  const modelChoice = h.target("[data-param]", { param: "model_id" });
  modelChoice.value = "model-1";
  h.root.dispatch("change", modelChoice);
  connect(0, 2);
  connect(1, 2);
  connect(2, 3);
  connect(2, 4);
  connect(3, 4);
  h.root.dispatch("dblclick", h.target("[data-node]", { node: ids[3] }));
  assert.match(h.root.innerHTML, /<option value="person"/);
  assert.match(h.root.innerHTML, /IN connections \(1\)/);
  assert.match(h.root.innerHTML, /OUT connections \(1\)/);
  h.root.dispatch("click", h.target("button", { addRule: "" }));
  h.root.dispatch("click", h.target("button", { addRule: "" }));
  const field = h.target("[data-rule]", { rule: "1", ruleKey: "field" });
  field.value = "identity";
  h.root.dispatch("change", field);
  assert.match(h.root.innerHTML, /If not identity/);
  const op = h.target("[data-rule]", { rule: "1", ruleKey: "operator" });
  op.value = "neq";
  h.root.dispatch("change", op);
  const value = h.target("[data-rule]", { rule: "1", ruleKey: "value" });
  value.value = "Guest";
  h.root.dispatch("input", value);
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const saved = h.calls.find(
    (x) => x.url === "/api/workflows" && x.options.method === "POST",
  ).body.workflow;
  assert.equal(saved.edges.length, 5);
  assert.equal(saved.edges[0].input, "camera");
  assert.equal(saved.edges[1].input, "model");
  assert.deepEqual(saved.nodes.find((n) => n.type === "filter").params.rules, [
    { field: "label", operator: "eq", value: "car" },
    { field: "identity", operator: "neq", value: "Guest" },
  ]);
  assert.match(h.root.innerHTML, /Delete workflow/);
  h.window.spyderWorkflows.unmount();
});

test("code language switches to JavaScript and test endpoint receives chosen language", async () => {
  const h = mountHarness();
  await h.flush();
  const id = addNode(h, "code");
  h.root.dispatch("dblclick", h.target("[data-node]", { node: id }));
  const language = h.target("[data-param]", { param: "language" });
  language.value = "javascript";
  h.root.dispatch("change", language);
  assert.match(h.root.innerHTML, /JavaScript code/);
  h.root.dispatch("click", h.target("button", { codeTest: "" }));
  h.root.querySelector("[data-test-input]").value = "[]";
  h.root.dispatch("click", h.target("button", { runTest: "" }));
  await h.flush();
  const call = h.calls.find((x) => x.url === "/api/workflows/code/test");
  assert.equal(call.body.language, "javascript");
  assert.equal(call.body.source, "output = detections;");
  h.window.spyderWorkflows.unmount();
});

test("import file applies disabled draft and showcase avoids model API requests", async () => {
  const h = mountHarness({ showcase: true });
  await h.flush();
  const graph = faceTemplate();
  graph.name = "Imported";
  graph.enabled = true;
  const file = h.target("[data-import-file]");
  file.files = [{ size: 200, text: async () => JSON.stringify(graph) }];
  h.root.dispatch("change", file);
  await h.flush();
  assert.match(h.root.innerHTML, /value="Imported"/);
  assert.match(h.root.innerHTML, /Imported as a disabled draft/);
  assert.equal(h.calls.length, 0);
  h.window.spyderWorkflows.unmount();
});

test("InsightFace notification template wires camera/model/filter/cooldown and starts disabled", () => {
  const graph = insightfaceTemplate({
    cameraId: "cam-1",
    modelId: "model-1",
    identity: "Alice",
    confidence: 0.8,
  });
  assert.equal(graph.enabled, false);
  assert.deepEqual(graph.camera_ids, []);
  assert.deepEqual(
    graph.nodes.map((n) => n.type),
    ["camera", "model", "detections", "filter", "cooldown", "notification"],
  );
  assert.equal(graph.nodes[0].params.camera_id, "cam-1");
  assert.equal(graph.nodes[1].params.model_id, "model-1");
  assert.equal(graph.nodes[2].params.engine, "insightface");
  assert.equal(graph.nodes[3].params.label, "face");
  assert.equal(graph.nodes[3].params.identity, "Alice");
  assert.equal(graph.nodes[3].params.confidence, 0.8);
  assert.equal(graph.nodes[4].params.seconds, 10);
  assert.deepEqual(validate(graph), []);
  assert.equal(graph.edges[0].input, "camera");
  assert.equal(graph.edges[1].input, "model");
  const restored = decodeWorkflow(encodeWorkflow(graph));
  assert.equal(restored.nodes.at(-1).type, "notification");
});

test("template button preselects local InsightFace model and makes matching filter editable", async () => {
  const h = mountHarness({
    initialModels: [
      { id: "other", name: "Objects", engine: "yolo", classes: ["person"] },
      {
        id: "faces",
        name: "Faces",
        engine: "insightface",
        classes: ["face"],
        metadata: {
          model_type: "face_classifier",
          label_semantics: "identity",
        },
      },
    ],
  });
  await h.flush();
  loadTemplate(h, "insightface-alert");
  assert.match(h.root.innerHTML, /InsightFace detection alert draft created/);
  assert.match(
    h.root.innerHTML,
    /Classifier identity<\/span><select data-param="identity"/,
  );
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const graph = h.calls.find(
    (c) => c.url === "/api/workflows" && c.options.method === "POST",
  ).body.workflow;
  assert.equal(graph.nodes[0].params.camera_id, "cam-1");
  const detection = graph.nodes.find((n) => n.type === "detections"),
    classifier = graph.nodes.find((n) => n.type === "classifier");
  assert.equal(classifier.params.model_id, "faces");
  assert.equal(detection.params.detector, undefined);
  assert.equal(
    graph.nodes.find((n) => n.type === "model").params.model_id,
    "builtin-scrfd-500mf",
  );
  assert.ok(
    graph.edges.some(
      (edge) => edge.to === detection.id && edge.input === "classifier",
    ),
  );
  assert.equal(graph.enabled, false);
  h.window.spyderWorkflows.unmount();
});

test("InsightFace template omits classifier when no compatible upload exists", async () => {
  const h = mountHarness({
    initialModels: [
      { id: "detector", engine: "insightface", classes: ["face"] },
    ],
  });
  await h.flush();
  loadTemplate(h, "insightface-alert");
  assert.match(h.root.innerHTML, /SCRFD 500MF/);
  assert.doesNotMatch(h.root.innerHTML, /we-node-classifier/);
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const graph = h.calls.find(
    (call) => call.url === "/api/workflows" && call.options.method === "POST",
  ).body.workflow;
  assert.equal(
    graph.nodes.some((item) => item.type === "classifier"),
    false,
  );
  assert.equal(
    graph.nodes.find((item) => item.type === "model").params.model_id,
    "builtin-scrfd-500mf",
  );
  h.window.spyderWorkflows.unmount();
});

test("workflow activation previews before saving and confirms motion replacement", async () => {
  const h = mountHarness({
    fetcher: (url) =>
      url === "/api/workflows/activation-preview"
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              cameras: [
                {
                  id: "cam-1",
                  name: "Camera one",
                  current_pipeline: "motion",
                  target_engine: "insightface",
                  motion_enabled: true,
                  replaces_motion_pipeline: true,
                },
              ],
              requires_motion_confirmation: true,
            }),
          }
        : undefined,
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { activate: "" }));
  await h.flush();
  assert.match(h.root.innerHTML, /role="dialog"/);
  assert.match(h.root.innerHTML, /Motion detection will be disabled/);
  assert.match(h.root.innerHTML, /Camera one/);
  assert.equal(
    h.calls.some(
      (call) => call.url === "/api/workflows" && call.options.method === "POST",
    ),
    false,
    "preview alone must not mutate workflow or camera state",
  );
  h.root.dispatch("click", h.target("button", { activationConfirm: "" }));
  await h.flush();
  const previewIndex = h.calls.findIndex(
      (call) => call.url === "/api/workflows/activation-preview",
    ),
    save = h.calls.find(
      (call) => call.url === "/api/workflows" && call.options.method === "POST",
    );
  assert.ok(previewIndex >= 0);
  assert.ok(save);
  assert.equal(save.body.workflow.enabled, true);
  assert.equal(save.body.disable_motion, true);
  assert.ok(
    h.calls.findIndex(
      (call) => call.url === "/api/workflows" && call.options.method === "POST",
    ) > previewIndex,
  );
  h.window.spyderWorkflows.unmount();
});

test("activation cancellation and stale review never save a workflow", async () => {
  const h = mountHarness({
    fetcher: (url) =>
      url === "/api/workflows/activation-preview"
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              cameras: [
                { id: "cam-1", name: "Camera one", motion_enabled: true },
              ],
              requires_motion_confirmation: true,
            }),
          }
        : undefined,
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { activate: "" }));
  await h.flush();
  h.root.dispatch("click", h.target("button", { activationCancel: "" }));
  assert.equal(
    h.calls.some(
      (call) => call.url === "/api/workflows" && call.options.method === "POST",
    ),
    false,
  );
  h.root.dispatch("click", h.target("button", { activate: "" }));
  await h.flush();
  const name = h.target("[data-name]");
  name.value = "Changed while reviewing";
  h.root.dispatch("input", name);
  h.root.dispatch("click", h.target("button", { activationConfirm: "" }));
  await h.flush();
  assert.equal(
    h.calls.some(
      (call) => call.url === "/api/workflows" && call.options.method === "POST",
    ),
    false,
  );
  assert.match(h.root.innerHTML, /changed during activation review/i);
  h.window.spyderWorkflows.unmount();
});

test("no-impact activation saves directly and enabled save also previews", async () => {
  const h = mountHarness({
    fetcher: (url) =>
      url === "/api/workflows/activation-preview"
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              cameras: [{ id: "cam-1", motion_enabled: false }],
              requires_motion_confirmation: false,
            }),
          }
        : {
            ok: true,
            status: 200,
            json: async () =>
              url === "/api/models"
                ? { models: [] }
                : url.endsWith("/vision")
                  ? { id: "cam-1", pipeline: "none", settings: {}, runtime: {} }
                  : { workflows: [], events: [] },
          },
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { activate: "" }));
  await h.flush();
  assert.ok(
    h.calls.some((call) => call.url === "/api/workflows/activation-preview"),
  );
  assert.ok(
    h.calls.some(
      (call) =>
        call.url === "/api/workflows" &&
        call.options.method === "POST" &&
        call.body.workflow.enabled,
    ),
  );
  assert.match(h.root.innerHTML, /Disable workflow/);
  const previews = h.calls.filter(
    (call) => call.url === "/api/workflows/activation-preview",
  ).length;
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  assert.equal(
    h.calls.filter((call) => call.url === "/api/workflows/activation-preview")
      .length,
    previews + 1,
  );
  h.window.spyderWorkflows.unmount();
});

test("disable saves an inactive workflow while camera pipeline remains untouched", async () => {
  const active = {
    id: "workflow-active",
    name: "Active",
    enabled: true,
    camera_ids: [],
    nodes: [],
    edges: [],
  };
  const h = mountHarness({
    fetcher: (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url === "/api/models"
          ? { models: [] }
          : url.endsWith("/vision")
            ? {
                id: "cam-1",
                pipeline: "insightface",
                settings: {},
                runtime: {},
              }
            : { workflows: [active], events: [] },
    }),
  });
  await h.flush();
  assert.match(h.root.innerHTML, /Disable workflow/);
  h.root.dispatch("click", h.target("button", { activate: "" }));
  await h.flush();
  const saved = h.calls.find(
    (call) => call.url === "/api/workflows" && call.options.method === "POST",
  );
  assert.equal(saved.body.workflow.enabled, false);
  assert.equal(saved.body.disable_motion, undefined);
  assert.match(h.root.innerHTML, /inference idles when unused/i);
  assert.equal(
    h.calls.some((call) => call.url === "/api/workflows/activation-preview"),
    false,
  );
  h.window.spyderWorkflows.unmount();
});

test("class identity mode offers connected model classes and keeps custom choice", async () => {
  const h = mountHarness({
    initialModels: [
      {
        id: "faces",
        name: "Faces",
        engine: "insightface",
        classes: ["face", "person"],
        metadata: {
          model_type: "face_classifier",
          label_semantics: "identity",
        },
      },
    ],
  });
  await h.flush();
  loadTemplate(h, "insightface-alert");
  const source = h.target("[data-param]", { param: "identity_source" });
  source.value = "class";
  h.root.dispatch("change", source);
  assert.match(h.root.innerHTML, /<option value="face"/);
  assert.match(
    h.root.innerHTML,
    /Classifier identity or model class<\/span><select data-param="identity"/,
  );
  h.root.dispatch("click", h.target("button", { addRule: "" }));
  const field = h.target("[data-rule]", { rule: "0", ruleKey: "field" });
  field.value = "identity";
  h.root.dispatch("change", field);
  assert.match(
    h.root.innerHTML,
    /data-rule="0" data-rule-key="value" aria-describedby="[^"]+"><option value="">Choose an identity/,
  );
  h.window.spyderWorkflows.unmount();
});

test("independent motion on a non-face workflow does not show a disable-motion warning", async () => {
  const h = mountHarness({
    fetcher: (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url === "/api/workflows/activation-preview"
          ? {
              cameras: [
                {
                  id: "cam-1",
                  target_engine: "yolo",
                  motion_enabled: true,
                  disable_motion: false,
                  replaces_motion_pipeline: false,
                },
              ],
              requires_motion_confirmation: false,
            }
          : url === "/api/models"
            ? { models: [] }
            : url.endsWith("/vision")
              ? { settings: {}, runtime: {} }
              : { workflows: [], events: [] },
    }),
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { activate: "" }));
  await h.flush();
  assert.doesNotMatch(h.root.innerHTML, /data-activation-modal/);
  const saved = h.calls.find(
    (c) => c.url === "/api/workflows" && c.options.method === "POST",
  );
  assert.equal(saved.body.workflow.enabled, true);
  assert.equal(saved.body.disable_motion, undefined);
  h.window.spyderWorkflows.unmount();
});

test("class identity without metadata retains editable text and import preserves its source", async () => {
  const h = mountHarness();
  await h.flush();
  loadTemplate(h, "insightface-alert");
  const modelId = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)].at(
    -1,
  )[1];
  h.root.dispatch("dblclick", h.target("[data-node]", { node: modelId }));
  const modelChoice = h.target("[data-param]", { param: "model_id" });
  modelChoice.value = "";
  h.root.dispatch("change", modelChoice);
  const filterId = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)][2][1];
  h.root.dispatch("dblclick", h.target("[data-node]", { node: filterId }));
  const source = h.target("[data-param]", { param: "identity_source" });
  source.value = "class";
  h.root.dispatch("change", source);
  assert.match(
    h.root.innerHTML,
    /Model class \(optional\)<\/span><input data-param="identity"/,
  );
  assert.match(h.root.innerHTML, /No class metadata available/);
  const graph = insightfaceTemplate();
  graph.nodes.find((n) => n.type === "filter").params.identity_source = "class";
  const imported = decodeWorkflow(encodeWorkflow(graph));
  assert.equal(
    imported.nodes.find((n) => n.type === "filter").params.identity_source,
    "class",
  );
  h.window.spyderWorkflows.unmount();
});

test("failed activation leaves workflow disabled and reports server error", async () => {
  const h = mountHarness({
    fetcher: (url, options) => ({
      ok: !(url === "/api/workflows" && options.method === "POST"),
      status: 400,
      json: async () =>
        url === "/api/workflows/activation-preview"
          ? { cameras: [], requires_motion_confirmation: false }
          : url === "/api/models"
            ? { models: [] }
            : url.endsWith("/vision")
              ? { settings: {}, runtime: {} }
              : options.method === "POST"
                ? { error: "Camera is unavailable" }
                : { workflows: [], events: [] },
    }),
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { activate: "" }));
  await h.flush();
  assert.match(h.root.innerHTML, /Camera is unavailable/);
  assert.match(h.root.innerHTML, />Enable workflow<\/button>/);
  assert.doesNotMatch(h.root.innerHTML, />Disable workflow<\/button>/);
  h.window.spyderWorkflows.unmount();
});

test("activation timeout reconciles server state and retains the draft", async () => {
  let saved = null;
  const h = mountHarness({
    fetcher: (url, options) => {
      if (url === "/api/workflows" && options.method === "POST") {
        saved = JSON.parse(options.body).workflow;
        throw Object.assign(Error("signal is aborted without reason"), {
          name: "AbortError",
        });
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          url === "/api/workflows/activation-preview"
            ? { cameras: [], requires_motion_confirmation: false }
            : url === "/api/models"
              ? { models: [] }
              : url.endsWith("/vision")
                ? { settings: {}, runtime: {} }
                : { workflows: saved ? [saved] : [], events: [] },
      };
    },
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { activate: "" }));
  await h.flush();
  assert.match(h.root.innerHTML, /Server reports workflow enabled/);
  assert.match(h.root.innerHTML, />Disable workflow<\/button>/);
  assert.match(h.root.innerHTML, /Draft edits are retained/);
  h.window.spyderWorkflows.unmount();
});

test("wire trash deletes only its connection and undo restores it", async () => {
  const h = mountHarness();
  await h.flush();
  loadTemplate(h, "face-event");
  const ids = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.match(h.root.innerHTML, /class="we-wire-trash"/);
  assert.match(h.root.innerHTML, /class="we-wire-hit"/);
  h.root.dispatch(
    "click",
    h.target("button", { deleteEdge: `${ids[0]}|${ids[1]}` }),
  );
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  let saved = h.calls
    .filter((c) => c.url === "/api/workflows" && c.options.method === "POST")
    .at(-1).body.workflow;
  assert.equal(saved.nodes.length, 4);
  assert.equal(saved.edges.length, 2);
  assert.ok(!saved.edges.some((e) => e.from === ids[0] && e.to === ids[1]));
  h.root.dispatch("click", h.target("button", { undo: "" }));
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  saved = h.calls
    .filter((c) => c.url === "/api/workflows" && c.options.method === "POST")
    .at(-1).body.workflow;
  assert.equal(saved.edges.length, 3);
  h.window.spyderWorkflows.unmount();
});

test("dragging connected IN moves the existing wire, cancellation and cycles keep it", async () => {
  const h = mountHarness();
  await h.flush();
  loadTemplate(h, "face-event");
  const ids = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)].map(
    (m) => m[1],
  );
  const input = (id) =>
    h.target(
      "[data-port]",
      { port: "in", input: "detections" },
      h.target("[data-node]", { node: id }),
    );
  h.root.dispatch("pointerdown", input(ids[1]), { pointerId: 7 });
  h.document.dispatch("pointercancel", h.root, { pointerId: 7 });
  h.root.dispatch("pointerdown", input(ids[2]), { pointerId: 8 });
  h.setHitTarget(input(ids[1]));
  h.document.dispatch("pointerup", h.root, { pointerId: 8 });
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  let saved = h.calls
    .filter((c) => c.url === "/api/workflows" && c.options.method === "POST")
    .at(-1).body.workflow;
  assert.deepEqual(saved.edges, [
    { from: ids[0], to: ids[1] },
    { from: ids[1], to: ids[2] },
    { from: ids[2], to: ids[3] },
  ]);
  h.root.dispatch("pointerdown", input(ids[1]), { pointerId: 9 });
  h.setHitTarget(input(ids[3]));
  h.document.dispatch("pointerup", h.root, { pointerId: 9 });
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  saved = h.calls
    .filter((c) => c.url === "/api/workflows" && c.options.method === "POST")
    .at(-1).body.workflow;
  assert.equal(saved.edges.length, 3);
  assert.equal(saved.nodes.length, 4);
  assert.ok(saved.edges.some((e) => e.from === ids[0] && e.to === ids[3]));
  assert.ok(!saved.edges.some((e) => e.from === ids[0] && e.to === ids[1]));
  h.window.spyderWorkflows.unmount();
});

test("unconnected IN creates a wire and a shared IN asks which wire to reconnect", async () => {
  const h = mountHarness();
  await h.flush();
  loadTemplate(h, "face-event");
  const ids = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)].map(
    (m) => m[1],
  );
  h.root.dispatch("click", h.target("button", { add: "filter" }));
  const extra = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)].at(
    -1,
  )[1];
  const input = (id) =>
    h.target(
      "[data-port]",
      { port: "in", input: "detections" },
      h.target("[data-node]", { node: id }),
    );
  const out = h.target(
    "[data-port]",
    { port: "out" },
    h.target("[data-node]", { node: ids[0] }),
  );
  h.root.dispatch("pointerdown", input(extra), { pointerId: 10 });
  h.setHitTarget(out);
  h.document.dispatch("pointerup", h.root, { pointerId: 10 });
  h.root.querySelector("[data-from]").value = ids[0];
  h.root.querySelector("[data-to]").value = ids[3];
  h.root.dispatch("click", h.target("button", { connect: "" }));
  h.root.dispatch("pointerdown", input(ids[3]), { pointerId: 11 });
  assert.match(h.root.innerHTML, /Drag the connection to move its IN end/);
  assert.match(h.root.innerHTML, /data-reconnect-edge=/);
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const saved = h.calls
    .filter((c) => c.url === "/api/workflows" && c.options.method === "POST")
    .at(-1).body.workflow;
  assert.equal(saved.edges.length, 5);
  h.window.spyderWorkflows.unmount();
});

test("settings signal drop creates live link; fixed class drop restores literal and undo works", async () => {
  const h = mountHarness({
    initialModels: [
      {
        id: "faces",
        name: "Faces",
        engine: "insightface",
        classes: ["face", "person"],
        metadata: {
          model_type: "face_classifier",
          label_semantics: "identity",
        },
      },
    ],
  });
  await h.flush();
  loadTemplate(h, "insightface-alert");
  const ids = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)].map(
    (m) => m[1],
  );
  h.root.dispatch("dblclick", h.target("[data-node]", { node: ids[3] }));
  assert.match(h.root.innerHTML, /IN · Upstream data/);
  assert.match(h.root.innerHTML, /OUT · Available data/);
  const signal = h.target("[data-signal-node]", {
    signalNode: ids[2],
    signalName: "classes",
  });
  h.root.dispatch("dragstart", signal, { dataTransfer: { setData() {} } });
  h.root.dispatch(
    "drop",
    h.target("[data-bind-field]", { bindField: "identity" }),
  );
  assert.match(h.root.innerHTML, /data-unbind="identity"/);
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  let saved = h.calls
    .filter((c) => c.url === "/api/workflows" && c.options.method === "POST")
    .at(-1).body.workflow;
  assert.deepEqual(saved.nodes[3].bindings.identity, {
    node: ids[2],
    signal: "classes",
  });
  assert.equal(saved.nodes[3].params.identity_source, "class");
  h.root.dispatch(
    "dragstart",
    h.target("[data-signal-node]", {
      signalNode: ids[2],
      signalName: "classes",
      signalMode: "fixed",
      signalValue: "person",
    }),
    { dataTransfer: { setData() {} } },
  );
  h.root.dispatch(
    "drop",
    h.target("[data-bind-field]", { bindField: "identity" }),
  );
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  saved = h.calls
    .filter((c) => c.url === "/api/workflows" && c.options.method === "POST")
    .at(-1).body.workflow;
  assert.equal(saved.nodes[3].params.identity, "person");
  assert.equal(saved.nodes[3].bindings?.identity, undefined);
  h.root.dispatch("click", h.target("button", { undo: "" }));
  assert.match(h.root.innerHTML, /data-unbind="identity"/);
  h.window.spyderWorkflows.unmount();
});

test("incompatible signal is rejected and deleting source connection clears downstream bindings", async () => {
  const h = mountHarness({
    initialModels: [
      {
        id: "faces",
        engine: "insightface",
        classes: ["face"],
        metadata: {
          model_type: "face_classifier",
          label_semantics: "identity",
        },
      },
    ],
  });
  await h.flush();
  loadTemplate(h, "insightface-alert");
  const ids = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)].map(
    (m) => m[1],
  );
  h.root.dispatch(
    "click",
    h.target("[data-signal-node]", {
      signalNode: ids[2],
      signalName: "classes",
    }),
  );
  h.root.dispatch("click", h.target("button", { useSignal: "confidence" }));
  assert.match(
    h.root.querySelector(".we-issues").textContent,
    /compatible upstream signal/,
  );
  h.root.dispatch("click", h.target("button", { useSignal: "identity" }));
  h.root.dispatch(
    "click",
    h.target("button", { deleteEdge: `${ids[2]}|${ids[1]}` }),
  );
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const saved = h.calls
    .filter((c) => c.url === "/api/workflows" && c.options.method === "POST")
    .at(-1).body.workflow;
  assert.equal(saved.nodes[3].bindings, undefined);
  assert.equal(saved.nodes.length, 7);
  h.window.spyderWorkflows.unmount();
});

test("import/export retains valid bindings and rejects dangling or incompatible links", () => {
  const graph = insightfaceTemplate();
  graph.nodes[3].bindings = {
    identity: { node: graph.nodes[2].id, signal: "classes" },
  };
  const imported = decodeWorkflow(encodeWorkflow(graph));
  assert.deepEqual(imported.nodes[3].bindings, graph.nodes[3].bindings);
  graph.nodes[3].bindings.identity.node = graph.nodes[5].id;
  assert.throws(
    () => decodeWorkflow(encodeWorkflow(graph)),
    /Invalid data link/,
  );
  graph.nodes[3].bindings = {
    confidence: { node: graph.nodes[2].id, signal: "classes" },
  };
  assert.throws(
    () => decodeWorkflow(encodeWorkflow(graph)),
    /Invalid data link/,
  );
});

test("removing a filter rule shifts remaining data links and unlink restores literal editing", async () => {
  const h = mountHarness({
    initialModels: [
      {
        id: "faces",
        engine: "insightface",
        classes: ["face"],
        metadata: {
          model_type: "face_classifier",
          label_semantics: "identity",
        },
      },
    ],
  });
  await h.flush();
  loadTemplate(h, "insightface-alert");
  const ids = [...h.root.innerHTML.matchAll(/data-node="([^"]+)"/g)].map(
    (m) => m[1],
  );
  h.root.dispatch("click", h.target("button", { addRule: "" }));
  h.root.dispatch("click", h.target("button", { addRule: "" }));
  const field = h.target("[data-rule]", { rule: "1", ruleKey: "field" });
  field.value = "identity";
  h.root.dispatch("change", field);
  const source = h.target("[data-param]", { param: "identity_source" });
  source.value = "class";
  h.root.dispatch("change", source);
  const literal = h.target("[data-rule]", { rule: "1", ruleKey: "value" });
  literal.value = "face";
  h.root.dispatch("change", literal);
  h.root.dispatch(
    "click",
    h.target("[data-signal-node]", {
      signalNode: ids[2],
      signalName: "classes",
    }),
  );
  h.root.dispatch("click", h.target("button", { useSignal: "rules.1.value" }));
  h.root.dispatch("click", h.target("button", { removeRule: "0" }));
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  let saved = h.calls
    .filter((c) => c.url === "/api/workflows" && c.options.method === "POST")
    .at(-1).body.workflow;
  assert.deepEqual(saved.nodes[3].bindings, {
    "rules.0.value": { node: ids[2], signal: "classes" },
  });
  h.root.dispatch("click", h.target("button", { unbind: "rules.0.value" }));
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  saved = h.calls
    .filter((c) => c.url === "/api/workflows" && c.options.method === "POST")
    .at(-1).body.workflow;
  assert.equal(saved.nodes[3].bindings?.["rules.0.value"], undefined);
  assert.equal(saved.nodes[3].params.rules[0].value, "face");
  h.window.spyderWorkflows.unmount();
});

test("late model metadata refreshes open signal panels without rebuilding edited settings", async () => {
  let deliverModels;
  const graph = insightfaceTemplate({ cameraId: "cam-1", modelId: "faces" });
  const h = mountHarness({
    fetcher: (url) =>
      url === "/api/models"
        ? new Promise((resolve) => {
            deliverModels = resolve;
          })
        : {
            ok: true,
            status: 200,
            json: async () =>
              url.endsWith("/vision")
                ? { settings: {}, runtime: {} }
                : { workflows: [graph], events: [] },
          },
  });
  await h.flush();
  h.root.dispatch(
    "dblclick",
    h.target("[data-node]", { node: graph.nodes[3].id }),
  );
  const before = h.root.assignments;
  const input = h.root.querySelector('[data-param="identity"]');
  input.value = "Unsaved person";
  deliverModels({
    ok: true,
    status: 200,
    json: async () => ({
      models: [
        { id: "faces", engine: "insightface", classes: ["face", "person"] },
      ],
    }),
  });
  await h.flush();
  assert.equal(
    h.root.assignments,
    before,
    "metadata must not replace the form",
  );
  assert.equal(input.value, "Unsaved person");
  assert.match(
    h.root.querySelector('.we-signals[aria-label="IN signals"]').outerHTML,
    /data-signal-value="person"/,
  );
  h.window.spyderWorkflows.unmount();
});

test("classifier library shows identities and explicit adapter compatibility warning", async () => {
  const h = mountHarness({
    initialModels: [
      {
        id: "classified",
        name: "CBE100_Classified",
        engine: "insightface",
        classes: ["one", "two"],
        metadata: {
          model_type: "face_classifier",
          label_semantics: "identity",
          input_size: "[112, 112]",
          compatibility:
            "Face identity classifier: a classifier adapter is required.",
          unknown_rejection: "none; always selects a trained identity",
        },
      },
    ],
  });
  await h.flush();
  assert.match(h.root.innerHTML, /2 identities/);
  assert.match(h.root.innerHTML, /Model role: face_classifier/);
  assert.match(h.root.innerHTML, /classifier adapter is required/);
  assert.match(h.root.innerHTML, /always selects a trained identity/);
  assert.match(h.root.innerHTML, /data-inspect-model="classified"/);
  h.window.spyderWorkflows.unmount();
});

test("Read file metadata reinspects an existing model and refreshes labels", async () => {
  let model = {
    id: "classified",
    name: "CBE100_Classified",
    engine: "insightface",
    classes: [],
  };
  const h = mountHarness({
    fetcher: (url) => {
      if (url === "/api/models/classified/inspect")
        model = {
          ...model,
          classes: ["one", "two"],
          metadata: {
            label_semantics: "identity",
            model_type: "face_classifier",
          },
        };
      return {
        ok: true,
        status: 200,
        json: async () =>
          url === "/api/models"
            ? { models: [model] }
            : url.endsWith("/inspect")
              ? model
              : url.endsWith("/vision")
                ? { settings: {}, runtime: {} }
                : { workflows: [], events: [] },
      };
    },
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { inspectModel: "classified" }));
  await h.flush();
  const request = h.calls.find(
    (c) => c.url === "/api/models/classified/inspect",
  );
  assert.equal(request.options.method, "POST");
  assert.deepEqual(request.body, {});
  assert.match(h.root.innerHTML, /2 identities/);
  assert.match(h.root.innerHTML, /Read 2 identities from model metadata/);
  h.window.spyderWorkflows.unmount();
});

test("ambiguous model metadata exposes source choices, explanations and explicit selection", async () => {
  let model = {
    id: "ambiguous",
    name: "Vendor model",
    engine: "insightface",
    classes: [],
    metadata: {
      resolution: "ambiguous",
      explanation: "Two label fields conflict.",
      label_candidates: [
        {
          path: "/vendor/people",
          count: 2,
          preview: ["one", "two"],
          confidence: "review",
          reason: "Unknown header needs review.",
        },
        {
          path: "/classes",
          count: 2,
          preview: ["cat", "dog"],
          confidence: "high",
          reason: "Recognized label key.",
        },
      ],
    },
  };
  const h = mountHarness({
    fetcher: (url, options) => {
      if (url === "/api/models/ambiguous/inspect") {
        const body = JSON.parse(options.body);
        model = {
          ...model,
          classes: ["one", "two"],
          metadata: {
            ...model.metadata,
            label_source: body.label_source,
            resolution: "selected",
          },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () =>
          url === "/api/models"
            ? { models: [model] }
            : url.endsWith("/inspect")
              ? model
              : url.endsWith("/vision")
                ? { settings: {}, runtime: {} }
                : { workflows: [], events: [] },
      };
    },
  });
  await h.flush();
  assert.match(h.root.innerHTML, /Two label fields conflict/);
  assert.match(h.root.innerHTML, /data-label-source="ambiguous"/);
  assert.match(h.root.innerHTML, /\/vendor\/people/);
  const source = h.root.querySelector('[data-label-source="ambiguous"]');
  source.value = "/vendor/people";
  h.root.dispatch("click", h.target("button", { useLabelSource: "ambiguous" }));
  await h.flush();
  const request = h.calls.find(
    (c) => c.url === "/api/models/ambiguous/inspect",
  );
  assert.deepEqual(request.body, { label_source: "/vendor/people" });
  assert.match(h.root.innerHTML, /value="\/vendor\/people" selected/);
  source.value = "";
  h.root.dispatch("click", h.target("button", { useLabelSource: "ambiguous" }));
  await h.flush();
  assert.equal(
    h.calls.filter((c) => c.url === "/api/models/ambiguous/inspect").at(-1).body
      .label_source,
    null,
  );
  h.window.spyderWorkflows.unmount();
});

test("activation rejection is prominent and checking never relabels draft Save as Saving", async () => {
  let resolvePreview;
  const h = mountHarness({
    fetcher: (url) =>
      url === "/api/workflows/activation-preview"
        ? new Promise((resolve) => {
            resolvePreview = resolve;
          })
        : {
            ok: true,
            status: 200,
            json: async () =>
              url === "/api/models"
                ? { models: [] }
                : url.endsWith("/vision")
                  ? { settings: {}, runtime: {} }
                  : { workflows: [], events: [] },
          },
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { activate: "" }));
  await h.flush();
  assert.match(h.root.innerHTML, />Checking workflow…<\/button>/);
  assert.doesNotMatch(h.root.innerHTML, />Saving…<\/button>/);
  resolvePreview({
    ok: false,
    status: 400,
    json: async () => ({
      error:
        "This model is a face identity classifier; classifier inference needs a separate adapter.",
    }),
  });
  await h.flush();
  assert.match(h.root.innerHTML, /data-activation-status/);
  assert.match(h.root.innerHTML, /role="alert"/);
  assert.match(h.root.innerHTML, /face identity classifier/);
  assert.match(h.root.innerHTML, /data-activate >Enable workflow/);
  assert.match(h.root.innerHTML, /data-save >Save workflow/);
  assert.equal(h.root.querySelector("[data-activation-status]").focused, true);
  h.root.dispatch("click", h.target("button", { activate: "" }));
  await h.flush();
  assert.equal(
    h.calls.filter((c) => c.url === "/api/workflows/activation-preview").length,
    2,
  );
  assert.match(h.root.innerHTML, />Checking workflow…<\/button>/);
  assert.equal(
    h.calls.some(
      (c) => c.url === "/api/workflows" && c.options.method === "POST",
    ),
    false,
  );
  h.window.spyderWorkflows.unmount();
});

test("poll synchronizes server enabled status while preserving unsaved workflow edits", async () => {
  const graph = {
    id: "saved",
    name: "Saved",
    enabled: true,
    camera_ids: [],
    nodes: [],
    edges: [],
  };
  const h = mountHarness({
    fetcher: (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url === "/api/models"
          ? { models: [] }
          : url.endsWith("/vision")
            ? { settings: {}, runtime: {} }
            : { workflows: [graph], events: [] },
    }),
  });
  await h.flush();
  const name = h.target("[data-name]");
  name.value = "Unsaved edit";
  h.root.dispatch("input", name);
  graph.enabled = false;
  const timer = [...h.pendingTimers.values()].find((t) => t.ms === 5000);
  assert.ok(timer);
  timer.fn();
  await h.flush();
  assert.equal(
    h.root.querySelector("[data-activate]").textContent,
    "Enable workflow",
  );
  assert.equal(
    h.root.querySelector("[data-workflow-state]").textContent,
    "Independent execution disabled",
  );
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const saved = h.calls.find(
    (c) => c.url === "/api/workflows" && c.options.method === "POST",
  );
  assert.ok(saved);
  assert.equal(saved.body.workflow.name, "Unsaved edit");
  assert.equal(saved.body.workflow.enabled, false);
  h.window.spyderWorkflows.unmount();
});

test("aborted compatibility response never proceeds to activation", async () => {
  const h = mountHarness({
    fetcher: (url) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (url === "/api/workflows/activation-preview")
          throw Object.assign(Error("signal aborted"), { name: "AbortError" });
        return url === "/api/models"
          ? { models: [] }
          : url.endsWith("/vision")
            ? { settings: {}, runtime: {} }
            : { workflows: [], events: [] };
      },
    }),
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { activate: "" }));
  await h.flush();
  assert.equal(
    h.calls.some(
      (c) => c.url === "/api/workflows" && c.options.method === "POST",
    ),
    false,
  );
  assert.match(h.root.innerHTML, /Compatibility check timed out/);
  assert.match(h.root.innerHTML, />Enable workflow<\/button>/);
  h.window.spyderWorkflows.unmount();
});

test("clean polling updates activation controls after another tab changes state", async () => {
  const graph = {
    id: "shared",
    name: "Shared",
    enabled: false,
    camera_ids: [],
    nodes: [],
    edges: [],
  };
  const h = mountHarness({
    fetcher: (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url === "/api/models"
          ? { models: [] }
          : url.endsWith("/vision")
            ? { settings: {}, runtime: {} }
            : { workflows: [graph], events: [] },
    }),
  });
  await h.flush();
  graph.enabled = true;
  [...h.pendingTimers.values()].find((t) => t.ms === 5000).fn();
  await h.flush();
  assert.equal(
    h.root.querySelector("[data-activate]").textContent,
    "Disable workflow",
  );
  assert.equal(
    h.root.querySelector("[data-workflow-state]").textContent,
    "Independent execution enabled",
  );
  graph.enabled = false;
  [...h.pendingTimers.values()].find((t) => t.ms === 5000).fn();
  await h.flush();
  assert.equal(
    h.root.querySelector("[data-activate]").textContent,
    "Enable workflow",
  );
  assert.equal(
    h.root.querySelector("[data-workflow-state]").textContent,
    "Independent execution disabled",
  );
  h.window.spyderWorkflows.unmount();
});

test("Model node owns the default detector; Detections contains no detector chooser", async () => {
  assert.equal(node("model").params.model_id, "builtin-scrfd-500mf");
  assert.equal(node("detections").params.detector, undefined);
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "model" }));
  assert.match(h.root.innerHTML, /InsightFace built-in detectors/);
  assert.match(h.root.innerHTML, /value="builtin-scrfd-500mf" selected/);
  assert.match(h.root.innerHTML, /Local detector availability/);
  h.root.dispatch("click", h.target("button", { add: "detections" }));
  const engine = h.target("[data-param]", { param: "engine" });
  engine.value = "insightface";
  h.root.dispatch("change", engine);
  assert.doesNotMatch(h.root.innerHTML, /data-param="detector"/);
  assert.doesNotMatch(h.root.innerHTML, /we-detector-catalog/);
  assert.match(
    h.root.innerHTML,
    /Choose an InsightFace detector in a connected Model node/,
  );
  h.window.spyderWorkflows.unmount();
});

test("legacy built-in detector selection migrates deterministically to a portable Model node", () => {
  for (const detector of ["scrfd-500mf", "scrfd-2.5gf", "scrfd-10gf"]) {
    const graph = faceTemplate();
    graph.nodes[0].params = { engine: "insightface", detector };
    const migrated = migrateDetectorNodes(graph),
      model = migrated.nodes.find((n) => n.type === "model");
    assert.ok(model);
    assert.equal(
      model.params.model_id,
      `builtin-${detector.replace(".", "-")}`,
    );
    assert.equal(migrated.nodes[0].params.detector, undefined);
    assert.ok(
      migrated.edges.some(
        (e) =>
          e.from === model.id &&
          e.to === graph.nodes[0].id &&
          e.input === "model",
      ),
    );
    assert.deepEqual(migrateDetectorNodes(graph), migrated);
    assert.deepEqual(migrateDetectorNodes(migrated), migrated);
    assert.equal(
      graph.nodes[0].params.detector,
      detector,
      "original saved object remains untouched",
    );
    const restored = decodeWorkflow(encodeWorkflow(migrated));
    assert.equal(
      restored.nodes.find((n) => n.type === "model").params.model_id,
      model.params.model_id,
    );
    assert.deepEqual(validate(restored), []);
  }
});

test("detector migration preserves custom models, legacy camera pipelines and workflow size limits", () => {
  const graph = insightfaceTemplate({ modelId: "uploaded" }),
    detection = graph.nodes.find((n) => n.type === "detections");
  detection.params.detector = "retinaface";
  const migrated = migrateDetectorNodes(graph);
  assert.equal(
    migrated.nodes.find((n) => n.type === "model").params.model_id,
    "uploaded",
  );
  assert.equal(
    migrated.nodes.find((n) => n.type === "detections").params.detector,
    undefined,
  );
  const legacy = faceTemplate();
  legacy.nodes[0].params.engine = "insightface";
  assert.deepEqual(migrateDetectorNodes(legacy), legacy);
  legacy.nodes[0].params.detector = "scrfd-500mf";
  while (legacy.nodes.length < 64) legacy.nodes.push(node("event"));
  assert.equal(migrateDetectorNodes(legacy).nodes.length, 64);
  assert.equal(
    migrateDetectorNodes(legacy).nodes[0].params.detector,
    "scrfd-500mf",
  );
});

test("Classifier stability controls save and import with conservative defaults", async () => {
  const h = mountHarness();
  await h.flush();
  h.root.dispatch("click", h.target("button", { add: "classifier" }));
  assert.match(h.root.innerHTML, /Confirm identity after/);
  assert.match(h.root.innerHTML, /Confirm identity switch after/);
  assert.match(h.root.innerHTML, /Minimum lead over runner-up/);
  for (const [key, value] of [
    ["confirmations", 4],
    ["switch_confirmations", 6],
    ["margin", 0.2],
  ]) {
    const field = h.target("[data-param]", { param: key });
    field.value = String(value);
    h.root.dispatch("change", field);
  }
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const saved = h.calls.find(
    (call) => call.url === "/api/workflows" && call.options.method === "POST",
  ).body.workflow;
  assert.equal(saved.nodes[0].params.confirmations, 4);
  assert.equal(saved.nodes[0].params.switch_confirmations, 6);
  assert.equal(saved.nodes[0].params.margin, 0.2);
  const restored = decodeWorkflow(encodeWorkflow(saved));
  assert.equal(restored.nodes[0].params.margin, 0.2);
  h.window.spyderWorkflows.unmount();
});

test("desktop permission belongs to Notification node gestures rather than editor startup", async () => {
  const h = mountHarness();
  let uses = 0;
  h.window.spyderNotifications = {
    useNode: () => {
      uses++;
      return Promise.resolve(false);
    },
    desktopStatus: () => "Permission not yet requested",
    desktopEnabled: () => false,
  };
  await h.flush();
  assert.equal(uses, 0);
  assert.doesNotMatch(h.root.innerHTML, /data-notification-permission/);
  h.root.dispatch("click", h.target("button", { add: "filter" }));
  assert.equal(uses, 0);
  h.root.dispatch("click", h.target("button", { add: "notification" }));
  assert.equal(uses, 1);
  assert.match(h.root.innerHTML, /PC \/ browser notifications/);
  assert.match(h.root.innerHTML, /data-notification-permission/);
  assert.match(h.root.innerHTML, /Send test notification/);
  loadTemplate(h, "insightface-alert");
  assert.equal(uses, 2);
  h.window.spyderWorkflows.unmount();
});

test("showcase rejects code execution even when disabled controls receive synthetic events", async () => {
  const h = mountHarness({ showcase: true });
  await h.flush();
  const id = addNode(h, "code");
  h.root.dispatch("dblclick", h.target("[data-node]", { node: id }));
  h.root.dispatch("click", h.target("button", { codeTest: "" }));
  h.root.dispatch("click", h.target("button", { runTest: "" }));
  await h.flush();
  assert.equal(h.calls.length, 0);
  assert.doesNotMatch(h.root.innerHTML, /data-test-pane/);
  h.window.spyderWorkflows.unmount();
});

test("palette groups contain each node once and search by name or function", () => {
  const groups = paletteGroups();
  assert.deepEqual(
    groups.flatMap((g) => g.types).sort(),
    Object.keys(TYPES).sort(),
  );
  assert.deepEqual(
    paletteGroups("PREVIEW").flatMap((g) => g.types),
    ["preview"],
  );
  assert.deepEqual(paletteGroups("nonexistent"), []);
  assert.equal(paletteGroups("vision")[0].types.includes("filter"), true);
});

test("model library search, filters and pagination are stable and do not mutate source order", () => {
  const models = Array.from({ length: 64 }, (_, i) => ({
    id: `model-${i}`,
    name: `Model ${64 - i}`,
    engine: i % 2 ? "yolo" : "insightface",
    classes: i % 3 ? ["Alice"] : [],
    path: `C:/models/file-${i}.onnx`,
  }));
  const original = models.map((m) => m.id);
  const first = modelPage(models);
  assert.equal(first.models[0].name, "Model 1");
  assert.equal(first.models.length, 8);
  assert.equal(first.pages, 8);
  const last = modelPage(models, { page: 999 });
  assert.equal(last.page, 7);
  assert.equal(last.models.length, 8);
  const filtered = modelPage(models, {
    query: "ALICE",
    engine: "yolo",
    labels: "available",
  });
  assert.ok(filtered.total > 8);
  assert.ok(
    filtered.models.every(
      (m) => m.engine === "yolo" && m.classes.includes("Alice"),
    ),
  );
  assert.equal(modelPage(models, { query: "file-2.onnx" }).total, 1);
  assert.ok(
    modelPage(models, { labels: "missing" }).models.every(
      (m) => !m.classes.length,
    ),
  );
  assert.equal(modelPage(models, { query: "no matching model" }).total, 0);
  assert.deepEqual(
    models.map((m) => m.id),
    original,
  );
});

test("toolbar rows, grouped scrollable palette and camera section render independently", async () => {
  const h = mountHarness();
  await h.flush();
  assert.match(
    h.root.innerHTML,
    /we-toolbar-identity[\s\S]*data-workflow[\s\S]*data-name[\s\S]*we-toolbar-actions[\s\S]*we-activation-main[\s\S]*data-activate[\s\S]*data-workflow-state/,
  );
  assert.match(h.root.innerHTML, /data-copy-node/);
  assert.match(h.root.innerHTML, /data-paste-node/);
  assert.match(h.root.innerHTML, /data-palette-search/);
  assert.match(h.root.innerHTML, /data-palette-group="Inputs &amp; models"/);
  assert.match(
    h.root.innerHTML,
    /<section class="we-camera-panel"><h3>Cameras<\/h3><div class="we-cameras">/,
  );
  const before = h.root.assignments;
  const search = h.target("[data-palette-search]");
  search.value = "preview";
  h.root.dispatch("input", search);
  const palette = h.root.querySelector(".we-palette").innerHTML;
  assert.match(palette, /data-add="preview"/);
  assert.doesNotMatch(palette, /data-add="camera"/);
  assert.equal(
    h.root.assignments,
    before,
    "search must not replace workflow canvas",
  );
  h.window.spyderWorkflows.unmount();
});

test("library filter controls update results without replacing the canvas or search control", async () => {
  const h = mountHarness({
    initialModels: Array.from({ length: 20 }, (_, i) => ({
      id: `m-${i}`,
      name: `Entry ${i}`,
      engine: i % 2 ? "yolo" : "insightface",
      classes: [`class-${i}`],
    })),
  });
  await h.flush();
  const before = h.root.assignments;
  const search = h.target("[data-library-search]");
  search.value = "Entry 19";
  h.root.dispatch("input", search);
  let html = h.root.querySelector("[data-library-results]").innerHTML;
  assert.match(html, /Entry 19/);
  assert.doesNotMatch(html, /data-library-model="m-18"/);
  h.root.dispatch("click", h.target("button", { libraryClear: "" }));
  html = h.root.querySelector("[data-library-results]").innerHTML;
  assert.match(html, /Page 1 of 3/);
  h.root.dispatch("click", h.target("button", { libraryNext: "" }));
  assert.match(
    h.root.querySelector("[data-library-results]").innerHTML,
    /Page 2 of 3/,
  );
  assert.equal(h.root.assignments, before);
  h.window.spyderWorkflows.unmount();
});

test("removing an uploaded model requires inline confirmation and sends guarded empty payload", async () => {
  let models = [
    {
      id: "remove-me",
      name: "Unused weights",
      engine: "yolo",
      classes: [],
      uploaded: true,
      usage: { in_use: false, references: [] },
    },
  ];
  const h = mountHarness({
    fetcher: (url) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (url === "/api/models") return { models };
        if (url === "/api/models/remove-me/remove") {
          models = [];
          return { removed: true, id: "remove-me", deleted_file: true };
        }
        return { workflows: [], events: [] };
      },
    }),
  });
  await h.flush();
  h.root.dispatch(
    "click",
    h.target("button", { requestRemoveModel: "remove-me" }),
  );
  assert.match(
    h.root.querySelector("[data-library-results]").innerHTML,
    /deletes the uploaded model file/,
  );
  assert.equal(
    h.calls.some((c) => c.url.endsWith("/remove")),
    false,
  );
  h.root.dispatch("click", h.target("button", { cancelRemoveModel: "" }));
  assert.equal(
    h.calls.some((c) => c.url.endsWith("/remove")),
    false,
  );
  h.root.dispatch(
    "click",
    h.target("button", { requestRemoveModel: "remove-me" }),
  );
  h.root.dispatch(
    "click",
    h.target("button", { confirmRemoveModel: "remove-me" }),
  );
  await h.flush();
  const call = h.calls.find((c) => c.url === "/api/models/remove-me/remove");
  assert.deepEqual(call.body, {});
  assert.equal(call.options.headers["X-Spyder-Control"], "1");
  assert.match(
    h.root.querySelector("[data-library-status]").textContent,
    /deleted/,
  );
  h.window.spyderWorkflows.unmount();
});

test("saved usage and current unsaved draft references both block library removal", async () => {
  const h = mountHarness({
    initialModels: [
      {
        id: "used",
        name: "Used model",
        engine: "yolo",
        classes: [],
        usage: { in_use: true, references: ["Workflow Entrance / node model"] },
      },
      {
        id: "draft-model",
        name: "Draft model",
        engine: "insightface",
        classes: ["Alice"],
        metadata: { model_type: "face_classifier" },
      },
    ],
  });
  await h.flush();
  h.root.dispatch("click", h.target("button", { confirmRemoveModel: "used" }));
  await h.flush();
  assert.equal(
    h.calls.some((c) => c.url.endsWith("/remove")),
    false,
  );
  h.root.dispatch("click", h.target("button", { libraryUse: "draft-model" }));
  assert.match(h.root.innerHTML, /Classifier node/);
  h.root.dispatch(
    "click",
    h.target("button", { confirmRemoveModel: "draft-model" }),
  );
  await h.flush();
  assert.equal(
    h.calls.some((c) => c.url.endsWith("/remove")),
    false,
  );
  h.root.dispatch("click", h.target("button", { save: "" }));
  await h.flush();
  const saved = h.calls.find(
    (c) => c.url === "/api/workflows" && c.options.method === "POST",
  ).body.workflow;
  assert.equal(
    saved.nodes.find((n) => n.type === "classifier").params.model_id,
    "draft-model",
  );
  assert.equal(
    h.calls.some((c) => c.url.endsWith("/vision")),
    false,
  );
  h.window.spyderWorkflows.unmount();
});

test("pre-event template connects lightweight InsightFace and unknown identity filtering", () => {
  const graph = preEventTemplate({
    cameraId: "front",
    classifierId: "face-classes",
  });
  assert.equal(graph.enabled, false);
  assert.deepEqual(
    graph.nodes.map((n) => n.type),
    [
      "camera",
      "model",
      "classifier",
      "detections",
      "filter",
      "cooldown",
      "event",
    ],
  );
  const [camera, model, classifier, detection, filter, cooldown, event] =
    graph.nodes;
  assert.equal(camera.params.camera_id, "front");
  assert.equal(model.params.model_id, "builtin-scrfd-500mf");
  assert.equal(classifier.params.model_id, "face-classes");
  assert.equal(detection.params.engine, "insightface");
  assert.equal(filter.params.label, "face");
  assert.equal(filter.params.identity_source, "identity");
  assert.deepEqual(filter.params.rules, [
    { field: "identity", operator: "is_unknown", value: "" },
  ]);
  assert.equal(cooldown.params.seconds, 45);
  for (const [input, source] of [
    ["camera", camera],
    ["model", model],
    ["classifier", classifier],
  ])
    assert.ok(
      graph.edges.some(
        (e) =>
          e.from === source.id && e.to === detection.id && e.input === input,
      ),
    );
  assert.equal(event.params.attachment, "recording");
  assert.equal(event.params.pre_event_seconds, 10);
  assert.equal(event.params.duration_seconds, 20);
  assert.match(event.params.message, /Unknown face/);
  assert.deepEqual(validate(graph), []);
  assert.deepEqual(
    decodeWorkflow(encodeWorkflow(graph)).nodes.find((n) => n.type === "filter")
      .params.rules,
    filter.params.rules,
  );
  const second = createWorkflowTemplate("pre-event-person", {
    cameraId: "back",
  });
  assert.notEqual(second.id, graph.id);
  assert.equal(
    second.nodes.find((n) => n.type === "classifier").params.model_id,
    "",
  );
  second.nodes.at(-1).params.pre_event_seconds = 1;
  assert.equal(event.params.pre_event_seconds, 10);
  filter.params.identity_source = "class";
  assert.match(validate(graph).join(" "), /Recognized identity/);
});

test("template catalog describes requirements and supports purpose search", () => {
  assert.equal(new Set(TEMPLATE_CATALOG.map((t) => t.id)).size, 3);
  for (const entry of TEMPLATE_CATALOG) {
    assert.ok(
      entry.name &&
        entry.description &&
        entry.purpose &&
        entry.details &&
        entry.setup,
    );
    assert.ok(entry.requirements.length);
    assert.equal(createWorkflowTemplate(entry.id).enabled, false);
  }
  assert.deepEqual(
    templateEntries("unknown recording").map((t) => t.id),
    ["pre-event-person"],
  );
  assert.deepEqual(
    templateEntries("  IDENTITY  ").map((t) => t.id),
    ["insightface-alert"],
  );
  assert.equal(templateEntries("no-such-template").length, 0);
  assert.throws(
    () => createWorkflowTemplate("unknown"),
    /Unknown workflow template/,
  );
});

test("template picker browses without modifying draft or requesting permissions", async () => {
  const h = mountHarness({ showcase: true });
  await h.flush();
  const name = h.target("[data-name]");
  name.value = "Keep this draft";
  h.root.dispatch("input", name);
  const before = h.local.get("spyder.workflow-editor.draft");
  h.root.dispatch("click", h.target("button", { openTemplates: "" }));
  assert.match(h.root.innerHTML, /Workflow templates/);
  assert.match(h.root.innerHTML, /aria-labelledby="we-template-title"/);
  assert.equal(
    (h.root.innerHTML.match(/class="we-template-thumbnail"/g) || []).length,
    3,
  );
  assert.match(h.root.innerHTML, /10s before · 20s after/);
  assert.match(h.root.innerHTML, /Idle recorder/);
  assert.match(
    h.root.innerHTML,
    /Showcase: templates are editable local drafts/,
  );
  const search = h.target("[data-template-search]");
  search.value = "unknown recording";
  h.root.dispatch("input", search);
  assert.match(
    h.root.querySelector("[data-template-list]").innerHTML,
    /Pre-event unknown face recording/,
  );
  assert.doesNotMatch(
    h.root.querySelector("[data-template-list]").innerHTML,
    /InsightFace detection alert/,
  );
  search.value = "nonexistent";
  h.root.dispatch("input", search);
  assert.match(
    h.root.querySelector("[data-template-list]").innerHTML,
    /No templates match/,
  );
  h.root.dispatch("keydown", search, { key: "Escape" });
  assert.doesNotMatch(h.root.innerHTML, /data-template-modal/);
  assert.equal(h.local.get("spyder.workflow-editor.draft"), before);
  assert.equal(h.root.querySelector("[data-open-templates]").focused, true);
  assert.equal(h.calls.length, 0);
  h.window.spyderWorkflows.unmount();
});

test("loading pre-event template creates disabled draft and undo restores unsaved work", async () => {
  const h = mountHarness({ showcase: true });
  await h.flush();
  const name = h.target("[data-name]");
  name.value = "My unsaved work";
  h.root.dispatch("input", name);
  const before = JSON.parse(h.local.get("spyder.workflow-editor.draft"));
  loadTemplate(h, "pre-event-person");
  const after = JSON.parse(h.local.get("spyder.workflow-editor.draft"));
  assert.notEqual(after.id, before.id);
  assert.equal(after.enabled, false);
  assert.equal(after.nodes[0].params.camera_id, "cam-1");
  assert.equal(after.nodes.at(-1).params.pre_event_seconds, 10);
  assert.doesNotMatch(h.root.innerHTML, /data-template-modal/);
  assert.match(h.root.innerHTML, /Review settings, save, then enable/);
  h.root.dispatch("click", h.target("button", { undo: "" }));
  assert.deepEqual(
    JSON.parse(h.local.get("spyder.workflow-editor.draft")),
    before,
  );
  assert.equal(h.calls.length, 0);
  h.window.spyderWorkflows.unmount();
});

test("node field help covers every parameter and moves explanations into hidden tooltips", () => {
  for (const [type, schema] of Object.entries(TYPES)) {
    for (const field of Object.keys(schema.params)) {
      if (field !== "rules")
        assert.ok(FIELD_HELP[field], `${type}.${field} has no help`);
    }
  }
  const original =
    '<label>After trigger<input data-param="duration_seconds" type="number" min="1" max="300" step="1" value="20"></label><p>Existing explanation.</p>';
  const result = fieldHelpMarkup(original, { id: "event-test", type: "event" });
  assert.match(result, /we-field-label">After trigger<\/span><input/);
  assert.match(result, /aria-describedby="we-help-event-test-params-1"/);
  assert.match(result, /data-field-help="we-help-event-test-params-1"/);
  assert.match(result, /aria-expanded="false"/);
  assert.match(result, /role="tooltip" hidden/);
  assert.match(result, /whole seconds from 1 to 300/);
  assert.match(result, /<span>Existing explanation\.<\/span>/);
  assert.doesNotMatch(result, /<p>/);
  assert.match(result, /type="number" min="1" max="300" step="1" value="20"/);
});

test("field help includes rules and connection fields with unique safe identifiers", () => {
  const html =
    '<label>Field<select data-rule="0" data-rule-key="field"><option>Class</option></select></label>' +
    '<label>Value<input data-rule="0" data-rule-key="value" value="person"></label>' +
    '<label>Label<input data-edge-label="a|b" maxlength="80"></label>';
  const result = fieldHelpMarkup(
    html,
    { id: 'node-"bad', type: "filter" },
    "connections",
  );
  assert.match(result, /Class compares label/);
  assert.match(result, /Confidence comparisons accept a number from 0 to 1/);
  assert.match(result, /Optional connection label/);
  const ids = [...result.matchAll(/role="tooltip" hidden/g)];
  assert.equal(ids.length, 3);
  assert.equal(
    new Set([...result.matchAll(/id="(we-help-[^"]+)"/g)].map((m) => m[1]))
      .size,
    3,
  );
  assert.doesNotMatch(result, /id="we-help-node-"bad/);
});

test("field help preserves existing descriptions and keeps live statuses visible", () => {
  const result = fieldHelpMarkup(
    '<label>Title<input data-param="title" aria-describedby="existing-help"></label><p role="status">Delivery unavailable</p>',
    { id: "alert", type: "notification" },
  );
  assert.match(
    result,
    /aria-describedby="existing-help we-help-alert-params-1"/,
  );
  assert.match(result, /<\/div><p role="status">Delivery unavailable<\/p>/);
});

test("unknown identity conditions need no value and remain editable in the filter", async () => {
  const h = mountHarness({ showcase: true });
  await h.flush();
  loadTemplate(h, "pre-event-person");
  const graph = JSON.parse(h.local.get("spyder.workflow-editor.draft"));
  const filter = graph.nodes.find((n) => n.type === "filter");
  assert.match(h.root.innerHTML, /Face · Is unknown/);
  assert.match(h.root.innerHTML, /Record · 10s before · 20s after/);
  h.root.dispatch("dblclick", h.target("[data-node]", { node: filter.id }));
  assert.match(h.root.innerHTML, /value="is_unknown" selected/);
  assert.match(h.root.innerHTML, /placeholder="No value needed" disabled/);
  assert.doesNotMatch(h.root.innerHTML, /data-bind-field="rules.0.value"/);
  const op = h.target("[data-rule]", { rule: "0", ruleKey: "operator" });
  op.value = "eq";
  h.root.dispatch("change", op);
  assert.doesNotMatch(h.root.innerHTML, /placeholder="No value needed"/);
  const value = h.target("[data-rule]", { rule: "0", ruleKey: "value" });
  value.value = "Alice";
  h.root.dispatch("input", value);
  op.value = "is_known";
  h.root.dispatch("change", op);
  const updated = JSON.parse(
    h.local.get("spyder.workflow-editor.draft"),
  ).nodes.find((n) => n.type === "filter");
  assert.deepEqual(updated.params.rules, [
    { field: "identity", operator: "is_known", value: "" },
  ]);
  assert.match(h.root.innerHTML, /placeholder="No value needed" disabled/);
  h.window.spyderWorkflows.unmount();
});

test("workflow picker keeps graph lists out of the toolbar and scopes polls", async () => {
  const h = mountHarness();
  await h.flush();
  assert.match(h.root.innerHTML, /data-open-workflow-manager/);
  assert.doesNotMatch(h.root.innerHTML, /<select data-workflow[ >]/);
  assert.ok(
    h.calls.some(
      (x) =>
        x.url.startsWith("/api/workflows?current=") &&
        x.url.endsWith("&first=1"),
    ),
  );
  assert.ok(
    !h.calls.some(
      (x) => x.url === "/api/workflows" && x.options.method !== "POST",
    ),
  );
  h.window.spyderWorkflows.unmount();
});

test("manager uses paged summaries and fetches only the graph selected", async () => {
  const h = mountHarness({
    fetcher: async (url) => ({
      ok: true,
      json: async () =>
        url.startsWith("/api/workflows/library?")
          ? { items: [], counts: { total: 5000, enabled: 2, disabled: 4998 } }
          : url === "/api/workflows/other"
            ? {
                workflow: {
                  id: "other",
                  name: "Other",
                  enabled: false,
                  camera_ids: [],
                  nodes: [],
                  edges: [],
                },
              }
            : { workflows: [], events: [] },
    }),
  });
  await h.flush();
  let options;
  h.window.spyderWorkflowManager = {
    open: (value) => {
      options = value;
      return {
        close() {
          value.onClose();
        },
      };
    },
  };
  h.root.dispatch("click", h.target("button", { openWorkflowManager: "" }));
  await options.loadPage(
    {
      status: "all",
      camera: "all",
      engine: "all",
      page: 2,
      size: 25,
      query: "Door",
    },
    {},
  );
  const call = h.calls.find((x) => x.url.startsWith("/api/workflows/library?"));
  const query = new URLSearchParams(call.url.split("?")[1]);
  assert.equal(query.get("status"), "");
  assert.equal(query.get("camera"), "");
  assert.equal(query.get("engine"), "");
  assert.equal(query.get("page"), "2");
  assert.ok(!h.calls.some((x) => x.url === "/api/workflows/other"));
  assert.equal(await options.onOpen("other"), true);
  assert.match(h.root.innerHTML, /value="Other"/);
  assert.equal(
    h.calls.filter((x) => x.url === "/api/workflows/other").length,
    1,
  );
  h.window.spyderWorkflows.unmount();
});

test("closed manager cannot replace editor with a late graph fetch", async () => {
  let resolveGraph;
  const h = mountHarness({
    fetcher: async (url) =>
      url === "/api/workflows/late"
        ? new Promise(
            (resolve) =>
              (resolveGraph = () =>
                resolve({
                  ok: true,
                  json: async () => ({
                    workflow: {
                      id: "late",
                      name: "Late workflow",
                      enabled: false,
                      camera_ids: [],
                      nodes: [],
                      edges: [],
                    },
                  }),
                })),
          )
        : { ok: true, json: async () => ({ workflows: [], events: [] }) },
  });
  await h.flush();
  let options;
  h.window.spyderWorkflowManager = {
    open: (value) => {
      options = value;
      return {
        close() {
          value.onClose();
        },
      };
    },
  };
  h.root.dispatch("click", h.target("button", { openWorkflowManager: "" }));
  const result = options.onOpen("late");
  options.onClose();
  resolveGraph();
  assert.equal(await result, false);
  assert.doesNotMatch(h.root.innerHTML, /value="Late workflow"/);
  h.window.spyderWorkflows.unmount();
});

test("toolbar delete opens confirmation manager rather than deleting immediately", async () => {
  const h = mountHarness();
  await h.flush();
  let options;
  h.window.spyderWorkflowManager = {
    open: (value) => {
      options = value;
      return {
        close() {
          value.onClose();
        },
      };
    },
  };
  h.root.dispatch("click", h.target("button", { remove: "" }));
  assert.ok(options.initialDelete.id);
  assert.ok(!h.calls.some((x) => x.url.endsWith("/remove")));
  h.window.spyderWorkflows.unmount();
});

test("demo library save preserves edits made while persistence is pending", async () => {
  const h = mountHarness({ showcase: true });
  await h.flush();
  let complete;
  h.window.spyderWorkflowStore = {
    save: (value) =>
      new Promise((resolve) => {
        complete = () => resolve(value);
      }),
    page: async () => ({ counts: { total: 1, enabled: 0, disabled: 1 } }),
  };
  h.root.dispatch("click", h.target("button", { save: "" }));
  const name = h.target("[data-name]");
  name.value = "Edited during save";
  h.root.dispatch("input", name);
  complete();
  await h.flush();
  let options;
  h.window.spyderWorkflowManager = {
    open: (value) => {
      options = value;
      return {
        close() {
          value.onClose();
        },
      };
    },
  };
  h.root.dispatch("click", h.target("button", { openWorkflowManager: "" }));
  assert.equal(options.isDirty(), true);
  assert.match(h.root.innerHTML, /value="Edited during save"/);
  h.window.spyderWorkflows.unmount();
});

test("library toggle uses saved graph and preserves unsaved editor edits", async () => {
  const saved = {
    id: "saved-flow",
    name: "Saved version",
    enabled: false,
    camera_ids: [],
    nodes: [],
    edges: [],
  };
  let state = structuredClone(saved);
  const h = mountHarness({
    fetcher: async (url, options) => ({
      ok: true,
      json: async () =>
        url === "/api/workflows/saved-flow"
          ? { workflow: state }
          : url.endsWith("/activation-preview")
            ? { cameras: [] }
            : url.endsWith("/enabled")
              ? {
                  workflow: (state = {
                    ...state,
                    enabled: JSON.parse(options.body).enabled,
                  }),
                }
              : { workflows: [], events: [] },
    }),
  });
  await h.flush();
  let options;
  h.window.spyderWorkflowManager = {
    open: (value) => {
      options = value;
      return {
        close() {
          value.onClose();
        },
      };
    },
  };
  h.root.dispatch("click", h.target("button", { openWorkflowManager: "" }));
  await options.onOpen("saved-flow");
  const name = h.target("[data-name]");
  name.value = "Unsaved editor version";
  h.root.dispatch("input", name);
  assert.equal(
    await options.onToggle("saved-flow", true, async () => {
      throw Error("No review expected");
    }),
    true,
  );
  const call = h.calls.find((item) => item.url.endsWith("/enabled"));
  assert.equal(call.body.expected_workflow.name, "Saved version");
  assert.equal(call.body.enabled, true);
  assert.equal(options.isDirty(), true);
  assert.match(h.root.innerHTML, /value="Saved version"/); // Input edits are not rerendered by the toggle.
  assert.equal(
    h.root.querySelector("[data-activate]").textContent,
    "Disable workflow",
  );
  h.window.spyderWorkflows.unmount();
});

test("library activation waits for motion review and cancellation performs no save", async () => {
  const saved = {
    id: "motion-flow",
    name: "Motion flow",
    enabled: false,
    camera_ids: [],
    nodes: [],
    edges: [],
  };
  const h = mountHarness({
    fetcher: async (url) => ({
      ok: true,
      json: async () =>
        url === "/api/workflows/motion-flow"
          ? { workflow: saved }
          : url.endsWith("/activation-preview")
            ? {
                requires_motion_confirmation: true,
                cameras: [
                  {
                    id: "cam-1",
                    name: "Front",
                    disable_motion: true,
                    target_engine: "insightface",
                  },
                ],
              }
            : url.endsWith("/enabled")
              ? { workflow: { ...saved, enabled: true } }
              : { workflows: [], events: [] },
    }),
  });
  await h.flush();
  let options;
  h.window.spyderWorkflowManager = {
    open: (value) => {
      options = value;
      return {
        close() {
          value.onClose();
        },
      };
    },
  };
  h.root.dispatch("click", h.target("button", { openWorkflowManager: "" }));
  let review;
  assert.equal(
    await options.onToggle("motion-flow", true, async (value) => {
      review = value;
      return false;
    }),
    false,
  );
  assert.equal(review.cameras[0].disable_motion, true);
  assert.ok(!h.calls.some((item) => item.url.endsWith("/enabled")));
  await options.onToggle("motion-flow", true, async () => true);
  assert.equal(
    h.calls.find((item) => item.url.endsWith("/enabled")).body.disable_motion,
    true,
  );
  h.window.spyderWorkflows.unmount();
});

test("demo refuses library activation without making requests", async () => {
  const h = mountHarness({ showcase: true });
  await h.flush();
  let options;
  h.window.spyderWorkflowManager = {
    open: (value) => {
      options = value;
      return {
        close() {
          value.onClose();
        },
      };
    },
  };
  h.root.dispatch("click", h.target("button", { openWorkflowManager: "" }));
  await assert.rejects(
    options.onToggle("saved", true, async () => true),
    /showcase/,
  );
  assert.equal(h.calls.length, 0);
  h.window.spyderWorkflows.unmount();
});

test("execution metadata round-trips for independent, callable, and both modes", () => {
  const {
    decodeWorkflow,
    workflowExecution,
  } = require("../src/spyder_cctv/assets/workflow-editor.js");
  const base = {
    id: "mode-test",
    name: "Mode test",
    enabled: false,
    camera_ids: [],
    nodes: [],
    edges: [],
  };
  assert.equal(workflowExecution(base).run_independently, true);
  for (const flags of [
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const execution = {
      run_independently: flags[0],
      allow_calls: flags[1],
      parameters: [],
      description: "Explicit invocation modes",
    };
    const decoded = decodeWorkflow(JSON.stringify({ ...base, execution }));
    assert.deepEqual(decoded.execution, execution);
  }
  assert.throws(
    () =>
      decodeWorkflow(
        JSON.stringify({
          ...base,
          execution: {
            run_independently: false,
            allow_calls: false,
            parameters: [],
            description: "",
          },
        }),
      ),
    /execution settings/,
  );
});
