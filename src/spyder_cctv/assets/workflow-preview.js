"use strict";
(() => {
  // Only camera ancestors of this branch can supply its video.
  function cameraIds(graph, nodeId) {
    const seen = new Set(),
      ids = new Set();
    let hasCamera = false;
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const n = graph.nodes.find((item) => item.id === id);
      if (n?.type === "camera") {
        hasCamera = true;
        if (n.params.camera_id) ids.add(n.params.camera_id);
      }
      for (const edge of graph.edges.filter((e) => e.to === id))
        visit(edge.from);
    };
    visit(nodeId);
    // Legacy workflows select cameras in the sidebar instead of Camera nodes.
    if (!hasCamera) for (const id of graph.camera_ids || []) ids.add(id);
    return [...ids];
  }
  function previewGraph(graph, nodeId) {
    const ids = new Set();
    const visit = (id) => {
      if (ids.has(id)) return;
      ids.add(id);
      for (const edge of graph.edges.filter((e) => e.to === id))
        visit(edge.from);
    };
    visit(nodeId);
    const nodes = graph.nodes.filter((n) => ids.has(n.id));
    return {
      id: graph.id,
      name: "Workflow preview",
      enabled: false,
      camera_ids: nodes.some((n) => n.type === "camera")
        ? []
        : [...(graph.camera_ids || [])],
      nodes: nodes.map((node) => ({ ...node, x: 0, y: 0 })),
      edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    };
  }
  function branchKey(graph, nodeId) {
    const branch = previewGraph(graph, nodeId);
    const nodes = branch.nodes;
    // Coordinates, workflow name/enabled state and unrelated branches cannot
    // change this monitor's data. Sort objects and edges to ignore save ordering.
    const stable = (value) => {
      if (Array.isArray(value)) return value.map(stable);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        );
      return value;
    };
    return JSON.stringify(
      stable({
        nodes: nodes
          .map(({ id, type, params, bindings }) => ({
            id,
            type,
            params,
            bindings: bindings || {},
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        edges: branch.edges
          .map((e) => ({
            from: e.from,
            to: e.to,
            input: e.input || "detections",
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        camera_ids: [...branch.camera_ids].sort(),
      }),
    );
  }
  function drawOverlay(context, detections, frameSize, width, height) {
    if (
      !Array.isArray(frameSize) ||
      !frameSize.every((v) => Number.isFinite(v) && v > 0)
    )
      return;
    const [fw, fh] = frameSize;
    context.lineWidth = Math.max(2, width / 320);
    context.font = `${Math.max(13, Math.round(width / 40))}px sans-serif`;
    context.textBaseline = "top";
    for (const d of (detections || []).slice(0, 500)) {
      const box = d?.bbox;
      if (
        !Array.isArray(box) ||
        box.length !== 4 ||
        !box.every(Number.isFinite)
      )
        continue;
      const [x1, y1, x2, y2] = box;
      if (x2 <= x1 || y2 <= y1) continue;
      const x = Math.max(0, Math.min(width, (x1 * width) / fw));
      const y = Math.max(0, Math.min(height, (y1 * height) / fh));
      const w = Math.max(0, Math.min(width, (x2 * width) / fw) - x);
      const h = Math.max(0, Math.min(height, (y2 * height) / fh) - y);
      const label = String(d.identity || d.label || "Detection").slice(0, 100);
      context.strokeStyle = "#F7D87F";
      context.strokeRect(x, y, w, h);
      const textWidth = Math.min(width, context.measureText(label).width + 8);
      const textY = Math.max(0, y - 22);
      context.fillStyle = "#830000";
      context.fillRect(x, textY, textWidth, 22);
      context.fillStyle = "#F8EBAB";
      context.fillText(label, x + 4, textY + 3, Math.max(1, width - x - 4));
    }
  }
  function create(root, options) {
    const states = new Map();
    let disposed = false,
      timer,
      cycling = false,
      generation = 0;
    const graphKey = (nodeId) => branchKey(options.graph(), nodeId);
    function cancel(state) {
      state.request?.abort();
      state.request = null;
      state.generation++;
    }
    function paint(state) {
      const panel = root.querySelector(`[data-preview="${state.id}"]`);
      if (!panel) return;
      const button = panel.querySelector("[data-preview-toggle]");
      button.textContent = state.running ? "Pause preview" : "Start preview";
      button.setAttribute("aria-pressed", String(state.running));
      button.disabled = !!options.demo;
      const select = panel.querySelector("[data-preview-camera]");
      const ids = cameraIds(options.graph(), state.id);
      const cameras = options.cameras();
      const key = JSON.stringify(
        ids.map((id) => [id, cameras.find((c) => c.id === id)?.name || id]),
      );
      if (select.dataset.options !== key) {
        select.replaceChildren();
        for (const id of ids) {
          const item = document.createElement("option");
          item.value = id;
          item.textContent = cameras.find((c) => c.id === id)?.name || id;
          select.append(item);
        }
        select.dataset.options = key;
      }
      select.value = state.camera;
      select.disabled = ids.length < 2 || !!options.demo;
      const placeholder = panel.querySelector(".we-preview-placeholder");
      placeholder.hidden = state.hasFrame;
      placeholder.textContent = options.demo
        ? "Local app preview only"
        : state.running
          ? "Waiting for camera…"
          : "Preview paused";
      panel.querySelector(".we-preview-status").textContent = options.demo
        ? "Preview execution is available in the installed local app."
        : state.message || "Connect a Camera or detection branch.";
      panel.classList.toggle("is-paused", !state.running);
      const canvas = panel.querySelector("canvas");
      if (state.canvas && canvas !== state.canvas)
        canvas.replaceWith(state.canvas);
      else state.canvas = canvas;
    }
    function sync() {
      if (disposed) return;
      const graph = options.graph();
      for (const [id, state] of states) {
        if (
          !graph.nodes.some((n) => n.id === id && n.type === "preview") ||
          state.workflow !== graph.id
        ) {
          cancel(state);
          states.delete(id);
        }
      }
      for (const node of graph.nodes.filter((n) => n.type === "preview")) {
        const key = graphKey(node.id);
        let state = states.get(node.id);
        if (!state) {
          state = {
            id: node.id,
            workflow: graph.id,
            running: false,
            generation: 0,
            hasFrame: false,
            camera: "",
          };
          states.set(node.id, state);
        }
        const ids = cameraIds(graph, node.id);
        if (state.key !== key) {
          cancel(state);
          state.key = key;
          if (!ids.includes(state.camera)) state.camera = ids[0] || "";
          state.hasFrame = false;
          state.canvas
            ?.getContext("2d")
            ?.clearRect(0, 0, state.canvas.width, state.canvas.height);
          state.message = state.running
            ? "Workflow changed · refreshing branch…"
            : "Paused · start to inspect this branch. Preview does not run action nodes.";
        }
        paint(state);
      }
    }
    async function fetchJSON(path, body, signal) {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Spyder-Control": "1",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal,
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Preview unavailable");
      return data;
    }
    async function update(state) {
      if (!state.camera) {
        state.message = "Connect a Camera node, or select a workflow camera.";
        paint(state);
        return;
      }
      const request = new AbortController();
      state.request = request;
      const token = state.generation;
      const timeout = setTimeout(() => request.abort(), 5000);
      const current = () =>
        !disposed &&
        state.running &&
        token === state.generation &&
        state.key === graphKey(state.id);
      let bitmap;
      try {
        const data = await fetchJSON(
          "/api/workflows/preview",
          {
            // Unrelated invalid draft nodes and unfinished workflow names must
            // never break validation of this monitor's otherwise valid branch.
            workflow: previewGraph(options.graph(), state.id),
            node_id: state.id,
            camera_id: state.camera,
          },
          request.signal,
        );
        if (!current()) return;
        if (data.camera_id !== state.camera)
          throw Error("Preview camera changed. Reconnect the branch.");
        if (data.state !== "running") {
          state.hasFrame = false;
          state.canvas
            ?.getContext("2d")
            ?.clearRect(0, 0, state.canvas.width, state.canvas.height);
          state.message =
            data.message || "Start the connected camera to preview.";
          paint(state);
          return;
        }
        const response = await fetch(
          `/api/cameras/${encodeURIComponent(state.camera)}/preview-frame`,
          { cache: "no-store", signal: request.signal },
        );
        if (!response.ok)
          throw Error("Camera frame unavailable. Check the camera is running.");
        bitmap = await createImageBitmap(await response.blob());
        if (!current()) return;
        const canvas = state.canvas;
        // Keep preview decode/draw memory bounded even with high resolution cameras.
        const ratio = Math.min(1, 960 / bitmap.width, 720 / bitmap.height);
        canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
        canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        drawOverlay(
          context,
          data.detections,
          data.frame_size,
          canvas.width,
          canvas.height,
        );
        state.hasFrame = true;
        state.message = `${data.detections?.length || 0} matching detections · ${data.engine || "camera"} · ${data.message || "Live branch preview"}`;
        paint(state);
      } catch (error) {
        if (!current()) return;
        state.hasFrame = false;
        state.canvas
          ?.getContext("2d")
          ?.clearRect(0, 0, state.canvas.width, state.canvas.height);
        state.message =
          error.name === "AbortError"
            ? "Preview timed out · retrying…"
            : error.message;
        paint(state);
      } finally {
        bitmap?.close();
        clearTimeout(timeout);
        if (state.request === request) state.request = null;
      }
    }
    async function cycle() {
      if (disposed || cycling) return;
      cycling = true;
      const token = generation;
      try {
        sync();
        for (const state of states.values()) {
          if (disposed || token !== generation) break;
          if (state.running && !document.hidden && !options.demo)
            await update(state);
        }
      } finally {
        cycling = false;
        if (!disposed) timer = setTimeout(cycle, 400);
      }
    }
    function click(event) {
      const button = event.target.closest("[data-preview-toggle]");
      if (!button || options.demo) return;
      const state = states.get(
        button.closest("[data-preview]").dataset.preview,
      );
      if (!state) return;
      state.running = !state.running;
      cancel(state);
      state.message = state.running
        ? "Starting branch preview…"
        : "Paused · last frame frozen. Camera and workflow continue running.";
      paint(state);
      clearTimeout(timer);
      cycle();
    }
    function change(event) {
      const select = event.target.closest("[data-preview-camera]");
      if (!select) return;
      const state = states.get(
        select.closest("[data-preview]").dataset.preview,
      );
      if (!state) return;
      cancel(state);
      state.camera = select.value;
      state.hasFrame = false;
      state.message = "Camera changed · waiting for a fresh frame…";
      state.canvas
        ?.getContext("2d")
        ?.clearRect(0, 0, state.canvas.width, state.canvas.height);
      paint(state);
    }
    function visibility() {
      if (document.hidden)
        for (const state of states.values()) {
          cancel(state);
          if (state.running) {
            state.message = "Preview suspended while this tab is hidden.";
            paint(state);
          }
        }
    }
    root.addEventListener("click", click);
    root.addEventListener("change", change);
    document.addEventListener("visibilitychange", visibility);
    timer = setTimeout(cycle, 400);
    return {
      sync,
      destroy() {
        disposed = true;
        generation++;
        clearTimeout(timer);
        for (const state of states.values()) cancel(state);
        states.clear();
        root.removeEventListener("click", click);
        root.removeEventListener("change", change);
        document.removeEventListener("visibilitychange", visibility);
      },
    };
  }
  if (typeof module !== "undefined" && module.exports)
    module.exports = {
      cameraIds,
      previewGraph,
      branchKey,
      drawOverlay,
      create,
    };
  if (typeof window !== "undefined") window.spyderWorkflowPreview = { create };
})();
