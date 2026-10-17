"use strict";
(() => {
  const app = window.spyder;
  const find = (s, root = document) => root.querySelector(s);
  const pages = {
    "control-room": ["Control Room", "grid", "Observe / control"],
    "vision-lab": ["Vision Lab", "vision", "Empower your security"],
    "camera-setup": ["Camera Setup", "settings", "Tune your devices"],
    recordings: [
      "Recordings",
      "record",
      "Capture every activity simultaneously",
    ],
    events: ["Events", "events", "Record and log everything you need"],
    layouts: ["Layouts", "grid", "Arrange your perspective"],
    system: [
      "System",
      "system",
      "Everything stays local, nothing is ever uploaded",
    ],
  };
  const nav = find("#workspace-nav");
  const chooser = find("#workspace-select");
  const page = find("#workspace-page");
  const message = document.createElement("p");
  message.className = "message workspace-message";
  message.setAttribute("role", "status");
  message.hidden = true;
  find("main").prepend(message);
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
  function updateActivityPreference(event) {
    const preference = event?.detail || window.spyderActivity?.getState();
    const checkbox = find("#system-pause-unfocused");
    const status = find("#system-pause-status");
    if (!preference || !checkbox || !status) return;
    checkbox.checked = preference.continuous
      ? false
      : preference.pause_when_unfocused;
    checkbox.disabled =
      preference.continuous ||
      preference.loading ||
      preference.saving ||
      !preference.saved;
    status.textContent = preference.continuous
      ? "Continuous server mode · cameras stay active"
      : preference.loading
        ? "Loading preference…"
        : !preference.saved
          ? "Preference unavailable · retrying"
          : preference.saving
            ? "Saving preference…"
            : preference.saveError
              ? "Could not save preference · previous setting restored"
              : window.spyderShowcase
                ? "Saved in this browser · showcase mode"
                : preference.storage_error
                  ? "Preference storage unavailable · changes may not persist"
                  : "Saved on this computer";
  }
  window.addEventListener(
    "spyder:activity-preference",
    updateActivityPreference,
  );
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
        tell("Frame capture saved. Open Recordings to view it.");
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
    window.spyderLayouts?.unmount();
    window.spyderEventLibrary?.unmount();
    window.spyderVisionLab?.unmount();
    window.spyderWorkflows?.unmount();
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
    const workspaceTitle = find("#workspace-title");
    workspaceTitle.textContent = title;
    const titleDot = document.createElement("span");
    titleDot.textContent = ".";
    titleDot.setAttribute("aria-hidden", "true");
    workspaceTitle.append(titleDot);
    find(".intro", page).textContent = subtitle;
    find(".workspace-badge", page).textContent = window.spyderShowcase
      ? "ON-DEVICE SHOWCASE"
      : "LOCAL WORKSPACE";
    const content = find("#workspace-content");
    cameraSignature = librarySignature = "";
    if (current === "recordings") {
      content.innerHTML =
        '<section class="workspace-panel"><div class="recording-heading"><h2>Tiled recording</h2><span id="recording-state" role="status"></span></div><p class="workspace-description" id="recording-description"></p><fieldset class="recording-storage" id="recording-storage"><legend>Storage &amp; quality</legend><div class="recording-storage-fields"><label>Recording profile<select id="recording-profile" aria-describedby="recording-estimate"></select></label><label>Clip length<select id="recording-segment"><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option></select></label><button class="button secondary" id="recording-storage-save">Save storage settings</button></div><p id="recording-estimate" class="field-help" role="status"></p><p class="field-help">Estimates cover the entire tiled video, not each camera. Actual sizes vary with motion, noise and encoder. Archive sacrifices detail and smoothness; test faces and plates before relying on it. Clips limit individual file size; they do not reduce total storage.</p></fieldset><div id="recording-preview" class="recording-preview" aria-label="Selected recording layout"></div><fieldset id="recording-cameras"><legend>Include cameras · changes apply to the current video</legend></fieldset><div class="recording-actions"><button id="record-start" class="button primary">Start recording</button><button id="record-stop" class="button secondary">Stop &amp; save</button><button id="capture-tiled" class="button secondary">Capture selected feeds</button></div><p class="field-help">Tiles resize as cameras join or leave. One tiled video; original proportions preserved. No audio. Storage settings apply to new recordings.</p></section><section class="workspace-panel"><h2>Saved recordings &amp; captures</h2><p class="field-help" id="library-note"></p><div id="media-library" class="media-library"></div></section>';
      find("#recording-description").textContent = window.spyderShowcase
        ? "Record locally in this browser. Keep this tab visible. Recordings stop when hidden or at the 128 MiB memory limit. Download before closing this tab."
        : "Recorded on this computer, even while the browser is away. Clips save automatically as you record. Stop recording to save the final clip. Saved files remain available after restarting.";
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
      function estimateStorage() {
        const profile = media.profiles?.[find("#recording-profile").value];
        if (!profile) return;
        const minutes = Number(find("#recording-segment").value);
        const rate = (profile.bitrate_kbps * 1000) / 8;
        find("#recording-estimate").textContent =
          `${profile.width} × ${profile.height} · ${profile.fps} fps · ${profile.bitrate_kbps} kbit/s target · ≈ ${((rate * 86400) / 1e9).toFixed(2)} GB/day` +
          (window.spyderShowcase
            ? " · browser chooses codec; 128 MiB tab limit, no automatic clips. Use the installed app for all-day recording."
            : ` · ≈ ${((rate * minutes * 60) / 1e6).toFixed(1)} MB/clip · H.264 MP4 · saved locally.`);
      }
      find("#recording-profile").addEventListener("change", estimateStorage);
      find("#recording-segment").addEventListener("change", estimateStorage);
      find("#recording-storage-save").addEventListener("click", async () => {
        if (busy || active()) return;
        busy = true;
        update();
        try {
          media = await request("/api/recordings/settings", {
            profile: find("#recording-profile").value,
            segment_minutes: Number(find("#recording-segment").value),
          });
          tell("Recording storage settings saved. Applies to new recordings.");
        } catch (error) {
          tell(error.message);
        } finally {
          busy = false;
          update();
        }
      });
      find("#record-start").addEventListener("click", () =>
        act("/api/recordings/start", [...selected]),
      );
      find("#record-stop").addEventListener("click", () =>
        act("/api/recordings/stop"),
      );
      find("#capture-tiled").addEventListener("click", () =>
        act("/api/captures", [...selected]),
      );
    } else if (current === "vision-lab") {
      content.innerHTML =
        '<div class="recording-actions"><button id="vision-motion-tab" class="button primary">Motion & ROI</button><button id="vision-workflow-tab" class="button secondary">Models & Workflows</button></div><div id="vision-mode-content"></div>';
      const mode = find("#vision-mode-content");
      function switchMode(workflow) {
        window.spyderVisionLab?.unmount();
        window.spyderWorkflows?.unmount();
        find("#vision-motion-tab").setAttribute(
          "aria-pressed",
          String(!workflow),
        );
        find("#vision-workflow-tab").setAttribute(
          "aria-pressed",
          String(workflow),
        );
        find("#vision-motion-tab").className =
          "button " + (workflow ? "secondary" : "primary");
        find("#vision-workflow-tab").className =
          "button " + (workflow ? "primary" : "secondary");
        if (workflow) window.spyderWorkflows?.mount(mode);
        else window.spyderVisionLab?.mount(mode);
      }
      find("#vision-motion-tab").addEventListener("click", () =>
        switchMode(false),
      );
      find("#vision-workflow-tab").addEventListener("click", () =>
        switchMode(true),
      );
      switchMode(false);
    } else if (current === "camera-setup") {
      content.innerHTML =
        '<section class="workspace-panel"><h2></h2><p class="workspace-description"></p><div id="device-list" class="device-list"></div></section>';
      find("h2", content).textContent =
        current === "vision-lab" ? "Vision pipelines" : "Connected cameras";
      find(".workspace-description", content).textContent =
        current === "vision-lab"
          ? "Inspect each camera’s existing pipeline. OpenCV, YOLO and InsightFace run in the installed app. Model selection and detection tuning will be added here."
          : "Open a camera’s settings to tune supported controls and assign profiles. Add and remove devices from the Control Room.";
    } else if (current === "events") {
      window.spyderEventLibrary?.mount(content);
    } else if (current === "layouts") {
      window.spyderLayouts?.mount(content);
    } else {
      content.innerHTML =
        '<section class="workspace-panel"><h2>Local system</h2><div id="system-details" class="system-details"></div><div id="system-metrics" class="system-metrics"></div><fieldset class="activity-policy"><legend>Camera focus preference</legend><label class="release-toggle"><input id="system-pause-unfocused" type="checkbox" checked /><span>Pause cameras when unfocused</span></label><p id="system-pause-status" class="field-help" role="status" aria-live="polite"></p><p class="field-help">When off, cameras keep running while the local server runs, even if you close this browser. Browser desktop notifications require this page to stay open.</p></fieldset><form id="system-storage" class="system-storage"><label for="system-output">Recordings and captures folder</label><input id="system-output" type="text" required maxlength="4096" placeholder="Absolute local folder path" /><div class="recording-actions"><button class="button primary" type="submit">Save output folder</button><button id="system-output-reset" class="button secondary" type="button">Use default folder</button></div><p class="field-help">A dedicated folder on a local drive is recommended. Keep enough free space for video. Changes apply after restarting SpyDER; files stay in their original folders, and previous folders remain available for playback. Models and configuration stay in their current locations.</p><p id="system-storage-status" class="field-help" role="status"></p></form></section>';
      updateActivityPreference();
      const details = find("#system-details");
      const output = find("#system-output");
      const storageStatus = find("#system-storage-status");
      const storageForm = find("#system-storage");
      let defaultDirectory = "";
      function populateSystem(data) {
        if (!details.isConnected) return;
        details.textContent =
          "Media folder: " +
          data.media_directory +
          " · Free space: " +
          (data.free_bytes / 1024 ** 3).toFixed(1) +
          " GiB";
        output.value = data.configured_media_directory || data.media_directory;
        defaultDirectory = data.default_media_directory || data.media_directory;
        storageStatus.textContent =
          data.storage_settings_error ||
          (data.command_line_override
            ? "The --media-dir command-line option overrides this preference. Remove it to use this folder."
            : data.restart_required
              ? "Saved. Restart SpyDER to use the new output folder."
              : "Current output folder is active.");
        const metrics = find("#system-metrics");
        metrics.replaceChildren();
        const fields = [
          ["Application", "SpyDER " + (data.version || "")],
          [
            "Runtime",
            "Python " +
              (data.python_version || "") +
              " · " +
              (data.platform || ""),
          ],
          [
            "Cameras",
            (data.running_cameras || 0) +
              " running / " +
              (data.camera_count || 0) +
              " configured",
          ],
          ["Recording", data.recording_state || "idle"],
          [
            "Event history",
            (data.event_count || 0) +
              " records · latest " +
              (data.event_retention_limit || 10000).toLocaleString() +
              " retained",
          ],
          [
            "Server uptime",
            Math.floor((data.uptime_seconds || 0) / 60) + " minutes",
          ],
        ];
        for (const [engine, info] of Object.entries(data.engines || {}))
          fields.push([
            engine + " dependencies",
            Object.entries(info.packages || {})
              .map(
                ([name, version]) => name + ": " + (version || "not installed"),
              )
              .join(" · "),
          ]);
        for (const [label, value] of fields) {
          const card = document.createElement("div");
          card.className = "system-metric";
          const title = document.createElement("strong");
          title.textContent = label;
          const text = document.createElement("span");
          text.textContent = value;
          card.append(title, text);
          metrics.append(card);
        }
      }
      if (window.spyderShowcase) {
        details.textContent =
          "Browser showcase · processing and recordings stay on your computer. Native CV requires the installed Python app.";
        storageForm.hidden = true;
      } else {
        details.textContent = "Loading local system details…";
        fetch("/api/system", { signal: AbortSignal.timeout(4000) })
          .then((response) => {
            if (!response.ok) throw new Error("System details unavailable");
            return response.json();
          })
          .then(populateSystem)
          .catch((error) => {
            if (details.isConnected) details.textContent = error.message;
          });
        find("#system-output-reset").addEventListener("click", () => {
          output.value = defaultDirectory;
          output.focus();
        });
        storageForm.addEventListener("submit", async (event) => {
          event.preventDefault();
          const buttons = [...storageForm.querySelectorAll("button")];
          buttons.forEach((button) => {
            button.disabled = true;
          });
          storageStatus.textContent = "Checking folder and saving…";
          try {
            const data = await app.request("/api/system/storage", {
              media_directory: output.value,
            });
            if (storageStatus.isConnected)
              storageStatus.textContent = data.command_line_override
                ? "Saved. Remove --media-dir and restart SpyDER to apply this preference."
                : data.restart_required
                  ? "Saved. Restart SpyDER to use this output folder. Existing files are kept."
                  : "Output folder is active.";
          } catch (error) {
            if (storageStatus.isConnected)
              storageStatus.textContent = error.message;
          } finally {
            buttons.forEach((button) => {
              button.disabled = false;
            });
          }
        });
      }
    }
    update();
    find("#workspace-title").focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  function addCardActions() {
    for (const card of document.querySelectorAll(".camera-card")) {
      if (card.dataset.dummy === "true") continue;
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
    addCardActions();
    if (current === "camera-setup") {
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
    const profileSelect = find("#recording-profile");
    if (!profileSelect.options.length && media.profiles) {
      for (const [value, profile] of Object.entries(media.profiles))
        profileSelect.append(new Option(profile.label, value));
      profileSelect.value = media.storage.profile;
      find("#recording-segment").value = String(media.storage.segment_minutes);
      profileSelect.dispatchEvent(new Event("change"));
    }
    for (const input of find("#recording-storage").querySelectorAll(
      "select, button",
    ))
      input.disabled =
        busy ||
        active() ||
        (window.spyderShowcase && input.id === "recording-segment");
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
          item.kind === "capture"
            ? "Frame capture"
            : "Tiled recording" +
              (item.segment_index ? ` · clip ${item.segment_index}` : "");
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
          window.spyderEventLibrary.mediaButton(item),
          detail,
          download,
        );
        library.append(row);
      }
    }
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("spyder:vision-lab-ready", () => {
    if (
      current === "vision-lab" &&
      find("#vision-motion-tab")?.getAttribute("aria-pressed") === "true"
    )
      window.spyderVisionLab.mount(find("#vision-mode-content"));
  });
  window.addEventListener("spyder:workflows-ready", () => {
    if (
      current === "vision-lab" &&
      find("#vision-workflow-tab")?.getAttribute("aria-pressed") === "true"
    )
      window.spyderWorkflows.mount(find("#vision-mode-content"));
  });
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
