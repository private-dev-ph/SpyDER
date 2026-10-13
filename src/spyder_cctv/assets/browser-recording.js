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
  const ctx = canvas.getContext("2d");
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
  function makeItem(blob, kind, name, duration) {
    const item = {
      id: `recording-${crypto.randomUUID()}`,
      kind,
      filename: name,
      created_at: new Date().toISOString(),
      size_bytes: blob.size,
      url: URL.createObjectURL(blob),
    };
    if (duration !== undefined) item.duration_seconds = duration;
    state.items.unshift(item);
    return item;
  }
  function download(item) {
    const link = document.createElement("a");
    link.href = item.url;
    link.download = item.filename;
    link.click();
  }
  function release(id) {
    if (!retained.has(id)) return Promise.resolve();
    retained.delete(id);
    return showcase.setRecording(id, false).catch(() => {});
  }
  async function retain(ids) {
    const wanted = new Set(ids);
    await Promise.all([...retained].filter((id) => !wanted.has(id)).map(release));
    for (const id of ids) {
      if (retained.has(id)) continue;
      await showcase.setRecording(id, true);
      retained.add(id);
    }
  }
  function placeholder(label, x, y, w, h) {
    ctx.fillStyle = "#171b23";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#f8ebab";
    ctx.font = "28px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, x + w / 2, y + h / 2);
    ctx.textAlign = "left";
  }
  function tiles(ids) {
    if (ids.length <= 1) return [1, 1];
    if (ids.length <= 2) return [2, 1];
    const cols = Math.ceil(Math.sqrt(ids.length));
    return [cols, Math.ceil(ids.length / cols)];
  }
  async function drawFrame(ids) {
    ctx.fillStyle = "#101319";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    if (!ids.length) {
      placeholder("No cameras selected", 0, 0, WIDTH, HEIGHT);
      return;
    }
    const [cols, rows] = tiles(ids);
    const cellW = WIDTH / cols;
    const cellH = HEIGHT / rows;
    await Promise.all(ids.map(async (id, index) => {
      const x = (index % cols) * cellW;
      const y = Math.floor(index / cols) * cellH;
      try {
        const source = await showcase.getFrameSource(id);
        ctx.drawImage(source, x, y, cellW, cellH);
        ctx.fillStyle = "rgba(0,0,0,.65)";
        ctx.fillRect(x, y + cellH - 52, cellW, 52);
        ctx.fillStyle = "white";
        ctx.font = "24px sans-serif";
        ctx.fillText(safeName(id), x + 18, y + cellH - 18);
      } catch {
        placeholder(`${safeName(id)} · offline`, x, y, cellW, cellH);
      }
    }));
    state.frames++;
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
      await drawFrame(currentIds);
      state.elapsed_seconds = Math.max(0, (Date.now() - startedAt) / 1000);
    } catch (error) {
      state.error = error.message || "Frame rendering failed.";
    } finally {
      pendingFrame = false;
    }
  }
  function mimeType() {
    if (!window.MediaRecorder) return "";
    const choices = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/mp4",
    ];
    return choices.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
  }
  async function stopRecording(reason = null) {
    if (state.state === "idle" || state.state === "stopping") return snapshot();
    state.state = "stopping";
    stopReason = reason;
    clearInterval(timer);
    timer = null;
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
      makeItem(blob, "video", filename("recording", extension), duration);
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
  }
  function dataAvailable(event) {
    if (!event.data?.size) return;
    if (chunkBytes + event.data.size > MAX_BYTES) {
      stopRecording("Recording stopped: local buffer reached 128 MiB.");
      return;
    }
    chunks.push(event.data);
    chunkBytes += event.data.size;
  }
  async function startRecording(ids) {
    if (state.state === "recording") await stopRecording();
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
      recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
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
    const all = await showcase.fetch("/api/cameras").then((response) => response.json());
    const available = new Set(all.map((camera) => camera.id));
    const selected = [...new Set(ids || [])].filter((id) => available.has(id));
    if (!selected.length) throw new Error("Select at least one camera.");
    await drawFrame(selected);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(
      (image) => image ? resolve(image) : reject(new Error("JPEG capture failed.")),
      "image/jpeg",
      0.9,
    ));
    const item = makeItem(blob, "capture", filename("capture", "jpg"));
    download(item);
    return snapshot();
  }
  async function request(path, data = {}) {
    if (path === "/api/recordings/start") return startRecording(data.camera_ids);
    if (path === "/api/recordings/cameras") return setCameras(data.camera_ids);
    if (path === "/api/recordings/stop") return stopRecording();
    if (path === "/api/captures") return capture(data.camera_ids);
    throw new Error("Unknown browser media route.");
  }
  function cleanup() {
    const releaseItems = () => {
      for (const item of state.items) URL.revokeObjectURL(item.url);
      state.items = [];
      return Promise.all([...retained].map(release));
    };
    if (state.state === "recording")
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
  state.download = (id) => {
    const item = state.items.find((entry) => entry.id === id);
    if (item) download(item);
  };
  state.removeItem = (id) => {
    const index = state.items.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    URL.revokeObjectURL(state.items[index].url);
    state.items.splice(index, 1);
    return true;
  };
  window.spyderBrowserMedia = { request, status: async () => snapshot() };
})();
