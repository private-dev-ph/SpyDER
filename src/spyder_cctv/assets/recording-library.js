/* Searchable local recording library. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.spyderRecordingLibrary = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  function recordingPage(items, options = {}) {
    const words = String(options.query || "")
      .toLocaleLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let rows = items.filter((item) => {
      const text = [
        item.filename,
        item.name,
        item.kind,
        item.created_at,
        item.segment_index,
      ]
        .join(" ")
        .toLocaleLowerCase();
      const after = options.after
        ? new Date(options.after + "T00:00:00").getTime()
        : NaN;
      return (
        words.every((word) => text.includes(word)) &&
        (!options.kind || item.kind === options.kind) &&
        (!Number.isFinite(after) || Date.parse(item.created_at) >= after) &&
        (!options.protection ||
          (options.protection === "protected"
            ? item.keep_forever === true
            : item.keep_forever !== true))
      );
    });
    rows = [...rows].sort((a, b) =>
      options.sort === "oldest"
        ? Date.parse(a.created_at) - Date.parse(b.created_at)
        : options.sort === "name"
          ? String(a.name || a.filename).localeCompare(
              String(b.name || b.filename),
              undefined,
              { numeric: true },
            )
          : options.sort === "size"
            ? (b.size_bytes || 0) - (a.size_bytes || 0)
            : options.sort === "duration"
              ? (b.duration_seconds || 0) - (a.duration_seconds || 0)
              : Date.parse(b.created_at) - Date.parse(a.created_at),
    );
    const size = Math.max(
      1,
      Math.min(50, Math.floor(Number(options.size) || 20)),
    );
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const page = Math.min(
      pages,
      Math.max(1, Math.floor(Number(options.page) || 1)),
    );
    return {
      items: rows.slice((page - 1) * size, page * size),
      total: rows.length,
      pages,
      page,
    };
  }
  let mounted;
  function mount(container, initialItems = [], adapters = {}) {
    unmount();
    let items = initialItems,
      signature = JSON.stringify(items),
      disposed = false;
    const options = {
      page: 1,
      size: 20,
      sort: "newest",
      kind: "",
      protection: "",
      query: "",
    };
    const el = (tag, cls, value) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (value != null) n.textContent = value;
      return n;
    };
    const panel = el("section", "recording-library");
    const controls = el("div", "recording-library-controls");
    const searchLabel = el("label", "", "Search recordings");
    const search = el("input");
    search.type = "search";
    search.placeholder = "Filename…";
    search.autocomplete = "off";
    searchLabel.append(search);
    const kindLabel = el("label", "", "Type");
    const kind = el("select");
    for (const [v, t] of [
      ["", "All files"],
      ["recording", "Videos"],
      ["capture", "Captures"],
    ])
      kind.append(new Option(t, v));
    kindLabel.append(kind);
    const protectedLabel = el("label", "", "Protection");
    const protection = el("select");
    for (const [v, t] of [
      ["", "All files"],
      ["protected", "Kept forever"],
      ["unprotected", "Not protected"],
    ])
      protection.append(new Option(t, v));
    protectedLabel.append(protection);
    const sortLabel = el("label", "", "Sort");
    const sort = el("select");
    for (const [v, t] of [
      ["newest", "Newest first"],
      ["oldest", "Oldest first"],
      ["name", "Name A–Z"],
      ["size", "Largest first"],
      ["duration", "Longest first"],
    ])
      sort.append(new Option(t, v));
    sortLabel.append(sort);
    const sizeLabel = el("label", "", "Per page");
    const size = el("select");
    for (const n of [20, 50]) size.append(new Option(String(n), String(n)));
    sizeLabel.append(size);
    const groupLabel = el("label", "", "Group");
    const group = el("select");
    for (const [v, t] of [
      ["", "No grouping"],
      ["day", "Date"],
      ["kind", "Type"],
    ])
      group.append(new Option(t, v));
    groupLabel.append(group);
    const dateLabel = el("label", "", "From date");
    const date = el("input");
    date.type = "date";
    dateLabel.append(date);
    controls.append(
      searchLabel,
      kindLabel,
      protectedLabel,
      sortLabel,
      sizeLabel,
      groupLabel,
      dateLabel,
    );
    const summary = el("p", "field-help recording-library-summary");
    summary.setAttribute("role", "status");
    const list = el("div", "recording-library-list");
    list.setAttribute("aria-label", "Saved recordings and captures");
    list.tabIndex = 0;
    const paging = el("div", "recording-library-pagination");
    const previous = el("button", "button secondary", "Previous");
    const pageNote = el("span", "field-help");
    const next = el("button", "button secondary", "Next");
    previous.type = next.type = "button";
    paging.append(previous, pageNote, next);
    panel.append(controls, summary, list, paging);
    container.append(panel);
    function render() {
      if (disposed) return;
      const result = recordingPage(items, options);
      options.page = result.page;
      summary.textContent = `${result.total} matching · ${items.length} stored`;
      list.replaceChildren();
      if (!result.items.length)
        list.append(
          el(
            "p",
            "recording-library-empty",
            options.query || options.kind || options.protection
              ? "No files match these filters."
              : "Your recordings and captures will appear here.",
          ),
        );
      let previousGroup = null;
      for (const item of result.items) {
        const groupKey =
          options.group === "day"
            ? new Date(item.created_at).toLocaleDateString()
            : options.group === "kind"
              ? item.kind === "capture"
                ? "Captures"
                : "Videos"
              : "";
        if (groupKey !== previousGroup) {
          if (groupKey)
            list.append(el("h3", "recording-library-group", groupKey));
          previousGroup = groupKey;
        }
        const row = el("article", "media-item recording-library-item");
        row.dataset.mediaId = item.id;
        const detail = el("div");
        const name = el(
          "strong",
          "",
          item.name ||
            item.filename ||
            (item.kind === "capture" ? "Frame capture" : "Tiled recording"),
        );
        const date = new Date(item.created_at);
        const note = el(
          "p",
          "",
          `${Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString()} · ${((item.size_bytes || 0) / 1024 ** 2).toFixed(2)} MiB${item.duration_seconds != null ? ` · ${Number(item.duration_seconds).toFixed(1)} s` : ""}`,
        );
        detail.append(name, note);
        const preview = window.spyderEventLibrary.mediaButton(item);
        preview.classList.add("recording-thumbnail");
        const image = el("img");
        image.alt = "";
        image.loading = "lazy";
        image.decoding = "async";
        const thumbnail =
          item.kind === "capture"
            ? item.url
            : window.spyderShowcase
              ? item.thumbnail_url || ""
              : `/api/media/${encodeURIComponent(item.id)}/thumbnail?v=${item.size_bytes}`;
        image.hidden = !thumbnail;
        if (thumbnail) image.src = thumbnail;
        const play = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        play.classList.add("icon", "recording-thumbnail-overlay");
        play.setAttribute("aria-hidden", "true");
        const use = document.createElementNS(play.namespaceURI, "use");
        use.setAttribute(
          "href",
          "/icons.svg#" + (item.kind === "capture" ? "capture" : "play"),
        );
        play.append(use);
        const missing = el(
          "span",
          "recording-thumbnail-missing",
          "Preview unavailable",
        );
        missing.hidden = Boolean(thumbnail);
        image.addEventListener("error", () => {
          image.hidden = true;
          missing.hidden = false;
        });
        preview.replaceChildren(image, play, missing);
        const actions = el("div", "recording-item-actions");
        const download = el("a", "button secondary", "Download");
        download.href = item.url;
        download.download = item.filename || "recording";
        actions.append(download);
        if (
          item.kind === "recording" &&
          item.duration_seconds > 0 &&
          adapters.onTimeline
        ) {
          const timeline = el("button", "button secondary", "Show on timeline");
          timeline.type = "button";
          timeline.addEventListener("click", () => adapters.onTimeline(item));
          actions.append(timeline);
        }
        if (item.recovered)
          detail.append(
            el("small", "field-help", "Recovered after interruption"),
          );
        if (
          item.kind === "recording" &&
          !item.archived &&
          !window.spyderShowcase
        ) {
          const request = (path, data = {}) => adapters.request(path, data);
          const keep = el(
            "button",
            "button secondary",
            item.keep_forever ? "Kept forever · allow cleanup" : "Keep forever",
          );
          keep.type = "button";
          keep.setAttribute("aria-pressed", String(!!item.keep_forever));
          keep.addEventListener("click", async () => {
            keep.disabled = true;
            try {
              const updated = await request(
                `/api/media/${encodeURIComponent(item.id)}/keep`,
                { keep_forever: !item.keep_forever },
              );
              if (typeof updated?.keep_forever === "boolean")
                setItems(
                  items.map((row) =>
                    row.id === item.id ? { ...row, ...updated } : row,
                  ),
                );
              await refresh();
              if (keep.isConnected) keep.disabled = false;
            } catch (error) {
              showError(error);
              if (keep.isConnected) keep.disabled = false;
            }
          });
          actions.append(keep);
          if (!item.keep_forever) {
            const remove = el("button", "button secondary", "Delete recording");
            remove.type = "button";
            remove.addEventListener("click", () => {
              remove.hidden = true;
              const confirm = el(
                "button",
                "button secondary",
                "Delete permanently",
              );
              confirm.type = "button";
              const cancel = el("button", "button secondary", "Cancel");
              cancel.type = "button";
              const warning = el(
                "span",
                "field-help",
                "Permanently delete this clip? Event attachments will also become unavailable.",
              );
              cancel.addEventListener("click", () => {
                warning.remove();
                confirm.remove();
                cancel.remove();
                remove.hidden = false;
                remove.focus();
              });
              confirm.addEventListener("click", async () => {
                confirm.disabled = true;
                try {
                  await request(
                    `/api/media/${encodeURIComponent(item.id)}/delete`,
                  );
                  setItems(items.filter((row) => row.id !== item.id));
                  await refresh();
                } catch (error) {
                  showError(error);
                  confirm.disabled = false;
                }
              });
              actions.append(warning, confirm, cancel);
            });
            remove.classList.add("recording-delete");
            actions.append(remove);
          }
          if (item.compressed)
            actions.append(el("small", "", "Recompressed · reduced detail"));
        }
        row.append(preview, detail, actions);
        list.append(row);
      }
      previous.disabled = result.page <= 1;
      next.disabled = result.page >= result.pages;
      pageNote.textContent = `Page ${result.page} of ${result.pages} · ${options.size} per page`;
    }
    const status = el("p", "field-help");
    status.setAttribute("role", "status");
    status.hidden = true;
    panel.insertBefore(status, list);
    function showError(error) {
      if (disposed) return;
      status.hidden = false;
      status.textContent = error.message;
    }
    async function refresh() {
      if (disposed) return false;
      try {
        const data = await adapters.readStatus();
        if (disposed) return false;
        status.hidden = true;
        status.textContent = "";
        adapters.onUpdate?.(data);
        setItems(data.items || []);
        return true;
      } catch (error) {
        showError(error);
        return false;
      }
    }
    function setItems(nextItems) {
      if (disposed) return;
      const nextSignature = JSON.stringify(nextItems);
      if (nextSignature === signature) return;
      signature = nextSignature;
      items = nextItems;
      render();
    }
    function resetPage() {
      options.page = 1;
      list.scrollTop = 0;
      render();
    }
    search.addEventListener("input", () => {
      options.query = search.value;
      resetPage();
    });
    for (const [input, key] of [
      [kind, "kind"],
      [protection, "protection"],
      [sort, "sort"],
      [size, "size"],
      [group, "group"],
    ])
      input.addEventListener("change", () => {
        options[key] = key === "size" ? Number(input.value) : input.value;
        resetPage();
      });
    date.addEventListener("change", () => {
      options.after = date.value;
      resetPage();
    });
    previous.addEventListener("click", () => {
      options.page--;
      render();
      list.scrollTop = 0;
    });
    next.addEventListener("click", () => {
      options.page++;
      render();
      list.scrollTop = 0;
    });
    const onKey = (event) => {
      if (event.key === "Escape" && search === document.activeElement) {
        search.value = "";
        options.query = "";
        resetPage();
      }
    };
    panel.addEventListener("keydown", onKey);
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      panel.remove();
      window.spyderEventLibrary.closeMedia();
    };
    mounted = cleanup;
    render();
    return { setItems, refresh, unmount: cleanup };
  }
  function unmount() {
    mounted?.();
    mounted = null;
  }
  return { recordingPage, mount, unmount };
});
