const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  vm = require("node:vm");
const {
  createFeed,
} = require("../src/spyder_cctv/assets/workflow-notifications.js");
const item = (id, extras = {}) => ({
  id,
  title: "Face matched",
  message: "Alice detected",
  camera_id: "cam-1",
  workflow_name: "Entrance",
  ...extras,
});
test("notification feed ignores history and deduplicates fresh matches across polls", () => {
  const calls = [],
    feed = createFeed((n) => calls.push(n));
  assert.deepEqual(
    feed.accept({ session_id: "a", notifications: [item("old")] }),
    [],
  );
  feed.accept({ session_id: "a", notifications: [item("old"), item("new")] });
  feed.accept({ session_id: "a", notifications: [item("old"), item("new")] });
  assert.deepEqual(
    calls.map((n) => n.id),
    ["new"],
  );
  feed.accept({ session_id: "b", notifications: [item("restart-history")] });
  assert.equal(calls.length, 1);
  feed.accept({ session_id: "b", notifications: [item("after-restart")] });
  assert.equal(calls.at(-1).id, "after-restart");
});
test("invalid snapshots do not consume session baseline or deliver malformed alerts", () => {
  const calls = [],
    feed = createFeed((n) => calls.push(n));
  assert.throws(() => feed.accept({ notifications: [] }), /Invalid/);
  feed.accept({ session_id: "a", notifications: [] });
  feed.accept({
    session_id: "a",
    notifications: [
      item("long", { message: "x".repeat(501) }),
      null,
      item("safe"),
    ],
  });
  assert.deepEqual(
    calls.map((n) => n.id),
    ["safe"],
  );
});
function harness({
  demo = false,
  permission = "default",
  preference = "0",
  desktopThrows = false,
  permissionResult = "granted",
} = {}) {
  const pending = new Map(),
    listeners = new Map(),
    docListeners = new Map(),
    requests = [],
    desktop = [],
    notices = [];
  let response = { session_id: "test", notifications: [] },
    sequence = 0,
    permissionCalls = 0;
  class Element {
    constructor() {
      this.children = [];
      this.attributes = {};
      this.handlers = {};
      this.classList = { add() {} };
      this.namespaceURI = "http://www.w3.org/2000/svg";
      this.disabled = false;
    }
    append(...nodes) {
      for (const n of nodes) {
        n.parent = this;
        this.children.push(n);
      }
    }
    get firstElementChild() {
      return this.children[0];
    }
    setAttribute(k, v) {
      this.attributes[k] = v;
    }
    addEventListener(k, fn) {
      this.handlers[k] = fn;
    }
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter((x) => x !== this);
    }
    closest(selector) {
      return selector === "[data-notification-permission]" &&
        this.permissionButton
        ? this
        : null;
    }
  }
  const body = new Element(),
    document = {
      body,
      createElement: () => new Element(),
      createElementNS: () => new Element(),
      addEventListener: (k, fn) => docListeners.set(k, fn),
    };
  class Notification {
    static permission = permission;
    static async requestPermission() {
      permissionCalls++;
      return (Notification.permission = permissionResult);
    }
    constructor(title, options) {
      if (desktopThrows) throw Error("unsupported");
      desktop.push({ title, options });
    }
  }
  const storage = new Map([["spyder.workflow.desktop-alerts", preference]]);
  const window = {
    Notification,
    isSecureContext: true,
    spyder: {
      cameras: () => [{ id: "cam-1", name: "Entrance" }],
      notify: (message) => notices.push(message),
    },
    addEventListener: (k, fn) => listeners.set(k, fn),
    dispatchEvent: (event) => {
      listeners.get(event.type)?.(event);
      return true;
    },
    focus() {},
    ...(demo ? { spyderShowcase: {} } : {}),
  };
  const context = vm.createContext({
    window,
    document,
    AbortController,
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    location: {},
    localStorage: {
      getItem: (k) => storage.get(k),
      setItem: (k, v) => storage.set(k, v),
    },
    fetch: async (path, options) => {
      requests.push({ path, options });
      return { ok: true, json: async () => response };
    },
    setTimeout: (fn, ms) => {
      const id = ++sequence;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
  });
  vm.runInContext(
    fs.readFileSync(
      require.resolve("../src/spyder_cctv/assets/workflow-notifications.js"),
      "utf8",
    ),
    context,
  );
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    body,
    window,
    storage,
    requests,
    desktop,
    notices,
    pending,
    flush,
    listeners,
    async poll(items, activities = []) {
      response = { session_id: "test", notifications: items, activities };
      const entry = [...pending].find(([, p]) => p.ms === 2000);
      assert.ok(entry, "poll scheduled");
      pending.delete(entry[0]);
      await entry[1].fn();
      await flush();
    },
    async clickPermission() {
      const button = new Element();
      button.permissionButton = true;
      await docListeners.get("click")({ target: button });
      return button;
    },
    permissionCalls: () => permissionCalls,
  };
}
test("alerts render safely on any workspace without requesting desktop permission automatically", async () => {
  const h = harness();
  await h.flush();
  assert.equal(h.permissionCalls(), 0);
  await h.poll([item("new", { message: "<img src=x onerror=alert(1)>" })]);
  const card = h.body.children[0].children[0];
  assert.equal(card.children[1].textContent, "<img src=x onerror=alert(1)>");
  assert.match(card.children[2].textContent, /Entrance/);
  assert.equal(h.desktop.length, 0);
  await h.poll([item("new")]);
  assert.equal(h.body.children[0].children.length, 1);
  card.children[3].handlers.click();
  assert.equal(h.body.children[0].children.length, 0);
  h.listeners.get("pagehide")();
  assert.equal(h.pending.size, 1); // Only card expiration timer remains.
});
test("desktop alerts require explicit permission and user opt-in; can be disabled", async () => {
  const h = harness();
  await h.flush();
  const button = await h.clickPermission();
  assert.equal(h.permissionCalls(), 1);
  assert.equal(button.textContent, "Disable desktop alerts");
  await h.poll([item("first")]);
  assert.equal(h.desktop.length, 1);
  assert.equal(h.desktop[0].options.tag, "spyder-first");
  await h.clickPermission();
  await h.poll([item("first"), item("second")]);
  assert.equal(h.desktop.length, 1);
  assert.equal(h.body.children[0].children.length, 2);
});
test("showcase makes no notification API calls or permission requests", async () => {
  const h = harness({ demo: true });
  await h.flush();
  await h.clickPermission();
  assert.equal(h.requests.length, 0);
  assert.equal(h.permissionCalls(), 0);
  assert.equal(h.pending.size, 0);
});
test("unsupported desktop constructor falls back to in-app and alert stack stays bounded", async () => {
  const h = harness({
    permission: "granted",
    preference: "1",
    desktopThrows: true,
  });
  await h.flush();
  await h.poll(Array.from({ length: 8 }, (_, i) => item(`n${i}`)));
  assert.equal(h.body.children[0].children.length, 5);
  assert.equal(h.storage.get("spyder.workflow.desktop-alerts"), "0");
  assert.equal(
    h.body.children[0].children[0].children[0].textContent,
    "Face matched",
  );
});

