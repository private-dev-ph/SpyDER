/* OpenCV runs only in this local browser worker. No user code or network APIs. */
"use strict";
const models = new Map();
let cvReady = false,
  cvApi = null;
let trackingOwner = null,
  trackSequence = 0;
function releaseTrack(model) {
  model.tracker?.delete();
  model.tracker = null;
  model.track = null;
  model.trackMissed = 0;
}
function destroy(id) {
  const model = models.get(id);
  if (!model) return;
  releaseTrack(model);
  if (trackingOwner === id) trackingOwner = null;
  for (const key of [
    "subtractor",
    "rgba",
    "bgr",
    "gray",
    "mask",
    "regionMask",
    "labels",
    "stats",
    "centroids",
    "kernel",
  ])
    model[key]?.delete();
  models.delete(id);
}
function create(id, width, height, config, revision, clipId) {
  destroy(id);
  if (models.size >= 8)
    throw Error(
      "MOG2 supports up to eight active browser cameras. Use frame difference for additional feeds.",
    );
  if (config.tracking && clipId !== "porch-parcel")
    throw Error(
      "Demo MIL is restricted to the Front porch: person and parcel clip.",
    );
  if (config.tracking && trackingOwner !== null && trackingOwner !== id)
    throw Error("Only one MIL tracker can be enabled in this demo tab.");
  const m = {
    width,
    height,
    config,
    revision,
    frames: 0,
    trackingState: config.tracking ? "warming_up" : "disabled",
    nextTrackUpdate: 0,
    trackingTimes: [],
  };
  if (config.tracking) trackingOwner = id;
  models.set(id, m);
  try {
    m.subtractor = new cvApi.BackgroundSubtractorMOG2(
      config.history,
      config.threshold,
      config.detect_shadows,
    );
    m.rgba = new cvApi.Mat(height, width, cvApi.CV_8UC4);
    if (config.tracking) m.bgr = new cvApi.Mat();
    for (const key of [
      "gray",
      "mask",
      "regionMask",
      "labels",
      "stats",
      "centroids",
    ])
      m[key] = new cvApi.Mat();
    m.kernel = cvApi.getStructuringElement(
      cvApi.MORPH_ELLIPSE,
      new cvApi.Size(3, 3),
    );
  } catch (error) {
    destroy(id);
    throw error;
  }

  return m;
}
function boundedBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite))
    return null;
  const [x, y, w, h] = box,
    left = Math.max(0, Math.round(x)),
    top = Math.max(0, Math.round(y));
  const right = Math.min(width, Math.round(x + w)),
    bottom = Math.min(height, Math.round(y + h));
  return right - left >= 8 && bottom - top >= 8
    ? [left, top, right - left, bottom - top]
    : null;
}
function overlap(a, b) {
  const x = Math.max(a[0], b[0]),
    y = Math.max(a[1], b[1]);
  const area =
    Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x) *
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y);
  return area / (a[2] * a[3] + b[2] * b[3] - area || 1);
}
function updateTrack(m, regions, roi, warmup) {
  if (!m.config.tracking) return [];
  if (warmup) {
    m.trackingState = "warming_up";
    return [];
  }
  if (m.trackingError) return [];
  try {
    if (typeof cvApi.TrackerMIL !== "function")
      throw Error("MIL is unavailable in this OpenCV build.");
    const now = performance.now();
    if (m.track) {
      const matched = regions.some(
        (r) => overlap(m.track.bbox, r.bbox) >= 0.05,
      );
      m.trackMissed = matched ? 0 : (m.trackMissed || 0) + 1;
      if (m.trackMissed > 12) releaseTrack(m);
    }
    if (now < m.nextTrackUpdate) {
      m.trackingState = m.track ? "tracking" : "searching";
      return m.track ? [{ ...m.track, bbox: [...m.track.bbox] }] : [];
    }
    const began = performance.now();
    cvApi.cvtColor(m.rgba, m.bgr, cvApi.COLOR_RGBA2BGR);
    if (m.tracker) {
      const [ok, rect] = m.tracker.update(m.bgr);
      const box = ok
        ? boundedBox(
            [rect.x, rect.y, rect.width, rect.height],
            m.width,
            m.height,
          )
        : null;
      const inside =
        box &&
        (!roi ||
          ((box[0] + box[2] / 2) / m.width >= roi[0] &&
            (box[0] + box[2] / 2) / m.width <= roi[2] &&
            (box[1] + box[3] / 2) / m.height >= roi[1] &&
            (box[1] + box[3] / 2) / m.height <= roi[3]));
      if (inside) m.track.bbox = box;
      else releaseTrack(m);
    }
    if (!m.tracker) {
      const box = regions
        .map((r) => boundedBox(r.bbox, m.width, m.height))
        .find(Boolean);
      if (box) {
        let tracker = new cvApi.TrackerMIL();
        try {
          tracker.init(m.bgr, new cvApi.Rect(...box));
          m.tracker = tracker;
          tracker = null;
        } finally {
          tracker?.delete();
        }
        m.track = { id: ++trackSequence, bbox: box, state: "tracking" };
        m.trackMissed = 0;
      }
    }
    m.trackingMs = performance.now() - began;
    m.nextTrackUpdate = performance.now() + 500;
    if (m.track) {
      m.trackingTimes.push(performance.now());
      m.trackingTimes = m.trackingTimes.filter(
        (t) => performance.now() - t < 5000,
      );
    }
    m.trackingState = m.track ? "tracking" : "searching";
    return m.track ? [{ ...m.track, bbox: [...m.track.bbox] }] : [];
  } catch (error) {
    releaseTrack(m);
    m.trackingError = String(error.message || error);
    m.trackingState = "error";
    return [];
  }
}
function processFrame(data) {
  const { id, revision, width, height, config, buffer, roi } = data;
  if (
    typeof id !== "string" ||
    id.length > 100 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    width > 480 ||
    height < 1 ||
    height > 960 ||
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength !== width * height * 4
  )
    throw Error("Invalid browser motion frame.");
  const started = performance.now();
  let m = models.get(id);
  if (!m || m.revision !== revision || m.width !== width || m.height !== height)
    m = create(id, width, height, config, revision, data.clip_id);
  m.rgba.data.set(new Uint8Array(buffer));
  cvApi.cvtColor(m.rgba, m.gray, cvApi.COLOR_RGBA2GRAY);
  m.subtractor.apply(m.gray, m.mask, config.learning_rate);
  cvApi.threshold(
    m.mask,
    m.mask,
    config.detect_shadows ? 200 : 1,
    255,
    cvApi.THRESH_BINARY,
  );
  cvApi.morphologyEx(m.mask, m.mask, cvApi.MORPH_OPEN, m.kernel);
  cvApi.morphologyEx(m.mask, m.mask, cvApi.MORPH_CLOSE, m.kernel);
  m.frames++;
  const warmup = Math.max(0, config.warmup_frames - m.frames),
    regions = [];
  if (!warmup) {
    m.mask.copyTo(m.regionMask);
    if (Array.isArray(roi)) {
      const left = Math.floor(roi[0] * width),
        top = Math.floor(roi[1] * height),
        right = Math.ceil(roi[2] * width),
        bottom = Math.ceil(roi[3] * height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          if (x < left || x >= right || y < top || y >= bottom)
            m.regionMask.data[y * width + x] = 0;
    }
    const count = cvApi.connectedComponentsWithStats(
      m.regionMask,
      m.labels,
      m.stats,
      m.centroids,
      8,
      cvApi.CV_32S,
    );
    for (let i = 1; i < count; i++) {
      const offset = i * 5,
        area = m.stats.data32S[offset + 4];
      if (area < (width * height * config.min_area_percent) / 100) continue;
      regions.push({
        bbox: Array.from(m.stats.data32S.slice(offset, offset + 4)),
        area_percent: (area / (width * height)) * 100,
      });
    }
    regions.sort((a, b) => b.area_percent - a.area_percent);
    regions.splice(32);
  }
  const tracks = updateTrack(m, regions, roi, warmup);
  const mask = warmup
    ? new Uint8Array(width * height)
    : new Uint8Array(m.mask.data);
  self.postMessage(
    {
      type: "result",
      id,
      revision,
      sequence: data.sequence,
      width,
      height,
      mask: mask.buffer,
      state: warmup ? "warming_up" : "ready",
      warmup_remaining: warmup,
      regions,
      region_count: regions.length,
      tracks,
      track_count: tracks.length,
      tracking_state: m.trackingState,
      tracking_error: m.trackingError || null,
      tracking_ms: m.trackingMs || 0,
      tracking_fps:
        m.trackingTimes.length > 1
          ? ((m.trackingTimes.length - 1) * 1000) /
            (m.trackingTimes.at(-1) - m.trackingTimes[0])
          : 0,
      max_tracks: 1,
      processing_ms: performance.now() - started,
      heap_bytes: cvApi.HEAP8.buffer.byteLength,
    },
    [mask.buffer],
  );
}
self.onmessage = (event) => {
  const d = event.data;
  if (d?.type === "release") {
    destroy(d.id);
    return;
  }
  if (d?.type !== "frame") return;
  try {
    if (!cvReady) throw Error("OpenCV is still loading.");
    processFrame(d);
  } catch (error) {
    self.postMessage({
      type: "error",
      id: d.id,
      revision: d.revision,
      sequence: d.sequence,
      error: String(error.message || error),
    });
  }
};
try {
  const began = performance.now();
  importScripts("/opencv-4.12.0.js");
  const loaded = (module) => {
    if (
      typeof module.BackgroundSubtractorMOG2 !== "function" ||
      typeof module.connectedComponentsWithStats !== "function"
    )
      throw Error("Bundled OpenCV build lacks MOG2 or connected components.");
    cvApi = module;
    cvReady = true;
    self.postMessage({
      type: "ready",
      mil_available:
        typeof module.TrackerMIL === "function" &&
        typeof module.TrackerMIL.prototype.init === "function" &&
        typeof module.TrackerMIL.prototype.update === "function",
      load_ms: performance.now() - began,
      heap_bytes: module.HEAP8.buffer.byteLength,
      build: module.getBuildInformation().slice(0, 220),
    });
  };
  if (self.cv?.then) self.cv.then(loaded);
  else loaded(self.cv);
} catch (error) {
  self.postMessage({ type: "failed", error: String(error.message || error) });
}
