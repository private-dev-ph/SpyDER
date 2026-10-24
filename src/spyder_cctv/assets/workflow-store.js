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
  window.spyderWorkflowStore = {
    async referencesSubflow(id) {
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
      const summaries = await read("summaries", undefined, signal);
      return {
        ...window.spyderWorkflowManager.workflowPage(summaries, options),
        counts: window.spyderWorkflowManager.summarize(summaries),
        storage_error: null,
      };
    },
    get(id, { signal } = {}) {
      return read("graphs", id, signal);
    },
    async save(value) {
      const graph = JSON.parse(JSON.stringify({ ...value, enabled: false }));
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
      return write(graph, graph.id);
    },
    remove(id) {
      return write(null, id);
    },
  };
})();
