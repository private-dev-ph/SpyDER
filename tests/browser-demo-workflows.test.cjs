const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const { TextEncoder } = require("node:util");
const source = fs.readFileSync(
  require.resolve("../src/spyder_cctv/assets/browser-demo-workflows.js"),
  "utf8",
);
let frameListener;
const notifications = [];
const saved = new Map();
const recordingCalls = [];
let recordingState = "idle";
let recordingSession = null;
let pendingStartResolve = null;
let deferStart = false;
const localStorage = {
  values: new Map(),
  getItem(key) { return this.values.get(key) ?? null; },
  setItem(key, value) { this.values.set(key, value); },
};
const window = {
  spyderWorkflowStore: {
    async save(graph) { saved.set(graph.id, structuredClone(graph)); return graph; },
    async get(id) { return saved.get(id) || null; },
  },
  spyderShowcase: {
    subscribeFrames(listener) { frameListener = listener; return () => { frameListener = null; }; },
    async fetch(path) {
      if (path === "/api/cameras") return { async json() { return [{ id: "clip-1", name: "Clip 1", state: "running" }]; } };
      return { async json() { return []; } };
    },
    async request(path, data) {
      if (path === "/api/captures") return { id: "capture-1", kind: "capture", filename: "capture.jpg", url: "blob:capture", size_bytes: 10 };
      recordingCalls.push({ path, data });
      if (path === "/api/recordings/start") {
        recordingState = "recording"; recordingSession = "workflow-session";
        if (deferStart) return new Promise((resolve) => { pendingStartResolve = () => resolve({ session_id: recordingSession }); });
        return { session_id: recordingSession };
      }
      if (path === "/api/recordings/stop") { recordingState = "idle"; recordingSession = null; }
    },
  },
  spyderBrowserMedia: { async status() { return { state: recordingState, session_id: recordingSession }; } },
  spyder: { notify(message) { notifications.push(message); } },
  addEventListener() {},
  dispatchEvent(event) { notifications.push(event.detail); },
};
class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
vm.runInNewContext(source, { window, localStorage, CustomEvent, console, structuredClone, JSON, Map, Set, Number, Error, setTimeout, clearTimeout, Response, TextEncoder });

function graph(id, includeUnsupported = false) {
  return {
    id,
    name: id,
    enabled: false,
    nodes: [
      { id: "cam", type: "camera", params: { camera_id: "clip-1" } },
      { id: "motion", type: "browser_motion", params: { threshold: 0.2 } },
      { id: "cool", type: "cooldown", params: { seconds: 2 } },
      { id: "alert", type: "notification", params: { title: id, message: "motion" } },
      ...(includeUnsupported ? [{ id: "model", type: "classifier", params: {} }] : []),
    ],
    edges: [
      { from: "cam", to: "motion", input: "camera" },
      { from: "motion", to: "cool" },
      { from: "cool", to: "alert" },
    ],
  };
}
function frame(frameId, timestamp, motion_fraction = 0.4) {
  return { camera: { id: "clip-1", state: "running" }, canvas: {}, motion_fraction, frameId, timestamp };
}
function recordGraph(id) {
  return {
    id, name: id, enabled: false,
    nodes: [
      { id: "cam", type: "camera", params: { camera_id: "clip-1" } },
      { id: "motion", type: "browser_motion", params: { threshold: 0.2 } },
      { id: "record", type: "record", params: { action: "start" } },
      { id: "event", type: "event", params: { duration_seconds: 1 } },
    ],
    edges: [
      { from: "cam", to: "motion", input: "camera" },
      { from: "motion", to: "record" },
      { from: "record", to: "event" },
    ],
  };
}

