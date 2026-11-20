const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {
  position,
  playableUrl,
} = require("../../src/spyder_cctv/assets/recording-player.js");
const source = fs.readFileSync(
  require.resolve("../../src/spyder_cctv/assets/recording-player.js"),
  "utf8",
);
const clip = (id = "a") => ({
  id: id.repeat(32),
  url: "/api/media/" + id.repeat(32),
  duration_seconds: 60,
  filename: "Clip.mp4",
});
function harness({ demo = false, fetcher } = {}) {
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.listeners = new Map();
      this.currentTime = 0;
      this.readyState = 0;
      this.duration = 60;
      this.textContent = "";
      this.hidden = false;
      this.isConnected = true;
    }
    append(...els) {
      this.children.push(...els);
    }
    replaceChildren(...els) {
      this.children = els;
    }
    setAttribute(k, v) {
      this[k] = v;
    }
    removeAttribute(k) {
      delete this[k];
    }
    addEventListener(k, f) {
      if (!this.listeners.has(k)) this.listeners.set(k, new Set());
      this.listeners.get(k).add(f);
    }
    removeEventListener(k, f) {
      this.listeners.get(k)?.delete(f);
    }
    dispatch(k) {
      for (const fn of this.listeners.get(k) || []) fn({ target: this });
    }
    pause() {
      this.dispatch("pause");
    }
    play() {
      this.dispatch("play");
      return Promise.resolve();
    }
    load() {}
    remove() {
      this.isConnected = false;
    }
  }
  const events = new Map(),
    timers = new Map(),
    requests = [],
    urls = [],
    revoked = [];
  let serial = 0;
  const document = {
    hidden: false,
    createElement: (tag) => new Element(tag),
    addEventListener: (k, f) => events.set(k, f),
    removeEventListener: (k, f) => {
      if (events.get(k) === f) events.delete(k);
    },
  };
  const window = { ...(demo ? { spyderShowcase: {} } : {}) };
  const context = vm.createContext({
    window,
    document,
    AbortController,
    performance: { now: () => 0 },
    URL: {
      createObjectURL: () => {
        const u = "blob:test-" + urls.length;
        urls.push(u);
        return u;
      },
      revokeObjectURL: (u) => revoked.push(u),
    },
    fetch: async (url, opts) => {
      requests.push({ url, opts });
      return fetcher
        ? fetcher(url, opts)
        : { ok: true, blob: async () => ({}) };
    },
    setTimeout: (fn, ms) => {
      const id = ++serial;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(source, context);
  const container = new Element("section"),
    times = [],
    states = [],
    errors = [];
  let ended = 0;
  const player = window.spyderRecordingPlayer.create(container, {
    onTime: (s) => times.push(s),
    onState: (s) => states.push(s),
    onError: (s) => errors.push(s),
    onEnded: () => ended++,
  });
  const surface = () => container.children[0].children[0];
  const video = () => surface().children[0];
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    player,
    document,
    events,
    timers,
    requests,
    urls,
    revoked,
    video,
    surface,
    times,
    states,
    errors,
    flush,
    get ended() {
      return ended;
    },
  };
}
test("playback accepts only local catalog or blob media and clamps positions", () => {
  assert.equal(playableUrl(clip()), clip().url);
  assert.equal(
    playableUrl({ url: "blob:https://demo.test/a" }),
    "blob:https://demo.test/a",
  );
  for (const url of [
    "https://other.test/video.mp4",
    "/api/media/../../config",
    "javascript:alert(1)",
    "/api/media/short",
  ])
    assert.equal(playableUrl({ url }), null);
  assert.equal(position(-1, 60), 0);
  assert.equal(position(100, 60), 59.999);
  assert.equal(position(NaN, 60), 0);
  assert.equal(position(2, NaN), 0);
});
test("native metadata applies queued seek and speed, then reports playback/end", async () => {
  const h = harness();
  await h.player.load(clip(), { offset: 12, autoplay: true, rate: 2 });
  const video = h.video();
  h.player.seek(18);
  video.readyState = 1;
  video.dispatch("loadedmetadata");
  assert.equal(video.currentTime, 18);
  assert.equal(video.playbackRate, 2);
  assert.deepEqual(h.states, [true]);
  video.currentTime = 24;
  video.dispatch("timeupdate");
  assert.equal(h.times.at(-1), 24);
  video.dispatch("ended");
  assert.equal(h.ended, 1);
  assert.equal(h.times.at(-1), 60);
  h.player.destroy();
  assert.equal(h.events.size, 0);
});
test("compatibility playback seeks locally and releases superseded frame URLs", async () => {
  const h = harness();
  await h.player.load(clip(), { offset: 15 });
  h.video().dispatch("error");
  await h.flush();
  assert.match(h.requests[0].url, /\/frame\?time=15\.000$/);
  assert.equal(h.urls.length, 1);
  h.player.seek(25);
  await h.flush();
  assert.equal(h.revoked.length, 1);
  assert.equal(h.times.at(-1), 25);
  h.player.destroy();
  assert.deepEqual(h.revoked, h.urls);
});
test("demo codec failure never calls local APIs", async () => {
  const h = harness({ demo: true });
  await h.player.load({ ...clip(), url: "blob:local" });
  h.video().dispatch("error");
  await h.flush();
  assert.equal(h.requests.length, 0);
  assert.match(h.errors[0], /cannot play/);
  h.player.destroy();
});
test("switching clips aborts obsolete frames and ignores late responses", async () => {
  let complete;
  const h = harness({
    fetcher: () =>
      new Promise(
        (resolve) =>
          (complete = () => resolve({ ok: true, blob: async () => ({}) })),
      ),
  });
  await h.player.load(clip());
  h.video().dispatch("error");
  await h.flush();
  const old = h.requests[0];
  await h.player.load(clip("b"), { offset: 8 });
  complete();
  await h.flush();
  assert.equal(old.opts.signal.aborted, true);
  assert.equal(h.urls.length, 0);
  assert.equal(h.times.at(-1), 8);
  h.player.destroy();
});
test("hiding the page pauses playback and destroys all pending work", async () => {
  const h = harness();
  await h.player.load(clip(), { autoplay: true });
  h.video().readyState = 1;
  h.video().dispatch("loadedmetadata");
  h.document.hidden = true;
  h.events.get("visibilitychange")();
  assert.equal(h.states.at(-1), false);
  h.player.destroy();
  assert.equal(h.timers.size, 0);
  assert.equal(h.events.size, 0);
});

test("seeking during compatibility playback invalidates the old tick loop", async () => {
  const completions = [];
  const h = harness({
    fetcher: () =>
      new Promise((resolve) =>
        completions.push(() => resolve({ ok: true, blob: async () => ({}) })),
      ),
  });
  await h.player.load(clip());
  h.video().dispatch("error");
  completions.shift()();
  await h.flush();
  h.player.play();
  await h.flush();
  const old = completions.shift();
  h.player.seek(20);
  await h.flush();
  const current = completions.shift();
  old();
  await h.flush();
  assert.equal(
    [...h.timers.values()].filter((t) => t.ms === 200).length,
    0,
    "Obsolete tick must not schedule playback",
  );
  current();
  await h.flush();
  assert.equal(
    [...h.timers.values()].filter((t) => t.ms === 200).length,
    1,
    "Only current seek may continue playback",
  );
  h.player.destroy();
});
