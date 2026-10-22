"use strict";
(() => {
  function workflowPage(
    items,
    {
      query = "",
      status = "",
      camera = "",
      engine = "",
      sort = "name",
      page = 1,
      size = 25,
    } = {},
  ) {
    const words = String(query)
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const filtered = items.filter((item) => {
      if (
        (status === "enabled" && !item.enabled) ||
        (status === "disabled" && item.enabled) ||
        (status === "empty" && item.node_count !== 0)
      )
        return false;
      if (camera && !(item.camera_ids || []).includes(camera)) return false;
      if (engine && !(item.engines || []).includes(engine)) return false;
      const text = [
        item.name,
        item.id,
        ...(item.camera_ids || []),
        ...(item.engines || []),
      ]
        .join(" ")
        .toLowerCase();
      return words.every((word) => text.includes(word));
    });
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const byName = (a, b) =>
      cmp(
        String(a.name || "").toLowerCase(),
        String(b.name || "").toLowerCase(),
      ) || cmp(String(a.id), String(b.id));
    if (sort === "name_desc")
      filtered.sort(
        (a, b) =>
          cmp(
            String(b.name || "").toLowerCase(),
            String(a.name || "").toLowerCase(),
          ) || cmp(String(a.id), String(b.id)),
      );
    else if (sort === "enabled")
      filtered.sort(
        (a, b) => Number(b.enabled) - Number(a.enabled) || byName(a, b),
      );
    else filtered.sort(byName);
    size = Math.max(1, Math.min(50, Math.floor(Number(size)) || 25));
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    page = Math.max(1, Math.min(pages, Math.floor(Number(page)) || 1));
    return {
      items: filtered.slice((page - 1) * size, page * size),
      page,
      pages,
      total: filtered.length,
      size,
      counts: workflowCounts(items),
    };
  }
  function workflowCounts(items) {
    return items.reduce(
      (counts, item) => {
        counts.total++;
        counts[item.enabled ? "enabled" : "disabled"]++;
        return counts;
      },
      { total: 0, enabled: 0, disabled: 0 },
    );
  }
  function summarizeWorkflow(graph) {
    const nodes = graph?.nodes || [],
      cameras = new Set(graph?.camera_ids || []),
      engines = new Set();
    for (const node of nodes) {
      if (node.type === "camera" && node.params?.camera_id)
        cameras.add(String(node.params.camera_id));
      if (
        node.type === "detections" &&
        node.params?.engine &&
        node.params.engine !== "any"
      )
        engines.add(String(node.params.engine));
    }
    return {
      id: String(graph?.id || ""),
      name: String(graph?.name || "Untitled workflow"),
      enabled: !!graph?.enabled,
      camera_ids: [...cameras].sort(),
      engines: [...engines].sort(),
      node_count: nodes.length,
      edge_count: (graph?.edges || []).length,
    };
  }
  const summarize = workflowCounts;
  const esc = (value) =>
    String(value ?? "").replace(
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
  const api = { workflowPage, workflowCounts, summarizeWorkflow, summarize };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window === "undefined" || !window.document) return;
  const doc = window.document;
  function open(options = {}) {
    const callbacks = options;
    const opener = callbacks.opener || doc.activeElement;
    const dialog = doc.createElement("dialog");
    dialog.className = "workflow-manager";
    dialog.setAttribute("aria-labelledby", "wm-title");
    dialog.innerHTML = `<div class="wm-shell" aria-busy="false"><header class="wm-header"><div><h2 id="wm-title">Workflows</h2><p class="wm-summary" aria-live="polite">Loading workflows…</p></div><button type="button" class="wm-close" aria-label="Close workflow manager"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#close"></use></svg></button></header><div class="wm-toolbar"><label class="wm-search">Search workflows<input type="search" name="query" autocomplete="off" placeholder="Find a workflow…"></label><label>Status<select name="status"><option value="">All statuses</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option><option value="empty">Empty drafts</option></select></label><label>Camera<select name="camera"><option value="">All cameras</option></select></label><label>Engine<select name="engine"><option value="">All engines</option></select></label><label>Sort<select name="sort"><option value="name">Name A–Z</option><option value="name_desc">Name Z–A</option><option value="enabled">Enabled first</option></select></label><button type="button" class="wm-primary" data-create>New workflow</button></div><p class="wm-error" role="alert" tabindex="-1" hidden></p><p class="wm-activity" role="status" aria-live="polite"></p><section class="wm-list" aria-label="Workflow results" tabindex="0"><div class="wm-rows"></div></section><footer class="wm-footer"><span class="wm-range"></span><div><button type="button" data-prev>Previous</button><span class="wm-page"></span><button type="button" data-next>Next</button><label>Rows<select name="size"><option>25</option><option>50</option></select></label></div></footer><section class="wm-guard" hidden role="alertdialog" aria-labelledby="wm-guard-title"><h3 id="wm-guard-title">Unsaved workflow edits</h3><p>Continuing will discard your current draft.</p><div><button type="button" data-keep>Keep editing</button><button type="button" class="wm-danger" data-discard>Discard edits &amp; continue</button></div></section><section class="wm-delete-confirm" hidden role="alertdialog" aria-labelledby="wm-delete-title"><h3 id="wm-delete-title"></h3><p></p><div><button type="button" data-cancel-delete>Cancel</button><button type="button" class="wm-danger" data-confirm-delete>Delete workflow</button></div></section></div>`;
    doc.body.append(dialog);
    const q = (s) => dialog.querySelector(s);
    let closed = false,
      timer = 0,
      controller = null,
      page = 1,
      rows = [],
      pending = null,
      busy = false;
    const filters = () => ({
      query: q('[name="query"]').value,
      status: q('[name="status"]').value,
      camera: q('[name="camera"]').value,
      engine: q('[name="engine"]').value,
      sort: q('[name="sort"]').value,
      size: Number(q('[name="size"]').value),
      page,
    });
    function error(message = "") {
      const box = q(".wm-error");
      box.textContent = message;
      box.hidden = !message;
      if (message) box.focus();
    }
    function setBusy(value) {
      busy = value;
      q(".wm-shell").setAttribute("aria-busy", String(value));
      q(".wm-activity").textContent = value ? "Saving workflow changes…" : "";
      for (const button of dialog.querySelectorAll(
        "[data-action], [data-create], .wm-rename button",
      ))
        button.disabled = value;
    }
    function guard(selector, visible) {
      q(selector).hidden = !visible;
      for (const area of dialog.querySelectorAll(
        ".wm-toolbar,.wm-list,.wm-footer",
      ))
        area.inert = visible;
    }
    function showDelete(item) {
      if (!item?.id) return;
      const focusReturn = doc.activeElement;
      const section = q(".wm-delete-confirm"),
        draft =
          callbacks.isDirty?.() && callbacks.currentId?.() === item.id
            ? " Your current unsaved draft will also be lost."
            : "";
      section.querySelector("h3").textContent =
        `Delete ${item.name || "this workflow"}?`;
      section.querySelector("p").textContent =
        `This permanently deletes the workflow. If enabled, its camera actions stop immediately.${draft}`;
      guard(".wm-delete-confirm", true);
      section.querySelector("[data-confirm-delete]").focus();
      section.querySelector("[data-cancel-delete]").onclick = () => {
        guard(".wm-delete-confirm", false);
        focusReturn?.focus?.();
      };
      section.querySelector("[data-confirm-delete]").onclick = async () => {
        guard(".wm-delete-confirm", false);
        await act("onDelete", item.id);
      };
    }
    function populateOptions(select, entries, label) {
      const value = select.value;
      select.replaceChildren(
        new Option(label, ""),
        ...entries.map(
          (entry) => new Option(entry.name || entry, entry.id || entry),
        ),
      );
      if ([...select.options].some((o) => o.value === value))
        select.value = value;
    }
    function paint(result) {
      rows = result.items || [];
      page = result.page || page;
      const counts = result.counts || {
        total: result.total,
        enabled: rows.filter((x) => x.enabled).length,
        disabled: rows.filter((x) => !x.enabled).length,
      };
      q(".wm-summary").textContent =
        `${counts.total} workflows · ${counts.enabled} enabled · ${counts.disabled} disabled${result.storage_error ? ` · ${result.storage_error}` : ""}`;
      q(".wm-range").textContent = result.total
        ? `${(page - 1) * result.size + 1}–${Math.min(page * result.size, result.total)} of ${result.total}`
        : "No workflows found";
      q(".wm-page").textContent = `Page ${page} of ${result.pages}`;
      q("[data-prev]").disabled = page <= 1;
      q("[data-next]").disabled = page >= result.pages;
      q(".wm-rows").innerHTML =
        rows
          .map(
            (item) =>
              `<article class="wm-row ${callbacks.currentId?.() === item.id ? "is-current" : ""}" data-id="${esc(item.id)}"><div class="wm-main"><strong>${esc(item.name || "Untitled workflow")}</strong>${callbacks.currentId?.() === item.id ? '<span class="wm-current">Editing</span>' : ""}<code>${esc(item.id)}</code><span class="wm-status ${item.enabled ? "is-enabled" : "is-disabled"}">${item.enabled ? "Enabled" : "Disabled"}</span></div><div class="wm-meta"><span>Camera: ${esc((item.camera_ids || []).map((id) => callbacks.cameras?.().find((c) => c.id === id)?.name || id).join(", ") || "None")}</span><span>Engines: ${esc((item.engines || []).join(", ") || "None")}</span><span>${Number(item.node_count) || 0} nodes · ${Number(item.edge_count) || 0} connections</span></div><div class="wm-actions"><button type="button" data-action="open" data-id="${esc(item.id)}">Open</button><details><summary aria-label="More actions for ${esc(item.name || item.id)}">More</summary><div><button type="button" data-action="rename" data-id="${esc(item.id)}">Rename</button><button type="button" data-action="duplicate" data-id="${esc(item.id)}">Duplicate</button><button type="button" data-action="export" data-id="${esc(item.id)}">Export</button><button type="button" class="wm-danger" data-action="delete" data-id="${esc(item.id)}">Delete</button></div></details></div></article>`,
          )
          .join("") ||
        `<p class="wm-empty">${filters().query ? "No workflows match this search." : "No workflows yet."}</p>`;
    }
    async function refresh() {
      if (closed || typeof callbacks.loadPage !== "function") return;
      if (controller) controller.abort();
      controller = new AbortController();
      const own = controller;
      const params = filters();
      error();
      try {
        const result = await callbacks.loadPage(params, { signal: own.signal });
        if (closed || own !== controller || own.signal.aborted) return;
        paint(result);
      } catch (e) {
        if (!closed && own === controller && !own.signal.aborted)
          error(e?.message || "Could not load workflows. Try again.");
      }
    }
    function queueSearch() {
      clearTimeout(timer);
      page = 1;
      timer = setTimeout(refresh, 200);
    }
    async function act(name, id) {
      const fn = callbacks[name];
      if (!fn || busy || closed) return;
      error();
      setBusy(true);
      try {
        const result = await fn(id);
        if (closed || result === false) return;
        if (
          name === "onOpen" ||
          name === "onCreate" ||
          name === "onDuplicate"
        ) {
          if (result === true) close();
          return;
        }
        if (name === "onDelete") {
          await refresh();
          return;
        }
        if (name !== "onExport") await refresh();
      } catch (e) {
        if (!closed) error(e?.message || "Action failed. Try again.");
      } finally {
        if (!closed) setBusy(false);
      }
    }
    function proceed(action, id) {
      if (callbacks.isDirty?.()) {
        pending = { action, id };
        guard(".wm-guard", true);
        q("[data-keep]").focus();
        return;
      }
      void act(action, id);
    }
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      controller?.abort();
      dialog.close();
      dialog.remove();
      try {
        callbacks.onClose?.();
      } finally {
        const target = opener?.isConnected
          ? opener
          : doc.querySelector("[data-workflow-selector], [data-workflow]");
        target?.focus?.();
      }
    }
    dialog.addEventListener("close", () => {
      if (!closed) close();
    });
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      close();
    });
    q(".wm-close").addEventListener("click", (e) => {
      e.preventDefault();
      close();
    });
    q('[name="query"]').addEventListener("input", queueSearch);
    for (const field of ["status", "camera", "engine", "sort", "size"])
      q(`[name="${field}"]`).addEventListener("change", () => {
        page = 1;
        void refresh();
      });
    q("[data-prev]").addEventListener("click", () => {
      page--;
      void refresh();
    });
    q("[data-next]").addEventListener("click", () => {
      page++;
      void refresh();
    });
    q("[data-create]").addEventListener("click", () => proceed("onCreate"));
    q("[data-keep]").addEventListener("click", () => {
      pending = null;
      close();
      callbacks.onKeepEditing?.();
    });
    q("[data-discard]").addEventListener("click", () => {
      const next = pending;
      pending = null;
      guard(".wm-guard", false);
      if (next) void act(next.action, next.id);
    });
    q(".wm-rows").addEventListener("click", async (e) => {
      const button = e.target.closest("[data-action]");
      if (!button || busy || closed) return;
      const { action, id } = button.dataset;
      if (action === "open") return proceed("onOpen", id);
      if (action === "duplicate") return proceed("onDuplicate", id);
      if (action === "delete") {
        showDelete(rows.find((x) => x.id === id));
        return;
      }
      if (action === "export") return act("onExport", id);
      if (action === "rename") {
        const item = rows.find((x) => x.id === id),
          row = button.closest(".wm-row"),
          main = row.querySelector(".wm-main");
        main.innerHTML = `<form class="wm-rename"><label>Workflow name<input maxlength="128" required value="${esc(item?.name || "")}"></label><button type="submit">Save name</button><button type="button" data-cancel-rename>Cancel</button></form>`;
        const input = main.querySelector("input");
        input.focus();
        input.select();
        main.querySelector("[data-cancel-rename]").onclick = () => {
          void refresh();
        };
        main.querySelector("form").onsubmit = async (ev) => {
          ev.preventDefault();
          if (busy || closed) return;
          const name = input.value.trim();
          if (!name) {
            input.setCustomValidity("Enter a workflow name.");
            input.reportValidity();
            return;
          }
          setBusy(true);
          try {
            const result = await callbacks.onRename?.(id, name);
            if (closed || result === false) return;
            await refresh();
          } catch (err) {
            if (!closed) error(err?.message || "Rename failed. Try again.");
          } finally {
            if (!closed) setBusy(false);
          }
        };
      }
    });
    const cameras = callbacks.cameras?.() || [];
    populateOptions(q('[name="camera"]'), cameras, "All cameras");
    const engines = [
      ...new Set(
        (callbacks.engines || ["opencv", "yolo", "insightface"]).map(String),
      ),
    ];
    populateOptions(q('[name="engine"]'), engines, "All engines");
    dialog.showModal();
    q('[name="query"]').focus();
    void refresh();
    if (callbacks.initialDelete) showDelete(callbacks.initialDelete);
    return {
      close,
      refresh,
      get element() {
        return dialog;
      },
    };
  }
  api.open = open;
  window.spyderWorkflowManager = api;
})();
