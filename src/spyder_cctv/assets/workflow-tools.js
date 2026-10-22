"use strict";
(() => {
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
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const stable = (value) =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    );
  const SUBFLOWS_KEY = "spyder.workflow.subflows.v1";
  let editor = {},
    catalogError = "",
    remoteCatalog = null;
  const demo = () => !!window.spyderShowcase;
  async function request(url, options) {
    const method = String(options?.method || "GET").toUpperCase();
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      headers: {
        ...(options?.headers || {}),
        ...(method === "POST" ? { "X-Spyder-Control": "1" } : {}),
      },
    });
    const data = await response.json();
    if (!response.ok)
      throw Error(data.error || "Workflow tools request failed.");
    return data;
  }
  async function subflows() {
    catalogError = "";
    if (demo()) {
      try {
        const stored = JSON.parse(localStorage.getItem(SUBFLOWS_KEY) || "[]"),
          latest = new Map();
        for (const item of stored) {
          const prior = latest.get(item.id);
          if (!prior || Number(item.version) > Number(prior.version))
            latest.set(item.id, {
              ...item,
              versions: stored
                .filter((version) => version.id === item.id)
                .map((version) => Number(version.version))
                .sort((a, b) => a - b),
            });
        }
        return [...latest.values()];
      } catch (error) {
        catalogError = `Browser subflow storage is invalid: ${error.message}`;
        return [];
      }
    }
    if (remoteCatalog) return remoteCatalog;
    const data = await request("/api/workflows/subflows");
    catalogError = data.storage_error || "";
    remoteCatalog = data.subflows || [];
    return remoteCatalog;
  }
  async function getSubflow(id, version) {
    const items = await subflows();
    const latest = items.find((item) => item.id === id);
    if (demo()) {
      try {
        return JSON.parse(localStorage.getItem(SUBFLOWS_KEY) || "[]").find(
          (item) => item.id === id && Number(item.version) === Number(version),
        );
      } catch (error) {
        throw Error(`Browser subflow storage is invalid: ${error.message}`);
      }
    }
    if (latest && Number(latest.version) === Number(version)) return latest;
    const data = await request(
      `/api/workflows/subflows/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`,
    );
    return data.subflow || data.definition || data;
  }
  async function historyPage(filters) {
    if (demo())
      return {
        runs: [],
        total: 0,
        page: 0,
        pages: 1,
        size: filters.size || 25,
        stats: {},
        settings: {},
        demo: true,
      };
    const normalized = { ...filters };
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized.until || ""))
      normalized.until = `${normalized.until}T23:59:59.999Z`;
    const query = new URLSearchParams(
      Object.entries(normalized).filter(([, v]) => v !== "" && v != null),
    );
    return request(`/api/workflows/history?${query}`);
  }
  async function exportBundle(workflow) {
    if (demo()) {
      const definitions = await subflows();
      const byKey = new Map(
        definitions.map((item) => [`${item.id}@${item.version}`, item]),
      );
      const included = new Map(),
        visiting = new Set();
      const collect = (graph) => {
        for (const node of graph.nodes || [])
          if (node.type === "subflow") {
            const key = `${node.params.subflow_id}@${node.params.version}`;
            if (visiting.has(key))
              throw Error("Subflow dependency cycle prevents bundle export.");
            if (included.has(key)) continue;
            const definition = byKey.get(key);
            if (!definition)
              throw Error(
                `Pinned subflow ${key} is unavailable in this browser.`,
              );
            visiting.add(key);
            included.set(key, clone(definition));
            collect(definition.graph);
            visiting.delete(key);
          }
      };
      collect(workflow);
      return {
        format: "spyder-workflow-bundle",
        version: 1,
        workflow: clone(workflow),
        subflows: [...included.values()],
      };
    }
    return request("/api/workflows/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow }),
    });
  }
  async function importBundle(text) {
    if (new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024)
      throw Error("Workflow bundle exceeds 32 MiB.");
    const bundle = JSON.parse(text);
    if (
      bundle.format !== "spyder-workflow-bundle" ||
      bundle.version !== 1 ||
      !bundle.workflow ||
      !Array.isArray(bundle.subflows) ||
      bundle.subflows.length > 50000
    )
      throw Error("Invalid workflow bundle.");
    if (demo()) {
      const existing = JSON.parse(localStorage.getItem(SUBFLOWS_KEY) || "[]");
      if (catalogError) throw Error(catalogError);
      validateBundle(bundle);
      const byVersion = new Map(
        existing.map((item) => [`${item.id}@${item.version}`, item]),
      );
      for (const item of bundle.subflows) {
        const key = `${item.id}@${item.version}`,
          prior = byVersion.get(key);
        if (prior && stable(prior) !== stable(item))
          throw Error(`Subflow version conflict: ${key}.`);
        byVersion.set(key, item);
      }
      localStorage.setItem(
        SUBFLOWS_KEY,
        JSON.stringify([...byVersion.values()]),
      );
      const workflow = clone(bundle.workflow);
      workflow.enabled = false;
      return workflow;
    }
    const result = await request("/api/workflows/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundle }),
    });
    return result.workflow || bundle.workflow;
  }
  function validateBundle(bundle) {
    const definitions = new Map();
    for (const item of bundle.subflows) {
      const key = `${item?.id}@${item?.version}`;
      if (
        !item?.id ||
        !Number.isInteger(item.version) ||
        item.version < 1 ||
        item.version > 100 ||
        definitions.has(key) ||
        !item.graph ||
        !Array.isArray(item.graph.nodes) ||
        !Array.isArray(item.graph.edges)
      )
        throw Error("Invalid or duplicate subflow definition in bundle.");
      if (
        item.graph.enabled !== false ||
        (item.graph.camera_ids || []).length ||
        item.graph.nodes.filter((node) => node.type === "subflow_input")
          .length !== 1 ||
        item.graph.nodes.filter((node) => node.type === "subflow_output")
          .length !== 1
      )
        throw Error(`Invalid subflow graph: ${key}.`);
      definitions.set(key, item);
    }
    const active = new Set(),
      done = new Set();
    const visit = (graph, depth = 0) => {
      if (depth > 4) throw Error("Subflow nesting exceeds four levels.");
      if (
        !Array.isArray(graph.nodes) ||
        graph.nodes.length > 64 ||
        !Array.isArray(graph.edges) ||
        graph.edges.length > 128
      )
        throw Error("Workflow graph exceeds node or connection limits.");
      const ids = new Set(graph.nodes.map((node) => node.id));
      if (
        ids.size !== graph.nodes.length ||
        graph.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))
      )
        throw Error(
          "Workflow contains duplicate nodes or missing connections.",
        );
      const incoming = new Map([...ids].map((id) => [id, 0]));
      for (const edge of graph.edges)
        incoming.set(edge.to, incoming.get(edge.to) + 1);
      const pending = [...ids].filter((id) => !incoming.get(id));
      for (let i = 0; i < pending.length; i++)
        for (const edge of graph.edges.filter(
          (edge) => edge.from === pending[i],
        )) {
          incoming.set(edge.to, incoming.get(edge.to) - 1);
          if (!incoming.get(edge.to)) pending.push(edge.to);
        }
      if (pending.length !== ids.size)
        throw Error("Workflow contains a connection cycle.");
      for (const node of graph.nodes || [])
        if (node.type === "subflow") {
          const key = `${node.params?.subflow_id}@${node.params?.version}`;
          if (!definitions.has(key))
            throw Error(`Missing subflow dependency ${key}.`);
          if (active.has(key))
            throw Error("Subflow dependency cycle in bundle.");
          if (!done.has(`${key}/${depth}`)) {
            active.add(key);
            visit(definitions.get(key).graph, depth + 1);
            active.delete(key);
            done.add(`${key}/${depth}`);
          }
        }
    };
    visit(bundle.workflow);
    for (const definition of definitions.values()) visit(definition.graph, 1);
    return true;
  }
  function modal(markup, onClose, replace = true) {
    if (replace)
      document.querySelector("[data-workflow-tools-modal]")?.remove();
    const returnFocus = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "wt-backdrop";
    wrap.dataset.workflowToolsModal = "";
    wrap.innerHTML = markup.replaceAll(
      "data-wt-close>Close</button>",
      'data-wt-close aria-label="Close dialog"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#close"/></svg></button>',
    );
    const close = () => {
      wrap.remove();
      onClose?.();
      returnFocus?.focus?.({ preventScroll: true });
    };
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap || event.target.closest("[data-wt-close]"))
        close();
    });
    wrap.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [
        ...wrap.querySelectorAll(
          "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]",
        ),
      ];
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items.at(-1).focus();
      } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault();
        items[0].focus();
      }
    });
    document.body.append(wrap);
    wrap.querySelector("input,button")?.focus();
    return { wrap, close };
  }
  async function openSubflows() {
    let entries = [];
    try {
      entries = await subflows();
    } catch (error) {
      catalogError = error.message;
    }
    let query = "";
    const show = () => {
      const view = modal(
        `<section class="wt-dialog" role="dialog" aria-modal="true" aria-labelledby="wt-subflows-title"><header><div><p class="eyebrow">REUSABLE WORKFLOWS</p><h2 id="wt-subflows-title">Subflows</h2></div><button class="button secondary" data-wt-close>Close</button></header><p>${demo() ? "Showcase subflows stay in this browser. Imports and exports work locally." : "Published versions stay immutable. Review upgrades before selecting a newer version."}</p>${catalogError ? `<p class="wt-error" role="alert">Subflow library could not load: ${esc(catalogError)}</p>` : ""}<label>Search subflows<input type="search" data-wt-search placeholder="Name or description" value="${esc(query)}"></label><div class="wt-list">${entries.map((item) => `<article data-wt-search-row="${esc(`${item.name} ${item.description} ${item.id} v${(item.versions || [item.version]).join(" ")}`.toLowerCase())}"><div><h3>${esc(item.name)} <small>v${esc(item.version)}</small></h3><p>${esc(item.description || "No description")}</p><small>${esc(item.id)} · ${item.parameters?.length || 0} parameters</small></div><label>Version<select data-wt-version="${esc(item.id)}">${(item.versions || [item.version]).map((version) => `<option value="${esc(version)}" ${Number(version) === Number(item.version) ? "selected" : ""}>v${esc(version)}${Number(version) === Number(item.version) ? " · latest" : ""}</option>`).join("")}</select></label><button class="button secondary" data-wt-edit="${esc(item.id)}">Open / Edit</button><button class="button secondary" data-wt-delete="${esc(item.id)}">Delete</button></article>`).join("") || ""}<p class="wt-empty" data-wt-empty ${entries.length ? "hidden" : ""}>${catalogError ? "Library unavailable." : "No published subflows yet. Start a subflow draft to create one."}</p></div><footer><button class="button secondary" data-wt-new>Start new subflow draft</button><button class="button secondary" data-wt-export>Export definitions</button><label class="button secondary wt-file-label">Import definitions<input type="file" data-wt-import accept="application/json,.json" hidden></label><button class="button primary" data-wt-publish>Publish current draft…</button></footer><p class="wt-status" role="status"></p></section>`,
      );
      const status = view.wrap.querySelector(".wt-status");
      view.wrap
        .querySelector("[data-wt-search]")
        .addEventListener("input", (event) => {
          query = event.target.value.toLowerCase().trim();
          let count = 0;
          view.wrap.querySelectorAll("[data-wt-search-row]").forEach((row) => {
            row.hidden = !row.dataset.wtSearchRow.includes(query);
            if (!row.hidden) count++;
          });
          view.wrap.querySelector("[data-wt-empty]").hidden = count > 0;
          status.textContent = `${count} subflows shown.`;
        });
      view.wrap.querySelectorAll("[data-wt-edit]").forEach((button) =>
        button.addEventListener("click", () => {
          const item = entries.find(
              (value) => value.id === button.dataset.wtEdit,
            ),
            version = Number(
              [...view.wrap.querySelectorAll("[data-wt-version]")].find(
                (select) => select.dataset.wtVersion === button.dataset.wtEdit,
              )?.value || item?.version,
            );
          if (item)
            getSubflow(item.id, version)
              .then((definition) => {
                if (!definition) throw Error("Subflow version is unavailable.");
                view.close();
                editor.currentDefinition = clone(definition);
                editor.subflowId = item.id;
                editor.onEdit?.(clone(definition));
              })
              .catch((error) => {
                status.textContent = error.message;
              });
        }),
      );
      view.wrap.querySelectorAll("[data-wt-delete]").forEach((button) =>
        button.addEventListener("click", async () => {
          if (
            !window.confirm(
              "Delete this subflow and all its versions? Referenced versions will be protected.",
            )
          )
            return;
          try {
            if (demo()) {
              const stored = await subflows();
              if (catalogError) throw Error(catalogError);
              const rest = stored.filter(
                (item) => item.id !== button.dataset.wtDelete,
              );
              localStorage.setItem(SUBFLOWS_KEY, JSON.stringify(rest));
            } else {
              await request(
                `/api/workflows/subflows/${encodeURIComponent(button.dataset.wtDelete)}/remove`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: "{}",
                },
              );
              remoteCatalog = null;
            }
            view.close();
            openSubflows();
          } catch (error) {
            status.textContent = error.message;
          }
        }),
      );
      view.wrap
        .querySelector("[data-wt-publish]")
        .addEventListener("click", () => {
          view.close();
          publishDialog(editor.getGraph?.(), editor.currentDefinition);
        });
      view.wrap.querySelector("[data-wt-new]").addEventListener("click", () => {
        view.close();
        const makeNode = (type, x) => ({
          id: `node-${Math.random().toString(36).slice(2, 10)}`,
          type,
          x,
          y: 140,
          params: {},
        });
        const input = makeNode("subflow_input", 80),
          output = makeNode("subflow_output", 360);
        editor.subflowId = undefined;
        editor.currentDefinition = null;
        editor.onCreateSubflow?.({
          id: `workflow-${Date.now().toString(36)}`,
          name: "New subflow",
          enabled: false,
          camera_ids: [],
          nodes: [input, output],
          edges: [{ from: input.id, to: output.id }],
        });
      });
      view.wrap
        .querySelector("[data-wt-export]")
        .addEventListener("click", async () => {
          try {
            if (!demo()) {
              download(
                await request("/api/workflows/subflows/export"),
                "spyder-subflows.json",
              );
              return;
            }

            const definitions = [];
            for (const item of entries)
              for (const version of item.versions || [item.version])
                definitions.push(await getSubflow(item.id, version));
            download(
              {
                format: "spyder-subflows",
                version: 1,
                subflows: definitions.filter(Boolean),
              },
              "spyder-subflows.json",
            );
          } catch (error) {
            status.textContent = error.message;
          }
        });
      view.wrap
        .querySelector("[data-wt-import]")
        .addEventListener("change", async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          try {
            if (file.size > 32 * 1024 * 1024)
              throw Error("Subflow bundle exceeds 32 MiB.");
            const payload = JSON.parse(await file.text());
            if (
              payload.format !== "spyder-subflows" ||
              payload.version !== 1 ||
              !Array.isArray(payload.subflows)
            )
              throw Error("Unsupported subflow bundle.");
            remoteCatalog = null;
            await importBundle(
              JSON.stringify({
                format: "spyder-workflow-bundle",
                version: 1,
                workflow: {
                  id: `workflow-import-${Date.now().toString(36)}`,
                  name: "Imported subflow dependencies",
                  enabled: false,
                  camera_ids: [],
                  nodes: [],
                  edges: [],
                },
                subflows: payload.subflows,
              }),
            );
            entries = await subflows();
            status.textContent = `${payload.subflows.length} definition(s) imported.`;
          } catch (error) {
            status.textContent = error.message;
          }
        });
    };
    show();
  }
  async function openDefinition(id, version) {
    try {
      const definition = await getSubflow(id, version);
      if (!definition?.graph) throw Error("Subflow version is unavailable.");
      editor.currentDefinition = clone(definition);
      editor.subflowId = id;
      editor.onEdit?.(clone(definition));
    } catch (error) {
      editor.onError?.(error.message);
    }
  }
  function download(value, filename) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  function publishDialog(graph, existing = editor.currentDefinition) {
    if (!graph) return;
    let parameters = [];
    const candidates = graph.nodes.flatMap((node) =>
      Object.entries(node.params || {})
        .filter(([, value]) =>
          ["string", "number", "boolean"].includes(typeof value),
        )
        .map(([field, value]) => ({ node, field, value })),
    );
    const view = modal(
      `<section class="wt-dialog" role="dialog" aria-modal="true" aria-labelledby="wt-publish-title"><header><h2 id="wt-publish-title">Publish subflow version</h2><button class="button secondary" data-wt-close>Close</button></header><p>Publishing creates a new immutable version. Add exactly one input and output bridge before publishing.</p><label>Name<input data-pub-name maxlength="128" value="${esc(graph.name)}"></label><label>Description<textarea data-pub-description maxlength="500">${esc(existing?.description || "")}</textarea></label><fieldset><legend>Expose parameters</legend><div class="wt-parameter-list">${
        candidates
          .map(({ node, field, value }, index) => {
            const parameter = existing?.parameters?.find(
              (item) => item.node_id === node.id && item.field === field,
            );
            const selectedType =
              parameter?.type ||
              (typeof value === "boolean"
                ? "boolean"
                : Number.isInteger(value)
                  ? "integer"
                  : typeof value === "number"
                    ? "number"
                    : "string");
            return `<label><input type="checkbox" data-pub-param="${index}" ${parameter ? "checked" : ""}>${esc(node.type)} · ${esc(field)} <select data-pub-type="${index}"><option ${selectedType === "string" ? "selected" : ""}>string</option><option ${selectedType === "number" ? "selected" : ""}>number</option><option ${selectedType === "integer" ? "selected" : ""}>integer</option><option ${selectedType === "boolean" ? "selected" : ""}>boolean</option></select><input data-pub-param-name="${index}" value="${esc(parameter?.name || field)}" aria-label="Parameter name"></label>`;
          })
          .join("") || "<p>No scalar fields available.</p>"
      }</div></fieldset><p class="wt-status" role="status"></p><footer><button class="button primary" data-pub-submit>Publish new version</button></footer></section>`,
    );
    view.wrap
      .querySelector("[data-pub-submit]")
      .addEventListener("click", async () => {
        const status = view.wrap.querySelector(".wt-status");
        const chosen = candidates
          .filter(
            (_, index) =>
              view.wrap.querySelector(`[data-pub-param="${index}"]`).checked,
          )
          .map(({ node, field, value }, index) => {
            const originalIndex = candidates.findIndex(
              (item) => item.node.id === node.id && item.field === field,
            );
            return {
              name: view.wrap
                .querySelector(`[data-pub-param-name="${originalIndex}"]`)
                .value.trim(),
              type: view.wrap.querySelector(
                `[data-pub-type="${originalIndex}"]`,
              ).value,
              default: value,
              node_id: node.id,
              field,
            };
          });
        if (
          new Set(chosen.map((item) => item.name)).size !== chosen.length ||
          chosen.some((item) => !item.name)
        ) {
          status.textContent = "Parameter names must be unique and non-empty.";
          return;
        }
        if (
          chosen.some((item) =>
            item.type === "string"
              ? typeof item.default !== "string"
              : item.type === "number"
                ? typeof item.default !== "number" ||
                  !Number.isFinite(item.default)
                : item.type === "integer"
                  ? !Number.isInteger(item.default)
                  : typeof item.default !== "boolean",
          )
        ) {
          status.textContent =
            "Each exposed parameter type must match its node field value. Set a compatible field value before publishing.";
          return;
        }
        if (
          graph.nodes.filter((item) => item.type === "subflow_input").length !==
            1 ||
          graph.nodes.filter((item) => item.type === "subflow_output")
            .length !== 1
        ) {
          status.textContent =
            "Add exactly one Subflow input and one Subflow output node before publishing.";
          return;
        }
        try {
          graph.name = view.wrap.querySelector("[data-pub-name]").value.trim();
          graph.enabled = false;
          graph.camera_ids = [];
          let published;
          if (demo()) {
            const list = JSON.parse(localStorage.getItem(SUBFLOWS_KEY) || "[]"),
              id =
                list.find((item) => item.name === graph.name)?.id ||
                `subflow-${Date.now().toString(36)}`;
            const version =
              Math.max(
                0,
                ...list
                  .filter((item) => item.id === id)
                  .map((item) => Number(item.version) || 0),
              ) + 1;
            published = {
              id,
              name: graph.name,
              description: view.wrap.querySelector("[data-pub-description]")
                .value,
              graph,
              parameters: chosen,
              version,
            };
            list.push(published);
            localStorage.setItem(SUBFLOWS_KEY, JSON.stringify(list));
          } else {
            const result = await request("/api/workflows/subflows", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                subflow: {
                  id: editor.subflowId || undefined,
                  name: graph.name,
                  description: view.wrap.querySelector("[data-pub-description]")
                    .value,
                  graph,
                  parameters: chosen,
                },
              }),
            });
            remoteCatalog = null;
            published = result.subflow || result.definition || result;
            if (!published?.id) {
              const latest = await subflows();
              published =
                latest.find((item) => item.name === graph.name) || published;
            }
          }
          if (published?.id) {
            const full =
              (await getSubflow(published.id, published.version)) || published;
            editor.subflowId = full.id;
            editor.currentDefinition = clone(full);
            editor.onPublished?.(clone(full));
          }
          status.textContent = "Published. Call nodes can pin this version.";
          view.wrap.querySelector("[data-pub-submit]").disabled = true;
        } catch (error) {
          status.textContent = error.message;
        }
      });
  }
  async function openHistory() {
    const filters = {
      query: "",
      workflow_id: "",
      camera_id: "",
      state: "",
      since: "",
      until: "",
      page: 0,
      size: 25,
    };
    const dialog = modal(
      `<section class="wt-dialog wt-history" role="dialog" aria-modal="true" aria-labelledby="wt-history-title"><header><div><p class="eyebrow">PERSISTENT RUN RECORDS</p><h2 id="wt-history-title">Execution history</h2></div><div class="wt-header-actions"><button class="button secondary" data-hist-refresh ${demo() ? "disabled" : ""}>Refresh</button><button class="button secondary" data-wt-close>Close</button></div></header>${demo() ? '<p class="wt-demo">Execution history is unavailable in this browser showcase. No network requests are sent.</p>' : ""}<div class="wt-filter-grid"><label>Search<input data-hist-filter="query" placeholder="Workflow name or camera"></label><label>Workflow ID<input data-hist-filter="workflow_id"></label><label>Camera ID<input data-hist-filter="camera_id"></label><label>State<select data-hist-filter="state"><option value="">All states</option><option>completed</option><option>filtered</option><option>error</option></select></label><label>Since<input type="date" data-hist-filter="since"></label><label>Until<input type="date" data-hist-filter="until"></label></div><div class="wt-capacity"><span data-hist-storage>Loading storage summary…</span><button class="button secondary" data-hist-settings ${demo() ? "disabled" : ""}>History settings</button></div><div data-hist-warnings></div><div class="wt-runs" data-hist-runs></div><nav class="wt-pages"><button class="button secondary" data-hist-prev>Previous</button><span data-hist-page></span><button class="button secondary" data-hist-next>Next</button></nav><div data-hist-detail></div></section>`,
    );
    let generation = 0,
      historyMode = "summary";
    const load = async () => {
      const current = ++generation,
        box = dialog.wrap.querySelector("[data-hist-runs]"),
        pager = dialog.wrap.querySelector("[data-hist-page]");
      box.innerHTML = "<p>Loading runs…</p>";
      try {
        const data = await historyPage(filters);
        if (current !== generation || !dialog.wrap.isConnected) return;
        historyMode = data.settings?.mode || historyMode;
        dialog.wrap.querySelector("[data-hist-storage]").textContent = data.demo
          ? "Storage: browser showcase · 0 runs"
          : `Storage: ${data.stats?.database_bytes ?? data.stats?.bytes_used ?? "—"} bytes on disk · ${data.stats?.data_bytes ?? "—"} data bytes · ${data.total} runs · retention ${data.settings?.retention_days ?? "—"} days`;
        const warnings = [
          data.sql_error,
          data.dropped_warning,
          data.storage_error,
          data.warning,
        ].filter(Boolean);
        dialog.wrap.querySelector("[data-hist-warnings]").innerHTML = warnings
          .map(
            (warning) => `<p class="wt-error" role="alert">${esc(warning)}</p>`,
          )
          .join("");
        pager.textContent = `${data.total} runs · page ${(data.page || 0) + 1} of ${data.pages || 1}`;
        box.innerHTML =
          (data.runs || [])
            .map(
              (run) =>
                `<article><div><strong>${esc(run.name || run.workflow_id)}</strong><span class="wt-state wt-state-${esc(run.state)}">${esc(run.state)}</span><small>${esc(run.started_at)} · ${esc(run.camera_id || "all cameras")} · ${esc(run.duration_ms ?? "—")} ms · ${esc(run.source || "")}</small></div><button class="button secondary" data-hist-open="${esc(run.id)}">Details</button></article>`,
            )
            .join("") ||
          `<p class="wt-empty">${data.demo ? "No server history is shown in showcase mode." : "No runs match these filters."}</p>`;
        box
          .querySelectorAll("[data-hist-open]")
          .forEach((button) =>
            button.addEventListener("click", () =>
              detail(button.dataset.histOpen),
            ),
          );
        dialog.wrap.querySelector("[data-hist-prev]").disabled =
          (data.page || 0) <= 0;
        dialog.wrap.querySelector("[data-hist-next]").disabled =
          (data.page || 0) + 1 >= (data.pages || 1);
      } catch (error) {
        box.innerHTML = `<p class="wt-error">${esc(error.message)}</p>`;
      }
    };
    const detail = async (id) => {
      const host = dialog.wrap.querySelector("[data-hist-detail]");
      host.innerHTML = "<p>Loading run details…</p>";
      try {
        const run = await request(
          `/api/workflows/history/${encodeURIComponent(id)}`,
        );
        const value = run.run || run;
        host.innerHTML = `<section class="wt-run-detail"><header><h3>${esc(value.name || value.workflow_id)} · ${esc(value.state)}</h3><button class="button secondary" data-hist-export>Export JSON</button><button class="button secondary" data-hist-replay ${value.graph_complete !== false && value.trace_complete !== false && value.context?.cv ? "" : "disabled"} title="${value.graph_complete === false ? "Configuration snapshot is incomplete." : value.context?.cv ? "Dry run using retained diagnostic inputs." : "Diagnostic inputs were not retained for this run."}">Safe replay diagnostics</button></header><p>${esc(value.started_at)} · ${esc(value.duration_ms)} ms · ${esc(value.camera_id || "all cameras")}</p>${value.snapshot_warning ? `<p class="wt-error">${esc(value.snapshot_warning)}</p>` : ""}<p>Run state reflects evaluation completion. Recording attachment state is shown per action and can finish later.</p>${window.spyderWorkflowRunView?.renderGraph(value) || ""}<div class="wt-timeline">${(value.nodes || []).map((item) => `<article class="wt-node-state wt-state-${esc(item.state)}"><strong>${esc(item.type)} · ${esc(item.id)}</strong><span>${esc(item.state)} · ${esc(item.input_count ?? 0)} IN / ${esc(item.output_count ?? 0)} OUT · ${esc(item.duration_ms ?? 0)} ms</span>${item.error ? `<p>${esc(item.error)}</p>` : ""}${item.path ? `<small>Path: ${esc(Array.isArray(item.path) ? item.path.join(" / ") : item.path)}</small>` : ""}${item.inputs !== undefined ? `<details><summary>Input summary</summary><pre>${esc(JSON.stringify(item.inputs, null, 2))}</pre></details>` : ""}${item.outputs !== undefined ? `<details><summary>Output summary</summary><pre>${esc(JSON.stringify(item.outputs, null, 2))}</pre></details>` : ""}</article>`).join("") || "<p>No node trace was stored.</p>"}</div><section class="wt-actions"><h4>Actions and media</h4>${(value.actions || []).map((action) => `<article><strong>${esc(action.type)} · ${esc(action.state)}</strong><small>Node ${esc(action.node_id)}${action.event_id ? ` · Event ${esc(action.event_id)}` : ""}</small>${action.attachment_state ? `<small>Recording attachment: ${esc(action.attachment_state)}${action.attachment_error ? ` · ${esc(action.attachment_error)}` : ""}</small>` : ""}${(Array.isArray(action.media) ? action.media : action.media ? [action.media] : []).map((media) => window.spyderWorkflowRunView?.renderMedia(media) || "").join("")}</article>`).join("") || "<p>No actions or media were recorded.</p>"}</section><pre class="wt-replay-result" data-replay-result></pre></section>`;
        host
          .querySelector("[data-hist-export]")
          .addEventListener("click", () =>
            download(value, `workflow-run-${id}.json`),
          );
        host
          .querySelector("[data-hist-replay]")
          .addEventListener("click", async () => {
            const result = host.querySelector("[data-replay-result]");
            result.textContent =
              "Running safe diagnostics; action nodes stay disabled…";
            try {
              const replay = await request(
                `/api/workflows/history/${encodeURIComponent(id)}/replay`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: "{}",
                },
              );
              result.textContent = `${replay.message ? `Replay notice: ${replay.message}` : ""}${replay.message ? String.fromCharCode(10, 10) : ""}${JSON.stringify(replay, null, 2)}`;
            } catch (error) {
              result.textContent = error.message;
            }
          });
      } catch (error) {
        host.innerHTML = `<p class="wt-error">${esc(error.message)}</p>`;
      }
    };
    dialog.wrap.querySelectorAll("[data-hist-filter]").forEach((input) =>
      input.addEventListener("change", () => {
        filters[input.dataset.histFilter] = input.value;
        filters.page = 0;
        load();
      }),
    );
    dialog.wrap
      .querySelector("[data-hist-refresh]")
      .addEventListener("click", load);
    dialog.wrap
      .querySelector("[data-hist-prev]")
      .addEventListener("click", () => {
        filters.page = Math.max(0, filters.page - 1);
        load();
      });
    dialog.wrap
      .querySelector("[data-hist-next]")
      .addEventListener("click", () => {
        filters.page++;
        load();
      });
    dialog.wrap
      .querySelector("[data-hist-settings]")
      .addEventListener("click", async () => {
        if (demo()) return;
        try {
          const data = await request("/api/workflows/history?size=1"),
            settings = data.settings || {};
          const form = modal(
            `<section class="wt-dialog" role="dialog" aria-modal="true"><header><h2>History storage settings</h2><button class="button secondary" data-wt-close>Close</button></header><p>Current use: ${esc(data.stats?.database_bytes ?? "—")} bytes on disk · ${esc(data.stats?.data_bytes ?? "—")} data bytes · ${esc(data.total ?? 0)} runs. Retention removes older records; capacity evicts oldest runs when needed.</p><label><input type="checkbox" data-hs-enabled ${settings.enabled !== false ? "checked" : ""}> Store workflow run history</label><label>Storage mode<select data-hs-mode><option ${settings.mode === "summary" ? "selected" : ""}>summary</option><option ${settings.mode === "diagnostic" ? "selected" : ""}>diagnostic</option></select></label><label>Retention days<input type="number" min="1" max="3650" data-hs-days value="${esc(settings.retention_days ?? 7)}"></label><label>Maximum runs<input type="number" min="1" max="100000" data-hs-runs value="${esc(settings.max_runs ?? 10000)}"></label><label>History data budget (MiB)<input type="number" min="1" max="2048" step="1" data-hs-mib value="${esc(Math.ceil((settings.max_bytes ?? 67108864) / 1048576))}"></label><p>SQLite indexes and journal can add disk overhead beyond this data budget.</p><p class="wt-status" role="status"></p><button class="button primary" data-hs-save>Save settings</button><button class="button secondary" data-hs-delete>Clear all history…</button></section>`,
            undefined,
            false,
          );
          form.wrap
            .querySelector("[data-hs-save]")
            .addEventListener("click", async () => {
              try {
                const settings = {
                  enabled: form.wrap.querySelector("[data-hs-enabled]").checked,
                  mode: form.wrap.querySelector("[data-hs-mode]").value,
                  retention_days: Number(
                    form.wrap.querySelector("[data-hs-days]").value,
                  ),
                  max_runs: Number(
                    form.wrap.querySelector("[data-hs-runs]").value,
                  ),
                  max_bytes: Math.round(
                    Number(form.wrap.querySelector("[data-hs-mib]").value) *
                      1048576,
                  ),
                };
                await request("/api/workflows/history/settings", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(settings),
                });
                form.wrap.querySelector(".wt-status").textContent =
                  "Settings saved.";
                historyMode = settings.mode;
              } catch (error) {
                form.wrap.querySelector(".wt-status").textContent =
                  error.message;
              }
            });
          form.wrap
            .querySelector("[data-hs-delete]")
            .addEventListener("click", async () => {
              if (
                !window.confirm(
                  "Delete every stored workflow run? This cannot be undone.",
                )
              )
                return;
              try {
                await request("/api/workflows/history/clear", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: "{}",
                });
                form.close();
                load();
              } catch (error) {
                form.wrap.querySelector(".wt-status").textContent =
                  error.message;
              }
            });
        } catch (error) {
          /* keep history panel usable */
        }
      });
    load();
  }
  window.spyderWorkflowTools = {
    mount(options) {
      editor = options || {};
    },
    openSubflows,
    openHistory,
    openDefinition,
    openPublish: (graph, existing) => publishDialog(graph, existing),
    listSubflows: subflows,
    getSubflow,
    exportBundle,
    importBundle,
    setSubflowId(id) {
      editor.subflowId = id;
      if (!id) editor.currentDefinition = null;
    },
    closeAll() {
      document
        .querySelectorAll("[data-workflow-tools-modal]")
        .forEach((item) => item.remove());
    },
  };
})();
