"use strict";
(() => {
  const app = window.spyder;
  const find = (s, root = document) => root.querySelector(s);
  const pages = {
    "control-room": ["Control Room", "grid", "Observe / control"],
    "vision-lab": ["Vision Lab", "vision", "Understand every frame"],
    "camera-setup": ["Camera Setup", "settings", "Tune your devices"],
    recordings: ["Recordings", "record", "One canvas. Every angle."],
    events: ["Events", "events", "Activity worth revisiting"],
    layouts: ["Layouts", "grid", "Arrange your perspective"],
    system: ["System", "system", "Everything stays local"],
  };
  const nav = find("#workspace-nav");
  const chooser = find("#workspace-select");
  const page = find("#workspace-page");
  const message = document.createElement("p");
  message.className = "message workspace-message";
  message.setAttribute("role", "status");
  message.hidden = true;
  find("main").prepend(message);
  const indicator = document.createElement("button");
  indicator.className = "button secondary recording-indicator";
  indicator.textContent = "Record / capture";
  indicator.addEventListener("click", () => {
    location.hash = "recordings";
  });
  find(".top-actions").prepend(indicator);
  let current = "control-room";
  let media = { state: "idle", camera_ids: [], elapsed_seconds: 0, items: [] };
  let selected = new Set();
  let busy = false;
  let cameraSignature = "";
  let librarySignature = "";

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(svg.namespaceURI, "use");
    use.setAttribute("href", "/icons.svg#" + name);
    svg.append(use);
    return svg;
  }
  for (const [key, [label, glyph]] of Object.entries(pages)) {
    chooser.append(new Option(label, key));
    if (key === "control-room") continue;
    const link = document.createElement("a");
    link.href = "#" + key;
    link.dataset.workspace = key;
    link.className = "workspace-link";
    link.append(icon(glyph), document.createTextNode(label));
    nav.append(link);
  }
  chooser.addEventListener("change", () => {
    location.hash = chooser.value;
  });
  function tell(text) {
    message.textContent = text;
    message.hidden = !text;
    window.dispatchEvent(new CustomEvent("spyder:notice", { detail: text }));
  }
  function settings(id) {
    document.dispatchEvent(
      new CustomEvent("spyder:camera-settings", { detail: { id } }),
    );
  }
  function button(label, action, primary = false) {
    const b = document.createElement("button");
    b.className = "button " + (primary ? "primary" : "secondary");
    b.textContent = label;
    b.addEventListener("click", action);
    return b;
  }
  async function request(path, data = {}) {
    if (window.spyderBrowserMedia)
      return window.spyderBrowserMedia.request(path, data);
    return app.request(path, data);
  }
  async function readStatus() {
    if (window.spyderBrowserMedia) return window.spyderBrowserMedia.status();
    const response = await fetch("/api/recordings", {
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Recording status unavailable");
    return response.json();
  }
  async function act(path, ids) {
    if (busy) return;
    busy = true;
    update();
    try {
      const result = await request(path, ids ? { camera_ids: ids } : {});
      if (path === "/api/captures")
        tell("Frame capture saved. Open Recordings to download it.");
      else {
        media = result;
        selected = new Set(media.camera_ids || []);
        tell("");
      }
      media = await readStatus();
    } catch (error) {
      tell(error.message);
      if (media.state === "recording") selected = new Set(media.camera_ids);
    } finally {
      busy = false;
      await app.refresh();
      update();
    }
  }
  const active = () => ["recording", "stopping"].includes(media.state);
  async function toggleCamera(id) {
    if (busy || media.state === "stopping") return;
    const ids = new Set(media.state === "recording" ? media.camera_ids : []);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    await act(
      media.state === "recording"
        ? "/api/recordings/cameras"
        : "/api/recordings/start",
      [...ids],
    );
  }
  function route() {
    const key = location.hash.slice(1);
    current = pages[key] ? key : "control-room";
    if (current !== "control-room") window.spyderWall?.exit();
    document.title = "SpyDER · " + pages[current][0];
    app.leaveFocus();
    chooser.value = current;
    for (const a of nav.querySelectorAll("a")) {
      const chosen = a.dataset.workspace === current;
      a.classList.toggle("rail-current", chosen);
      a.classList.toggle("workspace-link", !chosen);
      if (chosen) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    find("#control-room").hidden = current !== "control-room";
    page.hidden = current === "control-room";
    if (page.hidden) return;
    const [title, , subtitle] = pages[current];
    page.innerHTML =
      '<header class="page-heading"><div><p class="eyebrow">WORKSPACE</p><h1 id="workspace-title" tabindex="-1"></h1><p class="intro"></p></div><span class="workspace-badge"></span></header><div id="workspace-content"></div>';
    find("#workspace-title").textContent = title;
    find(".intro", page).textContent = subtitle;
    find(".workspace-badge", page).textContent =
      current === "recordings" ||
      current === "camera-setup" ||
      current === "system"
        ? "LOCAL WORKSPACE"
        : "FOUNDATION";
    const content = find("#workspace-content");
    cameraSignature = librarySignature = "";
    if (current === "recordings") {
      content.innerHTML =
        '<section class="workspace-panel"><div class="recording-heading"><h2>Tiled recording</h2><span id="recording-state" role="status"></span></div><p class="workspace-description" id="recording-description"></p><div id="recording-preview" class="recording-preview" aria-label="Selected recording layout"></div><fieldset id="recording-cameras"><legend>Include cameras · changes apply to the current video</legend></fieldset><div class="recording-actions"><button id="record-start" class="button primary">Start recording</button><button id="record-stop" class="button secondary">Stop &amp; save</button><button id="capture-tiled" class="button secondary">Capture selected feeds</button></div><p class="field-help">Tiles resize as cameras join or leave. One 1920 × 1080 video at 15 fps; original proportions preserved. No audio.</p></section><section class="workspace-panel"><h2>Saved recordings &amp; captures</h2><p class="field-help" id="library-note"></p><div id="media-library" class="media-library"></div></section>';
      find("#recording-description").textContent = window.spyderShowcase
        ? "Record locally in this browser. Keep this tab visible. Recordings stop when hidden or at the 128 MiB memory limit. Download before closing this tab."
        : "Recorded on this computer, even while the browser is away. Stop recording to finalize the video. Saved files remain available after restarting.";
      find("#library-note").textContent = window.spyderShowcase
        ? "Files stay in this tab until downloaded. Nothing is uploaded."
        : "Files are stored in your local media folder. Download a copy here; find the folder in System.";
      if (!active() && !selected.size)
        selected = new Set(
          app
            .cameras()
            .filter((c) => c.state === "running")
            .map((c) => c.id),
        );
      find("#record-start").addEventListener("click", () =>
        act("/api/recordings/start", [...selected]),
      );
      find("#record-stop").addEventListener("click", () =>
        act("/api/recordings/stop"),
      );
      find("#capture-tiled").addEventListener("click", () =>
        act("/api/captures", [...selected]),
      );
    } else if (["vision-lab", "camera-setup"].includes(current)) {
      content.innerHTML =
        '<section class="workspace-panel"><h2></h2><p class="workspace-description"></p><div id="device-list" class="device-list"></div></section>';
      find("h2", content).textContent =
        current === "vision-lab" ? "Vision pipelines" : "Connected cameras";
      find(".workspace-description", content).textContent =
        current === "vision-lab"
          ? "Inspect each camera’s existing pipeline. OpenCV, YOLO and InsightFace run in the installed app. Model selection and detection tuning will be added here."
          : "Open a camera’s settings to tune supported controls and assign profiles. Add and remove devices from the Control Room.";
    } else if (current === "events") {
      content.innerHTML =
        '<section class="workspace-panel foundation-panel"><h2>An activity timeline starts here.</h2><p>Motion and detection events will appear here with camera, time and frame captures.</p><p class="field-help">Event indexing and alerts are planned. This workspace does not yet store an event history. Frame captures are available in Recordings.</p></section>';
      content.append(
        button("Open captures", () => {
          location.hash = "recordings";
        }),
      );
    } else if (current === "layouts") {
      content.innerHTML =
        '<section class="workspace-panel"><h2>Your wall, your scale.</h2><p class="workspace-description">Choose a tile size for the Control Room. Named arrangements and rotating views will be added here.</p><div class="layout-options"></div></section>';
      for (const [value, label] of [
        ["auto", "Auto"],
        ["compact", "Compact"],
        ["large", "Large"],
      ]) {
        find(".layout-options", content).append(
          button(label, () => {
            find("#density").value = value;
            find("#density").dispatchEvent(new Event("change"));
            location.hash = "control-room";
          }),
        );
      }
    } else {
      content.innerHTML =
        '<section class="workspace-panel"><h2>Local system</h2><div id="system-details" class="system-details"></div><p class="field-help">CPU/GPU graphs and dependency diagnostics will be added here.</p></section>';
      const details = find("#system-details");
      if (window.spyderShowcase)
        details.textContent =
          "Browser showcase · processing and recordings stay on your computer. Native CV requires the installed Python app.";
      else {
        details.textContent = "Loading local storage details…";
        fetch("/api/system", { signal: AbortSignal.timeout(4000) })
          .then((r) => {
            if (!r.ok) throw new Error("Storage details unavailable");
            return r.json();
          })
          .then((data) => {
            details.textContent =
              "Media folder: " +
              data.media_directory +
              " · Free space: " +
              (data.free_bytes / 1024 ** 3).toFixed(1) +
              " GiB";
          })
          .catch((e) => {
            details.textContent = e.message;
          });
      }
    }
    update();
    find("#workspace-title").focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  function addCardActions() {
    for (const card of document.querySelectorAll(".camera-card")) {
      const id = card.dataset.id;
      if (!find(".record-camera", card)) {
        const record = button("Record", () => toggleCamera(id));
        record.className = "record-camera";
        record.prepend(icon("record"));
        const capture = button("Capture", () => act("/api/captures", [id]));
        capture.className = "capture-camera";
        capture.prepend(icon("capture"));
        find(".tile-actions", card).prepend(record, capture);
      }
      const isRecording = media.camera_ids?.includes(id) && active();
      const c = app.cameras().find((c) => c.id === id);
      const record = find(".record-camera", card);
      record.lastChild.textContent = isRecording ? "End view" : "Record";
      record.setAttribute(
        "aria-label",
        (isRecording ? "Remove from recording: " : "Record ") + (c?.name || id),
      );
      record.setAttribute("aria-pressed", String(isRecording));
      record.disabled =
        busy ||
        media.state === "stopping" ||
        (!isRecording && !["running", "starting"].includes(c?.state));
      find(".capture-camera", card).disabled = busy || c?.state !== "running";
      find(".capture-camera", card).setAttribute(
        "aria-label",
        "Capture frame from " + (c?.name || id),
      );
      card.dataset.recording = String(isRecording);
      if (isRecording) {
        find(".toggle-camera", card).disabled = true;
        find(".toggle-camera", card).title =
          "End this view’s recording before pausing";
      } else find(".toggle-camera", card).title = "";
    }
  }
  function update() {
    window.dispatchEvent(new CustomEvent("spyder:media", { detail: media }));
    indicator.textContent = active()
      ? "● REC · " + Math.floor(media.elapsed_seconds || 0) + "s"
      : "Record / capture";
    indicator.dataset.recording = String(active());
    addCardActions();
    if (["camera-setup", "vision-lab"].includes(current)) {
      const list = find("#device-list");
      const signature = JSON.stringify(
        app
          .cameras()
          .map((c) => [
            c.id,
            c.name,
            c.state,
            c.pipeline,
            c.profile_name,
            c.metadata?.cv?.state,
          ]),
      );
      if (!list || signature === cameraSignature) return;
      cameraSignature = signature;
      list.replaceChildren();
      if (!app.cameras().length)
        list.textContent = "No cameras yet. Add a camera in the Control Room.";
      for (const c of app.cameras()) {
        const item = document.createElement("article");
        item.className = "device-item";
        const description = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = c.name;
        const note = document.createElement("p");
        note.textContent =
          current === "vision-lab"
            ? c.pipeline +
              (c.metadata?.cv
                ? " · " + c.metadata.cv.engine + " · " + c.metadata.cv.state
                : " · " + c.state)
            : c.source_label +
              " · " +
              c.state +
              " · " +
              (c.profile_name || "Custom settings");
        description.append(name, note);
        item.append(description);
        if (current === "camera-setup")
          item.append(button("Settings & profiles", () => settings(c.id)));
        list.append(item);
      }
    }
    if (current !== "recordings" || !find("#recording-state")) return;
    const stateText = active()
      ? media.state === "stopping"
        ? "Finalizing…"
        : "REC · " +
          Math.floor(media.elapsed_seconds || 0) +
          "s · " +
          media.camera_ids.length +
          " views"
      : "Ready to record";
    find("#recording-state").textContent = media.error || stateText;
    find("#recording-state").dataset.recording = String(active());
    if (active()) selected = new Set(media.camera_ids);
    const ids = new Set(app.cameras().map((c) => c.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
    const fieldset = find("#recording-cameras");
    const signature = JSON.stringify(app.cameras().map((c) => [c.id, c.name]));
    if (signature !== cameraSignature) {
      cameraSignature = signature;
      fieldset.querySelectorAll("label").forEach((e) => e.remove());
      for (const c of app.cameras()) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = c.id;
        label.append(input, document.createTextNode(c.name));
        fieldset.append(label);
        input.addEventListener("change", () => {
          if (input.checked) selected.add(c.id);
          else selected.delete(c.id);
          if (media.state === "recording")
            act("/api/recordings/cameras", [...selected]);
          else update();
        });
      }
    }
    for (const input of fieldset.querySelectorAll("input")) {
      input.checked = selected.has(input.value);
      input.disabled = busy || media.state === "stopping";
    }
    const preview = find("#recording-preview");
    const previewIds = [...selected];
    if (preview.dataset.ids !== JSON.stringify(previewIds)) {
      preview.dataset.ids = JSON.stringify(previewIds);
      preview.replaceChildren();
      preview.style.setProperty(
        "--preview-columns",
        Math.ceil(Math.sqrt(previewIds.length || 1)),
      );
      for (const id of previewIds) {
        const tile = document.createElement("div");
        tile.dataset.id = id;
        const image = document.createElement("img");
        image.alt = "";
        image.hidden = true;
        const caption = document.createElement("span");
        caption.textContent =
          app.cameras().find((c) => c.id === id)?.name || id;
        tile.append(image, caption);
        preview.append(tile);
      }
      if (!previewIds.length)
        preview.textContent = "Select cameras to compose your video";
    }
    for (const tile of preview.querySelectorAll("[data-id]")) {
      const image = find("img", tile);
      const url = app.frame(tile.dataset.id);
      image.hidden = !url;
      if (url && image.getAttribute("src") !== url) image.src = url;
    }
    find("#record-start").disabled = busy || active() || !selected.size;
    find("#record-stop").disabled = busy || media.state !== "recording";
    find("#capture-tiled").disabled = busy || !selected.size;
    const library = find("#media-library");
    const signatureItems = JSON.stringify(media.items || []);
    if (signatureItems !== librarySignature) {
      librarySignature = signatureItems;
      library.replaceChildren();
      if (!media.items?.length)
        library.textContent = "Your recordings and captures will appear here.";
      for (const item of [...(media.items || [])].reverse()) {
        const row = document.createElement("article");
        row.className = "media-item";
        const detail = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent =
          item.kind === "capture" ? "Frame capture" : "Tiled recording";
        const note = document.createElement("p");
        note.textContent =
          new Date(item.created_at).toLocaleString() +
          " · " +
          (item.size_bytes / 1024 ** 2).toFixed(2) +
          " MiB" +
          (item.duration_seconds != null
            ? " · " + item.duration_seconds.toFixed(1) + "s"
            : "");
        detail.append(name, note);
        const download = document.createElement("a");
        download.className = "button secondary";
        download.textContent = "Download";
        download.href = item.url;
        download.download = item.filename;
        row.append(
          icon(item.kind === "capture" ? "capture" : "record"),
          detail,
          download,
        );
        library.append(row);
      }
    }
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("spyder:cameras", update);
  async function poll() {
    try {
      media = await readStatus();
      update();
    } catch {
      /* Camera connection status remains visible in the rail. */
    }
    setTimeout(poll, document.hidden ? 3000 : 1000);
  }
  app.media = {
    status: () => media,
    recordLive: () =>
      act(
        "/api/recordings/start",
        app
          .cameras()
          .filter((c) => c.state === "running")
          .map((c) => c.id),
      ),
    stop: () => act("/api/recordings/stop"),
    captureLive: () =>
      act(
        "/api/captures",
        app
          .cameras()
          .filter((c) => c.state === "running")
          .map((c) => c.id),
      ),
    busy: () => busy,
  };
  route();
  poll();
})();