test("Notification node use requests permission once and coalesces repeated gestures", async () => {
  const h = harness({ preference: null });
  await h.flush();
  assert.equal(h.permissionCalls(), 0);
  const first = h.window.spyderNotifications.useNode();
  const second = h.window.spyderNotifications.useNode();
  await Promise.all([first, second]);
  assert.equal(h.permissionCalls(), 1);
  assert.equal(h.window.spyderNotifications.desktopEnabled(), true);
  assert.equal(h.storage.get("spyder.workflow.desktop-alerts"), "1");
  await h.window.spyderNotifications.useNode();
  assert.equal(h.permissionCalls(), 1);
  await h.poll([item("native")]);
  assert.equal(h.desktop.length, 1);
  const restored = harness({ preference: "1", permission: "granted" });
  await restored.flush();
  assert.equal(restored.window.spyderNotifications.desktopEnabled(), true);
  assert.equal(restored.permissionCalls(), 0);
});

test("denied, dismissed, opted-out and showcase states do not repeatedly prompt", async () => {
  for (const options of [
    { preference: null, permission: "denied" },
    { preference: "0" },
    { preference: null, demo: true },
  ]) {
    const h = harness(options);
    await h.flush();
    await h.window.spyderNotifications.useNode();
    await h.window.spyderNotifications.useNode();
    assert.equal(h.permissionCalls(), 0);
    assert.equal(h.window.spyderNotifications.desktopEnabled(), false);
  }
  const dismissed = harness({ preference: null, permissionResult: "default" });
  await dismissed.flush();
  await dismissed.window.spyderNotifications.useNode();
  await dismissed.window.spyderNotifications.useNode();
  assert.equal(dismissed.permissionCalls(), 1);
  assert.equal(dismissed.window.spyderNotifications.desktopEnabled(), false);
  assert.match(
    dismissed.window.spyderNotifications.desktopStatus(),
    /never prompt for permission automatically/,
  );
});

test("notification polling forwards workflow activities without extra requests or permission prompts", async () => {
  const h = harness();
  await h.flush();
  const delivered = [];
  h.window.addEventListener("spyder:activity-snapshot", (event) =>
    delivered.push(event.detail),
  );
  const activities = [
    { id: "workflow-event", camera_id: "cam-1", created_at: 100 },
  ];
  await h.poll([], activities);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].activities, activities);
  assert.equal(h.requests.length, 2);
  assert.equal(h.permissionCalls(), 0);
});

test("an active storage-full alert survives reload and is delivered once without permission prompts", async () => {
  const delivered = [],
    feed = createFeed((item) => delivered.push(item.id));
  const alert = item("quota", {
    source: "storage",
    active: true,
    camera_id: "system",
  });
  assert.equal(
    feed.accept({
      session_id: "server",
      notifications: [item("history"), alert],
    }).length,
    1,
  );
  feed.accept({ session_id: "server", notifications: [alert] });
  assert.deepEqual(delivered, ["quota"]);
  const h = harness();
  await h.flush();
  await h.poll([alert]);
  assert.equal(h.permissionCalls(), 0);
  assert.equal(h.desktop.length, 0);
  assert.equal(h.body.children[0].children.length, 1);
});
