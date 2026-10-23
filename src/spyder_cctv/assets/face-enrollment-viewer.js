"use strict";
(() => {
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  const closeIcon =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  function clipRange(start, duration, length) {
    if (!Number.isFinite(length) || length < 5)
      throw Error(
        "Choose a video at least 5 seconds long with a readable duration.",
      );
    const span = Number(duration);
    if (!Number.isFinite(span) || span < 5 || span > 10)
      throw Error("Choose a range between 5 and 10 seconds.");
    if (length < span)
      throw Error(
        "This video is shorter than the selected range. Choose 5 seconds.",
      );
    return {
      start: clamp(Number(start) || 0, 0, Math.max(0, length - span)),
      duration: span,
    };
  }
  function normalizedRegion(a, b) {
    const x = clamp(Math.min(a.x, b.x), 0, 1),
      y = clamp(Math.min(a.y, b.y), 0, 1);
    const w = clamp(Math.abs(a.x - b.x), 0, 1 - x),
      h = clamp(Math.abs(a.y - b.y), 0, 1 - y);
    return w >= 0.02 && h >= 0.02 ? [x, y, w, h] : null;
  }
  async function open(options) {
    if (window.spyderShowcase)
      throw Error("Face enrollment requires the installed local app.");
    if (document.querySelector(".fe-studio")) return;
    const dialog = document.createElement("dialog");
    dialog.className = "dt-dialog fe-studio";
    dialog.setAttribute("aria-labelledby", "fe-studio-title");
    const cameras = window.spyder?.cameras?.() || [];
    dialog.innerHTML = `<header class="fe-heading"><div><p class="dt-eyebrow">REVIEW BEFORE ENROLLMENT</p><h3 id="fe-studio-title">Build a face profile</h3><p>${escape(options.galleryName || "Face gallery")} · Choose samples of one person.</p></div><button type="button" class="dt-icon-button" data-fe-close aria-label="Close enrollment viewer">${closeIcon}</button></header>
      <div class="fe-body"><section class="fe-main"><div class="fe-source-controls"><label>Source<select data-fe-source><option value="camera">Live camera</option><option value="image">Image / capture</option><option value="video">Video / clip</option></select></label><label data-fe-camera-label>Camera<select data-fe-camera><option value="">Choose running camera</option>${cameras.map((c) => `<option value="${escape(c.id)}">${escape(c.name || c.id)}</option>`).join("")}</select></label><label data-fe-file-label hidden>Local media<input type="file" data-fe-file accept="image/jpeg,image/png"></label></div>
      <div class="fe-viewer"><canvas data-fe-stage width="960" height="540" tabindex="0" aria-label="Enrollment source. Drag to mark the focus area; use focus fields below for keyboard control."></canvas><span data-fe-empty>Choose a source to preview it here</span></div><p class="fe-hint">Drag on the picture to focus on one person. Click a detected face box or its sample to select it.</p>
      <div class="fe-focus"><b>Focus area (%)</b>${["Left", "Top", "Width", "Height"].map((label, i) => `<label>${label}<input data-fe-roi="${i}" type="number" min="0" max="100" step="1" value="${i < 2 ? 0 : 100}"></label>`).join("")}<button type="button" class="dt-button" data-fe-reset-roi>Whole frame</button></div>
      <section class="fe-trim" data-fe-trim hidden><div class="fe-trim-head"><b>Use only a short range</b><output data-fe-range></output></div><label>Start time<input type="range" data-fe-start min="0" max="0" step="0.1" value="0"></label><div class="fe-actions"><label>Range length<select data-fe-duration>${[5, 6, 7, 8, 9, 10].map((seconds) => `<option value="${seconds}">${seconds} seconds</option>`).join("")}</select></label><button type="button" class="dt-button" data-fe-play>Play selected range</button><button type="button" class="dt-button dt-primary" data-fe-sample-video>Inspect range</button></div><p>Up to 10 evenly spaced frames are inspected locally. The full video is never sent to the server.</p></section>
      <div class="fe-actions"><button type="button" class="dt-button" data-fe-live>Pause preview</button><button type="button" class="dt-button dt-primary" data-fe-inspect>Analyze current frame</button><button type="button" class="dt-button" data-fe-cancel hidden>Cancel inspection</button></div><p class="fe-status" data-fe-status role="status" aria-live="polite">Nothing is saved until you select samples and confirm.</p></section>
      <aside class="fe-review"><label>Identity name<input data-fe-name maxlength="128" placeholder="Who is this person?" value="${escape(options.identityName || "")}"></label><div class="fe-review-head"><h4>Detected samples <span data-fe-count>0 selected</span></h4><div class="fe-actions"><button type="button" class="dt-button" data-fe-select-all>Select all</button><button type="button" class="dt-button" data-fe-clear>Clear review</button></div></div><p>Inspect the crops. Select only the same person across frames. Reviews expire after 5 minutes.</p><div class="fe-samples" data-fe-samples><p>No inspected frames yet.</p></div><button type="button" class="dt-button dt-primary fe-save" data-fe-save disabled>Save selected face samples</button><p>Face vectors and small portrait crops stay on this computer. Full photos and video are not retained.</p></aside></div>`;
    document.body.append(dialog);
    const $ = (selector) => dialog.querySelector(selector);
    const canvas = $("[data-fe-stage]"),
      context = canvas.getContext("2d");
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    let closed = false,
      generation = 0,
      operation = 0,
      busy = false,
      saving = false,
      source = "camera",
      live = true;
    let recording = null,
      recordingTime = 0,
      recordingPlaying = false,
      frameSerial = 0;
    const videoLength = () =>
      recording ? recording.duration_seconds : video.duration;
    let mediaURL = null,
      timer = null,
      previewAbort = null,
      requestAbort = null,
      currentImage = null,
      originalImage = null,
      imageReady = false,
      imageVersion = 0;
    let roi = null,
      drag = null,
      dragging = false,
      samples = [],
      shownToken = null;
    const selected = new Set();
    const status = (text, error = false) => {
      $("[data-fe-status]").textContent = text;
      $("[data-fe-status]").dataset.error = String(error);
    };
    function controls() {
      $("[data-fe-inspect]").disabled = busy || saving || !imageReady;
      $("[data-fe-sample-video]").disabled =
        busy ||
        saving ||
        source !== "video" ||
        !Number.isFinite(videoLength()) ||
        videoLength() < 5;
      $("[data-fe-save]").disabled =
        busy ||
        saving ||
        selected.size === 0 ||
        !$("[data-fe-name]").value.trim();
      $("[data-fe-cancel]").hidden = !busy;
      $("[data-fe-live]").hidden = source !== "camera";
      $("[data-fe-live]").textContent = live ? "Pause preview" : "Resume live";
      $("[data-fe-count]").textContent =
        `${selected.size} selected / ${samples.length} samples`;
      $("[data-fe-close]").disabled = saving;
      $("[data-fe-source]").disabled = saving;
      $("[data-fe-camera]").disabled = saving;
      $("[data-fe-file]").disabled = saving;
      $("[data-fe-select-all]").disabled =
        busy || saving || samples.length === 0;
      $("[data-fe-clear]").disabled = busy || saving;
      $("[data-fe-play]").textContent = recordingPlaying
        ? "Pause preview"
        : "Play selected range";
      $("[data-fe-play]").disabled =
        busy || saving || source !== "video" || !Number.isFinite(videoLength());
      dialog
        .querySelectorAll(
          "[data-fe-roi], [data-fe-reset-roi], [data-fe-start], [data-fe-duration]",
        )
        .forEach((el) => (el.disabled = busy || saving));
    }
    function draw() {
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (currentImage)
        context.drawImage(currentImage, 0, 0, canvas.width, canvas.height);
      if (roi) {
        const [x, y, w, h] = roi;
        // Shade only the outside. Re-cropping with canvas-sized source coordinates
        // samples the wrong pixels whenever the image/video was downscaled.
        const left = x * canvas.width,
          top = y * canvas.height;
        const width = w * canvas.width,
          height = h * canvas.height;
        context.fillStyle = "#0006";
        context.fillRect(0, 0, canvas.width, top);
        context.fillRect(
          0,
          top + height,
          canvas.width,
          canvas.height - top - height,
        );
        context.fillRect(0, top, left, height);
        context.fillRect(
          left + width,
          top,
          canvas.width - left - width,
          height,
        );
        context.strokeStyle = "#f7d87f";
        context.lineWidth = 3;
        context.strokeRect(
          x * canvas.width,
          y * canvas.height,
          w * canvas.width,
          h * canvas.height,
        );
      }
      samples.forEach((sample, index) => {
        if (sample.token !== shownToken || !Array.isArray(sample.box)) return;
        const [x1, y1, x2, y2] = sample.box;
        context.strokeStyle = selected.has(index) ? "#f7d87f" : "#ff3333";
        context.lineWidth = 3;
        context.strokeRect(
          x1 * canvas.width,
          y1 * canvas.height,
          (x2 - x1) * canvas.width,
          (y2 - y1) * canvas.height,
        );
        context.fillStyle = "#000d";
        context.fillRect(x1 * canvas.width, y1 * canvas.height, 88, 24);
        context.fillStyle = "#fff";
        context.font = "bold 14px sans-serif";
        context.fillText(
          `Face ${sample.face + 1}`,
          x1 * canvas.width + 5,
          y1 * canvas.height + 17,
        );
      });
    }
    function syncROI() {
      const area = roi || [0, 0, 1, 1];
      dialog
        .querySelectorAll("[data-fe-roi]")
        .forEach((input, i) => (input.value = Math.round(area[i] * 100)));
      draw();
    }
    function clearReview() {
      samples = [];
      selected.clear();
      shownToken = null;
      $("[data-fe-samples]").innerHTML = "<p>No inspected frames yet.</p>";
      draw();
      controls();
    }
    function paintSamples() {
      $("[data-fe-samples]").innerHTML = samples.length
        ? samples
            .map(
              (sample, index) =>
                `<button type="button" class="fe-sample ${selected.has(index) ? "is-selected" : ""}" data-fe-candidate="${index}" aria-pressed="${selected.has(index)}"><img draggable="false" alt="Detected face ${sample.face + 1}, ${escape(sample.label)}" src="${escape(sample.thumbnail)}"><span>${escape(sample.label)} · Face ${sample.face + 1}<small>${Number.isFinite(sample.confidence) ? Math.round(sample.confidence * 100) + "% detection confidence" : "Detected face"}</small></span><b>${selected.has(index) ? "Selected" : "Select"}</b></button>`,
            )
            .join("")
        : "<p>No faces detected. Adjust the focus area or choose another frame.</p>";
      draw();
      controls();
    }
    async function json(path, body, signal) {
      const response = await fetch(path, {
        method: "POST",
        cache: "no-store",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Spyder-Control": "1",
        },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error || "Enrollment request failed.");
      return result;
    }
    const route = (action) =>
      "/api/faces/galleries/" +
      encodeURIComponent(options.galleryId) +
      "/" +
      action;
    function loadImage(url, expected) {
      const version = ++imageVersion;
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          if (closed || expected !== generation || version !== imageVersion)
            return resolve(false);
          const scale = Math.min(
            1,
            1280 / image.naturalWidth,
            960 / image.naturalHeight,
          );
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          currentImage = image;
          imageReady = true;
          $("[data-fe-empty]").hidden = true;
          draw();
          controls();
          resolve(true);
        };
        image.onerror = () =>
          reject(
            Error("The selected image could not be decoded. Use JPEG or PNG."),
          );
        image.src = url;
      });
    }
    function stopPreview() {
      clearTimeout(timer);
      timer = null;
      recordingPlaying = false;
      frameSerial++;
      imageVersion++;
      previewAbort?.abort();
      previewAbort = null;
    }
    async function preview(expected) {
      if (
        closed ||
        expected !== generation ||
        source !== "camera" ||
        !live ||
        busy ||
        document.hidden
      )
        return;
      const camera = $("[data-fe-camera]").value;
      if (!camera) return;
      const abort = new AbortController();
      previewAbort = abort;
      let url;
      try {
        const response = await fetch(
          "/api/cameras/" + encodeURIComponent(camera) + "/preview-frame",
          { cache: "no-store", signal: abort.signal },
        );
        if (!response.ok)
          throw Error(
            "Keep the selected camera running to preview and enroll.",
          );
        url = URL.createObjectURL(await response.blob());
        await loadImage(url, expected);
      } catch (error) {
        if (error.name !== "AbortError" && expected === generation && !closed)
          status(error.message, true);
      } finally {
        if (url) URL.revokeObjectURL(url);
        if (previewAbort === abort) previewAbort = null;
        if (
          !closed &&
          expected === generation &&
          live &&
          source === "camera" &&
          !busy
        )
          timer = setTimeout(() => preview(expected), 350);
      }
    }
    function invalidate() {
      generation++;
      operation++;
      frameSerial++;
      recording = null;
      requestAbort?.abort();
      requestAbort = null;
      busy = false;
      stopPreview();
      video.pause();
      currentImage = null;
      originalImage = null;
      imageReady = false;
      roi = null;
      drag = null;
      if (mediaURL) URL.revokeObjectURL(mediaURL);
      mediaURL = null;
      video.removeAttribute("src");
      video.load();
      clearReview();
      syncROI();
      $("[data-fe-empty]").hidden = false;
    }
    function sourceChanged() {
      invalidate();
      source = $("[data-fe-source]").value;
      $("[data-fe-camera-label]").hidden = source !== "camera";
      $("[data-fe-file-label]").hidden = source === "camera";
      $("[data-fe-trim]").hidden = source !== "video";
      $("[data-fe-file]").accept =
        source === "video" ? "video/*" : "image/jpeg,image/png";
      $("[data-fe-file]").value = "";
      live = true;
      status(
        "Choose a source, mark its focus area, then inspect the detections.",
      );
      controls();
      if (source === "camera") preview(generation);
    }
    async function mediaFile(file) {
      if (!file) return;
      const kind =
        file.type.startsWith("video/") ||
        /\.(mp4|webm|mov|m4v|ogv|avi)$/i.test(file.name)
          ? "video"
          : "image";
      if (kind === "image" && file.size > 8 * 1024 * 1024)
        throw Error("Choose an image smaller than 8 MiB.");
      if (kind === "video" && file.size > 2 * 1024 * 1024 * 1024)
        throw Error("Choose a video smaller than 2 GiB.");
      $("[data-fe-source]").value = kind;
      sourceChanged();
      const expected = generation;
      if (typeof DataTransfer !== "undefined") {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        $("[data-fe-file]").files = transfer.files;
      }
      mediaURL = URL.createObjectURL(file);
      if (kind === "image") {
        await loadImage(mediaURL, expected);
        if (closed || expected !== generation) return;
        originalImage = currentImage;
        status("Drag a focus area, then analyze this image.");
      } else {
        video.src = mediaURL;
        await mediaEvent("loadedmetadata", expected, () => video.load());
        if (expected !== generation || closed) return;
        if (!Number.isFinite(videoLength()) || videoLength() < 5)
          throw Error("Choose a readable video at least 5 seconds long.");
        $("[data-fe-start]").value = 0;
        dialog
          .querySelectorAll("[data-fe-duration] option")
          .forEach(
            (option) =>
              (option.disabled = Number(option.value) > videoLength()),
          );
        $("[data-fe-duration]").value = 5;
        updateRange();
        await seek(0, expected);
        drawVideo();
        status(
          "Choose a 5–10 second range. Inspect it to review the detected faces.",
        );
      }
      controls();
    }
    function mediaEvent(event, expected, trigger) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            finish(
              Error(
                "Media decoding timed out. Choose a browser-supported format.",
              ),
            ),
          15000,
        );
        const finish = (error) => {
          clearTimeout(timeout);
          video.removeEventListener(event, done);
          video.removeEventListener("error", failed);
          error ? reject(error) : resolve(expected === generation && !closed);
        };
        const done = () => finish(),
          failed = () =>
            finish(
              Error(
                "This browser cannot decode the video. Try MP4/H.264 or WebM.",
              ),
            );
        video.addEventListener(event, done, { once: true });
        video.addEventListener("error", failed, { once: true });
        trigger();
      });
    }
    async function recordingSource(item, offset) {
      if (!/^[0-9a-f]{32}$/.test(String(item?.id || "")))
        throw Error("Choose a saved local recording.");
      $("[data-fe-source]").value = "video";
      sourceChanged();
      const expected = generation;
      const abort = new AbortController();
      previewAbort = abort;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, 15000);
      let response;
      try {
        response = await fetch(`/api/media/${item.id}/info`, {
          cache: "no-store",
          signal: abort.signal,
        });
      } catch (error) {
        if (timedOut)
          throw Error("Recording metadata loading timed out. Try again.");
        throw error;
      } finally {
        clearTimeout(timeout);
        if (previewAbort === abort) previewAbort = null;
      }
      if (!response.ok)
        throw Error("Recording is unavailable. It may have been removed.");
      const info = await response.json();
      if (closed || generation !== expected) return;
      clipRange(offset, 5, info.duration_seconds);
      recording = { id: item.id, duration_seconds: info.duration_seconds };
      $("[data-fe-file-label]").hidden = true;
      $("[data-fe-duration]").value = "5";
      dialog
        .querySelectorAll("[data-fe-duration] option")
        .forEach(
          (option) => (option.disabled = Number(option.value) > videoLength()),
        );
      $("[data-fe-start]").max = Math.max(0, videoLength() - 5);
      $("[data-fe-start]").value = clipRange(offset, 5, videoLength()).start;
      const range = updateRange();
      await seek(range.start, expected);
      if (closed || generation !== expected) return;
      status(
        `${item.name || item.filename || "Saved recording"} · Choose a 5–10 second range and focus on one person. Playback is a sampled local preview.`,
      );
      controls();
    }
    async function seek(time, expected) {
      if (recording) {
        const serial = ++frameSerial;
        previewAbort?.abort();
        const abort = new AbortController();
        previewAbort = abort;
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, 15000);
        let url;
        try {
          const response = await fetch(
            `/api/media/${recording.id}/frame?time=${time.toFixed(3)}`,
            { cache: "no-store", signal: abort.signal },
          );
          if (!response.ok)
            throw Error(
              "Recording frame is unavailable. Choose another time or verify the clip still exists.",
            );
          url = URL.createObjectURL(await response.blob());
          if (closed || expected !== generation || serial !== frameSerial)
            return false;
          recordingTime = time;
          shownToken = null;
          return await loadImage(url, expected);
        } catch (error) {
          if (timedOut)
            throw Error(
              "Recording frame loading timed out. Try another position.",
            );
          throw error;
        } finally {
          clearTimeout(timeout);
          if (url) URL.revokeObjectURL(url);
          if (previewAbort === abort) previewAbort = null;
        }
      }
      if (Math.abs(video.currentTime - time) < 0.01 && video.readyState >= 2)
        return Promise.resolve(true);
      return mediaEvent("seeked", expected, () => (video.currentTime = time));
    }
    function drawVideo() {
      if (recording) {
        draw();
        controls();
        return;
      }
      if (!video.videoWidth || !video.videoHeight) return;
      const scale = Math.min(
        1,
        1280 / video.videoWidth,
        960 / video.videoHeight,
      );
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      shownToken = null;
      currentImage = video;
      imageReady = true;
      $("[data-fe-empty]").hidden = true;
      draw();
      controls();
    }
    function updateRange() {
      if (!Number.isFinite(videoLength())) return;
      const range = clipRange(
        $("[data-fe-start]").value,
        $("[data-fe-duration]").value,
        videoLength(),
      );
      $("[data-fe-start]").max = Math.max(0, videoLength() - range.duration);
      $("[data-fe-start]").value = range.start;
      $("[data-fe-range]").textContent =
        `${range.start.toFixed(1)}s – ${(range.start + range.duration).toFixed(1)}s / ${videoLength().toFixed(1)}s`;
      return range;
    }
    function rawImage() {
      const raw = document.createElement("canvas");
      const media =
        source === "image" && originalImage ? originalImage : currentImage;
      const width = media.videoWidth || media.naturalWidth || media.width;
      const height = media.videoHeight || media.naturalHeight || media.height;
      const scale = Math.min(
        1,
        3840 / Math.max(width, height),
        Math.sqrt(8_000_000 / (width * height)),
      );
      raw.width = Math.max(1, Math.round(width * scale));
      raw.height = Math.max(1, Math.round(height * scale));
      raw.getContext("2d").drawImage(media, 0, 0, raw.width, raw.height);
      const encoded = raw.toDataURL("image/jpeg", 0.9).split(",")[1];
      if (encoded.length > (8 * 1024 * 1024 * 4) / 3)
        throw Error(
          "This frame is too large. Choose a smaller source image or video.",
        );
      return encoded;
    }
    async function analyze(body, label, expected, op) {
      if (samples.length >= 80)
        throw Error(
          "Review is full. Save or clear it before inspecting more frames.",
        );
      const result = await json(route("analyze"), body, requestAbort.signal);
      if (closed || expected !== generation || op !== operation) return;
      if (!String(result.preview).startsWith("data:image/jpeg;base64,"))
        throw Error("Detector returned an invalid preview.");
      await loadImage(result.preview, expected);
      if (closed || expected !== generation || op !== operation) return;
      shownToken = result.review_token || null;
      for (const face of result.faces || []) {
        if (samples.length >= 80) break;
        if (
          !String(face.thumbnail).startsWith("data:image/jpeg;base64,") ||
          !Array.isArray(face.bbox) ||
          face.bbox.length !== 4 ||
          !face.bbox.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
        )
          continue;
        samples.push({
          preview: result.preview,
          token: result.review_token,
          face: face.index,
          box: face.bbox,
          thumbnail: face.thumbnail,
          confidence: face.confidence,
          label,
        });
      }
      paintSamples();
      return result.faces?.length || 0;
    }
    async function inspect(batch = false) {
      if (busy || saving || !imageReady) return;
      busy = true;
      live = false;
      stopPreview();
      video.pause();
      controls();
      const expected = generation,
        op = ++operation;
      requestAbort = new AbortController();
      try {
        const focus = roi ? roi.slice() : null;
        if (batch) {
          const range = updateRange();
          if (!range) throw Error("Choose a video first.");
          const count = Math.min(10, Math.ceil(range.duration));
          for (let index = 0; index < count; index++) {
            if (closed || expected !== generation || op !== operation) break;
            const time = range.start + (index * range.duration) / count;
            status(
              `Inspecting frame ${index + 1} of ${count} at ${time.toFixed(1)}s…`,
            );
            const ready = await seek(time, expected);
            if (!ready) break;
            if (closed || expected !== generation || op !== operation) break;
            drawVideo();
            const body = { image_base64: rawImage() };
            if (focus) body.roi = focus;
            await analyze(body, `${time.toFixed(1)}s`, expected, op);
          }
        } else {
          // Inspect the displayed snapshot, including a paused camera preview.
          const body = { image_base64: rawImage() };
          if (focus) body.roi = focus;
          await analyze(
            body,
            source === "video"
              ? recording && !shownToken
                ? `${recordingTime.toFixed(1)}s`
                : currentImage === video
                  ? `${video.currentTime.toFixed(1)}s`
                  : samples.find((sample) => sample.token === shownToken)
                      ?.label || "Reviewed frame"
              : "Frame " + (new Set(samples.map((s) => s.token)).size + 1),
            expected,
            op,
          );
        }
        if (!closed && expected === generation && op === operation)
          status(
            "Review the detected crops and select only this person. Nothing has been saved.",
          );
      } catch (error) {
        if (
          error.name !== "AbortError" &&
          !closed &&
          expected === generation &&
          op === operation
        )
          status(error.message, true);
      } finally {
        if (expected === generation && op === operation) {
          busy = false;
          requestAbort = null;
          controls();
        }
      }
    }
    function toggle(index) {
      if (busy || saving || !samples[index]) return;
      if (selected.has(index)) selected.delete(index);
      else {
        if (selected.size >= 20)
          return status("Select at most 20 samples per save.", true);
        selected.add(index);
      }
      const sample = samples[index];
      if (sample.token !== shownToken) {
        live = false;
        stopPreview();
        video.pause();
        shownToken = sample.token;
        loadImage(sample.preview, generation).catch((error) =>
          status(error.message, true),
        );
      }
      paintSamples();
    }
    function point(event) {
      const box = canvas.getBoundingClientRect();
      return {
        x: clamp((event.clientX - box.left) / box.width, 0, 1),
        y: clamp((event.clientY - box.top) / box.height, 0, 1),
      };
    }
    canvas.addEventListener("dragstart", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      if (busy || saving || !imageReady || event.button !== 0) return;
      event.preventDefault();
      if (source === "camera" && live) {
        live = false;
        stopPreview();
        imageVersion++;
        status(
          "Preview frozen for precise focus. Analyze this frame or resume live.",
        );
        controls();
      }
      if (source === "video") {
        video.pause();
        stopPreview();
      }
      drag = point(event);
      dragging = false;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const end = point(event);
      if (Math.abs(end.x - drag.x) + Math.abs(end.y - drag.y) > 0.015) {
        dragging = true;
        roi = normalizedRegion(drag, end);
        syncROI();
      }
    });
    const endDrag = (event) => {
      if (!drag) return;
      const end = point(event);
      if (!dragging) {
        const index = samples.findIndex(
          (s) =>
            s.token === shownToken &&
            end.x >= s.box[0] &&
            end.x <= s.box[2] &&
            end.y >= s.box[1] &&
            end.y <= s.box[3],
        );
        if (index >= 0) toggle(index);
      }
      drag = null;
      dragging = false;
      if (canvas.hasPointerCapture(event.pointerId))
        canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", () => {
      drag = null;
      dragging = false;
    });
    dialog.addEventListener("input", (event) => {
      if (event.target.matches("[data-fe-name]")) controls();
      if (event.target.matches("[data-fe-roi]")) {
        const values = [...dialog.querySelectorAll("[data-fe-roi]")].map((el) =>
          clamp(Number(el.value) / 100, 0, 1),
        );
        values[0] = Math.min(values[0], 0.98);
        values[1] = Math.min(values[1], 0.98);
        values[2] = clamp(values[2], 0.02, 1 - values[0]);
        values[3] = clamp(values[3], 0.02, 1 - values[1]);
        roi = values;
        syncROI();
      }
      if (event.target.matches("[data-fe-start]")) {
        try {
          updateRange();
        } catch (error) {
          status(error.message, true);
        }
      }
    });
    dialog.addEventListener("change", async (event) => {
      try {
        if (event.target.matches("[data-fe-source]")) sourceChanged();
        if (event.target.matches("[data-fe-camera]")) {
          sourceChanged();
        }
        if (event.target.matches("[data-fe-file]"))
          await mediaFile(event.target.files[0]);
        if (event.target.matches("[data-fe-start], [data-fe-duration]")) {
          stopPreview();
          video.pause();
          const range = updateRange();
          await seek(range.start, generation);
          drawVideo();
        }
      } catch (error) {
        if (!closed && error.name !== "AbortError") status(error.message, true);
        controls();
      }
    });
    dialog.addEventListener("click", async (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      try {
        if (button.hasAttribute("data-fe-close")) dialog.close();
        if (button.hasAttribute("data-fe-inspect")) await inspect();
        if (button.hasAttribute("data-fe-sample-video")) await inspect(true);
        if (button.hasAttribute("data-fe-reset-roi")) {
          roi = null;
          syncROI();
        }
        if (button.hasAttribute("data-fe-clear")) clearReview();
        if (button.hasAttribute("data-fe-cancel")) {
          operation++;
          frameSerial++;
          imageVersion++;
          stopPreview();
          requestAbort?.abort();
          busy = false;
          status(
            "Inspection cancelled. Review any completed frames or inspect again.",
          );
          controls();
        }
        if (button.hasAttribute("data-fe-live")) {
          live = !live;
          shownToken = null;
          if (live) preview(generation);
          else stopPreview();
          draw();
          controls();
        }
        if (button.hasAttribute("data-fe-candidate"))
          toggle(Number(button.dataset.feCandidate));
        if (button.hasAttribute("data-fe-select-all")) {
          if (samples.length > 20)
            throw Error("Choose up to 20 samples individually.");
          samples.forEach((_, index) => selected.add(index));
          paintSamples();
        }
        if (button.hasAttribute("data-fe-play")) {
          if (recording && recordingPlaying) {
            stopPreview();
            controls();
            return;
          }
          const range = updateRange();
          if (!range) return;
          stopPreview();
          if (recording) {
            recordingPlaying = true;
            const expected = generation;
            const started = performance.now();
            const playRecording = async () => {
              if (
                closed ||
                document.hidden ||
                !recordingPlaying ||
                expected !== generation
              )
                return;
              const time = range.start + (performance.now() - started) / 1000;
              if (time >= range.start + range.duration) {
                recordingPlaying = false;
                controls();
                return;
              }
              try {
                await seek(time, expected);
              } catch (error) {
                const active = recordingPlaying && expected === generation;
                recordingPlaying = false;
                if (active && !closed) status(error.message, true);
                controls();
                return;
              }
              if (recordingPlaying && expected === generation)
                timer = setTimeout(playRecording, 500);
            };
            await playRecording();
            return;
          }
          await seek(range.start, generation);
          await video.play();
          const play = () => {
            if (closed || video.paused) return;
            if (video.currentTime >= range.start + range.duration) {
              video.pause();
              return;
            }
            drawVideo();
            timer = setTimeout(play, 50);
          };
          play();
        }
        if (button.hasAttribute("data-fe-save")) {
          const name = $("[data-fe-name]").value.trim();
          if (!name || !selected.size || saving || busy) return;
          saving = true;
          controls();
          status("Saving reviewed samples…");
          try {
            await json(route("enroll-reviewed"), {
              identity_name: name,
              selections: [...selected].map((index) => ({
                review_token: samples[index].token,
                face_index: samples[index].face,
              })),
            });
            clearReview();
            status(
              "Face profile saved. Portraits stay local; full source media was not retained.",
            );
            await options.onSaved?.();
          } finally {
            saving = false;
            controls();
          }
        }
      } catch (error) {
        if (!closed) status(error.message, true);
      }
    });
    const visibility = () => {
      if (document.hidden) {
        stopPreview();
        video.pause();
      } else if (source === "camera" && live && !busy) preview(generation);
    };
    document.addEventListener("visibilitychange", visibility);
    const observer = new MutationObserver(() => {
      if (options.opener && !options.opener.isConnected) dialog.close();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    dialog.addEventListener(
      "close",
      () => {
        closed = true;
        invalidate();
        observer.disconnect();
        document.removeEventListener("visibilitychange", visibility);
        dialog.remove();
        if (options.opener?.isConnected) options.opener.focus();
      },
      { once: true },
    );
    dialog.addEventListener("cancel", (event) => {
      if (saving) {
        event.preventDefault();
        status("Wait for the current save to finish.");
      }
    });
    dialog.showModal();
    $("[data-fe-camera]").value = options.cameraId || "";
    controls();
    if (options.recording) {
      try {
        await recordingSource(options.recording, options.offset || 0);
      } catch (error) {
        if (!closed && error.name !== "AbortError") status(error.message, true);
      }
    } else if (options.file) {
      try {
        await mediaFile(options.file);
      } catch (error) {
        status(error.message, true);
      }
    } else preview(generation);
    return dialog;
  }
  let handoff = 0;
  async function fromRecording(item, offset = 0) {
    if (
      window.spyderShowcase ||
      item?.kind !== "recording" ||
      !/^[0-9a-f]{32}$/.test(String(item?.id || ""))
    )
      return;
    if (document.querySelector(".fe-studio, .fe-recording-picker")) return;
    const token = ++handoff;
    // Wait for workspace mounting, rather than a fixed timeout after hash navigation.
    location.hash = "vision-lab";
    let observer, timeout;
    const tab = await new Promise((resolve) => {
      const scan = () => {
        const button = document.getElementById("vision-gallery-tab");
        if (button) {
          observer?.disconnect();
          clearTimeout(timeout);
          resolve(button);
        }
      };
      observer = new MutationObserver(scan);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      timeout = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, 5000);
      scan();
    });
    if (!tab || token !== handoff) return;
    tab.click();
    const picker = document.createElement("dialog");
    picker.className = "dt-dialog fe-recording-picker";
    picker.setAttribute("aria-labelledby", "fe-recording-title");
    picker.innerHTML = `<header class="fe-heading"><div><h3 id="fe-recording-title">Enroll someone from a recording</h3><p>${escape(item.name || item.filename || "Saved recording")} · ${Math.max(0, Number(offset) || 0).toFixed(1)}s</p></div><button type="button" class="dt-icon-button" data-picker-close aria-label="Cancel enrollment">${closeIcon}</button></header><p>Choose the gallery for this person. Then focus on their face and review a 5–10 second range before saving.</p><label>Face gallery<select data-picker-gallery disabled><option>Loading galleries…</option></select></label><p data-picker-status role="status"></p><div class="fe-actions"><button type="button" class="dt-button dt-primary" data-picker-open disabled>Open clip in Enrollment Studio</button><button type="button" class="dt-button" data-picker-close>Cancel</button></div>`;
    document.body.append(picker);
    picker.showModal();
    const abort = new AbortController();
    const navigation = new MutationObserver(() => {
      if (!tab.isConnected) picker.close();
    });
    navigation.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    picker.addEventListener(
      "close",
      () => {
        abort.abort();
        navigation.disconnect();
        picker.remove();
      },
      { once: true },
    );
    picker
      .querySelectorAll("[data-picker-close]")
      .forEach((button) => (button.onclick = () => picker.close()));
    try {
      const response = await fetch("/api/faces/galleries", {
        cache: "no-store",
        signal: abort.signal,
      });
      if (!response.ok)
        throw Error("Unable to load galleries. Cancel and try again.");
      const result = await response.json();
      if (!picker.open) return;
      const select = picker.querySelector("[data-picker-gallery]");
      select.replaceChildren();
      for (const gallery of result.galleries || [])
        select.add(new Option(gallery.name, gallery.id));
      const ready = select.options.length > 0;
      select.disabled = !ready;
      picker.querySelector("[data-picker-open]").disabled = !ready;
      if (!ready)
        picker.querySelector("[data-picker-status]").textContent =
          "Create a gallery on this page first, then return to your recording and choose Enroll someone.";
      picker.querySelector("[data-picker-open]").onclick = async () => {
        const galleryId = select.value;
        const galleryName = select.selectedOptions[0]?.text;
        picker.close();
        await open({
          galleryId,
          galleryName,
          recording: { id: item.id, name: item.name, filename: item.filename },
          offset,
          opener: tab,
          onSaved: () => {
            window.dispatchEvent(
              new CustomEvent("spyder:face-galleries-changed"),
            );
            document.querySelector(".fe-studio")?.close();
            if (tab.isConnected) tab.click();
          },
        });
      };
    } catch (error) {
      if (picker.open)
        picker.querySelector("[data-picker-status]").textContent =
          error.message;
    }
  }
  window.spyderFaceEnrollment = {
    open,
    clipRange,
    normalizedRegion,
    fromRecording,
  };
})();
