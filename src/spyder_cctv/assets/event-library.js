/* Local event library and on-demand media viewer. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.spyderEventLibrary = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  function eventPage(events, options = {}) {
    const words = String(options.query || "").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    let rows = events.filter((event) => {
      const text = [event.name, event.message, event.camera_name, event.camera_id, event.kind, event.workflow_name].join(" ").toLocaleLowerCase();
      const time = Date.parse(event.created_at);
      const after = options.after ? Date.parse(options.after) : NaN;
      return words.every((word) => text.includes(word)) &&
        (!options.kind || event.kind === options.kind) &&
        (!options.camera || event.camera_id === options.camera) &&
        (!options.media || (options.media === "none" ? !event.media?.length : event.media?.some((item) => item.kind === options.media))) &&
        (!Number.isFinite(after) || time >= after);
    });
    rows = [...rows].sort((a, b) => options.sort === "name" ? String(a.name).localeCompare(String(b.name), undefined, { numeric: true }) :
      options.sort === "oldest" ? Date.parse(a.created_at) - Date.parse(b.created_at) : Date.parse(b.created_at) - Date.parse(a.created_at));
    const size = Math.max(1, Math.min(50, Math.floor(Number(options.size) || 20)));
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const page = Math.min(pages, Math.max(1, Math.floor(Number(options.page) || 1)));
    return { items: rows.slice((page - 1) * size, page * size), total: rows.length, pages, page };
  }
  function groupKey(event, group) {
    if (group === "camera") return event.camera_name || event.camera_id || "Camera unavailable";
    if (group === "kind") return event.kind || "Event";
    if (group === "day") return new Date(event.created_at).toLocaleDateString();
    return "";
  }
  function mediaUrl(item) {
    const url = String(item?.url || "");
    return /^\/api\/media\/[a-zA-Z0-9_-]+(?:\?.*)?$/.test(url) || /^blob:/.test(url) ? url : null;
  }
  let viewer;
  let viewerReturn;
  let viewerCleanup;
  function glyph(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("icon"); svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(svg.namespaceURI, "use");
    use.setAttribute("href", "/icons.svg#" + name); svg.append(use); return svg;
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function action(text, handler, primary = false) {
    const button = element("button", "button " + (primary ? "primary" : "secondary"), text);
    button.type = "button"; button.addEventListener("click", handler); return button;
  }
  function closeMedia() {
    if (!viewer) return;
    viewer.dataset.closing = "true";
    viewerCleanup?.(); viewerCleanup = null;
    const video = viewer.querySelector("video");
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    if (viewer.open) viewer.close();
    viewer.remove(); viewer = null;
    if (viewerReturn?.isConnected) viewerReturn.focus({ preventScroll: true });
    viewerReturn = null;
  }
  function openMedia(item, trigger) {
    const url = mediaUrl(item); if (!url) return;
    closeMedia(); viewerReturn = trigger || document.activeElement;
    viewer = element("dialog", "media-viewer");
    viewer.setAttribute("aria-label", item.kind === "capture" ? "Frame capture" : "Recording player");
    const head = element("div", "media-viewer-heading");
    const title = element("h2", "", item.name || item.filename || "Saved media");
    const close = action("", closeMedia); close.append(glyph("close")); close.setAttribute("aria-label", "Close media viewer");
    head.append(title, close);
    const content = element(item.kind === "capture" ? "img" : "video", "media-viewer-content");
    if (content.tagName === "VIDEO") { content.controls = true; content.preload = "metadata"; content.playsInline = true; }
    else content.alt = item.name || "Saved frame capture";
    content.src = url;
    const error = element("p", "field-help"); error.setAttribute("role", "status");
    let fallbackStarted = false;
    content.addEventListener("error", () => {
      if (!viewer?.open || viewer.dataset.closing === "true" || !viewer.contains(content)) return;
      if (fallbackStarted) return;
      error.textContent = "This browser cannot play this file, or the file is unavailable. Use Download to open it with a local player.";
      if (content.tagName === "VIDEO" && !window.spyderShowcase && url.startsWith("/api/media/")) {
        fallbackStarted = true;
        viewerCleanup = fallbackPlayer(content, item, error);
      }
    });
    const download = element("a", "button secondary", "Download original");
    download.href = url; download.download = item.filename || "";
    viewer.append(head, content, error, download);
    viewer.addEventListener("cancel", (event) => { event.preventDefault(); closeMedia(); });
    viewer.addEventListener("click", (event) => { if (event.target !== viewer) return; const r = viewer.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeMedia(); });
    document.body.append(viewer); viewer.showModal(); close.focus();
  }
  function fallbackPlayer(video, item, status) {
    const dialog = video.closest("dialog");
    const image = element("img", "media-viewer-content"); image.alt = "Recording playback frame";
    const controls = element("div", "event-bulk");
    let disposed = false, playing = false, time = 0, duration = 0, timer, request, objectUrl;
    const base = "/api/media/" + encodeURIComponent(item.id);
    const play = action("Play", () => { playing = !playing; play.textContent = playing ? "Pause" : "Play"; clearTimeout(timer); if (playing) tick(); });
    const seek = element("input"); seek.type = "range"; seek.min = "0"; seek.step = "0.2"; seek.value = "0"; seek.setAttribute("aria-label", "Recording playback position"); seek.style.flex = "1 1 160px";
    const note = element("output", "field-help");
    function updateTime() { seek.value = String(time); note.textContent = time.toFixed(1) + " / " + duration.toFixed(1) + " s"; }
    async function frame() {
      request?.abort(); request = new AbortController(); const current = request;
      try {
        const response = await fetch(base + "/frame?time=" + Math.max(0, Math.min(time, Math.max(0, duration - .01))).toFixed(3), { signal: AbortSignal.any([current.signal, AbortSignal.timeout(10000)]), cache: "no-store" });
        if (!response.ok) throw new Error("Recording frame unavailable");
        const blob = await response.blob(); if (disposed || current.signal.aborted) return;
        const next = URL.createObjectURL(blob); image.src = next;
        if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = next; updateTime();
      } catch (error) { if (!disposed && error.name !== "AbortError") { playing = false; play.textContent = "Play"; status.textContent = "Local playback failed: " + error.message + ". Download the original to use another player."; } }
    }
    async function tick() {
      if (disposed || !playing || document.hidden) return;
      const started = performance.now(); await frame();
      if (!playing || disposed) return;
      time = Math.min(duration, time + .2);
      if (time >= duration) { playing = false; play.textContent = "Play again"; time = 0; return; }
      timer = setTimeout(tick, Math.max(0, 200 - (performance.now() - started)));
    }
    seek.addEventListener("input", () => { playing = false; play.textContent = "Play"; clearTimeout(timer); time = Number(seek.value); updateTime(); frame(); });
    const visibility = () => { if (document.hidden) { playing = false; play.textContent = "Play"; clearTimeout(timer); request?.abort(); } };
    document.addEventListener("visibilitychange", visibility);
    const initialization = new AbortController();
    fetch(base + "/info", { signal: AbortSignal.any([initialization.signal, AbortSignal.timeout(10000)]), cache: "no-store" }).then((response) => { if (!response.ok) throw new Error("Recording information unavailable"); return response.json(); }).then((info) => {
      if (disposed || !dialog.isConnected) return;
      duration = Number(info.duration_seconds || item.duration_seconds || 0);
      if (!Number.isFinite(duration) || duration <= 0) throw new Error("Recording has no playable frames");
      video.pause(); video.hidden = true; video.removeAttribute("src");
      seek.max = String(duration); controls.append(play, seek, note); video.after(image, controls);
      status.textContent = "Compatibility player · local preview at up to 5 frames/s. The downloaded original keeps its full frame rate. No audio.";
      updateTime(); return frame();
    }).catch((error) => { if (!disposed && error.name !== "AbortError") status.textContent = error.message + ". Download the original to open it with a local player."; });
    return () => { disposed = true; playing = false; clearTimeout(timer); request?.abort(); initialization.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); document.removeEventListener("visibilitychange", visibility); };
  }
  function mediaButton(item) {
    const button = action("", () => openMedia(item, button));
    button.className = "media-preview-button";
    button.append(glyph(item.kind === "capture" ? "capture" : "record"));
    button.setAttribute("aria-label", item.kind === "capture" ? "View capture" : "Play recording");
    button.title = item.kind === "capture" ? "View capture" : "Play recording";
    button.disabled = !mediaUrl(item); return button;
  }
  let mounted = null;
  function mount(container) {
    unmount();
    let events = [], selection = new Set(), busy = false, timer, controller, disposed = false;
    let options = { page: 1, size: 20 }, signature = "", statusMessage = "", pendingDelete = false, retention = 10000;
    const panel = element("section", "workspace-panel event-library");
    const heading = element("div", "event-heading");
    heading.append(element("h2", "", "Activity library"));
    const summary = element("span", "field-help", "Loading events…"); heading.append(summary);
    const controls = element("div", "event-filters");
    const searchLabel = element("label", "", "Search events");
    const search = element("input"); search.type = "search"; search.placeholder = "Name, camera, message…"; searchLabel.append(search); controls.append(searchLabel);
    const advanced = element("details", "event-filter-options");
    advanced.open = !window.matchMedia("(max-width: 800px)").matches;
    advanced.append(element("summary", "", "Filters, sorting & grouping"));
    const filterGrid = element("div", "event-filter-grid"); advanced.append(filterGrid); controls.append(advanced);
    const filterSelects = {};
    function select(label, key, values) {
      const wrapper = element("label", "", label), input = element("select");
      for (const [value, text] of values) input.append(new Option(text, value));
      input.addEventListener("change", () => { options[key] = input.value; options.page = 1; render(); });
      wrapper.append(input); filterGrid.append(wrapper); filterSelects[key] = input; return input;
    }
    select("Type", "kind", [["", "All events"], ["motion", "Motion"], ["workflow", "Workflow event"]]);
    select("Camera", "camera", [["", "All cameras"]]);
    select("Attachment", "media", [["", "All attachments"], ["capture", "Capture"], ["recording", "Recording"], ["none", "No attachment"]]);
    select("Sort", "sort", [["newest", "Newest first"], ["oldest", "Oldest first"], ["name", "Name A–Z"]]);
    select("Group", "group", [["", "No grouping"], ["day", "Day"], ["camera", "Camera"], ["kind", "Type"]]);
    const dateLabel = element("label", "", "From date"), date = element("input"); date.type = "date"; dateLabel.append(date); filterGrid.append(dateLabel);
    date.addEventListener("change", () => { options.after = date.value; options.page = 1; render(); });
    search.addEventListener("input", () => { options.query = search.value; options.page = 1; render(); });
    const bulk = element("div", "event-bulk");
    const allLabel = element("label", "event-select"); const all = element("input"); all.type = "checkbox"; allLabel.append(all, document.createTextNode("Select page"));
    const chosen = element("span", "field-help");
    const download = element("a", "button secondary", "Download selected"); download.download = "events.zip";
    const remove = action("Delete selected", () => { pendingDelete = true; renderActions(); });
    const clear = action("Clear selection", () => { selection.clear(); pendingDelete = false; render(); });
    bulk.append(allLabel, chosen, download, remove, clear);
    const confirmation = element("div", "event-confirm"); confirmation.hidden = true;
    const confirmLabel = element("span");
    const confirm = action("Delete events", async () => {
      const ids = [...selection]; if (!ids.length || busy) return;
      busy = true; renderActions();
      try { await window.spyder.request("/api/events/delete", { ids }); selection.clear(); pendingDelete = false; statusMessage = "Events deleted. Saved media files are retained in Recordings."; await load(); }
      catch (error) { statusMessage = error.message; }
      finally { busy = false; render(); }
    });
    const cancelDelete = action("Cancel", () => { pendingDelete = false; renderActions(); });
    confirmation.append(confirmLabel, confirm, cancelDelete);
    const status = element("p", "field-help event-status"); status.setAttribute("role", "status");
    const list = element("div", "event-list"); list.setAttribute("aria-label", "Saved events"); list.tabIndex = 0;
    const paging = element("div", "event-pagination");
    const previous = action("Previous", () => { options.page--; render(); list.scrollTop = 0; });
    const next = action("Next", () => { options.page++; render(); list.scrollTop = 0; });
    const pageNote = element("span", "field-help"); paging.append(previous, pageNote, next);
    panel.append(heading, controls, bulk, confirmation, status, list, paging); container.append(panel);
    function renderActions() {
      const page = eventPage(events, options);
      chosen.textContent = selection.size + " selected (up to 100)";
      all.checked = page.items.length > 0 && page.items.every((e) => selection.has(e.id));
      all.indeterminate = page.items.some((e) => selection.has(e.id)) && !all.checked;
      all.disabled = busy || !page.items.length;
      remove.disabled = clear.disabled = busy || !selection.size;
      download.setAttribute("aria-disabled", String(busy || !selection.size));
      if (selection.size && !busy) download.href = "/api/events/download?ids=" + encodeURIComponent([...selection].join(","));
      else download.removeAttribute("href");
      confirmation.hidden = !pendingDelete;
      confirmLabel.textContent = "Delete " + selection.size + " event records? Saved media files are kept.";
      confirm.disabled = busy || !selection.size;
      cancelDelete.disabled = busy;
      status.textContent = statusMessage;
    }
    all.addEventListener("change", () => {
      for (const event of eventPage(events, options).items) {
        if (all.checked && selection.size < 100) selection.add(event.id); else if (!all.checked) selection.delete(event.id);
      } pendingDelete = false; render();
    });
    function render() {
      if (disposed) return;
      const result = eventPage(events, options); options.page = result.page;
      summary.textContent = result.total + " matching / " + events.length + " stored · latest " + retention.toLocaleString() + " kept";
      const oldScroll = list.scrollTop;
      list.replaceChildren();
      if (!result.items.length) list.append(element("p", "event-empty", window.spyderShowcase ? "Events from native CV workflows are available in the installed app." : events.length ? "No events match these filters." : "No events yet. Enable motion analysis or connect an Event node to an enabled workflow."));
      const groups = new Map();
      for (const event of result.items) {
        const key = groupKey(event, options.group);
        if (!groups.has(key)) { const group = element("section", "event-group"); if (key) group.append(element("h3", "", key)); groups.set(key, group); list.append(group); }
        const row = element("article", "event-item"); row.dataset.eventId = event.id;
        const label = element("label", "event-select"); const checkbox = element("input"); checkbox.type = "checkbox"; checkbox.checked = selection.has(event.id); checkbox.disabled = busy || (!checkbox.checked && selection.size >= 100); checkbox.setAttribute("aria-label", "Select " + event.name); label.append(checkbox);
        checkbox.addEventListener("change", () => { if (checkbox.checked) selection.add(event.id); else selection.delete(event.id); pendingDelete = false; render(); });
        const detail = element("div", "event-detail");
        const name = element("strong", "", event.name || "Event");
        const note = element("p", "", new Date(event.created_at).toLocaleString() + " · " + (event.camera_name || event.camera_id || "Camera") + " · " + event.kind);
        const message = element("p", "", event.message || "");
        detail.append(name, note, message);
        if (event.attachment_status && event.attachment_status !== "ready") detail.append(element("p", "field-help", "Attachment: " + event.attachment_status + (event.attachment_error ? " · " + event.attachment_error : "")));
        const buttons = element("div", "event-item-actions");
        for (const media of event.media || []) buttons.append(mediaButton(media));
        const rename = action("Rename", () => {
          const form = element("form", "event-rename");
          const input = element("input"); input.type = "text"; input.value = event.name || ""; input.required = true; input.maxLength = 200; input.setAttribute("aria-label", "Event name");
          const save = action("Save name", () => {}); save.type = "submit";
          const cancel = action("Cancel", () => render());
          form.append(input, save, cancel); detail.replaceChildren(form);
          form.addEventListener("submit", async (e) => { e.preventDefault(); if (busy || !input.value.trim()) return; busy = true; save.disabled = true;
            try { const result = await window.spyder.request("/api/events/" + encodeURIComponent(event.id) + "/rename", { name: input.value.trim() }); events = events.map((row) => row.id === event.id ? { ...row, ...(result.event || result), name: input.value.trim() } : row); statusMessage = "Event renamed."; signature = ""; }
            catch (error) { statusMessage = error.message; }
            finally { busy = false; render(); }
          }); input.focus(); input.select();
        }); rename.disabled = busy; buttons.append(rename);
        row.append(label, detail, buttons); groups.get(key).append(row);
      }
      previous.disabled = result.page <= 1; next.disabled = result.page >= result.pages;
      pageNote.textContent = "Page " + result.page + " of " + result.pages + " · 20 per page";
      list.scrollTop = oldScroll;
      renderActions();
    }
    async function load() {
      if (disposed || window.spyderShowcase) return;
      controller = new AbortController();
      try {
        const response = await fetch("/api/events", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), cache: "no-store" });
        if (!response.ok) throw new Error("Event library unavailable");
        const data = await response.json(); if (disposed) return;
        retention = data.retention_limit || 10000;
        const updated = JSON.stringify(data.events || []);
        if (updated !== signature) {
          events = data.events || []; signature = updated;
          selection = new Set([...selection].filter((id) => events.some((event) => event.id === id)));
          const cameras = new Map(events.map((event) => [event.camera_id, event.camera_name || event.camera_id]));
          const select = filterSelects.camera; select.replaceChildren(new Option("All cameras", ""));
          for (const [id, name] of cameras) if (id) select.append(new Option(name, id));
          if (options.camera && !cameras.has(options.camera)) options.camera = "";
          select.value = options.camera || "";
          // Preserve an in-progress rename and expanded media while events arrive.
          if (!list.querySelector(".event-rename")) render();
        }
        if (data.storage_error) { statusMessage = data.storage_error; renderActions(); }
      } catch (error) { if (!disposed && error.name !== "AbortError") { statusMessage = error.message; renderActions(); } }
    }
    async function poll() { await load(); if (!disposed) timer = setTimeout(poll, document.hidden ? 10000 : 2500); }
    mounted = () => { disposed = true; clearTimeout(timer); controller?.abort(); panel.remove(); closeMedia(); };
    render(); poll();
  }
  function unmount() { mounted?.(); mounted = null; closeMedia(); }
  return { eventPage, groupKey, mediaUrl, mount, unmount, mediaButton, openMedia, closeMedia };
});
