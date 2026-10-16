"use strict";
(() => {
  const DEFAULTS = {
    enabled: false,
    contours: true,
    components: true,
    tracking: false,
    threshold: 16,
    history: 300,
    learning_rate: -1,
    detect_shadows: true,
    min_area_percent: 0.5,
    inference_fps: 5,
    input_width: 480,
    warmup_frames: 15,
    max_tracks: 2,
    overlay: true,
    roi: null,
  };
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

  window.spyderVisionLab = {
    mount(container) {
      this.unmount();
      const app = window.spyder;
      if (!container || !app) return;

      let selected = "",
        cfg = { ...DEFAULTS },
        runtime = {},
        capacity = null;
      let pipeline = "none",
        capacityError = "",
        maskURL = "",
        maskState = "";
      let viewMode = "original",
        timer = 0,
        token = 0,
        controller = null;
      let previewSession = "",
        draftRevision = 0,
        appliedRevision = 0,
        draftTimer = 0,
        frameTimer = 0,
        statusTimer = 0,
        frameBusy = false,
        previewBusy = false,
        draftPending = false,
        sessionRecovered = false,
        frameController = null,
        draftController = null,
        statusController = null,
        savedSettingsLoaded = false,
        imageURL = "";
      let maskController = null,
        maskAbortTimer = 0,
        maskRefreshTimer = 0,
        drag = null;
      let dirty = false,
        busy = false,
        capacityBusy = false,
        mounted = true;
      let cameraSignature = "",
        loadedFor = null,
        polling = false,
        pollPending = false;
      let messageText = "",
        messageError = false;
      const showcase = !!window.spyderShowcase;
      if (!showcase) maskState = "Loading isolated draft preview…";
      const root = document.createElement("div");
      root.className = "vision-lab";
      container.replaceChildren(root);

      const cams = () => app.cameras();
      const camera = () => cams().find((c) => c.id === selected);
      const get = async (path, signal) => {
        const response = await fetch(path, { cache: "no-store", signal });
        const data = await response.json();
        if (!response.ok) {
          const error = new Error(data.error || "Analysis status unavailable.");
          error.status = response.status;
          throw error;
        }
        return data;
      };
      const mutate = (path, data) => app.request(path, data);
      const sessionPath = () => `/api/analysis/preview/${previewSession}`;
      const makeSession = () => {
        const bytes = new Uint8Array(18);
        if (window.crypto?.getRandomValues)
          window.crypto.getRandomValues(bytes);
        else
          for (let i = 0; i < bytes.length; i++) bytes[i] = Math.random() * 256;
        return Array.from(bytes, (value) =>
          value.toString(16).padStart(2, "0"),
        ).join("");
      };
      function releaseSession() {
        clearTimeout(draftTimer);
        clearTimeout(frameTimer);
        draftTimer = frameTimer = 0;
        frameController?.abort();
        frameController = null;
        draftController?.abort();
        draftController = null;
        statusController?.abort();
        statusController = null;
        clearTimeout(statusTimer);
        statusTimer = 0;
        if (previewSession) {
          const path = sessionPath();
          previewSession = "";
          fetch(path + "/release", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Spyder-Control": "1",
            },
            body: "{}",
            keepalive: true,
          }).catch(() => {});
        }
        if (imageURL) URL.revokeObjectURL(imageURL);
        imageURL = "";
      }
      const normalize = (settings) => {
        const next = { ...DEFAULTS };
        for (const key of Object.keys(DEFAULTS))
          if (settings && Object.hasOwn(settings, key))
            next[key] = settings[key];
        if (!Array.isArray(next.roi) || next.roi.length !== 4) next.roi = null;
        else next.roi = next.roi.map(Number);
        return next;
      };
      const roiPercent = (i) => (cfg.roi?.[i] || 0) * 100;

      function readForm() {
        const f = root.querySelector("form");
        if (!f) return;
        const v = (name) => f.elements[name];
        cfg = {
          ...cfg,
          enabled: v("enabled").checked,
          contours: v("contours").checked,
          components: v("components").checked,
          tracking: v("tracking").checked,
          threshold: +v("threshold").value,
          history: +v("history").value,
          learning_rate:
            v("learning_rate").value === "auto"
              ? -1
              : +v("learning_rate").value,
          detect_shadows: v("detect_shadows").checked,
          min_area_percent: +v("min_area_percent").value,
          inference_fps: +v("inference_fps").value,
          input_width: +v("input_width").value,
          warmup_frames: +v("warmup_frames").value,
          max_tracks: +v("max_tracks").value,
          overlay: v("overlay").checked,
          roi: null,
        };
        const x = +v("roi_x").value / 100,
          y = +v("roi_y").value / 100;
        const w = +v("roi_w").value / 100,
          h = +v("roi_h").value / 100;
        if (w > 0 && h > 0) cfg.roi = [x, y, w, h];
      }

      function check(name, label) {
        return `<label class="vl-check"><input name="${name}" type="checkbox" ${cfg[name] ? "checked" : ""}><span>${label}</span></label>`;
      }
      function num(name, label, value, min, max, step) {
        return `<label class="vl-field"><span>${label}</span><input name="${name}" type="number" value="${esc(value)}" min="${min}" max="${max}" step="${step}" required></label>`;
      }
      function fields() {
        const c = camera();
        const effective = runtime || {};
        root.innerHTML = `
          <section class="workspace-panel vl-intro">
            <div class="vl-title"><div><p class="eyebrow">NATIVE COMPUTER VISION</p><h2>Motion analysis controls</h2></div><span class="vl-chip">Local processing</span></div>
            <p class="workspace-description">Configure OpenCV motion regions, optional tracking and overlays per camera. This processing stays separate from each camera’s YOLO and InsightFace pipeline.</p>
            ${showcase ? '<div class="vl-showcase" role="status"><strong>Native controls unavailable in browser showcase</strong><p>Preview remains available. Install the local Python app to configure and assess OpenCV analysis. Demo motion preview is browser generated.</p></div>' : ""}
            <div class="vl-picker"><label for="vl-camera">Camera</label><select id="vl-camera"></select><span class="vl-pipeline-label">App pipeline: <b class="vl-pipeline-value">${esc(c?.pipeline || pipeline)}</b> · MOG2 motion analysis</span></div>
          </section>
          <div class="vl-grid">
            <section class="workspace-panel vl-preview-panel">
              <div class="vl-section-head"><div><h2>Live preview</h2><span class="vl-sub">Temporary draft preview. Apply activates settings in Control Room.</span></div><span class="vl-status vl-preview-state" data-state="${esc(effective.state || c?.state || "idle")}">${esc(effective.state || c?.state || "offline")}</span></div>
              <p class="vl-preview-banner">Preview only — Apply activates Control Room</p>
              <label class="vl-view-picker"><span>Preview</span><select class="vl-view-mode" ${showcase ? "disabled" : ""}><option value="original" ${viewMode === "original" ? "selected" : ""}>Original</option><option value="mask" ${viewMode === "mask" ? "selected" : ""}>Foreground mask</option><option value="side-by-side" ${viewMode === "side-by-side" ? "selected" : ""}>Side by side</option></select><span class="vl-mask-note" role="status"></span></label>
              <div class="vl-stage" tabindex="0" aria-label="Camera preview. Drag to draw a region of interest."><div class="vl-image-pair"><img class="vl-image" draggable="false" alt="Selected camera live frame"><img class="vl-mask-image" draggable="false" alt="Draft foreground mask"></div><div class="vl-roi-box" hidden></div></div>
              <div class="vl-metrics"><div><span>Processing</span><b data-metric="processing">—</b></div><div><span>Result age</span><b data-metric="age">—</b></div><div><span>Dropped frames</span><b data-metric="dropped">—</b></div><div><span>Regions</span><b data-metric="regions">0</b></div><div><span>Tracks</span><b data-metric="tracks">0</b></div></div>
              <p class="vl-preview-note">ROI uses normalized source-image coordinates. Letterboxing is excluded. Draft preview never changes Control Room frames.</p><p class="vl-runtime-note" role="status"></p><p class="vl-tracking-note" role="status"></p><div class="vl-results"></div>
            </section>
            <section class="workspace-panel vl-config">
              <div class="vl-section-head"><div><h2>Per-camera configuration</h2><span class="vl-sub">Edits preview live · Apply activates Control Room</span></div><span class="vl-dirty" role="status">${dirty ? "Unsaved changes" : "Saved settings"}</span></div>
              ${showcase ? '<p class="vl-disabled-note">Configuration and server capacity assessment require the installed app.</p>' : ""}
              <form><fieldset ${showcase || !selected || !savedSettingsLoaded ? "disabled" : ""}><legend>Analysis settings</legend>
                <label class="vl-toggle"><input name="enabled" type="checkbox" ${cfg.enabled ? "checked" : ""}><span><b>Enable analysis</b><small>Independent per-camera switch. Off by default.</small></span></label>
                <p class="vl-help">OpenCV MOG2 foreground analysis runs separately from the app pipeline shown above.</p>
                <div class="vl-check-grid">${check("contours", "Contour detection")}${check("components", "Connected components")}${check("tracking", "MIL tracking")}</div>
                <details open><summary>Advanced settings</summary><div class="vl-fields">
                  ${num("threshold", "Threshold", cfg.threshold, 4, 128, 1)}${num("history", "History frames", cfg.history, 20, 2000, 1)}
                  <label class="vl-field"><span>Learning rate</span><select name="learning_rate"><option value="auto" ${cfg.learning_rate === -1 ? "selected" : ""}>Auto</option>${[0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1].map((x) => `<option value="${x}" ${cfg.learning_rate === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>
                  ${check("detect_shadows", "Detect shadows")}<p class="vl-help">Shadow suppression helps reduce illumination changes. Use Auto learning rate for most cameras.</p>
                  ${num("min_area_percent", "Minimum region area (%)", cfg.min_area_percent, 0.01, 25, 0.01)}${num("inference_fps", "Analysis rate (FPS)", cfg.inference_fps, 1, 15, 1)}
                  <label class="vl-field"><span>Input width</span><select name="input_width">${[320, 480, 640, 960].map((x) => `<option value="${x}" ${cfg.input_width === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>
                  ${num("warmup_frames", "Warmup frames", cfg.warmup_frames, 0, 120, 1)}${num("max_tracks", "Maximum tracks", cfg.max_tracks, 1, 4, 1)}${check("overlay", "Draw analysis overlay")}
                </div></details>
                <div class="vl-roi-head"><div><b>Region of interest</b><p class="vl-help">Draw on preview or enter normalized image percentages.</p></div><button type="button" class="button secondary vl-clear-roi">Clear ROI</button></div>
                <div class="vl-roi-fields">${num("roi_x", "X %", roiPercent(0), 0, 100, 0.1)}${num("roi_y", "Y %", roiPercent(1), 0, 100, 0.1)}${num("roi_w", "Width %", roiPercent(2), 0, 100, 0.1)}${num("roi_h", "Height %", roiPercent(3), 0, 100, 0.1)}</div>
                <div class="vl-actions"><button type="submit" class="button primary" ${busy ? "disabled" : ""}>${busy ? "Saving…" : "Apply settings"}</button><button type="button" class="button secondary vl-reset">Reset defaults</button><button type="button" class="button secondary vl-disable">Disable analysis</button></div>
                <p class="vl-message" role="status">${esc(messageText)}</p>
              </fieldset></form>
              <p class="vl-help">MOG2 learns background; a static camera gives best results. MIL tracking assigns local track IDs, not identities. YOLO and InsightFace remain independent.</p>
            </section>
          </div>
          <section class="workspace-panel vl-capacity"><div class="vl-section-head"><div><h2>Hardware capacity</h2><span class="vl-sub">Estimated analysis load from this computer</span></div><span class="vl-status vl-capacity-state" data-state="${esc(capacity?.state || "idle")}">${esc(capacityBusy ? "Assessing…" : capacity?.state || "Not assessed")}</span></div>
            <p class="vl-help">Estimates depend on settings, camera resolution and frame rate, plus competing YOLO or GPU workloads. They cannot guarantee a fixed stream count.</p><p class="vl-capacity-error vl-error">${esc(capacityError)}</p><div class="vl-capacity-body"></div><button type="button" class="button secondary vl-assess" ${showcase || capacityBusy ? "disabled" : ""}>Assess capacity</button>
          </section>`;
        updateCameraOptions();
        updatePreview();
        updateLive();
        updateCapacity();
        const msg = root.querySelector(".vl-message");
        msg.classList.toggle("vl-error", messageError);
      }

      function updateCameraOptions() {
        const select = root.querySelector("#vl-camera");
        if (!select) return;
        const options = cams().map(
          (c) => new Option(`${c.name} · ${c.state}`, c.id),
        );
        select.replaceChildren(...options);
        if (cams().some((c) => c.id === selected)) select.value = selected;
      }
      function finite(value, fallback, suffix = "") {
        return value !== null &&
          value !== undefined &&
          value !== "" &&
          Number.isFinite(+value)
          ? (+value).toFixed(1) + suffix
          : fallback;
      }
      function bytes(value) {
        return Number.isFinite(+value)
          ? (+value / 1024 ** 3).toFixed(1) + " GiB"
          : "—";
      }
      function updatePreview() {
        const img = root.querySelector(".vl-image"),
          mask = root.querySelector(".vl-mask-image");
        const pair = root.querySelector(".vl-image-pair"),
          note = root.querySelector(".vl-mask-note");
        if (!img || !pair) return;
        img.src = showcase
          ? selected
            ? app.frame(selected) || ""
            : ""
          : imageURL;
        img.draggable = false;
        mask.src = maskURL || "";
        mask.draggable = false;
        img.hidden = viewMode === "mask";
        mask.hidden = viewMode === "original";
        pair.dataset.mode = viewMode;
        pair.classList.toggle("vl-side-by-side", viewMode === "side-by-side");
        if (note) note.textContent = maskState;
        const stage = root.querySelector(".vl-stage");
        if (stage) stage.dataset.frame = String(!!img.src);
        drawROI();
      }
      function resultRows(r) {
        const items = [
          ...(r.regions || []).map(
            (x, i) =>
              `<div><b>Region ${i + 1}</b><span>${esc(x.area_percent)}% area · ${esc(JSON.stringify(x.bbox || []))}</span></div>`,
          ),
          ...(r.tracks || []).map(
            (x) =>
              `<div><b>Track ${esc(x.id)}</b><span>${esc(JSON.stringify(x.bbox || []))}</span></div>`,
          ),
        ];
        return items.length
          ? items.join("")
          : "<p>No motion regions or tracks reported.</p>";
      }
      function updateLive() {
        const c = camera(),
          r = runtime || {};
        const status = root.querySelector(".vl-preview-state");
        if (status) {
          const state = r.state || c?.state || "offline";
          status.textContent = state;
          status.dataset.state = state;
        }
        const pipelineValue = root.querySelector(".vl-pipeline-value");
        if (pipelineValue) pipelineValue.textContent = c?.pipeline || pipeline;
        const values = {
          processing: finite(r.processing_ms, "—", " ms"),
          age: finite(r.result_age_seconds, "—", " s"),
          dropped: r.dropped_frames ?? "—",
          regions: (r.regions || []).length,
          tracks: (r.tracks || []).length,
        };
        for (const [name, value] of Object.entries(values)) {
          const node = root.querySelector(`[data-metric="${name}"]`);
          if (node) node.textContent = value;
        }
        const results = root.querySelector(".vl-results");
        if (results) results.innerHTML = resultRows(r);
        const runtimeNote = root.querySelector(".vl-runtime-note");
        if (runtimeNote) runtimeNote.textContent = r.message || "";
        const trackingNote = root.querySelector(".vl-tracking-note");
        if (trackingNote) trackingNote.textContent = r.tracking_error || "";
        updateCapacity();
      }
      function updateCapacity() {
        const state = root.querySelector(".vl-capacity-state");
        if (state) {
          state.textContent = capacityBusy
            ? "Assessing…"
            : capacity?.state || "Not assessed";
          state.dataset.state = capacity?.state || "idle";
        }
        const error = root.querySelector(".vl-capacity-error");
        if (error) error.textContent = capacityError;
        const active = capacity?.report?.active_analysis;
        const activeCount = Array.isArray(active)
          ? active.length
          : Number.isFinite(+active)
            ? +active
            : cams().filter((c) => c.analysis_enabled && c.state === "running")
                .length;
        const body = root.querySelector(".vl-capacity-body");
        if (body)
          body.innerHTML = capacity?.report
            ? `<div class="vl-cap-facts"><span>Logical CPUs <b>${esc(capacity.report.hardware?.logical_cpus ?? "—")}</b></span><span>Memory <b>${bytes(capacity.report.hardware?.memory_bytes)}</b></span><span>Analysis running <b>${activeCount}</b></span></div><p>${esc(capacity.report.message || "")}</p><div class="vl-profiles">${(capacity.report.profiles || []).map((p) => `<article><div><b>${esc(p.name)}</b><span>${esc(p.cost_ms)} ms/frame · ${esc(p.suggested_instances)} estimated cameras</span></div><button type="button" class="button secondary vl-recommend" data-fps="${esc(p.inference_fps)}" data-width="${esc(p.input_width)}">Use recommendation</button></article>`).join("")}</div>`
            : `<p>${capacity?.state === "running" ? "Assessment is running…" : "Assess current hardware to see profile estimates."}</p>`;
        const assess = root.querySelector(".vl-assess");
        if (assess) assess.disabled = showcase || capacityBusy;
      }
      function drawROI() {
        const box = root.querySelector(".vl-roi-box");
        if (!box) return;
        const r = cfg.roi;
        box.hidden = !r;
        if (!r) return;
        const rect = imageRect();
        box.style.left = rect.x + r[0] * rect.w + "px";
        box.style.top = rect.y + r[1] * rect.h + "px";
        box.style.width = r[2] * rect.w + "px";
        box.style.height = r[3] * rect.h + "px";
      }
      function imageRect() {
        const stage = root.querySelector(".vl-stage"),
          img = root.querySelector(".vl-image");
        if (!stage || !img) return { x: 0, y: 0, w: 0, h: 0 };
        const s = stage.getBoundingClientRect(),
          nw = img.naturalWidth || 16,
          nh = img.naturalHeight || 9;
        const availableWidth =
          viewMode === "side-by-side" ? s.width / 2 : s.width;
        const scale = Math.min(availableWidth / nw, s.height / nh),
          w = nw * scale,
          h = nh * scale;
        return { x: (availableWidth - w) / 2, y: (s.height - h) / 2, w, h };
      }
      function setROIFromPoint(a, b) {
        const img = imageRect(),
          stage = root.querySelector(".vl-stage").getBoundingClientRect();
        if (!img.w || !img.h) return;
        const p = (q) => ({
          x: Math.max(0, Math.min(1, (q.x - stage.left - img.x) / img.w)),
          y: Math.max(0, Math.min(1, (q.y - stage.top - img.y) / img.h)),
        });
        const p1 = p(a),
          p2 = p(b);
        cfg.roi = [
          Math.min(p1.x, p2.x),
          Math.min(p1.y, p2.y),
          Math.abs(p2.x - p1.x),
          Math.abs(p2.y - p1.y),
        ];
        const f = root.querySelector("form");
        ["roi_x", "roi_y", "roi_w", "roi_h"].forEach((name, i) => {
          f.elements[name].value = (cfg.roi[i] * 100).toFixed(1);
        });
        dirty = true;
        const badge = root.querySelector(".vl-dirty");
        if (badge) badge.textContent = "Unsaved changes";
        drawROI();
        queueDraft();
      }

      function setMessage(text, error = false) {
        messageText = text;
        messageError = error;
        const node = root.querySelector(".vl-message");
        if (node) {
          node.textContent = text;
          node.classList.toggle("vl-error", error);
        }
      }
      function releaseMask() {
        clearTimeout(maskAbortTimer);
        clearTimeout(maskRefreshTimer);
        maskAbortTimer = maskRefreshTimer = 0;
        maskController?.abort();
        maskController = null;
        if (maskURL) URL.revokeObjectURL(maskURL);
        maskURL = "";
        maskState = "";
      }
      async function loadMask() {
        if (showcase || !selected || !previewSession || viewMode === "original")
          return;
        if (maskController) return;
        const id = selected,
          t = token,
          revision = appliedRevision,
          requestController = new AbortController();
        maskController = requestController;
        const timeout = setTimeout(() => requestController.abort(), 4000);
        maskAbortTimer = timeout;
        maskState = maskURL
          ? "Updating foreground mask…"
          : "Loading foreground mask…";
        updatePreview();
        try {
          const response = await fetch(`${sessionPath()}/mask`, {
            cache: "no-store",
            signal: requestController.signal,
          });
          if (
            !mounted ||
            t !== token ||
            id !== selected ||
            revision !== appliedRevision ||
            revision !== draftRevision
          )
            return;
          if (response.status === 503) {
            maskState = "Foreground mask warming up. Try again shortly.";
            return;
          }
          if (!response.ok) throw new Error("Foreground mask unavailable.");
          const blob = await response.blob();
          if (
            !mounted ||
            t !== token ||
            id !== selected ||
            revision !== appliedRevision ||
            revision !== draftRevision
          )
            return;
          const nextURL = URL.createObjectURL(blob),
            previousURL = maskURL;
          maskURL = nextURL;
          if (previousURL) URL.revokeObjectURL(previousURL);
          maskState = "Native foreground mask";
        } catch (error) {
          if (mounted && t === token && error.name !== "AbortError")
            maskState = error.message;
        } finally {
          clearTimeout(timeout);
          if (maskAbortTimer === timeout) maskAbortTimer = 0;
          if (maskController === requestController) maskController = null;
          if (mounted && t === token) {
            updatePreview();
            scheduleMaskRefresh(id, t);
          }
        }
      }
      function queueDraft(delay = 250) {
        if (showcase || !mounted || !selected || !previewSession) return;
        draftRevision++;
        releaseMask();
        maskState = "Updating draft preview…";
        updatePreview();
        clearTimeout(draftTimer);
        clearTimeout(frameTimer);
        frameTimer = 0;
        draftTimer = setTimeout(configureDraft, delay);
      }
      async function configureDraft() {
        if (showcase || !mounted || !selected || !previewSession) return;
        if (previewBusy) {
          draftPending = true;
          return;
        }
        const session = previewSession,
          id = selected,
          t = token,
          revision = draftRevision;
        previewBusy = true;
        const timeoutController = new AbortController();
        draftController = timeoutController;
        const timeout = setTimeout(() => timeoutController.abort(), 4000);
        try {
          const response = await fetch(sessionPath(), {
            method: "POST",
            cache: "no-store",
            signal: timeoutController.signal,
            headers: {
              "Content-Type": "application/json",
              "X-Spyder-Control": "1",
            },
            body: JSON.stringify({ camera_id: id, settings: { ...cfg } }),
          });
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error || "Draft preview unavailable.");
          if (
            !mounted ||
            t !== token ||
            id !== selected ||
            session !== previewSession
          )
            return;
          if (revision === draftRevision) {
            appliedRevision = revision;
            sessionRecovered = false;
            maskState = "";
            runtime = data.runtime || data;
            pipeline = data.pipeline || pipeline;
            updateLive();
            updatePreview();
            if (viewMode !== "original") loadMask();
            scheduleFrame();
            scheduleDraftPoll();
          }
        } catch (error) {
          if (mounted && t === token && error.name !== "AbortError") {
            maskState = error.message;
            updatePreview();
          }
        } finally {
          clearTimeout(timeout);
          if (draftController === timeoutController) draftController = null;
          previewBusy = false;
          if (
            mounted &&
            (draftPending || (t === token && revision !== draftRevision))
          ) {
            draftPending = false;
            configureDraft();
          }
        }
      }
      function scheduleFrame(delay = 250) {
        clearTimeout(frameTimer);
        if (showcase || !mounted || !previewSession || !selected) return;
        frameTimer = setTimeout(loadFrame, delay);
      }
      async function loadFrame() {
        if (frameBusy || showcase || !mounted || !previewSession || !selected)
          return;
        frameBusy = true;
        const id = selected,
          t = token,
          session = previewSession,
          revision = appliedRevision;
        const requestController = new AbortController();
        frameController = requestController;
        const timeout = setTimeout(() => requestController.abort(), 4000);
        try {
          const response = await fetch(`${sessionPath()}/frame`, {
            cache: "no-store",
            signal: requestController.signal,
          });
          if (
            !mounted ||
            t !== token ||
            id !== selected ||
            session !== previewSession ||
            revision !== appliedRevision ||
            revision !== draftRevision
          )
            return;
          if (response.status === 503) {
            maskState = "Preview warming up. Waiting for a fresh frame.";
          } else {
            if (!response.ok) throw new Error("Draft frame unavailable.");
            const blob = await response.blob();
            if (
              !mounted ||
              t !== token ||
              id !== selected ||
              session !== previewSession ||
              revision !== appliedRevision ||
              revision !== draftRevision
            )
              return;
            const nextURL = URL.createObjectURL(blob),
              previousURL = imageURL;
            imageURL = nextURL;
            if (previousURL) URL.revokeObjectURL(previousURL);
            maskState = "";
          }
        } catch (error) {
          if (mounted && t === token && error.name !== "AbortError")
            maskState = error.message;
        } finally {
          clearTimeout(timeout);
          if (frameController === requestController) frameController = null;
          frameBusy = false;
          if (mounted && previewSession) {
            updatePreview();
            scheduleFrame(250);
          }
        }
      }
      async function pollDraft() {
        if (showcase || !mounted || !previewSession || !selected) return;
        const id = selected,
          t = token,
          session = previewSession,
          revision = appliedRevision;
        const requestController = new AbortController();
        statusController = requestController;
        const timeout = setTimeout(() => requestController.abort(), 4000);
        try {
          const data = await get(sessionPath(), requestController.signal);
          if (
            !mounted ||
            t !== token ||
            id !== selected ||
            session !== previewSession ||
            revision !== appliedRevision ||
            revision !== draftRevision
          )
            return;
          runtime = data.runtime || {};
          pipeline = data.pipeline || pipeline;
          updateLive();
        } catch (error) {
          if (
            error.status === 404 &&
            !sessionRecovered &&
            mounted &&
            t === token &&
            session === previewSession
          ) {
            sessionRecovered = true;
            releaseSession();
            if (camera()?.state === "running") {
              previewSession = makeSession();
              queueDraft(0);
            }
            return;
          }
          if (mounted && t === token && error.name !== "AbortError") {
            runtime = { state: "error", message: error.message };
            updateLive();
          }
        } finally {
          clearTimeout(timeout);
          if (statusController === requestController) statusController = null;
          if (mounted && t === token) scheduleDraftPoll();
        }
      }
      function scheduleDraftPoll() {
        if (!showcase && mounted && previewSession) {
          clearTimeout(statusTimer);
          statusTimer = setTimeout(pollDraft, 1200);
        }
      }
      function scheduleMaskRefresh(id, t) {
        clearTimeout(maskRefreshTimer);
        if (
          showcase ||
          !mounted ||
          selected !== id ||
          token !== t ||
          viewMode === "original"
        )
          return;
        maskRefreshTimer = setTimeout(() => {
          maskRefreshTimer = 0;
          if (
            mounted &&
            selected === id &&
            token === t &&
            viewMode !== "original"
          )
            loadMask();
        }, 1200);
      }
      function schedulePoll() {
        if (showcase || !mounted) return;
        clearTimeout(timer);
        timer = setTimeout(poll, 1200);
      }
      async function poll() {
        if (showcase || !mounted) return;
        if (polling) {
          pollPending = true;
          return;
        }
        polling = true;
        pollPending = false;
        const id = selected,
          t = token,
          pollController = new AbortController();
        controller = pollController;
        const timeout = setTimeout(() => pollController.abort(), 4000);
        try {
          const capacityPromise = get(
            "/api/analysis/capacity",
            pollController.signal,
          );
          const analysisPromise =
            id && !savedSettingsLoaded
              ? get(
                  `/api/cameras/${encodeURIComponent(id)}/analysis`,
                  pollController.signal,
                )
              : Promise.resolve(null);
          const [nextCapacity, analysis] = await Promise.all([
            capacityPromise,
            analysisPromise,
          ]);
          if (!mounted || t !== token || id !== selected) return;
          capacity = nextCapacity;
          capacityError = "";
          if (analysis) {
            runtime = analysis.runtime || {};
            pipeline = analysis.pipeline || "none";
            if (!dirty && !busy && loadedFor !== id && analysis.settings) {
              cfg = normalize(analysis.settings);
              loadedFor = id;
              savedSettingsLoaded = true;
              render();
              if (camera()?.state === "running") {
                previewSession = makeSession();
                queueDraft(0);
              } else {
                runtime = {
                  state: "paused",
                  message:
                    "Camera stopped. Start camera in Control Room to preview analysis.",
                };
              }
            }
          }
          updateLive();
        } catch (error) {
          if (mounted && t === token && error.name !== "AbortError") {
            capacityError = error.message;
            if (id) runtime = { state: "error", message: error.message };
            updateLive();
          }
        } finally {
          clearTimeout(timeout);
          if (controller === pollController) controller = null;
          polling = false;
          if (!mounted) return;
          if (pollPending) {
            pollPending = false;
            poll();
          } else if (t === token) schedulePoll();
        }
      }
      function switchCamera(id) {
        if (id === selected) return;
        releaseMask();
        releaseSession();
        selected = id;
        token++;
        loadedFor = null;
        savedSettingsLoaded = false;
        clearTimeout(timer);
        controller?.abort();
        dirty = false;
        busy = false;
        capacityBusy = false;
        runtime = {};
        capacityError = "";
        cfg = { ...DEFAULTS };
        render();
        if (!showcase) {
          if (polling) pollPending = true;
          else poll();
          if (viewMode !== "original") loadMask();
        }
      }
      function render() {
        fields();
        const dirtyNode = root.querySelector(".vl-dirty");
        if (dirtyNode)
          dirtyNode.textContent = dirty ? "Unsaved changes" : "Saved settings";
        updatePreview();
      }

      const onInput = (event) => {
        if (!event.target.closest("form")) return;
        readForm();
        dirty = true;
        queueDraft();
        const badge = root.querySelector(".vl-dirty");
        if (badge) badge.textContent = "Unsaved changes";
        drawROI();
      };
      const onChange = (event) => {
        if (event.target.id === "vl-camera") {
          switchCamera(event.target.value);
          return;
        }
        if (event.target.classList?.contains("vl-view-mode")) {
          viewMode = event.target.value;
          if (viewMode === "original") releaseMask();
          updatePreview();
          loadMask();
          return;
        }
        onInput(event);
      };
      const onSubmit = async (event) => {
        if (!event.target.matches("form")) return;
        event.preventDefault();
        if (showcase || busy || !selected) return;
        readForm();
        const id = selected,
          t = token,
          revision = draftRevision,
          body = { ...cfg };
        busy = true;
        const button = root.querySelector('button[type="submit"]');
        if (button) {
          button.disabled = true;
          button.textContent = "Saving…";
        }
        try {
          await mutate(`/api/cameras/${encodeURIComponent(id)}/analysis`, {
            settings: body,
          });
          if (!mounted || t !== token || selected !== id) return;
          dirty = draftRevision !== revision;
          loadedFor = id;
          setMessage(
            dirty
              ? "Settings saved. Newer draft edits remain unapplied."
              : "Settings saved and scheduled.",
          );
          const badge = root.querySelector(".vl-dirty");
          if (badge)
            badge.textContent = dirty ? "Unsaved changes" : "Saved settings";
        } catch (error) {
          if (mounted && t === token) setMessage(error.message, true);
        } finally {
          if (t === token) {
            busy = false;
            const submit = root.querySelector('button[type="submit"]');
            if (submit) {
              submit.disabled = false;
              submit.textContent = "Apply settings";
            }
          }
        }
      };
      const onClick = async (event) => {
        if (showcase || !mounted) return;
        const button = event.target.closest("button");
        if (!button) return;
        if (button.classList.contains("vl-clear-roi")) {
          cfg.roi = null;
          ["roi_x", "roi_y", "roi_w", "roi_h"].forEach((name) => {
            root.querySelector(`[name="${name}"]`).value = 0;
          });
          dirty = true;
          root.querySelector(".vl-dirty").textContent = "Unsaved changes";
          drawROI();
          queueDraft();
        } else if (button.classList.contains("vl-reset")) {
          cfg = { ...DEFAULTS };
          dirty = true;
          render();
          queueDraft();
          setMessage("Defaults staged. Apply settings to save.");
        } else if (button.classList.contains("vl-disable")) {
          cfg = { ...cfg, enabled: false };
          root.querySelector('[name="enabled"]').checked = false;
          dirty = true;
          root.querySelector(".vl-dirty").textContent = "Unsaved changes";
          queueDraft();
        } else if (button.classList.contains("vl-assess")) {
          const t = token;
          capacityBusy = true;
          capacityError = "";
          updateCapacity();
          try {
            const result = await mutate("/api/analysis/assess", {});
            if (!mounted || t !== token) return;
            capacity = result;
            setMessage("Capacity assessment started.");
          } catch (error) {
            if (mounted && t === token) capacityError = error.message;
          } finally {
            if (mounted && t === token) {
              capacityBusy = false;
              updateCapacity();
              if (selected && !polling) poll();
            }
          }
        } else if (button.classList.contains("vl-recommend")) {
          root.querySelector('[name="inference_fps"]').value =
            button.dataset.fps;
          root.querySelector('[name="input_width"]').value =
            button.dataset.width;
          readForm();
          dirty = true;
          root.querySelector(".vl-dirty").textContent = "Unsaved changes";
          queueDraft();
          setMessage("Recommendation staged. Apply settings to save.");
        }
      };
      const onPointerDown = (event) => {
        if (
          showcase ||
          event.button !== 0 ||
          !selected ||
          !event.target.closest(".vl-stage")
        )
          return;
        event.preventDefault?.();
        const rect = imageRect(),
          stage = root.querySelector(".vl-stage").getBoundingClientRect();
        const x = event.clientX - stage.left,
          y = event.clientY - stage.top;
        if (
          x < rect.x ||
          x > rect.x + rect.w ||
          y < rect.y ||
          y > rect.y + rect.h
        )
          return;
        drag = { x: event.clientX, y: event.clientY };
        event.target.closest(".vl-stage").setPointerCapture(event.pointerId);
      };
      const onPointerMove = (event) => {
        if (drag) setROIFromPoint(drag, { x: event.clientX, y: event.clientY });
      };
      const onPointerUp = () => {
        if (drag) {
          drag = null;
          dirty = true;
        }
      };
      const onPointerCancel = () => {
        drag = null;
      };
      const onDragStart = (event) => {
        if (event.target.closest?.(".vl-image")) event.preventDefault?.();
      };
      const resize = () => drawROI();
      const refresh = () => {
        const signature = JSON.stringify(
          cams().map((c) => [c.id, c.name, c.state]),
        );
        if (signature === cameraSignature) return;
        cameraSignature = signature;
        if (
          (!selected && cams().length > 0) ||
          (selected && !cams().some((c) => c.id === selected))
        ) {
          releaseMask();
          releaseSession();
          selected = cams()[0]?.id || "";
          token++;
          loadedFor = null;
          savedSettingsLoaded = false;
          controller?.abort();
          dirty = false;
          busy = false;
          capacityBusy = false;
          cfg = { ...DEFAULTS };
          runtime = {};
          clearTimeout(timer);
          render();
          if (polling) pollPending = true;
          else poll();
          if (selected && viewMode !== "original") loadMask();
          return;
        }
        updateCameraOptions();
        if (selected && camera()?.state !== "running" && previewSession) {
          releaseMask();
          releaseSession();
          runtime = {
            state: "paused",
            message:
              "Camera stopped. Start camera in Control Room to preview analysis.",
          };
          updateLive();
          return;
        }
        if (
          selected &&
          camera()?.state === "running" &&
          !previewSession &&
          !showcase
        ) {
          if (savedSettingsLoaded) {
            previewSession = makeSession();
            queueDraft(0);
          } else if (!polling) poll();
        }
        updateLive();
      };
      const frameHandler = (event) => {
        if (event.detail?.id === selected) {
          const img = root.querySelector(".vl-image");
          if (showcase && img && viewMode !== "mask")
            img.src = event.detail.url;
        }
      };

      root.addEventListener("input", onInput);
      root.addEventListener("change", onChange);
      root.addEventListener("submit", onSubmit);
      root.addEventListener("click", onClick);
      root.addEventListener("pointerdown", onPointerDown);
      root.addEventListener("pointermove", onPointerMove);
      root.addEventListener("pointerup", onPointerUp);
      root.addEventListener("pointercancel", onPointerCancel);
      root.addEventListener("lostpointercapture", onPointerCancel);
      root.addEventListener("dragstart", onDragStart);
      window.addEventListener("resize", resize);
      window.addEventListener("spyder:cameras", refresh);
      document.addEventListener("spyder:camera-update", refresh);
      document.addEventListener("spyder:frame", frameHandler);
      selected = cams()[0]?.id || "";
      cameraSignature = JSON.stringify(
        cams().map((c) => [c.id, c.name, c.state]),
      );
      render();
      if (!showcase) poll();

      this.unmount = () => {
        mounted = false;
        token++;
        clearTimeout(timer);
        clearTimeout(statusTimer);
        controller?.abort();
        releaseMask();
        releaseSession();
        window.removeEventListener("resize", resize);
        window.removeEventListener("spyder:cameras", refresh);
        document.removeEventListener("spyder:camera-update", refresh);
        document.removeEventListener("spyder:frame", frameHandler);
        root.removeEventListener("input", onInput);
        root.removeEventListener("change", onChange);
        root.removeEventListener("submit", onSubmit);
        root.removeEventListener("click", onClick);
        root.removeEventListener("pointerdown", onPointerDown);
        root.removeEventListener("pointermove", onPointerMove);
        root.removeEventListener("pointerup", onPointerUp);
        root.removeEventListener("pointercancel", onPointerCancel);
        root.removeEventListener("lostpointercapture", onPointerCancel);
        root.removeEventListener("dragstart", onDragStart);
        root.remove();
      };
    },
    unmount() {},
  };
  window.dispatchEvent(new CustomEvent("spyder:vision-lab-ready"));
})();
