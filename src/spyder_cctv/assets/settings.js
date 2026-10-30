function computeSettingsPreview(capabilities = {}, draft = {}) {
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const delta = (name) => {
    const capability = capabilities[name];
    if (!capability?.supported || !Object.hasOwn(draft, name)) return 0;
    const selected = Number(draft[name]),
      baseline = Number(capability.value);
    return Number.isFinite(selected) && Number.isFinite(baseline)
      ? selected - baseline
      : 0;
  };
  const factor = (name) => {
    const capability = capabilities[name];
    if (!capability?.supported || !Object.hasOwn(draft, name)) return 1;
    const current = Number(draft[name]);
    const actual = Number(capability.value);
    if (
      !Number.isFinite(current) ||
      !Number.isFinite(actual) ||
      current <= 0 ||
      actual <= 0
    )
      return 1;
    return clamp(actual / current, 1, 4);
  };
  const zoomCapability = capabilities.zoom;
  let zoom = 1;
  if (zoomCapability?.supported && Object.hasOwn(draft, "zoom")) {
    const baseline = Number(zoomCapability.value),
      selected = Number(draft.zoom);
    if (Number.isFinite(baseline) && Number.isFinite(selected))
      zoom *= clamp(
        baseline > 0 ? selected / baseline : 1 + (selected - baseline) / 100,
        1,
        4,
      );
  }
  zoom *= factor("fov");
  zoom = clamp(zoom, 1, 4);
  const panX = clamp((delta("pan") / 100) * 50, -50, 50);
  const panY = clamp((delta("tilt") / 100) * 50, -50, 50);
  const filterFactor = (name, low, high) =>
    clamp(1 + delta(name) / 50, low, high);
  const filter = [
    `brightness(${filterFactor("brightness", 0.25, 2.5)})`,
    `contrast(${filterFactor("contrast", 0.25, 2.5)})`,
    `saturate(${filterFactor("saturation", 0, 3)})`,
  ].join(" ");
  return {
    filter,
    zoom,
    panX,
    panY,
    transform: `scale(${zoom})`,
    transformOrigin: `${clamp(50 - panX, 0, 100)}% ${clamp(50 - panY, 0, 100)}%`,
  };
}

if (typeof module === "object" && module.exports)
  module.exports = { computeSettingsPreview };

