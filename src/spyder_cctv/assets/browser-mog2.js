/* One optional local OpenCV worker, independent bounded state for each camera. */
(() => {
  "use strict";
  const defaults = Object.freeze({
    tracking: false,
    history: 300,
    threshold: 16,
    min_area_percent: 0.5,
    detect_shadows: true,
    learning_rate: -1,
    warmup_frames: 15,
    inference_fps: 5,
    input_width: 320,
  });
  const entries = new Map();
  let worker = null,
    loaded = false,
    loadTimer = null,
    loadStats = {},
    sequence = 0;
  function validate(value = {}) {
    const c = { ...defaults, ...value };
    for (const key of Object.keys(c))
      if (!Object.hasOwn(defaults, key))
        throw Error("Unknown motion setting: " + key);
    for (const [key, min, max, integer] of [
      ["history", 20, 2000, true],
      ["threshold", 4, 128, false],
      ["min_area_percent", 0.01, 25, false],
      ["warmup_frames", 0, 120, true],
      ["inference_fps", 1, 15, false],
    ])
      if (
        typeof c[key] !== "number" ||
        !Number.isFinite(c[key]) ||
        c[key] < min ||
        c[key] > max ||
        (integer && !Number.isInteger(c[key]))
      )
        throw Error("Invalid motion setting: " + key);
    if (
      typeof c.detect_shadows !== "boolean" ||
      typeof c.tracking !== "boolean" ||
      ![320, 480].includes(c.input_width) ||
      !Number.isFinite(c.learning_rate) ||
      (c.learning_rate !== -1 && (c.learning_rate < 0 || c.learning_rate > 1))
    )
      throw Error("Invalid MOG2 options.");
    return c;
  }
  function fail(error) {
    loaded = false;
    clearTimeout(loadTimer);
    worker?.terminate();
    worker = null;
    for (const entry of entries.values()) {
      entry.pending = false;
      entry.sample = null;
      entry.state = "error";
      entry.error = String(error);
    }
  }
  function startWorker() {
    if (worker) return;
    if (typeof Worker !== "function") {
      fail(
        "This browser cannot run a local MOG2 worker. Select frame difference instead.",
      );
      return;
    }
    try {
      const owner = (worker = new Worker("/mog2-worker.js"));
      loadTimer = setTimeout(() => {
        if (worker === owner)
          fail(
            "OpenCV did not load within 30 seconds. Reapply settings to retry, or select frame difference.",
          );
      }, 30000);
      owner.onerror = () => {
        if (worker === owner)
          fail(
            "OpenCV worker failed or was blocked. Camera video remains live; select frame difference or reapply to retry.",
          );
      };
      owner.onmessage = (event) => {
        if (worker !== owner) return;
        const d = event.data;
        if (d.type === "ready") {
          loaded = true;
          clearTimeout(loadTimer);
          loadStats = {
            load_ms: d.load_ms,
            heap_bytes: d.heap_bytes,
            build: d.build,
            mil_available: d.mil_available,
          };
          return;
        }
        if (d.type === "failed") {
          fail(d.error);
          return;
        }
        const entry = entries.get(d.id);
        if (
          !entry ||
          entry.revision !== d.revision ||
          entry.sequence !== d.sequence
        )
          return;
        entry.pending = false;
        if (d.type === "error") {
          entry.state = "error";
          entry.error = d.error;
          entry.sample = null;
          worker?.postMessage({ type: "release", id: d.id });
          return;
        }
        entry.state = d.state;
        entry.sample = {
          mask: new Uint8Array(d.mask),
          width: d.width,
          height: d.height,
        };
        const now = performance.now();
        entry.times.push(now);
        entry.times = entry.times.filter((t) => now - t < 5000);
        entry.count = (entry.count || 0) + 1;
        entry.samples ||= [];
        entry.samples.push(d.processing_ms);
        if (entry.samples.length > 180) entry.samples.shift();
        const ordered = [...entry.samples].sort((a, b) => a - b);
        entry.stats = {
          processed_frames: entry.count,
          mean_processing_ms:
            entry.samples.reduce((a, b) => a + b, 0) / entry.samples.length,
          p95_processing_ms: ordered[Math.floor((ordered.length - 1) * 0.95)],
          processing_ms: d.processing_ms,
          roundtrip_ms: Math.max(0, now - entry.pendingSince),
          heap_bytes: d.heap_bytes,
          region_count: d.region_count,
          regions: d.regions,
          tracks: d.tracks || [],
          track_count: d.track_count || 0,
          tracking_state: d.tracking_state || "disabled",
          tracking_error: d.tracking_error || null,
          tracking_ms: d.tracking_ms || 0,
          tracking_fps: d.tracking_fps || 0,
          max_tracks: 1,
          warmup_remaining: d.warmup_remaining,
          effective_fps:
            entry.times.length > 1
              ? ((entry.times.length - 1) * 1000) / (now - entry.times[0])
              : 0,
          width: d.width,
          height: d.height,
        };
        entry.average = entry.average
          ? entry.average * 0.8 + d.processing_ms * 0.2
          : d.processing_ms;
        entry.updated = now;
      };
    } catch (error) {
      fail(error.message);
    }
  }
  function validateTracking(id, config, clipId) {
    const options = validate(config);
    if (options.tracking && clipId !== "porch-parcel")
      throw Error(
        "Demo MIL is available only for Front porch: person and parcel.",
      );
    if (
      options.tracking &&
      [...entries].some(
        ([key, e]) => key !== id && e.config.tracking && e.state !== "error",
      )
    )
      throw Error(
        "Only one porch feed can use the demo MIL tracker at a time.",
      );
    return options;
  }
  function configure(id, config, clipId = null) {
    const options = validateTracking(id, config, clipId);
    const capacity = [...entries].filter(
      ([key, value]) => key !== id && value.state !== "error",
    ).length;
    release(id, false);
    entries.set(id, {
      revision: ++sequence,
      config: options,
      clip_id: clipId,
      state: "loading",
      pending: false,
      sample: null,
      next: 0,
      average: 0,
      times: [],
      stats: {},
      sourceEpoch: null,
      error: null,
    });
    if (capacity >= 8) {
      const entry = entries.get(id);
      entry.state = "error";
      entry.error =
        "Up to eight MOG2 cameras can share this worker. Select frame difference for additional cameras.";
    } else startWorker();
    return status(id);
  }
  function release(id, terminate = true) {
    if (entries.has(id)) {
      entries.delete(id);
      worker?.postMessage({ type: "release", id });
    }
    if (terminate && ![...entries.values()].some((e) => e.state !== "error")) {
      clearTimeout(loadTimer);
      worker?.terminate();
      worker = null;
      loaded = false;
      loadStats = {};
    }
  }
  function reset(entry, id, sourceEpoch) {
    entry.revision = ++sequence;
    entry.sourceEpoch = sourceEpoch;
    entry.pending = false;
    entry.sample = null;
    entry.updated = null;
    entry.next = 0;
    entry.average = 0;
    entry.times = [];
    entry.stats = {
      ...entry.stats,
      regions: [],
      tracks: [],
      track_count: 0,
      tracking_state: entry.config.tracking ? "warming_up" : "disabled",
      tracking_error: null,
      region_count: 0,
      warmup_remaining: entry.config.warmup_frames,
      effective_fps: 0,
    };
    entry.state = loaded ? "warming_up" : "loading";
    worker?.postMessage({ type: "release", id });
  }
  function analyze(id, canvas, config, sourceEpoch, roi, clipId = null) {
    let entry = entries.get(id);
    if (!entry) {
      configure(id, config, clipId);
      entry = entries.get(id);
    }
    if (entry.state === "error") return null;
    if (entry.sourceEpoch !== sourceEpoch) reset(entry, id, sourceEpoch);
    const now = performance.now();
    if (entry.pending && now - entry.pendingSince > 8000) {
      fail(
        "Motion worker stalled. Reduce analysis resolution/camera count and reapply, or select frame difference.",
      );
      return null;
    }
    if (
      loaded &&
      entry.state !== "error" &&
      !entry.pending &&
      now >= entry.next
    ) {
      const width = entry.config.input_width,
        height = Math.max(
          1,
          Math.min(960, Math.round((canvas.height * width) / canvas.width)),
        );
      entry.canvas ||= document.createElement("canvas");
      if (entry.canvas.width !== width || entry.canvas.height !== height) {
        entry.canvas.width = width;
        entry.canvas.height = height;
      }
      const ctx = entry.canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0, width, height);
      const image = ctx.getImageData(0, 0, width, height);
      entry.pending = true;
      entry.pendingSince = now;
      entry.sequence = ++sequence;
      const interval =
        1000 /
        Math.min(entry.config.inference_fps, 700 / Math.max(1, entry.average));
      // Advance the target cadence rather than rounding every request up to the
      // next video frame; a 6 FPS source can then sustain a 5 FPS analysis target.
      entry.next = entry.next > 0 ? entry.next + interval : now + interval;
      if (entry.next <= now) entry.next = now + interval;
      worker.postMessage(
        {
          type: "frame",
          id,
          revision: entry.revision,
          sequence: entry.sequence,
          width,
          height,
          config: entry.config,
          clip_id: entry.clip_id,
          roi,
          buffer: image.data.buffer,
        },
        [image.data.buffer],
      );
    }
    return entry.updated && now - entry.updated > 2000 ? null : entry.sample;
  }
  function status(id) {
    const e = entries.get(id);
    return e
      ? {
          state: e.state,
          error: e.error,
          ...loadStats,
          ...e.stats,
          heap_bytes: worker
            ? e.stats.heap_bytes || loadStats.heap_bytes || 0
            : 0,
          worker_active: !!worker,
          sample_age_ms: e.updated ? performance.now() - e.updated : null,
        }
      : { state: "idle" };
  }
  window.spyderBrowserMog2 = {
    defaults,
    validate,
    validateTracking,
    configure,
    release,
    analyze,
    status,
  };
  window.addEventListener("pagehide", () => {
    for (const id of [...entries.keys()]) release(id);
  });
})();
