/* Local saved-recording timeline. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.spyderRecordingTimeline = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";

  const MAX_BINS = 720;

  function segments(items) {
    return (Array.isArray(items) ? items : [])
      .filter((item) => item && item.kind !== "capture")
      .map((item) => {
        const start_ms = Date.parse(item.created_at);
        const duration = Number(item.duration_seconds ?? item.duration);
        return { item, start_ms, end_ms: start_ms + duration * 1000 };
      })
      .filter(
        (segment) =>
          Number.isFinite(segment.start_ms) &&
          Number.isFinite(segment.end_ms) &&
          segment.end_ms > segment.start_ms,
      )
      .sort(
        (a, b) =>
          a.start_ms - b.start_ms ||
          String(a.item.id || "").localeCompare(String(b.item.id || "")),
      );
  }

  function localDayRange(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
    if (!match) return null;
    const start = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
    );
    if (
      start.getFullYear() !== Number(match[1]) ||
      start.getMonth() !== Number(match[2]) - 1 ||
      start.getDate() !== Number(match[3])
    )
      return null;
    const end = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + 1,
    );
    return { start_ms: start.getTime(), end_ms: end.getTime() };
  }

  function findSegment(items, clockMs, preferredId) {
    return findSegmentInSegments(segments(items), clockMs, preferredId);
  }

  function findSegmentInSegments(list, clockMs, preferredId) {
    const matches = list.filter(
      (segment) => segment.start_ms <= clockMs && clockMs < segment.end_ms,
    );
    return (
      matches.find(
        (segment) => String(segment.item.id) === String(preferredId),
      ) ||
      matches.sort(
        (a, b) =>
          b.start_ms - a.start_ms ||
          String(a.item.id || "").localeCompare(String(b.item.id || "")),
      )[0] ||
      null
    );
  }

  function nextSegment(items, current, clockMs) {
    return nextSegmentInSegments(segments(items), current, clockMs);
  }

  function nextSegmentInSegments(list, current, clockMs) {
    if (current) {
      const id = current.item ? current.item.id : current.id;
      const saved = list.find(
        (segment) => String(segment.item.id) === String(id),
      );
      const boundary =
        current.end_ms ??
        saved?.end_ms ??
        segments([current.item || current])[0]?.end_ms ??
        Number(clockMs);
      if (!Number.isFinite(boundary)) return null;
      // End time must advance, including when returning from an event clip to
      // a longer recording that started earlier. This prevents overlap loops.
      const candidates = list.filter(
        (segment) =>
          String(segment.item.id) !== String(id) && segment.end_ms > boundary,
      );
      return (
        findSegmentInSegments(candidates, boundary) ||
        candidates.find((segment) => segment.start_ms >= boundary) ||
        null
      );
    }
    const boundary = Number(clockMs);
    return (
      list.find(
        (segment) =>
          segment.start_ms > (Number.isFinite(boundary) ? boundary : -Infinity),
      ) || null
    );
  }

  function cameraIds(item) {
    const ids = new Set(
      (Array.isArray(item.camera_ids) ? item.camera_ids : [])
        .filter((id) => id != null && String(id).trim())
        .map(String),
    );
    for (const id of [item.camera_id, item.cameraId])
      if (id != null && String(id).trim()) ids.add(String(id));
    for (const span of Array.isArray(item.camera_spans)
      ? item.camera_spans
      : []) {
      const id =
        typeof span === "string"
          ? span
          : span && (span.camera_id ?? span.cameraId ?? span.id);
      if (id != null && String(id).trim()) ids.add(String(id));
      for (const nested of span && Array.isArray(span.camera_ids)
        ? span.camera_ids
        : [])
        if (nested != null && String(nested).trim()) ids.add(String(nested));
    }
    return ids;
  }

  function belongsToCamera(item, cameraId) {
    if (!cameraId) return true;
    const ids = cameraIds(item);
    if (cameraId === "__unknown__") return ids.size === 0;
    return ids.has(String(cameraId));
  }

  function coverageBins(items, range, count = MAX_BINS) {
    return coverageBinsFromSegments(segments(items), range, count);
  }

  function coverageBinsFromSegments(list, range, count = MAX_BINS) {
    const size = Math.max(
      1,
      Math.min(MAX_BINS, Math.floor(Number(count) || MAX_BINS)),
    );
    const start = Number(range && range.start_ms);
    const end = Number(range && range.end_ms);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      return Array(size).fill(0);
    const bins = Array(size).fill(0);
    for (const segment of list) {
      const left = Math.max(start, segment.start_ms);
      const right = Math.min(end, segment.end_ms);
      if (right <= left) continue;
      const first = Math.max(
        0,
        Math.floor(((left - start) / (end - start)) * size),
      );
      const last = Math.min(
        size - 1,
        Math.ceil(((right - start) / (end - start)) * size) - 1,
      );
      for (let i = first; i <= last; i++) bins[i] = 1;
    }
    return bins;
  }

  function clipPage(items, page = 1, size = 25) {
    return clipPageFromSegments(segments(items), page, size);
  }

  function clipPageFromSegments(list, page = 1, size = 25) {
    const pageSize = Math.max(1, Math.min(50, Math.floor(Number(size) || 25)));
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    const currentPage = Math.max(
      1,
      Math.min(pages, Math.floor(Number(page) || 1)),
    );
    return {
      items: list.slice((currentPage - 1) * pageSize, currentPage * pageSize),
      total: list.length,
      pages,
      page: currentPage,
      size: pageSize,
    };
  }

  function mount(container, initialItems = [], adapters = {}) {
    if (!container || !container.append)
      throw new TypeError("Timeline container required");
    let items = Array.isArray(initialItems) ? initialItems.slice() : [];
    let itemSignature = JSON.stringify(items);
    let itemSegments = segments(items);
    let rangeCache = null;
    let events =
      typeof adapters.events === "function" ? adapters.events() || [] : [];
    let disposed = false,
      page = 1,
      selected = null;
    let playerGeneration = 0,
      playerEpoch = 0,
      playing = false;
    let speed = 1,
      scopeHours = 24,
      clockMs = Date.now(),
      camera = "";
    let lastLoadedId = null,
      playerHandle = null,
      clipNodes = [];
    const doc = container.ownerDocument || document;
    const el = (tag, cls, value) => {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (value != null) node.textContent = value;
      return node;
    };
    const button = (label, cls = "") => {
      const node = el("button", cls, label);
      node.type = "button";
      return node;
    };
    const panel = el("section", "recording-timeline");
    panel.setAttribute("aria-label", "Recording timeline");
    const heading = el("div", "recording-timeline-heading");
    heading.append(
      el("div", "", "Recordings"),
      el("p", "", "Browse saved clips by local date and camera."),
    );
    const toolbar = el("div", "recording-timeline-toolbar");
    const dateLabel = el("label", "", "Date");
    const dateInput = el("input");
    dateInput.type = "date";
    dateLabel.append(dateInput);
    const prevDay = button("Previous day", "secondary");
    const nextDay = button("Next day", "secondary");
    const cameraLabel = el("label", "", "Camera");
    const cameraSelect = el("select");
    cameraLabel.append(cameraSelect);
    const jumpLabel = el("label", "", "Jump to local time");
    const jumpInput = el("input");
    jumpInput.type = "datetime-local";
    jumpInput.step = "1";
    jumpLabel.append(jumpInput);
    toolbar.append(dateLabel, prevDay, nextDay, cameraLabel, jumpLabel);

    const stage = el("div", "recording-timeline-stage");
    const playerContainer = el("div", "recording-timeline-player");
    playerContainer.setAttribute("aria-label", "Recording player");
    const detail = el("div", "recording-timeline-player-detail");
    const loadedName = el(
      "strong",
      "recording-timeline-loaded",
      "Select a recording",
    );
    const loadedTime = el(
      "span",
      "recording-timeline-clock",
      "No clip selected",
    );
    detail.append(loadedName, loadedTime);
    const controls = el("div", "recording-timeline-player-controls");
    const playButton = button("Play", "primary");
    function setPlayButton(playingNow) {
      const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.classList.add("icon");
      icon.setAttribute("aria-hidden", "true");
      const use = doc.createElementNS(icon.namespaceURI, "use");
      use.setAttribute("href", `/icons.svg#${playingNow ? "pause" : "play"}`);
      icon.append(use);
      playButton.replaceChildren(
        icon,
        doc.createTextNode(playingNow ? "Pause" : "Play"),
      );
    }
    setPlayButton(false);
    const previousClip = button("Previous clip", "secondary");
    const nextClip = button("Next clip", "secondary");
    const rateLabel = el("label", "", "Speed");
    const rate = el("select");
    for (const value of [0.5, 1, 2, 4])
      rate.append(new Option(`${value}×`, String(value)));
    rate.value = "1";
    rateLabel.append(rate);
    const skipLabel = el("label", "recording-timeline-check", "Skip gaps");
    const skip = el("input");
    skip.type = "checkbox";
    skipLabel.prepend(skip);
    controls.append(previousClip, playButton, nextClip, rateLabel, skipLabel);
    stage.append(playerContainer, detail, controls);

    const railHeader = el("div", "recording-timeline-rail-header");
    const railTitle = el("strong", "", "24-hour coverage");
    const zoom = el("div", "recording-timeline-zoom");
    const zoomButtons = [];
    for (const [hours, label] of [
      [24, "24h"],
      [6, "6h"],
      [1, "1h"],
    ]) {
      const b = button(label, "secondary");
      b.dataset.hours = String(hours);
      zoomButtons.push(b);
      zoom.append(b);
    }
    railHeader.append(railTitle, zoom);
    const timeline = el("div", "recording-timeline-track-wrap");
    const track = el("div", "recording-timeline-track");
    track.setAttribute("role", "group");
    track.setAttribute("aria-label", "Recording coverage");
    const bins = el("div", "recording-timeline-bins");
    const markers = el("div", "recording-timeline-markers");
    const rangeInput = el("input", "recording-timeline-range");
    rangeInput.type = "range";
    rangeInput.min = "0";
    rangeInput.max = "10000";
    rangeInput.step = "1";
    rangeInput.setAttribute("aria-label", "Timeline playhead");
    const playhead = el("div", "recording-timeline-playhead");
    playhead.setAttribute("aria-hidden", "true");
    track.append(bins, markers, playhead, rangeInput);
    timeline.append(track);
    const labels = el("div", "recording-timeline-axis");
    const leftLabel = el("span"),
      middleLabel = el("span"),
      rightLabel = el("span");
    labels.append(leftLabel, middleLabel, rightLabel);
    const eventList = el("div", "recording-timeline-event-list");
    eventList.setAttribute("aria-label", "Events on selected timeline");
    const coverageState = el("p", "recording-timeline-state");
    coverageState.setAttribute("role", "status");
    const note = el(
      "p",
      "recording-timeline-note",
      "Times use this browser’s time zone and estimate the recording clock from clip start and duration. Older clips without camera metadata appear under Unknown camera. Camera filtering plays the original tiled video.",
    );
    const listHead = el("div", "recording-timeline-list-head");
    const listTitle = el("h3", "", "Saved clips");
    const listSummary = el("span", "field-help");
    listHead.append(listTitle, listSummary);
    const clipList = el("div", "recording-timeline-clips");
    const pagination = el("div", "recording-timeline-pagination");
    const pagePrev = button("Previous page", "secondary"),
      pageLabel = el("span", "field-help"),
      pageNext = button("Next page", "secondary");
    pagination.append(pagePrev, pageLabel, pageNext);
    panel.append(
      heading,
      toolbar,
      stage,
      railHeader,
      timeline,
      labels,
      eventList,
      coverageState,
      note,
      listHead,
      clipList,
      pagination,
    );
    container.replaceChildren(panel);

    function dayFor(ms) {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    function visibleItems() {
      return itemSegments.filter((s) => belongsToCamera(s.item, camera));
    }
    function selectedDate() {
      return dateInput.value || dayFor(clockMs);
    }
    function daySegments() {
      const range = localDayRange(selectedDate());
      return range
        ? visibleItems().filter(
            (s) => s.start_ms < range.end_ms && s.end_ms > range.start_ms,
          )
        : [];
    }
    function viewRange() {
      const day = localDayRange(selectedDate());
      if (!day) return { start_ms: clockMs, end_ms: clockMs + 1 };
      if (
        rangeCache &&
        rangeCache.date === selectedDate() &&
        rangeCache.hours === scopeHours
      )
        return rangeCache.range;
      if (scopeHours === 24) return day;
      const span = scopeHours * 3600000;
      const center =
        clockMs >= day.start_ms && clockMs < day.end_ms
          ? clockMs
          : day.start_ms + 12 * 3600000;
      let start = Math.max(day.start_ms, center - span / 2);
      let end = Math.min(day.end_ms, start + span);
      start = Math.max(day.start_ms, end - span);
      rangeCache = {
        date: selectedDate(),
        hours: scopeHours,
        range: { start_ms: start, end_ms: end },
      };
      return rangeCache.range;
    }
    function updateClockLabels() {
      const range = viewRange();
      const pct =
        ((clockMs - range.start_ms) /
          Math.max(1, range.end_ms - range.start_ms)) *
        100;
      const clamped = Math.max(0, Math.min(100, pct));
      playhead.style.left = `${clamped}%`;
      rangeInput.value = String(Math.round(clamped * 100));
      rangeInput.setAttribute(
        "aria-valuetext",
        new Date(clockMs).toLocaleString(),
      );
      if (doc.activeElement !== jumpInput) {
        const date = new Date(clockMs);
        jumpInput.value = `${dayFor(clockMs)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
      }
      loadedTime.textContent = `${new Date(clockMs).toLocaleString()} · local browser time`;
    }
    function refreshCameras() {
      const old = camera;
      cameraSelect.replaceChildren();
      cameraSelect.append(new Option("All cameras", ""));
      const cameras =
        typeof adapters.cameras === "function" ? adapters.cameras() || [] : [];
      const known = new Map(
        cameras
          .filter((entry) => entry && entry.id != null)
          .map((entry) => [
            String(entry.id),
            String(entry.name || entry.label || entry.id),
          ]),
      );
      for (const item of items)
        for (const id of cameraIds(item)) if (!known.has(id)) known.set(id, id);
      for (const [id, name] of [...known].sort((a, b) =>
        a[1].localeCompare(b[1]),
      ))
        cameraSelect.append(new Option(name, id));
      cameraSelect.append(new Option("Unknown camera", "__unknown__"));
      camera = [...cameraSelect.options].some((option) => option.value === old)
        ? old
        : "";
      cameraSelect.value = camera;
    }
    function renderRail() {
      const range = viewRange();
      const all = daySegments();
      const visible = visibleItems();
      const daily = localDayRange(selectedDate());
      const dailyVisible = daily
        ? visible.filter(
            (s) => s.start_ms < daily.end_ms && s.end_ms > daily.start_ms,
          )
        : [];
      const binsData = coverageBinsFromSegments(dailyVisible, range, MAX_BINS);
      bins.replaceChildren();
      binsData.forEach((covered, index) => {
        if (!covered) return;
        const bin = el("span", "recording-timeline-bin");
        bin.style.left = `${(index / MAX_BINS) * 100}%`;
        bin.style.width = `${100 / MAX_BINS + 0.06}%`;
        bins.append(bin);
      });
      markers.replaceChildren();
      const todaysEvents = (Array.isArray(events) ? events : [])
        .filter((event) => {
          const at = Date.parse(
            event.created_at || event.timestamp || event.occurred_at,
          );
          return (
            Number.isFinite(at) &&
            at >= range.start_ms &&
            at < range.end_ms &&
            belongsToCamera(event, camera)
          );
        })
        .slice(0, 100);
      eventList.replaceChildren();
      for (const event of todaysEvents) {
        const at = Date.parse(
          event.created_at || event.timestamp || event.occurred_at,
        );
        const marker = el("span", "recording-timeline-event-marker");
        marker.style.left = `${((at - range.start_ms) / (range.end_ms - range.start_ms)) * 100}%`;
        marker.title = String(
          event.label || event.name || event.event_type || "Event",
        );
        marker.setAttribute(
          "aria-label",
          `${marker.title} at ${new Date(at).toLocaleTimeString()}`,
        );
        markers.append(marker);
        const eventButton = button(
          `${marker.title} · ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
          "secondary",
        );
        eventButton.classList.add("recording-timeline-event-button");
        eventButton.addEventListener("click", () => moveToTime(at));
        eventList.append(eventButton);
      }
      const start = new Date(range.start_ms),
        end = new Date(range.end_ms);
      leftLabel.textContent = start.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
      middleLabel.textContent = new Date(
        (range.start_ms + range.end_ms) / 2,
      ).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      rightLabel.textContent = end.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
      const dailyTotal = daySegments().length;
      railTitle.textContent = `${scopeHours === 24 ? "24-hour" : `${scopeHours}-hour`} coverage · ${dailyTotal} clip${dailyTotal === 1 ? "" : "s"}`;
      zoomButtons.forEach((b) =>
        b.setAttribute(
          "aria-pressed",
          String(Number(b.dataset.hours) === scopeHours),
        ),
      );
      return { all, dailyVisible };
    }
    function renderTimeline() {
      if (disposed) return;
      const { all, dailyVisible } = renderRail();
      updateClockLabels();
      const dayHasFootage = all.length > 0;
      coverageState.textContent = dayHasFootage
        ? `${dailyVisible.length} saved clip${dailyVisible.length === 1 ? "" : "s"} · gaps show periods without saved footage`
        : "No saved footage for this date and camera.";
      renderClipList();
    }
    function renderClipList() {
      const paged = clipPageFromSegments(daySegments(), page, 25);
      page = paged.page;
      clipList.replaceChildren();
      clipNodes = [];
      listSummary.textContent = `${paged.total} clips · ${daySegments().length} on selected day`;
      if (!paged.items.length)
        clipList.append(
          el(
            "p",
            "recording-timeline-empty",
            "No clips match this date and camera.",
          ),
        );
      paged.items.forEach((segment) => {
        const row = el("article", "recording-timeline-clip");
        row.classList.toggle(
          "is-selected",
          selected && String(selected.item.id) === String(segment.item.id),
        );
        const info = el("div", "recording-timeline-clip-info");
        const name = el(
          "strong",
          "",
          segment.item.name || segment.item.filename || "Saved recording",
        );
        const localStart = new Date(segment.start_ms);
        const localEnd = new Date(segment.end_ms);
        const timing = el(
          "span",
          "",
          `${localStart.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}–${localEnd.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })} · ${Math.round((segment.end_ms - segment.start_ms) / 1000)} s`,
        );
        info.append(name, timing);
        const actions = el("div", "recording-timeline-clip-actions");
        const open = button("Play clip", "secondary");
        open.setAttribute("aria-label", `Play ${name.textContent}`);
        const download = button("Download", "secondary");
        open.addEventListener("click", () => selectSegment(segment, true));
        download.addEventListener("click", () => downloadItem(segment.item));
        actions.append(open, download);
        row.append(info, actions);
        clipList.append(row);
        clipNodes.push({ row, segment });
      });
      pageLabel.textContent = `Page ${paged.page} of ${paged.pages}`;
      pagePrev.disabled = paged.page <= 1;
      pageNext.disabled = paged.page >= paged.pages;
    }
    function syncSelectedRow() {
      for (const entry of clipNodes)
        entry.row.classList.toggle(
          "is-selected",
          selected &&
            String(selected.item.id) === String(entry.segment.item.id),
        );
    }
    function clearSelection(message = "Select a clip to play saved footage.") {
      if (playerHandle) {
        try {
          playerHandle.pause();
        } catch (_) {}
        if (typeof playerHandle.destroy === "function") playerHandle.destroy();
      }
      playerGeneration++;
      playerEpoch++;
      playerHandle = null;
      lastLoadedId = null;
      selected = null;
      playing = false;
      playerContainer.replaceChildren(
        el("p", "recording-timeline-empty", message),
      );
      loadedName.textContent = "Select a recording";
      setPlayButton(false);
      syncSelectedRow();
    }
    function ensurePlayer() {
      if (playerHandle) return true;
      if (typeof adapters.createPlayer !== "function") return false;
      playerContainer.replaceChildren();
      startPlayer();
      return !!playerHandle;
    }
    function selectSegment(
      segment,
      autoplay = false,
      offset = 0,
      displayClockMs = null,
    ) {
      if (disposed || !segment) return;
      selected = segment;
      clockMs = Number.isFinite(displayClockMs)
        ? displayClockMs
        : segment.start_ms +
          Math.max(
            0,
            Math.min(segment.end_ms - segment.start_ms - 1, offset * 1000),
          );
      const clockDate = dayFor(clockMs);
      if (clockDate !== selectedDate()) {
        dateInput.value = clockDate;
        page = 1;
        rangeCache = null;
      }
      loadedName.textContent =
        segment.item.name || segment.item.filename || "Saved recording";
      syncSelectedRow();
      renderTimeline();
      if (!ensurePlayer()) {
        coverageState.textContent = "Recording player is unavailable.";
        return;
      }
      if (lastLoadedId === String(segment.item.id)) {
        playerHandle.seek(Math.max(0, offset));
        if (autoplay) playerHandle.play();
        return;
      }
      const generation = ++playerGeneration;
      lastLoadedId = String(segment.item.id);
      const promise = playerHandle.load(segment.item, {
        offset,
        autoplay,
        rate: speed,
      });
      Promise.resolve(promise).catch((error) => {
        if (disposed || generation !== playerGeneration) return;
        coverageState.textContent =
          error && error.message ? error.message : "Could not load recording.";
      });
    }
    function moveToTime(ms) {
      const target = Number(ms);
      if (!Number.isFinite(target)) return;
      const targetDate = dayFor(target);
      if (targetDate !== selectedDate()) setDate(targetDate);
      clockMs = target;
      rangeCache = null;
      const hit = findSegmentInSegments(
        visibleItems(),
        target,
        selected && selected.item.id,
      );
      if (!hit) {
        clearSelection("No saved footage at selected time.");
        renderTimeline();
        return;
      }
      selectSegment(hit, false, Math.max(0, (target - hit.start_ms) / 1000));
    }
    function navNext() {
      const next = nextSegmentInSegments(visibleItems(), selected, clockMs);
      if (next)
        selectSegment(
          next,
          true,
          selected ? Math.max(0, (selected.end_ms - next.start_ms) / 1000) : 0,
        );
    }
    function navPrevious() {
      const list = visibleItems();
      const index = selected
        ? list.findIndex((s) => String(s.item.id) === String(selected.item.id))
        : list.findIndex((s) => s.start_ms >= clockMs);
      const previous =
        list[index > 0 ? index - 1 : index === -1 ? list.length - 1 : -1];
      if (previous) selectSegment(previous, true);
    }
    function onEnded() {
      playing = false;
      setPlayButton(false);
      if (!selected) return;
      const next = nextSegmentInSegments(visibleItems(), selected, clockMs);
      const gap = next ? next.start_ms - selected.end_ms : Infinity;
      if (!next || (gap > 1000 && !skip.checked)) return;
      selectSegment(
        next,
        true,
        Math.max(0, (selected.end_ms - next.start_ms) / 1000),
      );
    }
    function downloadItem(item) {
      let url = "";
      const blobURL = item.safe_url || item.url;
      if (
        typeof blobURL === "string" &&
        /^blob:(?:https?:\/\/[^/\s]+|null)\/[a-f0-9-]+$/i.test(blobURL)
      )
        url = blobURL;
      else if (/^[a-f0-9]{32}$/i.test(String(item.id || "")))
        url = `/api/media/${encodeURIComponent(item.id)}`;
      if (!url) return;
      const anchor = el("a");
      anchor.href = url;
      anchor.download = item.filename || item.name || "recording";
      anchor.hidden = true;
      panel.append(anchor);
      anchor.click();
      anchor.remove();
    }
    function startPlayer() {
      if (typeof adapters.createPlayer !== "function") {
        playerContainer.append(
          el(
            "p",
            "recording-timeline-empty",
            "Select a clip to play saved footage.",
          ),
        );
        return;
      }
      const epoch = ++playerEpoch;
      const current = () => !disposed && epoch === playerEpoch;
      playerHandle = adapters.createPlayer(playerContainer, {
        onTime(seconds) {
          if (!current() || !selected || !Number.isFinite(Number(seconds)))
            return;
          clockMs = selected.start_ms + Math.max(0, Number(seconds) * 1000);
          const playbackDate = dayFor(clockMs);
          if (playbackDate !== selectedDate()) {
            dateInput.value = playbackDate;
            rangeCache = null;
            renderTimeline();
          } else {
            const range = viewRange();
            if (
              scopeHours < 24 &&
              (clockMs < range.start_ms || clockMs >= range.end_ms)
            ) {
              rangeCache = null;
              renderRail();
              updateClockLabels();
            } else updateClockLabels();
          }
        },
        onEnded() {
          if (current()) onEnded();
        },
        onState(value) {
          if (current()) {
            playing = !!value;
            setPlayButton(playing);
          }
        },
        onError(message) {
          if (current())
            coverageState.textContent = String(
              message || "Could not play recording.",
            );
        },
      });
    }
    function setDate(date, clear = true) {
      const range = localDayRange(date);
      if (!range) return;
      if (clear) clearSelection();
      dateInput.value = date;
      const newest = visibleItems().find(
        (s) => s.start_ms >= range.start_ms && s.start_ms < range.end_ms,
      );
      clockMs = newest ? newest.start_ms : range.start_ms;
      rangeCache = null;
      page = 1;
      renderTimeline();
    }
    refreshCameras();
    const newest = itemSegments[itemSegments.length - 1] || null;
    dateInput.value = newest ? dayFor(newest.start_ms) : dayFor(Date.now());
    clockMs = newest
      ? newest.start_ms
      : (localDayRange(dateInput.value) || { start_ms: Date.now() }).start_ms;
    startPlayer();
    renderTimeline();
    if (newest) selectSegment(newest, false, 0);

    dateInput.addEventListener("change", () => setDate(dateInput.value));
    prevDay.addEventListener("click", () => {
      const d = localDayRange(selectedDate());
      if (d) setDate(dayFor(d.start_ms - 1000));
    });
    nextDay.addEventListener("click", () => {
      const d = localDayRange(selectedDate());
      if (d) setDate(dayFor(d.end_ms));
    });
    cameraSelect.addEventListener("change", () => {
      clearSelection();
      camera = cameraSelect.value;
      rangeCache = null;
      page = 1;
      renderTimeline();
    });
    jumpInput.addEventListener("change", () => {
      const ms = new Date(jumpInput.value).getTime();
      if (!Number.isFinite(ms)) return;
      moveToTime(ms);
    });
    zoomButtons.forEach((b) =>
      b.addEventListener("click", () => {
        scopeHours = Number(b.dataset.hours);
        rangeCache = null;
        renderTimeline();
      }),
    );
    rangeInput.addEventListener("input", () => {
      const range = viewRange();
      const fraction = Number(rangeInput.value) / 10000;
      const ms = range.start_ms + fraction * (range.end_ms - range.start_ms);
      const hit = findSegmentInSegments(
        visibleItems(),
        ms,
        selected && selected.item.id,
      );
      if (!hit) {
        clockMs = ms;
        clearSelection("No saved footage at selected time.");
        renderTimeline();
        return;
      }
      if (!selected || String(hit.item.id) !== String(selected.item.id))
        selectSegment(hit, false, (ms - hit.start_ms) / 1000);
      else {
        clockMs = ms;
        updateClockLabels();
        if (playerHandle) playerHandle.seek((ms - selected.start_ms) / 1000);
      }
    });
    track.addEventListener("click", (event) => {
      if (event.target === rangeInput) return;
      const rect = track.getBoundingClientRect();
      if (!rect.width) return;
      const range = viewRange();
      const ms =
        range.start_ms +
        Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) *
          (range.end_ms - range.start_ms);
      moveToTime(ms);
    });
    playButton.addEventListener("click", () => {
      if (!playerHandle) return;
      if (playing) playerHandle.pause();
      else if (selected && lastLoadedId === String(selected.item.id))
        playerHandle.play();
      else {
        const hit = findSegmentInSegments(
          visibleItems(),
          clockMs,
          selected && selected.item.id,
        );
        if (hit) selectSegment(hit, true, (clockMs - hit.start_ms) / 1000);
        else {
          clearSelection();
          renderTimeline();
        }
      }
    });
    previousClip.addEventListener("click", navPrevious);
    nextClip.addEventListener("click", navNext);
    pagePrev.addEventListener("click", () => {
      page--;
      renderClipList();
    });
    pageNext.addEventListener("click", () => {
      page++;
      renderClipList();
    });
    rate.addEventListener("change", () => {
      speed = Number(rate.value) || 1;
      if (playerHandle) playerHandle.setRate(speed);
    });

    return {
      setItems(nextItems) {
        if (disposed) return;
        const next = Array.isArray(nextItems) ? nextItems.slice() : [];
        const nextSignature = JSON.stringify(next);
        if (nextSignature === itemSignature) return;
        const oldId = selected && String(selected.item.id);
        const oldCamera = camera;
        items = next;
        itemSignature = nextSignature;
        itemSegments = segments(items);
        refreshCameras();
        const replacement = oldId
          ? itemSegments.find((s) => String(s.item.id) === oldId)
          : null;
        if (oldCamera !== camera || (oldId && !replacement)) clearSelection();
        else if (replacement) selected = replacement;
        renderTimeline();
      },
      setEvents(nextEvents) {
        if (disposed) return;
        const next = Array.isArray(nextEvents) ? nextEvents.slice() : [];
        if (JSON.stringify(next) === JSON.stringify(events)) return;
        events = next;
        renderTimeline();
      },
      seekTo(targetClockMs, preferredId) {
        if (disposed || !Number.isFinite(Number(targetClockMs))) return false;
        const target = Number(targetClockMs);
        const targetDate = dayFor(target);
        if (targetDate !== selectedDate()) setDate(targetDate);
        const candidates = visibleItems();
        const preferred =
          preferredId == null
            ? null
            : candidates.find((s) => String(s.item.id) === String(preferredId));
        const hit =
          preferred ||
          findSegmentInSegments(
            candidates,
            target,
            selected && selected.item.id,
          );
        if (!hit) {
          clockMs = target;
          rangeCache = null;
          clearSelection("No saved footage at selected time.");
          renderTimeline();
          return false;
        }
        const offset = preferred
          ? 0
          : Math.max(0, (target - hit.start_ms) / 1000);
        selectSegment(hit, false, offset, preferred ? target : null);
        return true;
      },
      unmount() {
        if (disposed) return;
        disposed = true;
        playerGeneration++;
        playerEpoch++;
        if (playerHandle && typeof playerHandle.destroy === "function")
          playerHandle.destroy();
        playerHandle = null;
        container.replaceChildren();
      },
    };
  }

  return {
    segments,
    localDayRange,
    findSegment,
    nextSegment,
    coverageBins,
    clipPage,
    cameraIds,
    belongsToCamera,
    mount,
  };
});
