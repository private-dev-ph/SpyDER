"use strict";
(() => {
  function workflowPage(
    items,
    {
      query = "",
      status = "",
      mode = "",
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
      const executionMode =
        item.execution_mode ||
        (item.execution?.allow_calls
          ? item.execution?.run_independently === false
            ? "callable"
            : "both"
          : "independent");
      if (
        mode === "independent" &&
        !["independent", "both"].includes(executionMode)
      )
        return false;
      if (mode === "callable" && !["callable", "both"].includes(executionMode))
        return false;
      if (mode === "both" && executionMode !== "both") return false;
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
      engines = new Set(),
      callIds = new Set();
    for (const node of nodes) {
      if (node.type === "camera" && node.params?.camera_id)
        cameras.add(String(node.params.camera_id));
      if (
        node.type === "detections" &&
        node.params?.engine &&
        node.params.engine !== "any"
      )
        engines.add(String(node.params.engine));
      if (node.params?.subflow_id) callIds.add(String(node.params.subflow_id));
    }
    const execution = graph?.execution || {};
    const runIndependently = execution.run_independently !== false;
    const allowCalls = execution.allow_calls === true;
    return {
      id: String(graph?.id || ""),
      name: String(graph?.name || "Untitled workflow"),
      enabled: !!graph?.enabled,
      camera_ids: [...cameras].sort(),
      engines: [...engines].sort(),
      node_count: nodes.length,
      edge_count: (graph?.edges || []).length,
      execution_mode: allowCalls
        ? runIndependently
          ? "both"
          : "callable"
        : "independent",
      callable_version: Number(graph?.callable_version) || 0,
      call_ids: [...callIds].sort(),
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
    dialog.innerHTML = `<div class="wm-shell" aria-busy="false"><header class="wm-header"><div><h2 id="wm-title">Workflows</h2><p class="wm-summary" aria-live="polite">Loading workflows…</p></div><button type="button" class="wm-close" aria-label="Close workflow manager"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#close"></use></svg></button></header><div class="wm-toolbar"><label class="wm-search">Search workflows<input type="search" name="query" autocomplete="off" placeholder="Find a workflow…"></label><label>Status<select name="status"><option value="">All statuses</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option><option value="empty">Empty drafts</option></select></label><label>Camera<select name="camera"><option value="">All cameras</option></select></label><label>Engine<select name="engine"><option value="">All engines</option></select></label><label>Sort<select name="sort"><option value="name">Name A–Z</option><option value="name_desc">Name Z–A</option><option value="enabled">Enabled first</option></select></label><button type="button" class="wm-primary" data-create>New workflow</button></div><p class="wm-error" role="alert" tabindex="-1" hidden></p><p class="wm-activity" role="status" aria-live="polite"></p><section class="wm-list" aria-label="Workflow results" tabindex="0"><div class="wm-rows"></div></section><footer class="wm-footer"><span class="wm-range"></span><div><button type="button" data-prev>Previous</button><span class="wm-page"></span><button type="button" data-next>Next</button><label>Rows<select name="size"><option>25</option><option>50</option></select></label></div></footer><section class="wm-toggle-confirm" hidden role="alertdialog" aria-labelledby="wm-toggle-title"><h3 id="wm-toggle-title">Review camera changes</h3><p></p><ul></ul><div><button type="button" data-cancel-toggle>Cancel</button><button type="button" class="wm-primary" data-confirm-toggle>Enable saved workflow</button></div></section><section class="wm-guard" hidden role="alertdialog" aria-labelledby="wm-guard-title"><h3 id="wm-guard-title">Unsaved workflow edits</h3><p>Continuing will discard your current draft.</p><div><button type="button" data-keep>Keep editing</button><button type="button" class="wm-danger" data-discard>Discard edits &amp; continue</button></div></section><section class="wm-delete-confirm" hidden role="alertdialog" aria-labelledby="wm-delete-title"><h3 id="wm-delete-title"></h3><p></p><div><button type="button" data-cancel-delete>Cancel</button><button type="button" class="wm-danger" data-confirm-delete>Delete workflow</button></div></section></div>`;
    const toolbar = dialog.querySelector(".wm-toolbar");
    toolbar.insertAdjacentHTML(
      "beforeend",
      '<label>Execution<select name="mode"><option value="">All</option><option value="independent">Independent</option><option value="callable">Callable</option><option value="both">Both</option></select></label><button type="button" data-create-callable>New callable workflow</button>',
    );
    doc.body.append(dialog);
    const q = (s) => dialog.querySelector(s);
    let closed = false,
      timer = 0,
      controller = null,
      page = 1,
      rows = [],
      pending = null,
      busy = false,
      toggleReview = null;
    const filters = () => ({
      query: q('[name="query"]').value,
      status: q('[name="status"]').value,
      mode: q('[name="mode"]').value,
      camera: q('[name="camera"]').value,
      engine: q('[name="engine"]').value,
      sort: q('[name="sort"]').value,
      size: Number(q('[name="size"]').value),
      page,
    });
    q('[name="mode"]').value = callbacks.initialMode || "";
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
        "[data-action], [data-create], [data-create-callable], .wm-rename button",
      )) {
        const item = rows.find((row) => row.id === button.dataset.id);
        const mode = item?.execution_mode || "independent";
        button.disabled =
          value ||
          (button.dataset.action === "toggle" &&
            mode === "callable") ||
          (button.dataset.action === "call" &&
            !(Number(item?.callable_version) > 0)) ||
          (button.dataset.action === "publish" &&
            !!(callbacks.isDirty?.() && callbacks.currentId?.() === item?.id));
      }
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
          .map((item) => {
            const mode = item.execution_mode || "independent";
            const callable = mode === "callable" || mode === "both";
            const independent = mode !== "callable";
            const dirty =
              callbacks.isDirty?.() && callbacks.currentId?.() === item.id;
        return `<article class="wm-row ${callbacks.currentId?.() === item.id ? "is-current" : ""}" data-id="${esc(item.id)}"><div class="wm-main"><strong>${esc(item.name || "Untitled workflow")}</strong>${callbacks.currentId?.() === item.id ? '<span class="wm-current">Editing</span>' : ""}<code>${esc(item.id)}</code><span class="wm-mode mode-${esc(mode)}">${mode === "both" ? "Independent + callable" : mode === "callable" ? "Callable only" : "Independent"}</span><span class="wm-status ${item.enabled && independent ? "is-enabled" : "is-disabled"}">Independent trigger ${item.enabled && independent ? "enabled" : "disabled"}</span>${callable ? `<span class="wm-callable-meta">Callable v${Number(item.callable_version) || "—"} · ${Number(item.caller_count) || 0} callers</span>` : ""}</div><div class="wm-meta"><span>Camera: ${esc((item.camera_ids || []).map((id) => callbacks.cameras?.().find((c) => c.id === id)?.name || id).join(", ") || "None")}</span><span>Engines: ${esc((item.engines || []).join(", ") || "None")}</span><span>${Number(item.node_count) || 0} nodes · ${Number(item.edge_count) || 0} connections</span></div><div class="wm-actions">${independent ? `<button type="button" class="${item.enabled ? "wm-primary" : ""}" data-action="toggle" data-id="${esc(item.id)}" aria-label="${item.enabled ? "Disable" : "Enable"} independent trigger for ${esc(item.name || item.id)}">${item.enabled ? "Disable" : "Enable"}</button>` : '<span class="wm-trigger-note">Callable only</span>'}${callable ? `<button type="button" data-action="call" data-id="${esc(item.id)}" ${Number(item.callable_version) > 0 ? "" : 'disabled title="Publish a callable version first"'}>Use in workflow</button>` : ""}<button type="button" data-action="open" data-id="${esc(item.id)}">Open</button><details><summary aria-label="More actions for ${esc(item.name || item.id)}">More</summary><div>${callable ? `<button type="button" data-action="publish" data-id="${esc(item.id)}" ${dirty ? 'disabled title="Save workflow before publishing"' : ""}>Publish callable version</button>` : ""}<button type="button" data-action="rename" data-id="${esc(item.id)}">Rename</button><button type="button" data-action="duplicate" data-id="${esc(item.id)}">Duplicate</button><button type="button" data-action="export" data-id="${esc(item.id)}">Export</button><button type="button" class="wm-danger" data-action="delete" data-id="${esc(item.id)}">Delete</button></div></details></div></article>`;
          })
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
    function confirmToggle(review) {
      if (closed) return Promise.resolve(false);
      const section = q(".wm-toggle-confirm");
      section.querySelector("p").textContent =
        `Enabling ${review.name} changes these cameras. Only the saved workflow will run; unsaved edits remain in the editor.`;
      const list = section.querySelector("ul");
      list.replaceChildren();
      for (const camera of review.cameras || []) {
        const row = doc.createElement("li");
        row.textContent = `${camera.name || camera.id}: ${camera.disable_motion ? "motion analysis will be disabled" : "Motion pipeline will be replaced"}${camera.target_engine ? " · " + camera.target_engine : ""}`;
        list.append(row);
      }
      guard(".wm-toggle-confirm", true);
      return new Promise((resolve) => {
        toggleReview = resolve;
        const finish = (value) => {
          guard(".wm-toggle-confirm", false);
          toggleReview = null;
          resolve(value);
        };
        q("[data-cancel-toggle]").onclick = () => finish(false);
        q("[data-confirm-toggle]").onclick = () => finish(true);
        q("[data-cancel-toggle]").focus();
      });
    }
    async function toggle(item) {
      if (!item || busy || closed || !callbacks.onToggle)
        return;
      error();
      setBusy(true);
      try {
        const result = await callbacks.onToggle(
          item.id,
          !item.enabled,
          confirmToggle,
        );
        if (!closed && result !== false) await refresh();
      } catch (e) {
        if (!closed)
          error(e?.message || "Workflow state could not be changed.");
      } finally {
        if (!closed) {
          setBusy(false);
          if (q(".wm-error").hidden) {
            const target = [
              ...dialog.querySelectorAll('[data-action="toggle"]'),
            ].find((button) => button.dataset.id === item.id);
            (target || q(".wm-list")).focus();
          }
        }
      }
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
          name === "onCall" ||
          name === "onCreate" ||
          name === "onCreateCallable" ||
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
      toggleReview?.(false);
      toggleReview = null;
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
    for (const field of ["status", "mode", "camera", "engine", "sort", "size"])
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
    q("[data-create-callable]").addEventListener("click", () =>
      proceed("onCreateCallable"),
    );
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
      if (action === "toggle")
        return toggle(rows.find((item) => item.id === id));
      if (action === "open") return proceed("onOpen", id);
      if (action === "call") return act("onCall", id);
      if (action === "publish") return act("onPublish", id);
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
