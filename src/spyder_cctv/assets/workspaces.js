"use strict";
(() => {
  const app = window.spyder;
  const find = (s, root = document) => root.querySelector(s);
  const sectionAnimations = new WeakMap();
  function revealSection(element, direction = 0) {
    if (!element?.animate) return;
    sectionAnimations.get(element)?.cancel();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    sectionAnimations.set(element, element.animate(
      [{ opacity: .4, transform: direction ? `translateX(${direction * 24}px)` : "translateY(4px)" }, { opacity: 1, transform: "none" }],
      { duration: 220, easing: "cubic-bezier(.2,.75,.25,1)" },
    ));
  }
  const navigatorObservers = [];
  const navigatorPositions = new WeakMap();
  let pendingVisionRender = null;
  function cancelVisionRender() {
    if (!pendingVisionRender) return;
    cancelAnimationFrame(pendingVisionRender.frame);
    clearTimeout(pendingVisionRender.timer);
    pendingVisionRender = null;
  }
  function updateNavigator(nav, measure = false) {
    const selected = nav.querySelector('[aria-selected="true"]');
    if (!selected) return;
    if (measure || !navigatorPositions.has(nav)) {
      const frame = nav.getBoundingClientRect(), style = getComputedStyle(nav);
      const left = frame.left + parseFloat(style.borderLeftWidth), top = frame.top + parseFloat(style.borderTopWidth);
      navigatorPositions.set(nav, new Map([...nav.querySelectorAll(':scope > [role="tab"]')].map((tab) => {
        const box = tab.getBoundingClientRect();
        return [tab.id, { x: box.left - left, y: box.top - top, width: box.width, height: box.height }];
      })));
      const layer = nav.querySelector(":scope > .nav-contrast-layer");
      if (layer) {
        const labels = [...nav.querySelectorAll(':scope > [role="tab"]')].map((tab) => {
          const box = navigatorPositions.get(nav).get(tab.id), style = getComputedStyle(tab);
          return { text: tab.textContent, box, font: style.font, spacing: style.letterSpacing, padding: style.padding, whiteSpace: style.whiteSpace };
        });
        layer.replaceChildren(...labels.map(({text, box, font, spacing, padding, whiteSpace}) => {
          const label = document.createElement("span");
          label.textContent = text;
          label.style.cssText = `left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px`;
          label.style.font = font;
          label.style.letterSpacing = spacing;
          label.style.padding = padding;
          label.style.whiteSpace = whiteSpace;
          return label;
        }));
      }
    }
    const box = navigatorPositions.get(nav).get(selected.id);
    for (const [name, value] of Object.entries(box)) {
      const property = `--nav-${name}`, next = `${value}px`;
      if (nav.style.getPropertyValue(property) !== next) nav.style.setProperty(property, next);
    }
    nav.classList.add("has-nav-indicator");
  }
  function setupNavigator(nav) {
    const layer = document.createElement("span");
    layer.className = "nav-contrast-layer";
    layer.setAttribute("aria-hidden", "true");
    nav.append(layer);
    updateNavigator(nav, true);
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => updateNavigator(nav, true));
      observer.observe(nav);
      navigatorObservers.push(observer);
    }
  }
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
  const workspaceTrigger = find("#workspace-switch-trigger");
  let workspaceDialog = null;
  const page = find("#workspace-page");
  find(".skip-link")?.addEventListener("click", (event) => {
    event.preventDefault();
    const main = find("main");
    main.focus({ preventScroll: true });
    main.scrollIntoView({ block: "start" });
  });
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
  let recordingLibrary = null;
  let recordingTimeline = null;
  let recordingView = "library";
  let timelineEventsController = null;
  let timelineEventsAt = 0;
  let timelineRouteGeneration = 0;
  function closeTimeline() {
    timelineRouteGeneration++;
    timelineEventsController?.abort();
    timelineEventsController = null;
    timelineEventsAt = 0;
    recordingTimeline?.unmount();
    recordingTimeline = null;
  }
  async function loadTimelineEvents() {
    if (
      !recordingTimeline ||
      window.spyderShowcase ||
      document.hidden ||
      timelineEventsController ||
      Date.now() - timelineEventsAt < 15000
    )
      return;
    const generation = timelineRouteGeneration;
    const controller = new AbortController();
    timelineEventsController = controller;
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch("/api/events", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw Error("Events unavailable");
      const data = await response.json();
      if (generation !== timelineRouteGeneration) return;
      recordingTimeline?.setEvents(data.events || []);
      const note = find("#timeline-events-status");
      if (note) {
        note.textContent = data.storage_error
          ? "Event storage is unavailable. Recorded footage remains playable."
          : "";
        note.hidden = !note.textContent;
      }
    } catch {
      if (generation !== timelineRouteGeneration) return;
      const note = find("#timeline-events-status");
      if (note) {
        note.hidden = false;
        note.textContent =
          "Event markers are unavailable. Recorded footage remains playable.";
      }
    } finally {
      clearTimeout(timeout);
      if (timelineEventsController === controller) {
        timelineEventsController = null;
        timelineEventsAt = Date.now();
      }
    }
  }
  function switchRecordingView(view, item) {
    recordingView = view;
    const timeline = find("#recording-timeline"),
      library = find("#media-library");
    if (!timeline || !library) return;
    library.hidden = view === "timeline";
    timeline.hidden = view !== "timeline";
    for (const name of ["library", "timeline"]) {
      const tab = find("#recording-" + name + "-tab");
      tab.setAttribute("aria-pressed", String(view === name));
      tab.className = "button " + (view === name ? "primary" : "secondary");
    }
    if (view === "timeline") {
      if (!recordingTimeline)
        recordingTimeline = window.spyderRecordingTimeline.mount(
          timeline,
          media.items || [],
          {
            cameras: () => app.cameras(),
            createPlayer: (host, callbacks) =>
              window.spyderRecordingPlayer.create(host, callbacks),
          },
        );
      if (item) recordingTimeline.seekTo(Date.parse(item.created_at), item.id);
      void loadTimelineEvents();
    } else closeTimeline();
    revealSection(view === "timeline" ? timeline : library);
  }

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("icon");
    svg.setAttribute("viewBox", "0 0 24 24");
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
  function syncWorkspaceLauncher() {
    if (!workspaceDialog) return;
    find("[data-workspace-name]", workspaceTrigger).textContent = pages[current][0];
    find("[data-workspace-glyph]", workspaceTrigger).replaceChildren(icon(pages[current][1]));
    workspaceTrigger.setAttribute("aria-label", `Switch workspace. Current: ${pages[current][0]}`);
    for (const link of workspaceDialog.querySelectorAll("[data-workspace-destination]")) {
      if (link.dataset.workspaceDestination === current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }
  function setupWorkspaceLauncher() {
    if (!workspaceTrigger || typeof HTMLDialogElement === "undefined" || !HTMLDialogElement.prototype.showModal) return;
    workspaceDialog = document.createElement("dialog");
    let restoreFocus = true;
    workspaceDialog.id = "workspace-switcher";
    workspaceDialog.className = "workspace-switcher";
    workspaceDialog.setAttribute("aria-labelledby", "workspace-switcher-title");
    workspaceDialog.innerHTML = '<header class="workspace-switcher-head"><div><h2 id="workspace-switcher-title">Workspaces</h2><p>Choose where to work.</p></div><button type="button" class="icon-button" aria-label="Close workspace switcher"></button></header><nav class="workspace-switcher-grid" aria-label="Choose workspace"></nav>';
    const close = workspaceDialog.querySelector("button");
    close.append(icon("close"));
    close.addEventListener("click", () => workspaceDialog.close());
    const descriptions = {
      "control-room": "Live cameras & controls", "vision-lab": "Analysis & workflows",
      "camera-setup": "Devices & discovery", recordings: "Videos & captures",
      events: "Activity & detections", layouts: "Camera wall designer", system: "Health, storage & backups",
    };
    for (const [key, [label, glyph]] of Object.entries(pages)) {
      const link = document.createElement("a");
      link.href = "#" + key;
      link.dataset.workspaceDestination = key;
      link.className = "workspace-card";
      const symbol = document.createElement("span"), copy = document.createElement("span"), marker = document.createElement("span");
      symbol.className = "workspace-card-icon";
      symbol.append(icon(glyph));
      copy.className = "workspace-card-copy";
      const name = document.createElement("strong"), detail = document.createElement("small");
      name.textContent = label;
      detail.textContent = descriptions[key];
      copy.append(name, detail);
      marker.className = "workspace-card-marker";
      marker.setAttribute("aria-hidden", "true");
      marker.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg>';
      link.append(symbol, copy, marker);
      link.addEventListener("click", () => {
        restoreFocus = false;
        workspaceDialog.close();
      });
      workspaceDialog.querySelector("nav").append(link);
    }
    workspaceDialog.addEventListener("click", (event) => {
      if (event.target !== workspaceDialog) return;
      const box = workspaceDialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) workspaceDialog.close();
    });
    workspaceDialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = [...workspaceDialog.querySelectorAll("button,a")];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    workspaceDialog.addEventListener("close", () => {
      workspaceTrigger.setAttribute("aria-expanded", "false");
      if (restoreFocus && workspaceTrigger.getClientRects().length) workspaceTrigger.focus({ preventScroll: true });
    });
    document.body.append(workspaceDialog);
    workspaceTrigger.hidden = false;
    chooser.closest("label").hidden = true;
    workspaceTrigger.addEventListener("click", () => {
      restoreFocus = true;
      syncWorkspaceLauncher();
      workspaceDialog.showModal();
      workspaceTrigger.setAttribute("aria-expanded", "true");
      const selected = workspaceDialog.querySelector('[aria-current="page"]');
      selected?.focus({ preventScroll: true });
      selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    window.matchMedia("(max-width: 800px)").addEventListener("change", (event) => {
      if (!event.matches && workspaceDialog.open) {
        restoreFocus = false;
        workspaceDialog.close();
      }
    });
    syncWorkspaceLauncher();
  }
  setupWorkspaceLauncher();
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
    cancelVisionRender();
    navigatorObservers.splice(0).forEach((observer) => observer.disconnect());
    for (const element of document.querySelectorAll("#workspace-content, #control-room, #vision-mode-content, [data-system-panel]"))
      sectionAnimations.get(element)?.cancel();
    window.spyderLayouts?.unmount();
    window.spyderEventLibrary?.unmount();
    recordingLibrary?.unmount();
    recordingLibrary = null;
    closeTimeline();
    window.spyderVisionLab?.unmount();
    window.spyderWorkflows?.unmount();
    const key = location.hash.slice(1);
    current = pages[key] ? key : "control-room";
    if (current !== "control-room") window.spyderWall?.exit();
    document.title = "SpyDER · " + pages[current][0];
    app.leaveFocus();
    chooser.value = current;
    syncWorkspaceLauncher();
    for (const a of nav.querySelectorAll("a")) {
      const chosen = a.dataset.workspace === current;
      a.classList.toggle("rail-current", chosen);
      a.classList.toggle("workspace-link", !chosen);
      if (chosen) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    find("#control-room").hidden = current !== "control-room";
    page.hidden = current === "control-room";
    if (page.hidden) {
      revealSection(find("#control-room"));
      return;
    }
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
    cameraSignature = "";
    if (current === "recordings") {
      content.innerHTML =
        '<section class="workspace-panel"><div class="recording-heading"><h2>Tiled recording</h2><span id="recording-state" role="status"></span></div><p class="workspace-description" id="recording-description"></p><fieldset class="recording-storage" id="recording-storage"><legend>Storage &amp; quality</legend><div class="recording-storage-fields"><label>Recording profile<select id="recording-profile" aria-describedby="recording-estimate"></select></label><label>Clip length<select id="recording-segment"><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option><option value="180">3 hours</option><option value="360">6 hours</option><option value="720">12 hours</option><option value="1440">24 hours</option></select></label><button class="button secondary" id="recording-storage-save">Save storage settings</button></div><p id="recording-estimate" class="field-help" role="status"></p><p class="field-help">Estimates cover the entire tiled video, not each camera. Actual sizes vary with motion, noise and encoder. Archive sacrifices detail and smoothness; test faces and plates before relying on it. Clips limit individual file size; they do not reduce total storage.</p></fieldset><div id="recording-preview" class="recording-preview" aria-label="Selected recording layout"></div><fieldset id="recording-cameras"><legend>Include cameras · changes apply to the current video</legend></fieldset><p id="recording-allowance-notice" class="field-help" role="status" hidden></p><div class="recording-actions"><button id="record-start" class="button primary">Start recording</button><button id="record-stop" class="button secondary">Stop &amp; save</button><button id="capture-tiled" class="button secondary">Capture selected feeds</button></div><p class="field-help">Tiles resize as cameras join or leave. One tiled video; original proportions preserved. No audio. Storage settings apply to new recordings.</p></section><section class="workspace-panel"><h2>Saved recordings &amp; captures</h2><p class="field-help" id="library-note"></p><p id="recording-recovery-status" class="field-help" role="status"></p><div class="recording-actions recording-view-tabs" aria-label="Recording views"><button type="button" id="recording-library-tab" class="button primary" aria-pressed="true">Library</button><button type="button" id="recording-timeline-tab" class="button secondary" aria-pressed="false">Timeline playback</button></div><p id="timeline-events-status" class="field-help" role="status" hidden></p><div id="media-library" class="media-library"></div><div id="recording-timeline" hidden></div></section>';
      find("#recording-description").textContent = window.spyderShowcase
        ? "Record locally in this browser. Keep this tab visible. Recordings stop when hidden or at the 128 MiB memory limit. Download before closing this tab."
        : "Recorded on this computer, even while the browser is away. Clips save automatically as you record. Stop recording to save the final clip. Saved files remain available after restarting.";
      if (window.spyderShowcase && window.spyderBrowserMedia?.importVideo) {
        const openVideo = document.createElement("button");
        openVideo.type = "button";
        openVideo.className = "button secondary";
        openVideo.textContent = "Open local video";
        const picker = document.createElement("input");
        picker.type = "file";
        picker.accept = "video/*,.mkv,.avi";
        picker.hidden = true;
        openVideo.addEventListener("click", () => picker.click());
        picker.addEventListener("change", async () => {
          const file = picker.files?.[0];
          if (!file) return;
          openVideo.disabled = true;
          try {
            await window.spyderBrowserMedia.importVideo(file);
            media = await readStatus();
            update();
            tell(
              "Local video opened in this tab. Open it from the library, then import its detection files. Nothing was uploaded.",
            );
          } catch (error) {
            tell(error.message);
          } finally {
            openVideo.disabled = false;
            picker.value = "";
          }
        });
        find(".recording-view-tabs").append(openVideo, picker);
      }
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
      recordingLibrary = window.spyderRecordingLibrary.mount(
        find("#media-library"),
        media.items || [],
        {
          readStatus,
          request,
          onTimeline: (item) => switchRecordingView("timeline", item),
          onUpdate: (status) => {
            media = status;
            update();
          },
        },
      );
      find("#recording-library-tab").addEventListener("click", () =>
        switchRecordingView("library"),
      );
      find("#recording-timeline-tab").addEventListener("click", () =>
        switchRecordingView("timeline"),
      );
      switchRecordingView(recordingView);
    } else if (current === "vision-lab") {
      content.innerHTML =
        '<div class="recording-actions vision-nav" role="tablist" aria-label="Vision Lab sections"><button type="button" role="tab" id="vision-motion-tab" class="button primary" aria-selected="true" aria-controls="vision-mode-content">Motion & ROI</button><button type="button" role="tab" id="vision-workflow-tab" class="button secondary" aria-selected="false" aria-controls="vision-mode-content" tabindex="-1">Models & Workflows</button><button type="button" role="tab" id="vision-gallery-tab" class="button secondary" aria-selected="false" aria-controls="vision-mode-content" tabindex="-1">Face galleries</button></div><div id="vision-mode-content" role="tabpanel" aria-labelledby="vision-motion-tab"></div>';
      const mode = find("#vision-mode-content");
      const visionTabs = [...content.querySelectorAll(".vision-nav button")];
      let visionSelection = null;
      function selectVision(id) {
        if (visionSelection === id && mode.childElementCount) return;
        cancelVisionRender();
        const previous = visionTabs.findIndex((tab) => tab.id === visionSelection);
        const next = visionTabs.findIndex((tab) => tab.id === id);
        visionSelection = id;
        for (const tab of visionTabs) {
          const selected = tab.id === id;
          tab.setAttribute("aria-selected", String(selected));
          tab.tabIndex = selected ? 0 : -1;
          tab.className = "button " + (selected ? "primary" : "secondary");
        }
        mode.setAttribute("aria-labelledby", id);
        updateNavigator(content.querySelector(".vision-nav"));
        const renderSelection = () => {
          pendingVisionRender = null;
          if (!mode.isConnected || visionSelection !== id) return;
          window.spyderVisionLab?.unmount();
          window.spyderWorkflows?.unmount();
          try {
            if (id === "vision-workflow-tab") window.spyderWorkflows?.mount(mode);
            else if (id === "vision-motion-tab") window.spyderVisionLab?.mount(mode);
            else mode.innerHTML = '<div id="face-gallery-tools"></div>';
          } finally {
            mode.removeAttribute("aria-busy");
          }
          revealSection(mode, previous < 0 ? 0 : Math.sign(next - previous));
        };
        if (previous < 0 || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) renderSelection();
        else {
          mode.setAttribute("aria-busy", "true");
          // Paint the compositor-backed indicator before mounting a potentially large graph.
          const task = pendingVisionRender = { frame: 0, timer: 0 };
          task.frame = requestAnimationFrame(() => {
            task.timer = setTimeout(renderSelection, 0);
          });
        }
      }
      for (const tab of visionTabs) tab.addEventListener("click", () => selectVision(tab.id));
      content.querySelector(".vision-nav").addEventListener("keydown", (event) => {
        const index = visionTabs.indexOf(event.target);
        if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? visionTabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + visionTabs.length) % visionTabs.length;
        // Manual activation: arrows focus a tab; Enter/Space opens it.
        visionTabs.forEach((tab, i) => { tab.tabIndex = i === next ? 0 : -1; });
        visionTabs[next].focus();
      });
      selectVision("vision-motion-tab");
      setupNavigator(content.querySelector(".vision-nav"));
    } else if (current === "camera-setup") {
      content.innerHTML =
        '<section class="workspace-panel"><h2></h2><p class="workspace-description"></p><div id="device-list" class="device-list"></div></section><div id="onvif-camera-tools"></div>';
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
      // Keep the existing controls mounted while switching focused System views.
      const systemRoot = document.createElement("div");
      systemRoot.className = "system-workspace";
      systemRoot.innerHTML = '<header class="system-head"><div><h1 id="system-heading" tabindex="-1">System</h1><p>Health, storage, backups and local runtime details.</p></div><button type="button" class="system-health-shortcut" data-system-health-label aria-controls="system-overview">Checking health…</button></header><p id="system-pending-restore" role="status" hidden></p><div class="system-nav" role="tablist" aria-label="System sections">' + ["overview", "storage", "backups", "diagnostics"].map((name, index) => `<button type="button" role="tab" id="system-tab-${name}" data-system-tab="${name}" aria-controls="${name === "storage" ? "system-storage-panel" : "system-" + name}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${name[0].toUpperCase() + name.slice(1)}</button>`).join("") + '</div>' + ["overview", "storage", "backups", "diagnostics"].map((name, index) => `<section role="tabpanel" id="${name === "storage" ? "system-storage-panel" : "system-" + name}" data-system-panel="${name}" aria-labelledby="system-tab-${name}" ${index ? "hidden" : ""}></section>`).join("");
      const localPanel = content.firstElementChild;
      const overview = systemRoot.querySelector("#system-overview");
      const storagePane = systemRoot.querySelector("#system-storage-panel");
      const focusPanel = document.createElement("section");
      focusPanel.className = "workspace-panel system-focus-panel";
      focusPanel.innerHTML = '<h2>Camera behavior</h2>';
      focusPanel.append(localPanel.querySelector(".activity-policy"));
      overview.append(focusPanel);
      const folderPanel = document.createElement("section");
      folderPanel.className = "workspace-panel system-folder-panel";
      folderPanel.innerHTML = '<h2>Media folder</h2>';
      folderPanel.append(localPanel.querySelector("#system-details"), localPanel.querySelector("#system-storage"));
      storagePane.append(folderPanel);
      localPanel.querySelector("h2").textContent = "Runtime & dependencies";
      systemRoot.querySelector("#system-diagnostics").append(localPanel);
      content.replaceChildren(systemRoot);
      const systemTabs = [...systemRoot.querySelectorAll("[data-system-tab]")];
      function selectSystemTab(name, focus = false) {
        const previous = systemTabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true");
        const next = systemTabs.findIndex((tab) => tab.dataset.systemTab === name);
        for (const tab of systemTabs) {
          const selected = tab.dataset.systemTab === name;
          tab.setAttribute("aria-selected", String(selected));
          tab.tabIndex = selected ? 0 : -1;
          if (selected && focus) tab.focus();
        }
        for (const pane of systemRoot.querySelectorAll("[data-system-panel]")) {
          const entering = pane.hidden && pane.dataset.systemPanel === name;
          pane.hidden = pane.dataset.systemPanel !== name;
          if (pane.hidden) sectionAnimations.get(pane)?.cancel();
          if (entering) revealSection(pane, Math.sign(next - previous));
        }
        updateNavigator(systemRoot.querySelector(".system-nav"));
      }
      setupNavigator(systemRoot.querySelector(".system-nav"));
      systemRoot.querySelector(".system-nav").addEventListener("click", (event) => {
        const tab = event.target.closest("[data-system-tab]");
        if (tab) selectSystemTab(tab.dataset.systemTab);
      });
      systemRoot.querySelector(".system-nav").addEventListener("keydown", (event) => {
        const index = systemTabs.indexOf(event.target);
        if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? systemTabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + systemTabs.length) % systemTabs.length;
        selectSystemTab(systemTabs[next].dataset.systemTab, true);
      });
      systemRoot.querySelector("[data-system-health-label]").addEventListener("click", () => selectSystemTab("overview", true));
      const allowancePanel = document.createElement("section");
      allowancePanel.className = "workspace-panel";
      allowancePanel.innerHTML =
        '<h2>Recording storage allowance</h2><p class="field-help">Applies to videos in the active output folder. Captures, models and previous folders are excluded.</p><p id="allowance-usage" role="status">Loading recording usage…</p><progress id="allowance-meter" max="1" value="0" aria-label="Recording storage used"></progress><p id="allowance-status" class="field-help" role="status"></p><form id="allowance-form"><fieldset disabled><div class="recording-storage-fields"><label>Maximum storage (GB)<input id="allowance-limit" type="number" min="0" max="17592" step="any" value="0" required aria-describedby="allowance-limit-help" /></label><label>When the allowance fills<select id="allowance-action"><option value="stop">Stop &amp; save · block new recordings</option><option value="compress">Recompress oldest · stop if insufficient</option><option value="delete">Delete oldest unprotected recordings</option></select></label></div><p id="allowance-limit-help" class="field-help">0 means unlimited. Decimal GB. A 4 MiB safety margin is reserved to finish the current clip. The limit is a software allowance; encoder buffers can cause small overshoots.</p><p class="field-help">Recompression is lossy, runs once per eligible MP4, and replaces the original only after playback validation and at least 5% savings. If it cannot free enough space, recording stops. Delete permanently removes oldest eligible clips, including event attachments. Mark important videos “Keep forever” in Recordings to exclude them from both policies. The current clip is preserved.</p><div class="recording-actions"><button class="button primary" type="submit">Save allowance</button><button id="allowance-retry" class="button secondary" type="button">Check space / retry cleanup</button></div></fieldset></form><p id="allowance-feedback" class="field-help" role="status"></p><div class="recording-actions"><button type="button" class="button secondary" data-notification-permission>Enable desktop alerts</button><span class="field-help" data-notification-status>In-app storage alerts are automatic. Desktop alerts need browser permission and an open SpyDER page.</span></div><details><summary>Recent storage alerts</summary><ul id="allowance-alerts"></ul></details>';
      storagePane.append(allowancePanel);
      const allowanceEditor = document.createElement("details");
      allowanceEditor.className = "system-disclosure system-allowance-editor";
      allowanceEditor.innerHTML = '<summary>Edit recording allowance</summary>';
      const allowanceForm = find("#allowance-form", allowancePanel);
      allowanceForm.before(allowanceEditor);
      allowanceEditor.append(allowanceForm);
      const limitHelp = find("#allowance-limit-help", allowancePanel);
      const policyCopy = allowanceForm.querySelectorAll("fieldset > .field-help")[1];
      const policyDetails = document.createElement("details");
      policyDetails.className = "system-disclosure system-policy-details";
      policyDetails.innerHTML = '<summary>Policy limits &amp; protections</summary>';
      const fullPolicy = document.createElement("p");
      fullPolicy.className = "field-help";
      fullPolicy.textContent = limitHelp.textContent + " " + policyCopy.textContent;
      policyDetails.append(fullPolicy);
      policyCopy.replaceWith(policyDetails);
      limitHelp.textContent = "0 means unlimited. Values use decimal GB.";
      const policyHelp = document.createElement("p");
      policyHelp.id = "allowance-policy-help";
      policyHelp.className = "field-help system-policy-help";
      policyHelp.setAttribute("role", "status");
      find(".recording-storage-fields", allowancePanel).after(policyHelp);
      find("#allowance-action", allowancePanel).setAttribute("aria-describedby", policyHelp.id);
      function updatePolicyHelp() {
        const action = find("#allowance-action", allowancePanel).value;
        policyHelp.textContent = action === "delete"
          ? 'Permanently deletes the oldest unprotected recordings, including event attachments. Mark important videos “Keep forever” to protect them. The current clip is preserved.'
          : action === "compress"
            ? 'Lossy recompression replaces an original only after playback validation and at least 5% savings. If space is still insufficient, recording stops. Kept and current clips are protected.'
            : 'Stops and saves the current clip, then blocks new recordings until space is available. Stopped sessions do not resume automatically.';
      }
      find("#allowance-action", allowancePanel).addEventListener("change", updatePolicyHelp);
      allowancePanel.addEventListener("spyder:allowance-ready", updatePolicyHelp);
      updatePolicyHelp();
      window.spyderNotifications?.refresh?.();
      if (window.spyderShowcase) {
        allowanceEditor.hidden = true;
        find("#allowance-form").hidden = true;
        find("#allowance-usage").textContent =
          "Browser showcase: a fixed 128 MiB tab buffer. Use the installed app for persistent storage allowances and keep-forever protection.";
        find("#allowance-meter").hidden = true;
      } else {
        const saveAllowance = async (retry = false) => {
          const form = find("#allowance-form");
          if (form.dataset.saving === "true") return;
          form.dataset.saving = "true";
          form.querySelector("fieldset").disabled = true;
          const feedback = find("#allowance-feedback");
          feedback.textContent = retry
            ? "Checking storage…"
            : "Saving allowance…";
          try {
            const data = retry
              ? {}
              : {
                  max_bytes: Math.round(
                    Number(find("#allowance-limit").value) * 1e9,
                  ),
                  action: find("#allowance-action").value,
                };
            media.allowance = await app.request(
              retry
                ? "/api/system/recording-allowance/retry"
                : "/api/system/recording-allowance",
              data,
            );
            feedback.textContent =
              "Allowance saved. Resolved storage permits new recordings; stopped sessions do not resume automatically.";
          } catch (error) {
            feedback.textContent = error.message;
          } finally {
            form.dataset.saving = "false";
            form.querySelector("fieldset").disabled = false;
            updateAllowance();
          }
        };
        find("#allowance-form").addEventListener("submit", (event) => {
          event.preventDefault();
          saveAllowance();
        });
        find("#allowance-retry").addEventListener("click", () =>
          saveAllowance(true),
        );
      }
      updateActivityPreference();
      const details = find("#system-details");
      const output = find("#system-output");
      const storageStatus = find("#system-storage-status");
      const storageForm = find("#system-storage");
      let defaultDirectory = "";
      function populateSystem(data) {
        if (!details.isConnected) return;
        media.allowance = data.recording_allowance;
        updateAllowance();
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
    (find("#system-heading") || find("#workspace-title")).focus({ preventScroll: true });
    window.scrollTo(0, 0);
    revealSection(content);
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
  function updateAllowance() {
    const quota = media.allowance;
    const form = find("#allowance-form");
    if (window.spyderShowcase || !form || !quota) return;
    if (form.dataset.ready !== "true") {
      find("#allowance-limit").value = String(quota.max_bytes / 1e9);
      find("#allowance-action").value = quota.action;
      form.dataset.ready = "true";
      form.querySelector("fieldset").disabled = false;
      form.closest(".workspace-panel").dispatchEvent(new Event("spyder:allowance-ready"));
    }
    const used = (quota.used_bytes / 1e9).toFixed(3);
    find("#allowance-usage").textContent =
      `${used} GB used` +
      (quota.max_bytes
        ? ` / ${(quota.max_bytes / 1e9).toFixed(2)} GB allocated`
        : " · unlimited") +
      ` · ${(quota.protected_bytes / 1e9).toFixed(3)} GB kept forever`;
    const meter = find("#allowance-meter");
    meter.value = quota.max_bytes
      ? Math.min(1, quota.used_bytes / quota.max_bytes)
      : 0;
    find("#allowance-status").textContent =
      quota.error ||
      (quota.phase === "compressing"
        ? "Recompressing old footage locally. Current recordings may stop while space is recovered. Originals stay intact until a smaller replacement is validated."
        : quota.blocked
          ? "Recording blocked: storage is full or below the safety reserve. Increase the allowance, free space, or retry cleanup. Kept, current and unmanaged files cannot be automatically removed. The stopped clip remains saved."
          : "Storage available. New recordings are allowed. Stopped sessions require a new start.");
    const list = find("#allowance-alerts");
    const signature = JSON.stringify(quota.alerts || []);
    if (list.dataset.signature !== signature) {
      list.dataset.signature = signature;
      list.replaceChildren();
      for (const alert of [...(quota.alerts || [])].reverse().slice(0, 5)) {
        const row = document.createElement("li");
        row.textContent =
          new Date(alert.created_at).toLocaleString() + " · " + alert.message;
        list.append(row);
      }
      if (!list.childElementCount) list.textContent = "No storage alerts.";
    }
  }
  function update() {
    updateAllowance();
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
    const quotaBlocked = !!media.allowance?.blocked;
    const quotaNotice = find("#recording-allowance-notice");
    quotaNotice.hidden = !quotaBlocked;
    quotaNotice.replaceChildren();
    if (quotaBlocked) {
      quotaNotice.append(
        document.createTextNode(
          active()
            ? "Storage full: stopping and saving the current clip. "
            : "Recording blocked until storage is resolved. ",
        ),
      );
      const link = document.createElement("a");
      link.href = "#system";
      link.textContent = "Review storage in System";
      quotaNotice.append(link);
    }
    find("#record-start").disabled =
      busy || active() || !selected.size || quotaBlocked;
    find("#record-stop").disabled = busy || media.state !== "recording";
    find("#capture-tiled").disabled = busy || !selected.size;
    const recovery = media.recovery;
    const recoveryStatus = find("#recording-recovery-status");
    recoveryStatus.textContent =
      recovery?.durability_warning ||
      (recovery?.pending?.length
        ? `${recovery.pending.length} interrupted recording(s) retained for recovery. Check the local media folder; no source footage was discarded.`
        : recovery?.recovered?.length
          ? `${recovery.recovered.length} recording(s) recovered after interruption and marked Keep forever.`
          : "Installed recordings use crash-resilient fragments and periodic disk checkpoints. The newest buffered seconds may still be lost on power failure.");
    if (window.spyderShowcase)
      recoveryStatus.textContent =
        "Browser demo recordings stay in memory; a crashed or closed tab cannot be recovered. Download before closing.";
    recordingLibrary?.setItems(media.items || []);
    recordingTimeline?.setItems(media.items || []);
    void loadTimelineEvents();
  }
  window.addEventListener("hashchange", route);
  window.addEventListener("spyder:vision-lab-ready", () => {
    if (
      current === "vision-lab" &&
      find("#vision-motion-tab")?.getAttribute("aria-selected") === "true"
    )
      window.spyderVisionLab.mount(find("#vision-mode-content"));
  });
  window.addEventListener("spyder:workflows-ready", () => {
    if (
      current === "vision-lab" &&
      find("#vision-workflow-tab")?.getAttribute("aria-selected") === "true"
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
