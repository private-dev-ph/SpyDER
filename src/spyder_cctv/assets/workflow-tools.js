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
  function readBrowserDefinitions() {
    const raw = localStorage.getItem(SUBFLOWS_KEY) || "[]";
    if (new TextEncoder().encode(raw).byteLength > 8 * 1024 * 1024)
      throw Error("Subflow library exceeds its 8 MiB limit.");
    const definitions = JSON.parse(raw);
    if (!Array.isArray(definitions))
      throw Error("Subflow library must contain a list.");
    for (const definition of definitions) {
      if (
        !definition ||
        !definition.graph ||
        typeof definition.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(definition.id) ||
        !Number.isInteger(definition.version) ||
        definition.version < 1 ||
        definition.version > 100 ||
        !Array.isArray(definition.parameters)
      )
        throw Error("Invalid stored subflow definition.");
      editor.validateGraph?.(definition.graph);
    }
    return definitions;
  }
  function storeBrowserDefinitions(definitions) {
    if (new Set(definitions.map((item) => item.id)).size > 500)
      throw Error("Subflow library supports up to 500 definitions.");
    const text = JSON.stringify(definitions);
    if (new TextEncoder().encode(text).byteLength > 8 * 1024 * 1024)
      throw Error(
        "Subflow library exceeds its 8 MiB limit. Export definitions before removing unused ones.",
      );
    localStorage.setItem(SUBFLOWS_KEY, text);
  }
  function libraryPage(
    items,
    { query = "", sort = "name", page = 0, size = 8 } = {},
  ) {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const rows = items.filter((item) =>
      words.every((word) =>
        `${item.name} ${item.description} ${item.id}`
          .toLowerCase()
          .includes(word),
      ),
    );
    const byName = (a, b) =>
      String(a.name).localeCompare(String(b.name), undefined, {
        numeric: true,
        sensitivity: "base",
      }) || String(a.id).localeCompare(String(b.id));
    rows.sort(
      sort === "version"
        ? (a, b) => b.version - a.version || byName(a, b)
        : sort === "name-desc"
          ? (a, b) => -byName(a, b)
          : byName,
    );
    size = Math.max(1, Math.min(24, Math.floor(size) || 8));
    const pages = Math.max(1, Math.ceil(rows.length / size));
    page = Math.max(0, Math.min(pages - 1, Math.floor(page) || 0));
    return {
      rows: rows.slice(page * size, (page + 1) * size),
      total: rows.length,
      page,
      pages,
    };
  }
  function createSubflowDraft(kind = "blank") {
    const nodes = [
      { id: "input", type: "subflow_input", x: 80, y: 140, params: {} },
    ];
    if (kind !== "blank") {
      nodes.push({
        id: "filter",
        type: "filter",
        x: 320,
        y: 140,
        params: {
          label: "",
          confidence: 0.65,
          identity_source: "identity",
          identity: "",
          rules: [],
          match: "all",
        },
      });
      nodes.push({
        id: "cooldown",
        type: "cooldown",
        x: 560,
        y: 140,
        params: { seconds: 10 },
      });
    }
    if (kind === "event")
      nodes.push({
        id: "event",
        type: "event",
        x: 800,
        y: 140,
        params: {
          message: "Detection matched",
          name_pattern: "{workflow} · {camera} · {date} {time}",
          attachment: "none",
          duration_seconds: 10,
          pre_event_seconds: 0,
        },
      });
    nodes.push({
      id: "output",
      type: "subflow_output",
      x: nodes.length * 240 + 80,
      y: 140,
      params: {},
    });
    return {
      id: `workflow-${Date.now().toString(36)}`,
      name:
        kind === "event"
          ? "Reusable event log"
          : kind === "confidence"
            ? "Confidence and cooldown"
            : "New subflow",
      enabled: false,
      camera_ids: [],
      nodes,
      edges: nodes
        .slice(1)
        .map((node, index) => ({ from: nodes[index].id, to: node.id })),
    };
  }
  function subflowThumbnail(definition) {
    const source = definition.graph.nodes;
    const incoming = new Map(source.map((node) => [node.id, 0]));
    for (const edge of definition.graph.edges)
      incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    const ordered = source.filter((node) => incoming.get(node.id) === 0);
    for (let index = 0; index < ordered.length; index++)
      for (const edge of definition.graph.edges.filter(
        (edge) => edge.from === ordered[index].id,
      )) {
        incoming.set(edge.to, incoming.get(edge.to) - 1);
        if (incoming.get(edge.to) === 0)
          ordered.push(source.find((node) => node.id === edge.to));
      }
    const nodes = (ordered.length === source.length ? ordered : source).slice(
      0,
      12,
    );
    const columns = Math.min(4, Math.max(1, nodes.length));
    const cells = new Map(
      nodes.map((node, index) => [
        node.id,
        {
          x: (index % columns) * 100 + 10,
          y: Math.floor(index / columns) * 56 + 10,
        },
      ]),
    );
    const edges = definition.graph.edges.filter(
      (edge) => cells.has(edge.from) && cells.has(edge.to),
    );
    return `<svg class="wt-subflow-preview" viewBox="0 0 ${columns * 100 + 10} ${Math.ceil(nodes.length / columns) * 56 + 10}" role="img" aria-label="${esc(definition.graph.nodes.length)} node subflow preview"><g>${edges
      .map((edge) => {
        const a = cells.get(edge.from),
          b = cells.get(edge.to);
        return `<path d="M${a.x + 80} ${a.y + 18} L${b.x} ${b.y + 18}"/>`;
      })
      .join("")}</g>${nodes
      .map((node) => {
        const at = cells.get(node.id);
        return `<g><rect x="${at.x}" y="${at.y}" width="80" height="36" rx="6"/><text x="${at.x + 40}" y="${at.y + 22}" text-anchor="middle">${esc(node.type.replace("subflow_", "").slice(0, 12))}</text></g>`;
      })
      .join("")}</svg>`;
  }
  async function subflows() {
    catalogError = "";
    if (demo()) {
      try {
        const stored = readBrowserDefinitions(),
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
        return readBrowserDefinitions().find(
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
      const definitions = readBrowserDefinitions();
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
      const existing = readBrowserDefinitions();
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
      storeBrowserDefinitions([...byVersion.values()]);
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
      const ids = new Set(item.graph.nodes.map((node) => node.id));
      const input = item.graph.nodes.find(
        (node) => node.type === "subflow_input",
      );
      const output = item.graph.nodes.find(
        (node) => node.type === "subflow_output",
      );
      const ancestors = new Set([output.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const edge of item.graph.edges)
          if (ancestors.has(edge.to) && !ancestors.has(edge.from)) {
            ancestors.add(edge.from);
            changed = true;
          }
      }
      if (
        ancestors.size !== ids.size ||
        !ancestors.has(input.id) ||
        item.graph.edges.filter((edge) => edge.to === output.id).length !== 1
      )
        throw Error(
          "Connect every subflow node to the Output, with exactly one connection into Output.",
        );
      if (
        !Array.isArray(item.parameters) ||
        item.parameters.length > 64 ||
        typeof item.name !== "string" ||
        !item.name.trim() ||
        item.name.length > 128 ||
        typeof item.description !== "string" ||
        item.description.length > 1000
      )
        throw Error("Invalid subflow name, description or exposed settings.");
      const names = new Set(),
        fields = new Set();
      for (const parameter of item.parameters) {
        const node = item.graph.nodes.find(
          (node) => node.id === parameter.node_id,
        );
        const field = `${parameter.node_id}.${parameter.field}`;
        const validType = (value) =>
          parameter.type === "string"
            ? typeof value === "string"
            : parameter.type === "boolean"
              ? typeof value === "boolean"
              : parameter.type === "integer"
                ? Number.isInteger(value)
                : parameter.type === "number" &&
                  typeof value === "number" &&
                  Number.isFinite(value);
        if (
          !/^[A-Za-z0-9_-]{1,64}$/.test(parameter.name) ||
          names.has(parameter.name) ||
          fields.has(field) ||
          !node ||
          ["subflow", "subflow_input", "subflow_output"].includes(node.type) ||
          !Object.hasOwn(node.params || {}, parameter.field) ||
          !validType(parameter.default) ||
          !validType(node.params[parameter.field])
        )
          throw Error(
            "Exposed settings must have unique names, compatible types and valid node fields.",
          );
        names.add(parameter.name);
        fields.add(field);
      }
      definitions.set(key, item);
    }
    const active = new Set(),
      done = new Set();
    const visit = (graph, depth = 0) => {
      editor.validateGraph?.(graph);
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
          "button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary,[tabindex]:not([tabindex='-1'])",
        ),
      ].filter(
        (item) => item.getClientRects().length && !item.closest("[hidden]"),
      );
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
    let entries = [],
      page = 0,
      query = "",
      sort = "name";
    remoteCatalog = null;
    try {
      entries = await subflows();
    } catch (error) {
      catalogError = error.message;
    }
    const view = modal(
      `<section class="wt-dialog wt-subflows" role="dialog" aria-modal="true" aria-labelledby="wt-subflows-title"><header><div><p class="eyebrow">REUSABLE WORKFLOWS</p><h2 id="wt-subflows-title">Subflow library</h2></div><button class="button secondary" data-wt-close>Close</button></header><p>Build a branch once. Reuse it with separate settings and state in each workflow. Calls stay pinned to the version you choose.</p>${demo() ? '<p class="wt-demo">Demo editing only. Definitions stay in this browser; camera inference and actions require the installed app.</p>' : ""}<div class="wt-library-toolbar"><label>Search subflows<input type="search" data-wt-search placeholder="Name, description or ID" autocomplete="off"></label><label>Sort<select data-wt-sort><option value="name">Name A–Z</option><option value="name-desc">Name Z–A</option><option value="version">Latest version</option></select></label></div><div class="wt-list" data-wt-rows></div><nav class="wt-library-pages" aria-label="Subflow library pages"><button class="button secondary" data-wt-prev>Previous</button><span data-wt-page role="status"></span><button class="button secondary" data-wt-next>Next</button></nav><details class="wt-subflow-guide" ${entries.length ? "" : "open"}><summary>Create a reusable branch</summary><p>Choose a starter, connect processing nodes between Input and Output, then publish. Parent workflow edits are preserved while you work. No actions run while authoring.</p><div class="wt-starter-actions"><button class="button secondary" data-wt-new>Blank subflow</button><button class="button secondary" data-wt-starter="confidence">Confidence + cooldown</button><button class="button secondary" data-wt-starter="event">Filtered event log</button></div></details><footer><button class="button secondary" data-wt-export>Export definitions</button><label class="button secondary wt-file-label">Import definitions<input type="file" data-wt-import accept="application/json,.json" hidden></label><button class="button primary" data-wt-publish ${editor.subflowId || editor.getGraph?.()?.nodes.some((node) => node.type === "subflow_input") ? "" : "disabled"}>Publish current draft…</button></footer><p class="wt-status" role="status"></p></section>`,
    );
    const status = view.wrap.querySelector(".wt-status");
    function paint() {
      const result = libraryPage(entries, { query, sort, page });
      page = result.page;
      view.wrap.querySelector("[data-wt-rows]").innerHTML = catalogError
        ? `<p class="wt-error" role="alert">${esc(catalogError)}</p>`
        : result.rows
            .map(
              (item) =>
                `<article class="wt-subflow-row">${subflowThumbnail(item)}<div class="wt-subflow-copy"><h3>${esc(item.name)} <small>Latest v${item.version}</small></h3><p>${esc(item.description || "No description yet.")}</p><small>${item.graph.nodes.length} nodes · ${item.parameters.length} exposed settings · ${(item.versions || [item.version]).length} versions</small><small>Detections IN / OUT · ${esc(item.id)}</small></div><div class="wt-subflow-actions"><label>Version<select data-wt-version="${esc(item.id)}">${(item.versions || [item.version]).map((version) => `<option value="${version}" ${version === item.version ? "selected" : ""}>v${version}${version === item.version ? " · latest" : ""}</option>`).join("")}</select></label><button class="button primary" data-wt-insert="${esc(item.id)}">Add to workflow</button><button class="button secondary" data-wt-edit="${esc(item.id)}">Edit definition</button><button class="button secondary" data-wt-delete="${esc(item.id)}">Delete</button></div></article>`,
            )
            .join("") ||
          `<p class="wt-empty" data-wt-empty>${query ? "No subflows match. Try another search." : "No published subflows. Choose a starter below to create your first reusable branch."}</p>`;
      view.wrap.querySelector("[data-wt-page]").textContent =
        `${result.total} subflows · Page ${page + 1} of ${result.pages}`;
      view.wrap.querySelector("[data-wt-prev]").disabled = page === 0;
      view.wrap.querySelector("[data-wt-next]").disabled =
        page + 1 >= result.pages;
    }
    paint();
    view.wrap
      .querySelector("[data-wt-search]")
      .addEventListener("input", (event) => {
        query = event.target.value;
        page = 0;
        paint();
      });
    view.wrap
      .querySelector("[data-wt-sort]")
      .addEventListener("change", (event) => {
        sort = event.target.value;
        page = 0;
        paint();
      });
    view.wrap.addEventListener("click", async (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.matches("[data-wt-prev],[data-wt-next]")) {
        page += button.hasAttribute("data-wt-next") ? 1 : -1;
        paint();
        return;
      }
      if (button.hasAttribute("data-wt-new") || button.dataset.wtStarter) {
        view.close();
        editor.subflowId = undefined;
        editor.currentDefinition = null;
        editor.onCreateSubflow?.(
          createSubflowDraft(button.dataset.wtStarter || "blank"),
        );
        return;
      }
      if (button.hasAttribute("data-wt-publish")) {
        view.close();
        publishDialog(editor.getGraph?.(), editor.currentDefinition);
        return;
      }
      const id =
        button.dataset.wtInsert ||
        button.dataset.wtEdit ||
        button.dataset.wtDelete;
      if (!id) return;
      button.disabled = true;
      status.textContent = "Loading subflow…";
      try {
        if (button.dataset.wtDelete) {
          if (
            !window.confirm(
              "Delete this subflow and all its versions? Referenced definitions are protected.",
            )
          )
            return;
          if (demo()) {
            const definitions = readBrowserDefinitions();
            const references = (graph) =>
              graph?.nodes?.some(
                (node) =>
                  node.type === "subflow" && node.params.subflow_id === id,
              );
            if (
              references(editor.getGraph?.()) ||
              definitions.some((item) => references(item.graph))
            )
              throw Error(
                "Subflow is referenced by a draft or another subflow. Remove those calls first.",
              );
            if (!window.spyderWorkflowStore)
              throw Error(
                "Workflow library is unavailable; deletion cannot safely check references.",
              );
            if (await window.spyderWorkflowStore.referencesSubflow(id))
              throw Error(
                "Subflow is referenced by a saved workflow. Remove that call first.",
              );
            for (const draft of editor.getDrafts?.() || [])
              if (references(draft))
                throw Error(
                  "Subflow is referenced by an open draft. Remove that call first.",
                );
            const current = readBrowserDefinitions();
            storeBrowserDefinitions(current.filter((item) => item.id !== id));
          } else
            await request(
              `/api/workflows/subflows/${encodeURIComponent(id)}/remove`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              },
            );
          remoteCatalog = null;
          entries = await subflows();
          paint();
          status.textContent = "Subflow deleted.";
          return;
        }
        const version = Number(
          [...view.wrap.querySelectorAll("[data-wt-version]")].find(
            (select) => select.dataset.wtVersion === id,
          )?.value,
        );
        const definition = await getSubflow(id, version);
        if (!definition)
          throw Error("Selected subflow version is unavailable.");
        if (!view.wrap.isConnected) return;
        if (button.dataset.wtInsert) {
          await editor.onInsertSubflow?.(clone(definition));
          view.close();
        } else {
          view.close();
          editor.currentDefinition = clone(definition);
          editor.subflowId = id;
          editor.onEdit?.(clone(definition));
        }
      } catch (error) {
        status.textContent = error.message;
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
    view.wrap
      .querySelector("[data-wt-export]")
      .addEventListener("click", async () => {
        try {
          download(
            demo()
              ? {
                  format: "spyder-subflows",
                  version: 1,
                  subflows: readBrowserDefinitions(),
                }
              : await request("/api/workflows/subflows/export"),
            "spyder-subflows.json",
          );
          status.textContent = "Definitions exported.";
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
          await importBundle(
            JSON.stringify({
              format: "spyder-workflow-bundle",
              version: 1,
              workflow: {
                id: "subflow-import",
                name: "Imported dependencies",
                enabled: false,
                camera_ids: [],
                nodes: [],
                edges: [],
              },
              subflows: payload.subflows,
            }),
          );
          remoteCatalog = null;
          entries = await subflows();
          page = 0;
          paint();
          status.textContent = `${payload.subflows.length} versions imported.`;
        } catch (error) {
          status.textContent = error.message;
        } finally {
          event.target.value = "";
        }
      });
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
    const candidates = graph.nodes
      .filter(
        (node) =>
          !["subflow", "subflow_input", "subflow_output"].includes(node.type),
      )
      .flatMap((node) =>
        Object.entries(node.params || {})
          .filter(([, value]) =>
            ["string", "number", "boolean"].includes(typeof value),
          )
          .map(([field, value]) => ({ node, field, value })),
      );
    const view = modal(
      `<section class="wt-dialog wt-publish" role="dialog" aria-modal="true" aria-labelledby="wt-publish-title"><header><h2 id="wt-publish-title">Publish subflow version</h2><button class="button secondary" data-wt-close>Close</button></header><p>Publishing creates a new immutable version. Add exactly one input and output bridge before publishing.</p><label>Name<input data-pub-name maxlength="128" value="${esc(graph.name)}"></label><label>Description<textarea data-pub-description maxlength="1000">${esc(existing?.description || "")}</textarea></label><fieldset><legend>Expose parameters</legend><div class="wt-parameter-list">${
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
            return `<div class="wt-parameter-row"><label class="wt-parameter-toggle"><input type="checkbox" data-pub-param="${index}" ${parameter ? "checked" : ""}>${esc(node.type)} · ${esc(field)}</label><small class="wt-parameter-meta">Default: ${esc(String(value).slice(0, 100))} · ${esc(node.id)}</small><label>Value type<select data-pub-type="${index}"><option ${selectedType === "string" ? "selected" : ""}>string</option><option ${selectedType === "number" ? "selected" : ""}>number</option><option ${selectedType === "integer" ? "selected" : ""}>integer</option><option ${selectedType === "boolean" ? "selected" : ""}>boolean</option></select></label><label>Setting name<input data-pub-param-name="${index}" value="${esc(parameter?.name || (candidates.filter((item) => item.field === field).length > 1 ? node.id + "_" + field : field))}" aria-label="Parameter name" maxlength="64"></label></div>`;
          })
          .join("") || "<p>No scalar fields available.</p>"
      }</div></fieldset><p class="wt-status" role="status"></p><footer><button class="button primary" data-pub-submit>Publish new version</button></footer></section>`,
    );
    let publishing = false;
    view.wrap
      .querySelector("[data-pub-submit]")
      .addEventListener("click", async () => {
        if (publishing) return;
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
          chosen.some((item) => !/^[A-Za-z0-9_-]{1,64}$/.test(item.name))
        ) {
          status.textContent =
            "Setting names must be unique: 1–64 letters, numbers, underscores or hyphens.";
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
          publishing = true;
          view.wrap.querySelector("[data-pub-submit]").disabled = true;
          status.textContent = "Publishing version…";
          graph.name = view.wrap.querySelector("[data-pub-name]").value.trim();
          if (!graph.name) throw Error("Enter a name for this subflow.");
          graph.enabled = false;
          graph.camera_ids = [];
          let published;
          if (demo()) {
            const list = readBrowserDefinitions(),
              id =
                existing?.id ||
                editor.subflowId ||
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
            const bundle = {
              format: "spyder-workflow-bundle",
              version: 1,
              workflow: {
                id: "publish-check",
                name: "Publish check",
                enabled: false,
                camera_ids: [],
                nodes: [],
                edges: [],
              },
              subflows: [...list, published],
            };
            validateBundle(bundle);
            storeBrowserDefinitions(bundle.subflows);
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
          publishing = false;
          view.wrap.querySelector("[data-pub-submit]").disabled = false;
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
    libraryPage,
    createSubflowDraft,
    openSubflows,
    openHistory,
    openDefinition,
    openPublish: (graph, existing) => publishDialog(graph, existing),
    listSubflows: subflows,
    getSubflow,
    exportBundle,
    importBundle,
    restoreSubflowContext(definition) {
      editor.currentDefinition = definition ? clone(definition) : null;
      editor.subflowId = definition?.id;
    },
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
