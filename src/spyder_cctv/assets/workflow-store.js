/* Browser-only workflow library. Graphs and summaries commit in one transaction. */
(() => {
  "use strict";
  const MAX_COUNT = 5000,
    MAX_BYTES = 64 * 1024 * 1024;
  let connection;
  function database() {
    if (!globalThis.indexedDB)
      return Promise.reject(
        new Error(
          "Workflow library storage is unavailable in this browser. Export your draft to keep a copy.",
        ),
      );
    connection ||= new Promise((resolve, reject) => {
      const request = indexedDB.open("spyder-workflow-library", 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        request.result.createObjectStore("graphs", { keyPath: "id" });
        request.result.createObjectStore("summaries", { keyPath: "id" });
        request.result.createObjectStore("meta");
      };
      request.onerror = () => {
        connection = null;
        reject(request.error);
      };
      request.onblocked = () => {
        blocked = true;
        connection = null;
        reject(
          new Error("Close other SpyDER tabs to update workflow storage."),
        );
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          connection = null;
        };
        resolve(db);
      };
    });
    return connection;
  }
  async function read(store, id, signal) {
    if (signal?.aborted)
      throw new DOMException("Request cancelled", "AbortError");
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, "readonly");
      const request =
        id === undefined
          ? transaction.objectStore(store).getAll()
          : transaction.objectStore(store).get(id);
      const abort = () => transaction.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const cleanup = () => signal?.removeEventListener("abort", abort);
      transaction.oncomplete = () => {
        cleanup();
        resolve(request.result);
      };
      transaction.onabort = () => {
        cleanup();
        reject(
          transaction.error ||
            new DOMException("Request cancelled", "AbortError"),
        );
      };
      transaction.onerror = () => {
        cleanup();
        reject(transaction.error);
      };
    });
  }
  async function write(graph, id) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["graphs", "summaries", "meta"], "readwrite");
      const graphs = tx.objectStore("graphs"),
        summaries = tx.objectStore("summaries"),
        meta = tx.objectStore("meta");
      let failure;
      const oldRequest = summaries.get(id),
        usageRequest = meta.get("usage");
      let oldReady = false,
        usageReady = false;
      const apply = () => {
        if (!oldReady || !usageReady) return;
        try {
          const old = oldRequest.result;
          const usage = usageRequest.result || { count: 0, bytes: 0 };
          if (!graph) {
            graphs.delete(id);
            summaries.delete(id);
            meta.put(
              {
                count: Math.max(0, usage.count - (old ? 1 : 0)),
                bytes: Math.max(0, usage.bytes - (old?.stored_bytes || 0)),
              },
              "usage",
            );
            return;
          }
          const bytes = new TextEncoder().encode(
            JSON.stringify(graph),
          ).byteLength;
          const next = {
            count: usage.count + (old ? 0 : 1),
            bytes: usage.bytes - (old?.stored_bytes || 0) + bytes,
          };
          if (next.count > MAX_COUNT || next.bytes > MAX_BYTES)
            throw new Error(
              "Workflow library limit reached (5,000 workflows or 64 MiB). Export and remove unused workflows.",
            );
          graphs.put(graph);
          summaries.put({
            ...window.spyderWorkflowManager.summarizeWorkflow(graph),
            stored_bytes: bytes,
          });
          meta.put(next, "usage");
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      oldRequest.onsuccess = () => {
        oldReady = true;
        apply();
      };
      usageRequest.onsuccess = () => {
        usageReady = true;
        apply();
      };
      tx.oncomplete = () => resolve(graph);
      tx.onabort = () =>
        reject(
          failure ||
            tx.error ||
            new Error(
              "Workflow could not be saved. Export your draft before closing this page.",
            ),
        );
      tx.onerror = () =>
        reject(
          tx.error ||
            new Error(
              "Workflow storage is full or unavailable. Export your draft before closing this page.",
            ),
        );
    });
  }
  const SNAPSHOTS_KEY = "spyder.workflow.subflows.v1";
  let migratedText = null,
    migration = Promise.resolve();
  function snapshots() {
    const text = localStorage.getItem(SNAPSHOTS_KEY) || "[]";
    if (new TextEncoder().encode(text).byteLength > 8 * 1024 * 1024)
      throw Error("Published workflow storage exceeds 8 MiB.");
    const values = JSON.parse(text);
    if (!Array.isArray(values))
      throw Error("Published workflow storage is invalid.");
    return values;
  }
  async function refreshUnifiedSummaries() {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
          ["graphs", "summaries", "meta"],
          "readwrite",
        ),
        meta = transaction.objectStore("meta");
      const marker = meta.get("unified-summary-version");
      marker.onsuccess = () => {
        if (marker.result === 1) return;
        const cursor = transaction.objectStore("graphs").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) {
            meta.put(1, "unified-summary-version");
            return;
          }
          transaction.objectStore("summaries").put({
            ...window.spyderWorkflowManager.summarizeWorkflow(row.value),
            stored_bytes: new TextEncoder().encode(JSON.stringify(row.value))
              .byteLength,
          });
          row.continue();
        };
      };
      transaction.oncomplete = resolve;
      transaction.onabort = transaction.onerror = () =>
        reject(
          transaction.error ||
            Error(
              "Workflow metadata migration failed; original graphs were preserved.",
            ),
        );
    });
  }
  function ensureUnified() {
    let text;
    try {
      text = localStorage.getItem(SNAPSHOTS_KEY) || "[]";
    } catch (error) {
      return Promise.reject(error);
    }
    if (text === migratedText) return migration;
    migratedText = text;
    migration = migration
      .catch(() => {})
      .then(async () => {
        await refreshUnifiedSummaries();
        const latest = new Map();
        for (const definition of snapshots()) {
          if (
            !definition ||
            typeof definition.id !== "string" ||
            !definition.graph ||
            !Array.isArray(definition.parameters)
          )
            throw Error(
              "A published workflow definition is invalid; original storage was preserved.",
            );
          if (
            !latest.has(definition.id) ||
            latest.get(definition.id).version < definition.version
          )
            latest.set(definition.id, definition);
        }
        for (const definition of latest.values()) {
          const existing = await read("graphs", definition.id);
          if (existing) {
            if (!existing.execution?.allow_calls && !existing.callable_version)
              throw Error(
                `Workflow ID collision for ${definition.id}. Existing workflows and published versions were preserved.`,
              );
            if (existing.callable_version !== definition.version) {
              existing.callable_version = definition.version;
              await write(existing, existing.id);
            }
            continue;
          }
          const graph = JSON.parse(JSON.stringify(definition.graph));
          graph.id = definition.id;
          graph.name = definition.name;
          graph.enabled = false;
          graph.camera_ids = [];
          graph.callable_version = definition.version;
          graph.execution = {
            run_independently: false,
            allow_calls: true,
            parameters: definition.parameters,
            description: definition.description || "",
          };
          await write(graph, graph.id);
        }
      })
      .catch((error) => {
        migratedText = null;
        throw error;
      });
    return migration;
  }
  function publishedReferences(id, excluding = null) {
    return snapshots().some(
      (definition) =>
        definition.id !== excluding &&
        definition.graph.nodes.some(
          (node) => node.type === "subflow" && node.params?.subflow_id === id,
        ),
    );
  }
  window.spyderWorkflowStore = {
    migrateCallables: ensureUnified,
    async callableIds() {
      await ensureUnified();
      const rows = await read("summaries");
      return rows
        .filter((row) => ["callable", "both"].includes(row.execution_mode))
        .map((row) => row.id);
    },
    async referencesSubflow(id) {
      await ensureUnified();
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction("graphs", "readonly");
        const cursor = transaction.objectStore("graphs").openCursor();
        let found = false;
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          if (
            entry.value.nodes?.some(
              (node) =>
                node.type === "subflow" && node.params?.subflow_id === id,
            )
          )
            found = true;
          else entry.continue();
        };
        transaction.oncomplete = () => resolve(found);
        transaction.onabort = transaction.onerror = () =>
          reject(
            transaction.error ||
              Error("Workflow references could not be checked."),
          );
      });
    },
    async page(options, { signal } = {}) {
      await ensureUnified();
      const stored = await read("summaries", undefined, signal),
        versions = snapshots();
      const summaries = stored.map((row) => {
        const published = versions
          .filter((item) => item.id === row.id)
          .map((item) => item.version)
          .sort((a, b) => a - b);
        const callers = new Set(
          stored
            .filter((item) => item.call_ids?.includes(row.id))
            .map((item) => item.id),
        );
        for (const item of versions)
          if (
            item.id !== row.id &&
            item.graph.nodes.some(
              (node) =>
                node.type === "subflow" && node.params?.subflow_id === row.id,
            )
          )
            callers.add(item.id);
        return {
          ...row,
          callable_version: published.at(-1) || 0,
          versions: published,
          caller_count: callers.size,
        };
      });
      return {
        ...window.spyderWorkflowManager.workflowPage(summaries, options),
        counts: window.spyderWorkflowManager.summarize(summaries),
        storage_error: null,
      };
    },
    async get(id, { signal } = {}) {
      await ensureUnified();
      return read("graphs", id, signal);
    },
    async save(value, { preserveEnabled = false } = {}) {
      await ensureUnified();
      if (!preserveEnabled)
        await window.spyderDemoWorkflowRuntime?.savedDisabled?.(value.id);
      const graph = JSON.parse(JSON.stringify({ ...value, enabled: preserveEnabled && value.enabled === true }));
      if (
        typeof graph.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(graph.id) ||
        typeof graph.name !== "string" ||
        !graph.name.trim() ||
        graph.name.length > 128 ||
        !Array.isArray(graph.nodes) ||
        !Array.isArray(graph.edges)
      )
        throw new Error("Invalid workflow library entry.");
      const latest = snapshots()
        .filter((item) => item.id === graph.id)
        .reduce((version, item) => Math.max(version, item.version), 0);
      if (latest) graph.callable_version = latest;
      else delete graph.callable_version;
      for (const node of graph.nodes)
        if (node.type === "subflow") {
          const target = await read("graphs", node.params?.subflow_id);
          if (target && !target.execution?.allow_calls)
            throw Error(
              "The selected workflow does not accept workflow calls.",
            );
        }
      if (graph.execution?.run_independently === false) graph.enabled = false;
      if (
        graph.execution?.allow_calls === false &&
        ((await this.referencesSubflow(graph.id)) ||
          publishedReferences(graph.id, graph.id))
      )
        throw Error(
          "Other workflows still call this workflow. Remove those references before disabling calls.",
        );
      return write(graph, graph.id);
    },
    async remove(id) {
      await ensureUnified();
      await window.spyderDemoWorkflowRuntime?.removeLocal?.(id);
      if ((await this.referencesSubflow(id)) || publishedReferences(id, id))
        throw Error(
          "This workflow is called by another workflow or published version. Remove those references first.",
        );
      const remaining = snapshots().filter((item) => item.id !== id);
      await write(null, id);
      localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(remaining));
      migratedText = null;
    },
  };
})();