(async () => {
  const runtime = window.spyderDemoWorkflowRuntime;
  assert.equal(runtime.inspect(graph("bad", true)).supported, false, "unsupported classifier must block activation");
  assert.match(runtime.inspect(graph("bad", true)).errors.join(" "), /Unsupported browser workflow node/);

  const one = graph("one"), two = graph("two");
  const recordingAttachment = recordGraph("unsupported-event-recording");
  recordingAttachment.nodes.find((node) => node.type === "event").params.attachment = "recording";
  assert.match(runtime.inspect(recordingAttachment).errors.join(" "), /recording attachments are unavailable/);
  await runtime.enable(one);
  await runtime.enable(two);
  assert.equal(saved.get("one").enabled, true);
  assert.equal(typeof frameListener, "function", "enabling subscribes to actual camera frames");

  frameListener(frame(1, 1000));
  frameListener(frame(1, 1000));
  assert.equal(notifications.filter((item) => typeof item === "string" && /motion/i.test(item)).length, 2, "same frame triggers each enabled workflow once");
  frameListener(frame(2, 1500));
  assert.equal(notifications.filter((item) => typeof item === "string" && /motion/i.test(item)).length, 2, "cooldown suppresses repeated motion");
  frameListener(frame(3, 3500));
  assert.equal(notifications.filter((item) => typeof item === "string" && /motion/i.test(item)).length, 4, "cooldown allows later motion in both workflows");

  await runtime.disable("one");
  assert.equal(saved.get("one").enabled, false, "disable persists disabled state");
  frameListener(frame(4, 6000));
  assert.equal(notifications.filter((item) => typeof item === "string" && /motion/i.test(item)).length, 5, "remaining workflow still runs independently");
  await runtime.disable("two");
  assert.equal(frameListener, null, "last disable releases frame subscription");

  const branch = graph("branch");
  branch.nodes.find((node) => node.type === "cooldown").params.seconds = 5;
  branch.nodes.push({ id: "direct", type: "notification", params: { title: "branch-direct", message: "direct" } });
  branch.edges.push({ from: "motion", to: "direct" });
  await runtime.enable(branch);
  frameListener(frame(10, 10000));
  assert.equal(notifications.filter((item) => item === "branch-direct: direct").length, 1);
  frameListener(frame(11, 11500));
  assert.equal(notifications.filter((item) => item === "branch-direct: direct").length, 2, "blocked cooldown branch does not block independent action branch");
  assert.equal(notifications.filter((item) => item === "branch: motion").length, 1, "cooldown blocks only its downstream branch");
  await runtime.disable("branch");

  await runtime.enable(recordGraph("recording"));
  frameListener(frame(5, 7000));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(recordingCalls.map((item) => item.path).filter((path) => path.startsWith("/api/recordings/")), ["/api/recordings/start", "/api/recordings/stop"], "workflow recording stops after event duration");
  const eventResponse = await runtime.fetch("/api/events");
  let eventData = await eventResponse.json();
  assert.equal(eventData.events.length, 1, "Event node stores a real workflow event row");
  const eventId = eventData.events[0].id;
  await runtime.request(`/api/events/${encodeURIComponent(eventId)}/rename`, { name: "Renamed browser event" });
  eventData = await (await runtime.fetch("/api/events")).json();
  assert.equal(eventData.events[0].name, "Renamed browser event");
  await runtime.request("/api/events/delete", { ids: [eventId] });
  assert.equal((await (await runtime.fetch("/api/events")).json()).events.length, 0);
  await runtime.disable("recording");
  assert.equal(await runtime.request("/api/not-owned", {}), undefined, "unknown request routes remain unowned");
  const captureGraph = {
    id: "capture-event", name: "Capture event", enabled: false,
    nodes: [
      { id: "cam", type: "camera", params: { camera_id: "clip-1" } },
      { id: "motion", type: "browser_motion", params: { threshold: 0.2 } },
      { id: "event", type: "event", params: { attachment: "capture", message: "Captured" } },
    ],
    edges: [{ from: "cam", to: "motion", input: "camera" }, { from: "motion", to: "event" }],
  };
  await runtime.enable(captureGraph);
  frameListener(frame(20, 8000));
  await new Promise((resolve) => setTimeout(resolve, 0));
  eventData = await (await runtime.fetch("/api/events")).json();
  assert.equal(eventData.events[0].media[0].url, "blob:capture", "real capture URL is available in current page session");
  assert.doesNotMatch(localStorage.getItem("spyder.workflow.demo.events.v1"), /blob:capture/, "expired blob URL is omitted from persisted event metadata");
  await runtime.disable("capture-event");

  recordingState = "recording";
  recordingSession = "manual-session";
  const recordingCallsBeforeManual = recordingCalls.filter((item) => item.path.startsWith("/api/recordings/")).length;
  await runtime.enable(recordGraph("manual-recording"));
  frameListener(frame(6, 9000));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(recordingCalls.filter((item) => item.path.startsWith("/api/recordings/")).length, recordingCallsBeforeManual, "workflow never takes ownership of manual recording");
  assert.ok(notifications.some((item) => typeof item === "string" && /will not take ownership/.test(item)));
  await runtime.disable("manual-recording");
  recordingState = "idle";
  recordingSession = null;
  assert.equal(frameListener, null, "last disable releases frame subscription");

  deferStart = true;
  await runtime.enable(recordGraph("pending"));
  frameListener(frame(7, 12000));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof pendingStartResolve, "function", "recording start is pending");
  await runtime.disable("pending");
  pendingStartResolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(recordingCalls.filter((item) => item.path === "/api/recordings/stop").length, 2, `disable stops pending workflow-owned session after start resolves: ${JSON.stringify(recordingCalls.filter((item) => item.path.startsWith("/api/recordings/")))}`);
  deferStart = false;
  recordingState = "idle";
  recordingSession = null;
  process.stdout.write("browser demo workflow runtime checks passed\n");
})().catch((error) => { console.error(error); process.exitCode = 1; });
