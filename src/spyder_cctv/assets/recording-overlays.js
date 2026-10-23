/* Opt-in, bounded detection overlays for local recording playback. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.spyderRecordingOverlays = api;
})(typeof window === "undefined" ? globalThis : window, function (root) {
  "use strict";
  const CHUNK_SECONDS = 30, MAX_JSON = 2 * 1024 * 1024, MAX_FILES = 2881, MAX_CACHE = 3;
  const NO_DATA = Symbol("no saved detections");
  const idPattern = /^[a-f0-9]{32}$/;
  function chunkNumber(time) { return Math.floor(Math.max(0, Number(time) || 0) / CHUNK_SECONDS); }
  function validate(data, index, expectedMediaId = null) {
    if (!data || data.version !== 1 || data.chunk_seconds !== 30 || data.index !== index ||
        !Number.isFinite(data.width) || data.width <= 0 || !Number.isFinite(data.height) || data.height <= 0 ||
        !Number.isFinite(data.fps) || data.fps <= 0 || !Array.isArray(data.samples) || data.samples.length > 1800)
      throw Error("Detection metadata is invalid.");
    if (data.media_id != null && expectedMediaId != null && data.media_id !== expectedMediaId)
      throw Error("Detection metadata belongs to another clip.");
    const samples = [];
    let previousTime = -Infinity;
    for (const sample of data.samples) {
      if (!sample || !Number.isFinite(sample.time) || sample.time <= previousTime || sample.time < index * 30 || sample.time >= (index + 1) * 30 || !Array.isArray(sample.boxes) || sample.boxes.length > 128)
        throw Error("Detection metadata is invalid.");
      previousTime = sample.time;
      const boxes = [];
      for (const box of sample.boxes) {
        const b = box?.bbox;
        if (!Array.isArray(b) || b.length !== 4 || b.some((n) => !Number.isFinite(n)) ||
            b[0] < 0 || b[1] < 0 || b[2] < 0 || b[3] < 0 || b[0] + b[2] > 1.00001 || b[1] + b[3] > 1.00001 ||
            typeof box.camera_id !== "string" || typeof box.kind !== "string" || typeof box.label !== "string" ||
            (box.confidence != null && (!Number.isFinite(box.confidence) || box.confidence < 0 || box.confidence > 1)) ||
            (box.identity != null && typeof box.identity !== "string") || (box.track_id != null && typeof box.track_id !== "string" && typeof box.track_id !== "number"))
          throw Error("Detection metadata is invalid.");
        boxes.push({ bbox: b, camera_id: box.camera_id, kind: box.kind, label: box.label, confidence: box.confidence, identity: box.identity, track_id: box.track_id == null ? undefined : String(box.track_id) });
      }
      samples.push({ time: sample.time, boxes });
    }
    return { ...data, samples };
  }
  async function boundedText(response) {
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > MAX_JSON) throw Error("Detection metadata exceeds 2 MiB limit.");
    if (!response.body?.getReader) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_JSON) throw Error("Detection metadata exceeds 2 MiB limit.");
      return text;
    }
    const reader = response.body.getReader(), parts = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON) { await reader.cancel(); throw Error("Detection metadata exceeds 2 MiB limit."); }
      parts.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return new TextDecoder().decode(bytes);
  }
  function attach(surface, options) {
    const { item, media, time, demo = !!root.spyderShowcase } = options;
    let active = true, enabled = false, currentChunk = -1, frameHandle = 0, observer, resize;
    let files = new Map(), cache = new Map(), cacheMessages = new Map(), pending = new Map(), overlayData = null, status = "", metadata = null, displayedTime = Number(time()) || 0;
    const doc = surface.ownerDocument || document;
    const canvas = doc.createElement("canvas"); canvas.className = "recording-overlay-canvas"; canvas.setAttribute("aria-hidden", "true");
    const controls = doc.createElement("div"); controls.className = "recording-overlay-controls";
    const label = doc.createElement("label"); label.className = "recording-overlay-toggle";
    const toggle = doc.createElement("input"); toggle.type = "checkbox";
    label.append(toggle, doc.createTextNode("Show detections"));
    const importButton = doc.createElement("button"); importButton.type = "button"; importButton.className = "button secondary recording-overlay-import"; importButton.textContent = "Import detection files";
    const picker = doc.createElement("input"); picker.type = "file"; picker.accept = ".json,.json.gz,application/json,application/gzip"; picker.multiple = true; picker.hidden = true;
    const fullscreen = doc.createElement("button"); fullscreen.type = "button"; fullscreen.className = "button secondary recording-overlay-fullscreen"; fullscreen.textContent = "Full screen"; fullscreen.hidden = typeof surface.requestFullscreen !== "function";
    const download = doc.createElement("button"); download.type = "button"; download.className = "button secondary recording-overlay-download"; download.textContent = "Download detection chunk"; download.hidden = demo || !idPattern.test(String(item.id || ""));
    const statusNode = doc.createElement("span"); statusNode.className = "field-help recording-overlay-status"; statusNode.setAttribute("role", "status");
    controls.append(label, importButton, picker, fullscreen, download, statusNode);
    surface.classList.add("recording-overlay-surface"); surface.append(canvas, controls);
    function setStatus(value) { status = value; statusNode.textContent = value; }
    function draw() {
      if (!active) return;
      const rect = media.getBoundingClientRect?.(), sr = surface.getBoundingClientRect?.();
      if (!rect || !sr) return;
      const dpr = Math.max(1, Number(root.devicePixelRatio) || 1);
      const w = Math.max(1, surface.clientWidth || sr.width), h = Math.max(1, surface.clientHeight || sr.height);
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      const ctx = canvas.getContext?.("2d"); if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      if (!enabled || !metadata || !overlayData || !overlayData.samples.length) return;
      const sourceW = Number(media.videoWidth || media.naturalWidth || metadata.width), sourceH = Number(media.videoHeight || media.naturalHeight || metadata.height);
      const sourceAspect = sourceW / sourceH, metadataAspect = metadata.width / metadata.height;
      if (!sourceW || !sourceH || Math.abs(sourceAspect - metadataAspect) / metadataAspect > 0.01) { setStatus("Detection geometry does not match this video."); return; }
      const mediaLeft = rect.left - sr.left, mediaTop = rect.top - sr.top;
      const scale = Math.min(rect.width / sourceW, rect.height / sourceH), drawnW = sourceW * scale, drawnH = sourceH * scale;
      const left = mediaLeft + (rect.width - drawnW) / 2, top = mediaTop + (rect.height - drawnH) / 2;
      let low = 0, high = overlayData.samples.length;
      while (low < high) { const mid = (low + high) >>> 1; if (overlayData.samples[mid].time <= displayedTime) low = mid + 1; else high = mid; }
      if (!low) return;
      const selected = overlayData.samples[low - 1];
      ctx.lineWidth = 2; ctx.font = "12px sans-serif"; ctx.textBaseline = "top";
      for (const box of selected.boxes) {
        const [x, y, bw, bh] = box.bbox, px = left + x * drawnW, py = top + y * drawnH, pw = bw * drawnW, ph = bh * drawnH;
        ctx.strokeStyle = root.getComputedStyle?.(surface)?.getPropertyValue("--gold")?.trim() || "#d99b35"; ctx.strokeRect(px, py, pw, ph);
        const text = [box.label, box.identity, Number.isFinite(box.confidence) ? Math.round(box.confidence * 100) + "%" : ""].filter(Boolean).join(" · ");
        if (text) { const tw = ctx.measureText(text).width + 8; ctx.fillStyle = "rgba(0,0,0,.78)"; ctx.fillRect(px, Math.max(0, py - 18), tw, 18); ctx.fillStyle = "#fff"; ctx.fillText(text, px + 4, Math.max(0, py - 16)); }
      }
    }
    function remember(index, data, message = "") {
      cache.delete(index); cache.set(index, data); cacheMessages.set(index, message);
      while (cache.size > MAX_CACHE) { const oldest = cache.keys().next().value; cache.delete(oldest); cacheMessages.delete(oldest); }
    }
    async function parseFile(file, index, filenameClipId) {
      if (!file || file.size > MAX_JSON) throw Error("Detection file exceeds 2 MiB limit.");
      let bytes = await file.arrayBuffer();
      if (file.name.endsWith(".gz")) {
        if (typeof DecompressionStream !== "function") throw Error("This browser cannot open gzip detection files. Import uncompressed JSON files.");
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        const reader = stream.getReader(), chunks = []; let size = 0;
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_JSON) { await reader.cancel(); throw Error("Decoded detection file exceeds 2 MiB limit."); } chunks.push(value); }
        const decoded = new Uint8Array(size); let offset = 0; for (const part of chunks) { decoded.set(part, offset); offset += part.length; }
        bytes = decoded.buffer;
      }
      return validate(JSON.parse(new TextDecoder().decode(bytes)), index, filenameClipId);
    }
    function cacheFileSet(list) {
      if (list.length > MAX_FILES) throw Error("Select no more than 2881 detection files.");
      const clipIds = new Set(), mapped = new Map();
      for (const file of list) {
        const match = /^([a-f0-9]{32})\.overlays-(\d{6})\.json(?:\.gz)?$/.exec(file.name);
        if (!match) throw Error("Detection filenames must use the clip overlay chunk format.");
        clipIds.add(match[1]); const index = Number(match[2]);
        if (index > 2880) throw Error("Detection chunk number is outside supported range.");
        mapped.set(index, { file, clipId: match[1] });
      }
      if (clipIds.size > 1 || (clipIds.size && !demo && !clipIds.has(String(item.id || "")))) throw Error("Detection files must match this clip ID.");
      requestController?.abort(); requestController = null; requestChunk = -1; pending.clear(); currentChunk = -1; overlayData = null; metadata = null; clear();
      files = mapped; cache.clear(); cacheMessages.clear();
    }
    importButton.addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => { try { cacheFileSet([...picker.files]); setStatus("Imported files stay on this device."); update(Number(time())); } catch (error) { setStatus(error.message); } });
    toggle.addEventListener("change", () => { enabled = toggle.checked; if (!enabled) clear(); else update(Number(time())); });
    function clear() { const ctx = canvas.getContext?.("2d"); ctx?.clearRect(0, 0, canvas.width, canvas.height); }
    fullscreen.addEventListener("click", async () => {
      try { if (doc.fullscreenElement === surface) await doc.exitFullscreen?.(); else await surface.requestFullscreen?.(); }
      catch (error) { setStatus(error.message || "Full screen is unavailable."); }
    });
    async function loadChunk(index, token) {
      if (cache.has(index)) return cache.get(index);
      if (pending.has(index)) return pending.get(index);
      let promise;
      promise = (async () => {
        try {
          let data;
          if (files.size && !files.has(index)) { remember(index, NO_DATA); setStatus("No saved detections for this chunk."); return NO_DATA; }
          else if (files.has(index)) { const entry = files.get(index); data = await parseFile(entry.file, index, entry.clipId); }
          else if (item.overlayChunks && Object.prototype.hasOwnProperty.call(item.overlayChunks, index)) data = validate(item.overlayChunks[index], index, String(item.id || ""));
          else if (demo) { const message = "No saved detections. Import detection files to view overlays."; remember(index, NO_DATA, message); setStatus(message); return NO_DATA; }
          else if (idPattern.test(String(item.id || ""))) {
            const response = await fetch("/api/media/" + item.id + "/overlays?chunk=" + index, { signal: token.signal, cache: "no-store" });
            if (!response.ok) throw Error("Detection metadata could not be loaded.");
            const raw = await boundedText(response);
            const body = JSON.parse(raw);
            if (!active || token.signal.aborted || currentChunk !== index) return null;
            if (body.unavailable || body.available === false) { remember(index, NO_DATA); setStatus("No saved detections for this chunk."); return NO_DATA; }
            data = validate(body, index, String(item.id || ""));
          } else { setStatus("No saved detections. Import detection files to view overlays."); return null; }
          if (!active || token.signal.aborted || currentChunk !== index) return null;
          remember(index, data); return data;
        } catch (error) {
          if (active && !token.signal.aborted && currentChunk === index) {
            const message = error.message || "Detection metadata could not be loaded.";
            remember(index, NO_DATA, message); setStatus(message);
          }
          return null;
        }
        finally { if (pending.get(index) === promise) pending.delete(index); }
      })(); pending.set(index, promise); return promise;
    }
    let requestController, requestChunk = -1;
    async function update(value) {
      if (!active) return;
      displayedTime = Number(value) || 0;
      const index = chunkNumber(displayedTime); if (index !== currentChunk) { currentChunk = index; requestController?.abort(); pending.clear(); overlayData = null; metadata = null; clear(); }
      if (!enabled) { clear(); return; }
      if (cache.has(index)) {
        overlayData = cache.get(index); metadata = overlayData === NO_DATA ? null : overlayData;
        if (overlayData === NO_DATA) { setStatus(cacheMessages.get(index) || "No saved detections for this chunk."); clear(); } else { setStatus(overlayData.truncated ? "Detections loaded; chunk is truncated." : "Detections loaded."); draw(); }
        return;
      }
      if (requestController && requestChunk === index && pending.has(index)) return;
      requestController?.abort(); requestController = new AbortController(); requestChunk = index;
      setStatus("Loading detections…");
      const token = requestController;
      const data = await loadChunk(index, token);
      if (active && token === requestController && currentChunk === index) {
        if (data && data !== NO_DATA) { overlayData = metadata = data; setStatus(data.truncated ? "Detections loaded; chunk is truncated." : "Detections loaded."); draw(); }
        else if (data === NO_DATA) { overlayData = null; metadata = null; clear(); }
      }
    }
    download.addEventListener("click", async () => {
      const index = chunkNumber(Number(time()));
      try {
        if (index !== currentChunk) { currentChunk = index; requestController?.abort(); pending.clear(); overlayData = null; metadata = null; clear(); }
        requestController = new AbortController(); requestChunk = index;
        const data = cache.get(index) || await loadChunk(index, requestController);
        if (!active || !data || data === NO_DATA) return;
        const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
        if (blob.size > MAX_JSON) throw Error("Detection metadata exceeds 2 MiB limit.");
        const url = URL.createObjectURL(blob), anchor = doc.createElement("a");
        anchor.href = url; anchor.download = String(item.id) + ".overlays-" + String(index).padStart(6, "0") + ".json";
        anchor.click(); URL.revokeObjectURL(url);
      } catch (error) { setStatus(error.message || "Detection chunk could not be downloaded."); }
    });
    const frame = () => { if (!active) return; draw(); frameHandle = requestAnimationFrame(frame); };
    if (typeof ResizeObserver === "function") { observer = new ResizeObserver(() => draw()); observer.observe(surface); }
    const onResize = () => draw();
    const onFullscreen = () => { fullscreen.textContent = doc.fullscreenElement === surface ? "Exit full screen" : "Full screen"; onResize(); };
    root.addEventListener?.("resize", onResize); doc.addEventListener?.("fullscreenchange", onFullscreen);
    const updateFromMedia = () => { if (enabled) void update(Number(time())); draw(); };
    const mediaEvents = ["timeupdate", "seeked", "pause", "loadedmetadata"];
    for (const name of mediaEvents) media.addEventListener?.(name, updateFromMedia);
    if (media.tagName === "VIDEO" && media.requestVideoFrameCallback) {
      const onFrame = (_now, meta) => { if (!active) return; if (enabled) void update(Number(meta.mediaTime)); frameHandle = media.requestVideoFrameCallback(onFrame); };
      frameHandle = media.requestVideoFrameCallback(onFrame);
    } else { frameHandle = requestAnimationFrame(frame); }
    return { update, destroy() { if (!active) return; active = false; requestController?.abort(); observer?.disconnect(); root.removeEventListener?.("resize", onResize); doc.removeEventListener?.("fullscreenchange", onFullscreen); if (frameHandle) { if (media.cancelVideoFrameCallback && media.tagName === "VIDEO") media.cancelVideoFrameCallback(frameHandle); else root.cancelAnimationFrame?.(frameHandle); } for (const name of mediaEvents) media.removeEventListener?.(name, updateFromMedia); surface.classList.remove("recording-overlay-surface"); canvas.remove(); controls.remove(); } };
  }
  return { attach, validate, chunkNumber, CHUNK_SECONDS, MAX_JSON, MAX_FILES, MAX_CACHE };
});
