/* Local browser recording. Media never leaves this tab. */
(() => {
  "use strict";
  const showcase = window.spyderShowcase;
  if (!showcase) return;

  const WIDTH = 1920;
  const HEIGHT = 1080;
  const FPS = 15;
  const MAX_BYTES = 128 * 1024 * 1024;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const captureCanvas = document.createElement("canvas");
  const state = {
    state: "idle",
    camera_ids: [],
    elapsed_seconds: 0,
    frames: 0,
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    error: null,
    items: [],
  };
  let recorder = null;
  let stream = null;
  let timer = null;
  let startedAt = 0;
  let chunks = [];
  let chunkBytes = 0;
  let pendingFrame = false;
  let stopReason = null;
  let retained = new Set();
  let currentIds = [];
  let stopPromise = null;
  let requestQueue = Promise.resolve();

  function snapshot() {
    return { ...state, camera_ids: [...state.camera_ids], items: [...state.items] };
  }
  function safeName(value) {
    return String(value || "showcase")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "showcase";
  }
  function filename(kind, extension) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `spyder-${kind}-${stamp}.${extension}`;
  }
  function makeItem(blob, kind, name, duration, createdAt = new Date()) {
    const item = {
      id: `recording-${crypto.randomUUID()}`,
      kind,
      filename: name,
      created_at: createdAt.toISOString(),
      size_bytes: blob.size,
      url: URL.createObjectURL(blob),
    };
    if (duration !== undefined) item.duration_seconds = duration;
    state.items.push(item);
    state.items.sort((a, b) =>
      a.created_at.localeCompare(b.created_at) ||
      (a.kind === "recording" ? -1 : b.kind === "recording" ? 1 : 0),
    );
    return item;
  }
  function storedBytes() {
    return state.items.reduce((sum, item) => sum + item.size_bytes, 0);
  }
  function release(id) {
    if (!retained.has(id)) return Promise.resolve();
    retained.delete(id);
    return showcase.setRecording(id, false).catch(() => {});
  }
  async function retain(ids) {
    const wanted = new Set(ids);
    const added = [];
    try {
      for (const id of ids) {
        if (retained.has(id)) continue;
        await showcase.setRecording(id, true);
        retained.add(id);
        added.push(id);
      }
    } catch (error) {
      await Promise.all(added.map(release));
      throw error;
    }
    await Promise.all([...retained].filter((id) => !wanted.has(id)).map(release));
  }
  function placeholder(targetCtx, label, x, y, w, h) {
    targetCtx.fillStyle = "#171b23";
    targetCtx.fillRect(x, y, w, h);
    targetCtx.fillStyle = "#f8ebab";
    targetCtx.font = "28px sans-serif";
    targetCtx.textAlign = "center";
    targetCtx.fillText(label, x + w / 2, y + h / 2);
    targetCtx.textAlign = "left";
  }
  function tiles(ids) {
    if (ids.length <= 1) return [1, 1];
    if (ids.length <= 2) return [2, 1];
    const cols = Math.ceil(Math.sqrt(ids.length));
    return [cols, Math.ceil(ids.length / cols)];
  }
  function fit(ctx2d, source, x, y, w, h) {
    const sw = source.width || source.videoWidth;
    const sh = source.height || source.videoHeight;
    if (!sw || !sh) throw new Error("No fresh camera frame.");
    const scale = Math.min(w / sw, h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx2d.drawImage(source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
  async function drawFrame(ids, target = canvas, { countFrame = false, fresh = false, overlays = true } = {}) {
    const targetCtx = target.getContext("2d");
    const width = target.width;
    const height = target.height;
    targetCtx.fillStyle = "#101319";
    targetCtx.fillRect(0, 0, width, height);
    if (!ids.length) {
      placeholder(targetCtx, "No cameras selected", 0, 0, width, height);
      return;
    }
    const [cols, rows] = tiles(ids);
    const cellW = width / cols;
    const cellH = height / rows;
    const failures = [];
    await Promise.all(ids.map(async (id, index) => {
      const x = (index % cols) * cellW;
      const y = Math.floor(index / cols) * cellH;
      try {
        const source = await showcase.getFrameSource(id);
        if (fresh && source.width === 0 && source.height === 0)
          throw new Error("No fresh camera frame.");
        fit(targetCtx, source, x, y, cellW, cellH);
        if (overlays && ids.length > 1) {
          targetCtx.fillStyle = "rgba(0,0,0,.65)";
          targetCtx.fillRect(x, y + cellH - 52, cellW, 52);
          targetCtx.fillStyle = "white";
          targetCtx.font = "24px sans-serif";
          targetCtx.fillText(safeName(id), x + 18, y + cellH - 18);
        }
      } catch (error) {
        if (fresh) failures.push(error);
        else placeholder(targetCtx, `${safeName(id)} · offline`, x, y, cellW, cellH);
      }
    }));
    if (failures.length) throw failures[0];
    if (countFrame) state.frames++;
  }
  async function tick() {
    if (pendingFrame || state.state !== "recording") return;
    pendingFrame = true;
    try {
      const all = await showcase.fetch("/api/cameras").then((response) => response.json());
      const present = new Set(all.map((camera) => camera.id));
      const next = currentIds.filter((id) => present.has(id));
      if (next.length !== currentIds.length) {
        currentIds = next;
        state.camera_ids = [...next];
        await retain(next);
        if (!next.length) {
          await stopRecording();
          return;
        }
      }
      await drawFrame(currentIds, canvas, { countFrame: true });
      state.elapsed_seconds = Math.max(0, (Date.now() - startedAt) / 1000);
    } catch (error) {
      state.error = error.message || "Frame rendering failed.";
    } finally {
      pendingFrame = false;
    }
  }
  function mimeType() {
    const Recorder = window.MediaRecorder;
    if (!Recorder) return "";
    const choices = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/mp4",
    ];
    return choices.find((type) => Recorder.isTypeSupported?.(type)) || "";
  }
  function stopRecording(reason = null) {
    if (stopPromise) return stopPromise;
    if (state.state === "idle" || state.state === "error") return Promise.resolve(snapshot());
    state.state = "stopping";
    stopReason = reason;
    clearInterval(timer);
    timer = null;
    stopPromise = (async () => {
      await new Promise((resolve) => {
        if (!recorder || recorder.state === "inactive") return resolve();
        recorder.addEventListener("stop", resolve, { once: true });
        try { recorder.stop(); } catch { resolve(); }
      });
      await Promise.all([...retained].map(release));
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (chunks.length) {
        const type = recorder?.mimeType || chunks[0].type || "video/webm";
        const blob = new Blob(chunks, { type });
        const extension = type.includes("mp4") ? "mp4" : "webm";
        const duration = Math.max(0, (Date.now() - startedAt) / 1000);
        makeItem(blob, "recording", filename("recording", extension), duration, new Date(startedAt));
      }
      chunks = [];
      chunkBytes = 0;
      recorder = null;
      state.elapsed_seconds = startedAt ? Math.max(0, (Date.now() - startedAt) / 1000) : 0;
      state.state = stopReason ? "error" : "idle";
      state.error = stopReason;
      state.camera_ids = [];
      currentIds = [];
      return snapshot();
    })().finally(() => { stopPromise = null; });
    return stopPromise;
  }
  function dataAvailable(event) {
    if (!event.data?.size) return;
    if (storedBytes() + chunkBytes + event.data.size > MAX_BYTES) {
      stopRecording("128 MiB local buffer reached. Final chunk was discarded; saved recording may be incomplete.");
      return;
    }
    chunks.push(event.data);
    chunkBytes += event.data.size;
  }
  async function startRecording(ids) {
    if (state.state === "recording" || state.state === "stopping") {
      throw new Error("A recording is already active or stopping.");
    }
    if (storedBytes() >= MAX_BYTES) {
      state.state = "error";
      state.error = "Local media buffer reached 128 MiB. Download items and reload the showcase to record again.";
      throw new Error(state.error);
    }
    state.error = null;
    if (document.hidden) {
      state.state = "error";
      state.error = "Showcase must stay visible while recording.";
      throw new Error(state.error);
    }
    if (!window.MediaRecorder || !canvas.captureStream) {
      state.state = "error";
      state.error = "This browser cannot record a canvas stream.";
      throw new Error(state.error);
    }
    const all = await showcase.fetch("/api/cameras").then((response) => response.json());
    const available = new Set(all.map((camera) => camera.id));
    const selected = [...new Set(ids || [])].filter((id) => available.has(id));
    if (!selected.length) {
      state.state = "error";
      state.error = "Select at least one camera.";
      throw new Error(state.error);
    }
    state.state = "idle";
    state.error = null;
    state.frames = 0;
    state.elapsed_seconds = 0;
    chunks = [];
    chunkBytes = 0;
    startedAt = Date.now();
    currentIds = selected;
    state.camera_ids = [...selected];
    try {
      await retain(selected);
      await drawFrame(selected);
      stream = canvas.captureStream(FPS);
      const type = mimeType();
      const Recorder = window.MediaRecorder;
      recorder = type ? new Recorder(stream, { mimeType: type }) : new Recorder(stream);
      recorder.addEventListener("dataavailable", dataAvailable);
      recorder.addEventListener("error", (event) => {
        stopRecording(event.error?.message || "Browser recording failed.");
      });
      recorder.addEventListener("stop", () => {
        if (state.state !== "stopping") stopRecording("Recording stopped unexpectedly.");
      });
      recorder.start(1000);
      state.state = "recording";
      timer = setInterval(tick, 1000 / FPS);
      return snapshot();
    } catch (error) {
      await Promise.all([...retained].map(release));
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      recorder = null;
      state.state = "error";
      state.camera_ids = [];
      currentIds = [];
      state.error = error.message || "Could not start browser recording.";
      throw error;
    }
  }
  async function setCameras(ids) {
    if (state.state === "stopping") throw new Error("Recording is stopping. Try again shortly.");
    const all = await showcase.fetch("/api/cameras").then((response) => response.json());
    const available = new Set(all.map((camera) => camera.id));
    const selected = [...new Set(ids || [])].filter((id) => available.has(id));
    if (state.state === "recording") {
      if (!selected.length) return stopRecording();
      await retain(selected);
      currentIds = selected;
      state.camera_ids = [...selected];
    } else state.camera_ids = selected;
    return snapshot();
  }
  async function capture(ids) {
    if (state.state === "stopping") throw new Error("Recording is stopping. Try capture again shortly.");
    if (storedBytes() >= MAX_BYTES)
      throw new Error("Local media buffer reached 128 MiB. Download items and reload the showcase to capture again.");
    const all = await showcase.fetch("/api/cameras").then((response) => response.json());
    const available = new Set(all.map((camera) => camera.id));
    const selected = [...new Set(ids || [])].filter((id) => available.has(id));
    if (!selected.length) throw new Error("Select at least one camera.");
    const sources = await Promise.all(selected.map((id) => showcase.getFrameSource(id)));
    const captureWidth = selected.length === 1 ? sources[0].width || sources[0].videoWidth : WIDTH;
    const captureHeight = selected.length === 1 ? sources[0].height || sources[0].videoHeight : HEIGHT;
    if (!captureWidth || !captureHeight) throw new Error("No fresh camera frame.");
    if (storedBytes() + captureWidth * captureHeight * 4 > MAX_BYTES)
      throw new Error("Local media buffer has insufficient space for this capture.");
    captureCanvas.width = captureWidth;
    captureCanvas.height = captureHeight;
    await drawFrame(selected, captureCanvas, { fresh: true, overlays: selected.length > 1 });
    const blob = await new Promise((resolve, reject) => captureCanvas.toBlob(
      (image) => image ? resolve(image) : reject(new Error("JPEG capture failed.")),
      "image/jpeg",
      0.9,
    ));
    if (storedBytes() + blob.size > MAX_BYTES)
      throw new Error("Local media buffer reached 128 MiB. Download items and reload the showcase to capture again.");
    return makeItem(blob, "capture", filename("capture", "jpg"));
  }
  async function dispatch(path, data = {}) {
    if (path === "/api/recordings/start") return startRecording(data.camera_ids);
    if (path === "/api/recordings/cameras") return setCameras(data.camera_ids);
    if (path === "/api/recordings/stop") return stopRecording();
    if (path === "/api/captures") return capture(data.camera_ids);
    throw new Error("Unknown browser media route.");
  }
  function request(path, data = {}) {
    if (path === "/api/recordings/start" && (state.state === "recording" || state.state === "stopping"))
      return Promise.reject(new Error("A recording is already active or stopping."));
    const result = requestQueue.then(() => dispatch(path, data));
    requestQueue = result.catch(() => {});
    return result;
  }
  function cleanup() {
    const releaseItems = () => {
      for (const item of state.items) URL.revokeObjectURL(item.url);
      state.items = [];
      return Promise.all([...retained].map(release));
    };
    if (stopPromise) stopPromise.then(releaseItems);
    else if (state.state === "recording")
      stopRecording("Showcase requires a visible tab.").then(releaseItems);
    else releaseItems();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.state === "recording")
      stopRecording("Recording stopped: keep the showcase tab visible.");
  });
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) cleanup();
  });
  window.spyderBrowserMedia = { request, status: async () => snapshot() };
})();
