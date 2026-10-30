/* OpenCV runs only in this local browser worker. No user code or network APIs. */
"use strict";
const models = new Map();
let cvReady = false,
  cvApi = null;
function destroy(id) {
  const model = models.get(id);
  if (!model) return;
  for (const key of [
    "subtractor",
    "rgba",
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
function create(id, width, height, config, revision) {
  destroy(id);
  if (models.size >= 8)
    throw Error(
      "MOG2 supports up to eight active browser cameras. Use frame difference for additional feeds.",
    );
  const m = { width, height, config, revision, frames: 0 };
  models.set(id, m);
  try {
    m.subtractor = new cvApi.BackgroundSubtractorMOG2(
      config.history,
      config.threshold,
      config.detect_shadows,
    );
    m.rgba = new cvApi.Mat(height, width, cvApi.CV_8UC4);
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
    m = create(id, width, height, config, revision);
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