/* Device controls and profile workflows use the dashboard's small public interface. */
(() => {
  "use strict";
  if (typeof window === "undefined") return;
  const app = window.spyder;
  const find = (selector, root = document) => root.querySelector(selector);
  const dialog = find("#settings-dialog");
  const library = find("#profiles-dialog");
  const labels = {
    zoom: "Zoom",
    fov: "Field of view",
    pan: "Pan",
    tilt: "Tilt",
    brightness: "Brightness",
    contrast: "Contrast",
    saturation: "Saturation",
  };
  let active = null;
  let generation = 0;
  let snapshot = null;
  let profiles = [];
  let draft = {};
  let dirty = false;
  let busy = false;
  let pollTimer = null;
  let pollController = null;
  let draftRevision = 0;
  let simulationSuspended = false;
  const rows = new Map();
  const motionDefaults = Object.freeze({
    history: 300,
    threshold: 16,
    min_area_percent: 0.5,
    detect_shadows: true,
    learning_rate: -1,
    warmup_frames: 15,
    inference_fps: 5,
    input_width: 320,
  });
  let motionEngine = "frame-difference";
  let motionConfig = { ...motionDefaults };
  let motionDirty = false;
  let motionBusy = false;
  let motionFeedback = "";
  let motionPanel = null;
  let motionConfigFields = [];
  function current(id, token) {
    return active === id && generation === token && dialog.open;
  }

  function showcaseMotionCamera() {
    if (!window.spyderShowcase || !active) return null;
    return (
      app
        .cameras()
        .find((camera) => camera.id === active && camera.pipeline === "motion") ||
      null
    );
  }

  function createMotionPanel(container) {
    if (!showcaseMotionCamera()) return;
    if (!motionPanel) {
      motionPanel = document.createElement("fieldset");
      motionPanel.className = "browser-motion-panel";
      motionPanel.setAttribute("aria-describedby", "browser-motion-help");
      motionPanel.innerHTML = [
        "<legend>Browser motion engine</legend>",
        '<p id="browser-motion-help" class="field-help">Runs on this device in a local browser worker. Frames stay on this device; no uploads. Frame difference measures inter-frame change; MOG2 measures foreground. Review workflow thresholds when switching. OpenCV.js failure keeps video live and does not silently switch engines.</p>',
        '<label for="browser-motion-engine">Engine</label>',
        '<select id="browser-motion-engine"><option value="frame-difference">Frame difference</option><option value="mog2">MOG2 background subtraction (OpenCV.js)</option></select>',
        '<div class="browser-motion-config" id="browser-motion-config">',
        '<p class="field-help">Changing MOG2 settings resets its learned background. Existing workflows keep their thresholds. Load an updated Approach template or edit the MOG2 foreground fraction in its Browser motion node.</p>',
        '<div class="browser-motion-config-grid">',
        '<label>Analysis rate (1–15 FPS)<input type="number" data-motion-config="inference_fps" min="1" max="15" step="1"></label>',
        '<label>Input width<select data-motion-config="input_width"><option value="320">320 px · lower load</option><option value="480">480 px · native default width</option></select></label>',
        '<label>History frames (20–2000)<input type="number" data-motion-config="history" min="20" max="2000" step="1"></label>',
        '<label>Foreground threshold (4–128)<input type="number" data-motion-config="threshold" min="4" max="128" step="1"></label>',
        '<label>Minimum region area (%)<input type="number" data-motion-config="min_area_percent" min="0.01" max="25" step="0.01"></label>',
        '<label>Warm-up frames (0–120)<input type="number" data-motion-config="warmup_frames" min="0" max="120" step="1"></label>',
        '<label>Learning rate (−1 = auto; otherwise 0–1)<input type="number" data-motion-config="learning_rate" min="-1" max="1" step="0.01"></label>',
        '<label class="browser-motion-check"><input type="checkbox" data-motion-config="detect_shadows"> Detect shadows</label>',
        "</div></div>",
        '<div class="browser-motion-diagnostics" aria-label="Motion processing diagnostics">',
        '<p class="browser-motion-state" id="browser-motion-state" role="status" aria-live="polite"></p>',
        '<p class="browser-motion-metrics" id="browser-motion-metrics"></p></div>',
        '<p class="browser-motion-feedback" id="browser-motion-feedback" role="status" aria-live="polite"></p>',
        '<button type="button" class="button secondary" id="browser-motion-apply">Apply motion engine</button>',
      ].join("");
      container.append(motionPanel);
      motionPanel
        .querySelector("#browser-motion-engine")
        .addEventListener("change", (event) => {
          motionEngine = event.currentTarget.value;
          motionChanged();
        });
      motionConfigFields = [...motionPanel.querySelectorAll("[data-motion-config]")];
      for (const field of motionConfigFields) {
        field.addEventListener("input", () => {
          readMotionConfigField(field);
          motionChanged();
        });
        field.addEventListener("change", () => {
          readMotionConfigField(field);
          motionChanged();
        });
      }
      motionPanel
        .querySelector("#browser-motion-apply")
        .addEventListener("click", applyMotionSettings);
    } else if (motionPanel.parentElement !== container) {
      container.append(motionPanel);
    }
    syncMotionFields();
    updateMotionControls();
    renderMotionDiagnostics();
  }

  function syncMotionFields() {
    if (!motionPanel) return;
    motionPanel.querySelector("#browser-motion-engine").value = motionEngine;
    for (const field of motionConfigFields) {
      const key = field.dataset.motionConfig;
      if (key === "detect_shadows") field.checked = !!motionConfig[key];
      else field.value = String(motionConfig[key]);
    }
  }

  function readMotionConfigField(field) {
    const key = field.dataset.motionConfig;
    if (key === "detect_shadows") motionConfig[key] = field.checked;
    else if (
      field.value !== "" &&
      field.validity.valid &&
      Number.isFinite(Number(field.value))
    )
      motionConfig[key] = Number(field.value);
  }

  function motionChanged() {
    motionDirty = true;
    motionFeedback = "Unsaved. Apply to start this engine with these settings.";
    updateMotionControls();
  }

  function updateMotionControls() {
    if (!motionPanel) return;
    const engine = motionPanel.querySelector("#browser-motion-engine");
    motionPanel.querySelector("#browser-motion-config").hidden =
      motionEngine !== "mog2";
    for (const field of motionConfigFields) {
      field.disabled = motionBusy;
    }
    engine.disabled = motionBusy;
    const button = motionPanel.querySelector("#browser-motion-apply");
    button.disabled =
      motionBusy || (!motionDirty && !canRetryMotion()) || !showcaseMotionCamera();
    button.textContent = motionBusy ? "Applying…" : "Apply motion engine";
  }

  function canRetryMotion() {
    const analysis = showcaseMotionCamera()?.motion_analysis;
    return (
      motionEngine === "mog2" &&
      analysis?.engine === "mog2" &&
      analysis.state === "error"
    );
  }

  function formatMotionBytes(value) {
    if (value == null) return null;
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return null;
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KiB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
  }

  function renderMotionDiagnostics() {
    if (!motionPanel) return;
    const analysis = showcaseMotionCamera()?.motion_analysis;
    const state = motionPanel.querySelector("#browser-motion-state");
    const metrics = motionPanel.querySelector("#browser-motion-metrics");
    const feedback = motionPanel.querySelector("#browser-motion-feedback");
    let text = "No motion diagnostics reported yet.";
    let failed = false;
    if (analysis) {
      const engineName =
        analysis.engine === "mog2" ? "MOG2" : "Frame difference";
      const stateText = {
        idle: "Waiting to start",
        loading: "Loading local OpenCV.js…",
        warming_up: "Learning the background…",
        ready: "Ready",
        error: "Failed",
      }[analysis.state] || String(analysis.state || "status unavailable");
      text = engineName + " · " + stateText;
      if (analysis.state === "error") {
        text +=
          ". Preview remains live; no automatic fallback. Apply MOG2 to retry, or choose Frame difference.";
        failed = true;
      }
      if (analysis.error && analysis.state === "error")
        text += " · " + analysis.error;
    } else if (showcaseMotionCamera()) {
      text = "Waiting for this camera’s motion status.";
    }
    if (state.textContent !== text) state.textContent = text;
    state.classList.toggle("error", failed);
    const values = [];
    if (
      analysis?.processing_ms != null &&
      Number.isFinite(Number(analysis.processing_ms))
    )
      values.push(Number(analysis.processing_ms).toFixed(1) + " ms/frame");
    if (
      analysis?.effective_fps != null &&
      Number.isFinite(Number(analysis.effective_fps))
    )
      values.push(Number(analysis.effective_fps).toFixed(1) + " FPS");
    if (analysis?.width && analysis?.height)
      values.push(analysis.width + " × " + analysis.height + " px");
    if (
      analysis?.region_count != null &&
      Number.isFinite(Number(analysis.region_count))
    )
      values.push(Number(analysis.region_count) + " regions");
    const heap = formatMotionBytes(analysis?.heap_bytes);
    if (heap) values.push(heap + " shared Wasm heap");
    const metricText = values.join(" · ");
    if (metrics.textContent !== metricText) metrics.textContent = metricText;
    metrics.hidden = values.length === 0;
    if (feedback.textContent !== motionFeedback)
      feedback.textContent = motionFeedback;
    feedback.classList.toggle("error", motionFeedback.startsWith("Could not"));
    updateMotionControls();
  }

  async function applyMotionSettings() {
    if (motionBusy || !active || (!motionDirty && !canRetryMotion())) return;
    const id = active;
    const token = generation;
    if (!showcaseMotionCamera()) return;
    if (motionEngine === "mog2")
      for (const field of motionConfigFields) {
        if (!field.checkValidity()) {
          field.reportValidity();
          return;
        }
      }
    const payload = { engine: motionEngine, ...motionConfig };
    motionBusy = true;
    motionFeedback = "Applying local motion engine…";
    updateMotionControls();
    renderMotionDiagnostics();
    try {
      await app.request("/api/cameras/" + id + "/motion", payload);
      if (!current(id, token)) return;
      motionDirty = false;
      motionFeedback = "Motion engine requested. Loading and processing stay on this device.";
      await app.refresh();
      renderMotionDiagnostics();
    } catch (error) {
      if (current(id, token)) {
        motionFeedback = "Could not apply motion engine: " + error.message;
        renderMotionDiagnostics();
      }
    } finally {
      if (current(id, token)) {
        motionBusy = false;
        updateMotionControls();
      }
    }
  }

  function resetMotionDraft() {
    const analysis = showcaseMotionCamera()?.motion_analysis;
    motionEngine = ["frame-difference", "mog2"].includes(analysis?.engine)
      ? analysis.engine
      : "frame-difference";
    motionConfig = {
      ...motionDefaults,
      ...(analysis?.config && typeof analysis.config === "object"
        ? analysis.config
        : {}),
    };
    motionDirty = false;
    motionBusy = false;
    motionFeedback = "";
    syncMotionFields();
    updateMotionControls();
  }

  async function get(path, controller = new AbortController()) {
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await (window.spyderShowcase?.fetch || fetch)(path, {
        cache: "no-store",
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Camera settings unavailable.");
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
  function result(element, text, error = false) {
    element.textContent = text;
    element.classList.toggle("error", error);
  }
  function settingsMessage(text, error = false) {
    result(find("#settings-result"), text, error);
  }
  function libraryMessage(text, error = false) {
    result(find("#profiles-result"), text, error);
  }
  function percent(value) {
    return Number(value).toFixed(1) + "%";
  }
  function selectedSettings() {
    const values = {};
    for (const [name, row] of rows)
      if (row.include.checked) values[name] = Number(row.slider.value);
    return values;
  }
  function resetPreviewStyles() {
    const image = find("#settings-preview");
    image.draggable = false;
    image.style.removeProperty("filter");
    image.style.removeProperty("transform");
    image.style.removeProperty("transform-origin");
  }
  function updateSimulatedPreview() {
    const image = find("#settings-preview");
    const note = find("#settings-preview-note");
    image.draggable = false;
    if (
      !snapshot?.available ||
      !image.getAttribute("src") ||
      simulationSuspended
    ) {
      resetPreviewStyles();
      if (snapshot?.available && simulationSuspended) {
        note.hidden = false;
        note.textContent =
          "Hardware is applying changes. Preview simulation resumes after readback.";
      }
      return;
    }
    if (!dirty) {
      resetPreviewStyles();
      note.hidden = false;
      note.textContent =
        "Live hardware preview · Edit controls for a simulated draft";
      return;
    }
    const simulated = computeSettingsPreview(snapshot.capabilities, draft);
    image.style.filter = simulated.filter;
    image.style.transform = simulated.transform;
    image.style.transformOrigin = simulated.transformOrigin;
    note.hidden = false;
    note.textContent =
      "Simulated preview · Apply changes hardware/Control Room · Approximate vs driver";
  }
  function availability() {
    for (const [name, row] of rows) {
      const capability = snapshot?.capabilities[name];
      row.slider.disabled =
        !snapshot?.available ||
        !capability?.supported ||
        !row.include.checked ||
        busy;
      row.include.disabled =
        busy || (!capability?.supported && !(name in draft));
    }
    find("#apply-settings").disabled = busy || !snapshot?.available;
    find("#control-defaults").disabled =
      busy ||
      !snapshot?.available ||
      !Object.values(snapshot.capabilities).some(
        (c) => c.supported && typeof c.default_percent === "number",
      );
    find("#control-defaults").title = window.spyderShowcase
      ? "Browsers do not report driver defaults"
      : "Stage defaults for selected controls";
    find("#save-profile").disabled =
      busy || !Object.keys(selectedSettings()).length;
    find("#assign-profile").disabled = busy || !snapshot;
    find("#profile-choice").disabled = busy || !snapshot;
  }
  function profileOptions(selected = "") {
    const select = find("#profile-choice");
    select.replaceChildren(new Option("Custom settings", ""));
    for (const profile of profiles)
      select.append(new Option(profile.name, profile.id));
    select.value = selected || "";
  }
  function drawControls() {
    const container = find("#camera-controls");
    container.replaceChildren();
    rows.clear();
    for (const [name, labelText] of Object.entries(labels)) {
      const capability = snapshot.capabilities[name] || {
        supported: false,
        reason: "Not reported by this camera",
      };
      const row = document.createElement("div");
      row.className =
        "control-row" + (capability.supported ? "" : " unsupported");
      const heading = document.createElement("div");
      heading.className = "control-heading";
      const label = document.createElement("label");
      const include = document.createElement("input");
      include.type = "checkbox";
      include.setAttribute("aria-label", "Include " + labelText);
      include.checked = name in draft;
      label.append(include, document.createTextNode(labelText));
      const output = document.createElement("output");
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "100";
      slider.step = "0.1";
      slider.id = "control-" + name;
      slider.setAttribute("aria-label", labelText);
      slider.value = draft[name] ?? capability.value ?? 0;
      slider.style.setProperty("--range-progress", slider.value + "%");
      output.htmlFor = slider.id;
      output.textContent =
        capability.supported || name in draft
          ? percent(slider.value)
          : "Unavailable";
      const native = document.createElement("p");
      native.className = "control-native";
      native.id = "control-info-" + name;
      slider.setAttribute("aria-describedby", native.id);
      include.addEventListener("change", () => {
        if (include.checked) draft[name] = Number(slider.value);
        else delete draft[name];
        dirty = true;
        draftRevision++;
        updateSimulatedPreview();
        settingsMessage(
          "Unsaved changes. Apply to activate settings on hardware.",
        );
        availability();
      });
      slider.addEventListener("input", () => {
        slider.style.setProperty("--range-progress", slider.value + "%");
        draft[name] = Number(slider.value);
        output.textContent = percent(slider.value);
        dirty = true;
        draftRevision++;
        updateSimulatedPreview();
        settingsMessage(
          "Unsaved changes. Apply to activate settings on hardware.",
        );
      });
      heading.append(label, output);
      row.append(heading, slider, native);
      container.append(row);
      rows.set(name, { element: row, include, output, slider, native });
    }
    createMotionPanel(container);
    updateReadbacks();
  }
  function updateReadbacks() {
    if (!snapshot.available) {
      find("#settings-preview").hidden = true;
      find("#settings-preview").removeAttribute("src");
      find("#settings-preview-note").hidden = false;
      find("#settings-preview-note").textContent =
        "Start the camera to preview its current frame";
    }
    for (const [name, row] of rows) {
      const capability = snapshot.capabilities[name];
      const outcome = snapshot.results[name];
      row.native.textContent = capability?.supported
        ? "Current " +
          capability.native_value +
          " device units · " +
          percent(capability.value) +
          " · Range " +
          capability.minimum +
          "–" +
          capability.maximum +
          " · Step " +
          capability.step +
          (capability.mode === "auto"
            ? " · Auto (applying switches to manual)"
            : "")
        : capability?.reason || "Not reported by this camera";
      if (outcome) {
        const state = document.createElement("span");
        state.className = "control-result";
        state.textContent =
          " · " +
          ({
            applied: "Applied",
            adjusted: "Driver adjusted",
            unsupported: "Skipped: unavailable",
            rejected: "Driver rejected",
            failed: "Control failed",
          }[outcome.status] || outcome.status) +
          (outcome.value != null ? " at " + percent(outcome.value) : "");
        row.native.append(state);
      }
    }
    updateSimulatedPreview();
    availability();
  }
  function chooseDraft() {
    draft = { ...snapshot.desired };
    if (!Object.keys(draft).length)
      for (const [name, capability] of Object.entries(snapshot.capabilities)) {
        if (capability.supported) draft[name] = capability.value;
      }
    dirty = false;
    profileOptions(snapshot.profile_id);
    drawControls();
  }
  async function settingsPoll() {
    if (!dialog.open || !active || !snapshot) return;
    const id = active;
    const token = generation;
    pollController = new AbortController();
    try {
      const next = await get(
        "/api/cameras/" + id + "/settings",
        pollController,
      );
      if (!current(id, token)) return;
      const changed = snapshot.available !== next.available;
      snapshot = next;
      if (simulationSuspended && snapshot.settings_state !== "pending")
        simulationSuspended = false;
      if (changed && !dirty) chooseDraft();
      else updateReadbacks();
      renderMotionDiagnostics();
      if (!busy && !dirty)
        settingsMessage(
          !snapshot.available
            ? "Camera paused or offline. Assign a profile now; it applies on the next start."
            : snapshot.settings_state === "pending"
              ? "Applying saved settings…"
              : snapshot.settings_state === "partial"
                ? "Some controls were skipped, adjusted, or rejected. Readbacks below show what applied."
                : Object.keys(snapshot.desired).length
                  ? "Settings are saved. Current values are confirmed by the driver."
                  : "Current values are read from the camera. Apply or save a profile to remember changes.",
        );
    } catch (error) {
      if (current(id, token) && error.name !== "AbortError") {
        settingsMessage(error.message, true);
        snapshot.available = false;
        availability();
      }
    } finally {
      if (generation === token) pollController = null;
      if (current(id, token)) pollTimer = setTimeout(settingsPoll, 900);
    }
  }
  async function openSettings(id) {
    const token = ++generation;
    clearTimeout(pollTimer);
    pollController?.abort();
    pollController = null;
    active = id;
    snapshot = null;
    draft = {};
    resetMotionDraft();
    simulationSuspended = false;
    resetPreviewStyles();
    find("#settings-preview").removeAttribute("src");
    find("#settings-preview-note").textContent =
      "Start the camera for a live preview";
    find("#settings-preview-note").hidden = false;
    dirty = false;
    busy = true;
    rows.clear();
    find("#camera-controls").replaceChildren();
    find("#settings-camera-label").textContent =
      app.cameras().find((camera) => camera.id === id)?.name || "Camera";
    settingsMessage("Reading camera capabilities…");
    dialog.showModal();
    availability();
    try {
      const [camera, saved] = await Promise.all([
        get("/api/cameras/" + id + "/settings"),
        get("/api/profiles"),
      ]);
      if (!current(id, token)) return;
      snapshot = camera;
      profiles = saved;
      chooseDraft();
      const frame = app.frame(id);
      find("#settings-preview").hidden = !frame || !camera.available;
      find("#settings-preview-note").hidden = !!frame && camera.available;
      if (frame && camera.available) find("#settings-preview").src = frame;
      updateSimulatedPreview();
      settingsMessage(
        camera.available
          ? "Select the controls you want to apply or include in a profile."
          : "Start the camera to discover its controls. Profiles can be assigned while paused.",
      );
    } catch (error) {
      if (current(id, token)) settingsMessage(error.message, true);
    } finally {
      if (current(id, token)) {
        busy = false;
        availability();
        if (snapshot) settingsPoll();
      }
    }
  }
  document.addEventListener("spyder:camera-settings", (event) =>
    openSettings(event.detail.id),
  );
  document.addEventListener("spyder:frame", (event) => {
    if (dialog.open && active === event.detail.id && snapshot?.available) {
      find("#settings-preview").src = event.detail.url;
      find("#settings-preview").hidden = false;
      updateSimulatedPreview();
    }
  });
  for (const button of document.querySelectorAll(".close-settings"))
    button.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    generation++;
    active = null;
    clearTimeout(pollTimer);
    pollController?.abort();
    simulationSuspended = false;
    resetPreviewStyles();
    find("#settings-preview").removeAttribute("src");
    find("#settings-preview-note").textContent =
      "Start the camera for a live preview";
    find("#settings-preview-note").hidden = false;
    find("#profile-name").value = "";
    motionDirty = false;
    motionBusy = false;
    motionFeedback = "";
  });
  find("#control-defaults").addEventListener("click", () => {
    for (const [name, row] of rows)
      if (
        snapshot.capabilities[name]?.supported &&
        row.include.checked &&
        typeof snapshot.capabilities[name].default_percent === "number"
      ) {
        row.slider.value = snapshot.capabilities[name].default_percent;
        row.slider.style.setProperty(
          "--range-progress",
          row.slider.value + "%",
        );
        row.output.textContent = percent(row.slider.value);
        if (row.include.checked) draft[name] = Number(row.slider.value);
      }
    dirty = true;
    draftRevision++;
    updateSimulatedPreview();
    settingsMessage("Defaults are staged. Apply to this camera to save them.");
  });
  find("#assign-profile").textContent = "Assign & apply";
  find("#apply-settings").addEventListener("click", async () => {
    if (busy || !active) return;
    const id = active;
    const token = generation;
    const submittedRevision = draftRevision;
    const settings = selectedSettings();
    busy = true;
    availability();
    try {
      const updated = await app.request("/api/cameras/" + id + "/settings", {
        settings,
      });
      if (!current(id, token)) {
        await app.refresh();
        return;
      }
      snapshot = updated;
      simulationSuspended = true;
      dirty = draftRevision !== submittedRevision;
      updateSimulatedPreview();
      profileOptions("");
      settingsMessage("Settings saved. The camera worker is applying them…");
      await app.refresh();
    } catch (error) {
      if (current(id, token)) settingsMessage(error.message, true);
    } finally {
      if (current(id, token)) {
        busy = false;
        availability();
      }
    }
  });
  find("#profile-choice").addEventListener("change", () => {
    const profile = profiles.find(
      (item) => item.id === find("#profile-choice").value,
    );
    if (profile) {
      draft = { ...profile.settings };
      dirty = true;
      draftRevision++;
      drawControls();
      settingsMessage(
        "Profile preview staged. Assign & apply to activate it on this camera.",
      );
    } else
      settingsMessage(
        "Assign Custom settings to detach the current profile while keeping its values.",
      );
  });
  find("#assign-profile").addEventListener("click", async () => {
    if (busy || !active) return;
    const id = active;
    const token = generation;
    busy = true;
    availability();
    try {
      const updated = await app.request("/api/cameras/" + id + "/profile", {
        profile_id: find("#profile-choice").value || null,
      });
      if (!current(id, token)) {
        await app.refresh();
        return;
      }
      snapshot = updated;
      simulationSuspended = true;
      chooseDraft();
      settingsMessage(
        snapshot.available
          ? "Profile assignment saved. Applying supported controls…"
          : "Profile assignment saved for the next camera start.",
      );
      await app.refresh();
    } catch (error) {
      if (current(id, token)) settingsMessage(error.message, true);
    } finally {
      if (current(id, token)) {
        busy = false;
        availability();
      }
    }
  });
  find("#save-profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !active) return;
    const id = active;
    const token = generation;
    const name = find("#profile-name").value.trim();
    const settings = selectedSettings();
    if (!name || !Object.keys(settings).length) {
      settingsMessage(
        "Name your profile and select at least one control.",
        true,
      );
      return;
    }
    busy = true;
    availability();
    try {
      const profile = await app.request("/api/profiles", { name, settings });
      // Saving a profile does not assign or apply it.
      profiles = await get("/api/profiles");
      if (!current(id, token)) {
        app.notify("Profile saved. Use Profiles to assign it.");
        return;
      }
      profileOptions(profile.id);
      draft = { ...settings };
      draftRevision++;
      dirty = true;
      drawControls();
      settingsMessage(
        "Profile saved. Apply settings or Assign & apply to activate.",
      );
      find("#profile-name").value = "";
    } catch (error) {
      if (current(id, token)) settingsMessage(error.message, true);
    } finally {
      if (current(id, token)) {
        busy = false;
        availability();
      }
    }
  });

  function drawLibrary(selected = "") {
    find("#profiles-empty").hidden = profiles.length > 0;
    find("#profiles-content").hidden = profiles.length === 0;
    const select = find("#library-profile");
    select.replaceChildren();
    for (const profile of profiles)
      select.append(new Option(profile.name, profile.id));
    if (profiles.some((profile) => profile.id === selected))
      select.value = selected;
    drawTargets();
  }
  function drawTargets() {
    const profile = profiles.find(
      (item) => item.id === find("#library-profile").value,
    );
    const targets = find("#profile-targets");
    targets.replaceChildren();
    const legend = document.createElement("legend");
    legend.textContent = "Assign to cameras";
    targets.append(legend);
    if (!profile) return;
    find("#library-details").textContent = Object.entries(profile.settings)
      .map(([name, value]) => labels[name] + " " + percent(value))
      .join(" · ");
    for (const camera of app.cameras()) {
      const label = document.createElement("label");
      label.className = "profile-target";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = camera.id;
      checkbox.checked = camera.profile_id === profile.id;
      const text = document.createElement("span");
      text.textContent = camera.name;
      const hint = document.createElement("small");
      hint.textContent =
        camera.state === "running"
          ? "Live · applies now"
          : "Paused / offline · applies on start";
      text.append(hint);
      label.append(checkbox, text);
      targets.append(label);
    }
    const inUse = profile.assigned_to.length > 0;
    find("#delete-profile").disabled = inUse;
    find("#delete-profile").title = inUse
      ? "Unassign this profile in camera Settings before deleting it"
      : "Delete unused profile";
    find("#apply-profile-many").disabled = !app.cameras().length;
  }
  find("#library-profile").addEventListener("change", drawTargets);
  find("#open-profiles").addEventListener("click", async () => {
    library.showModal();
    find("#profiles-content").hidden = true;
    libraryMessage("Loading saved profiles…");
    try {
      profiles = await get("/api/profiles");
      drawLibrary();
      libraryMessage("");
    } catch (error) {
      libraryMessage(error.message, true);
    }
  });
  for (const button of document.querySelectorAll(".close-profiles"))
    button.addEventListener("click", () => library.close());
  find("#apply-profile-many").addEventListener("click", async () => {
    const profileId = find("#library-profile").value;
    const cameras = [
      ...document.querySelectorAll("#profile-targets input:checked"),
    ].map((input) => input.value);
    if (!cameras.length) {
      libraryMessage("Select at least one camera.", true);
      return;
    }
    const button = find("#apply-profile-many");
    button.disabled = true;
    const outcomes = await Promise.allSettled(
      cameras.map((id) =>
        app.request("/api/cameras/" + id + "/profile", {
          profile_id: profileId,
        }),
      ),
    );
    const failed = outcomes.filter((outcome) => outcome.status === "rejected");
    libraryMessage(
      "Profile assigned to " +
        (cameras.length - failed.length) +
        " of " +
        cameras.length +
        " camera(s). Supported controls apply now or on the next start." +
        (failed.length ? " " + failed[0].reason.message : ""),
      !!failed.length,
    );
    await app.refresh();
    try {
      profiles = await get("/api/profiles");
      drawLibrary(profileId);
    } catch (error) {
      libraryMessage(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  find("#delete-profile").addEventListener("click", async () => {
    const profile = profiles.find(
      (item) => item.id === find("#library-profile").value,
    );
    if (!profile || !confirm("Delete unused profile “" + profile.name + "”?"))
      return;
    try {
      await app.request("/api/profiles/" + profile.id + "/remove");
      profiles = await get("/api/profiles");
      drawLibrary();
      libraryMessage("Profile deleted.");
    } catch (error) {
      libraryMessage(error.message, true);
    }
  });
})();
