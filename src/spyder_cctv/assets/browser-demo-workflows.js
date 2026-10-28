/* Browser showcase workflow runtime. Uses only real per-frame motion metadata. */
(() => {
  "use strict";
  const KEY = "spyder.workflow.demo.enabled.v1";
  const EVENTS_KEY = "spyder.workflow.demo.events.v1";
  const MAX_EVENTS = 500;
  const workflows = new Map();
  let events = [];
  const cooldowns = new Map();
  const lastFrames = new Map();
  const rateLimits = new Map();
  const ownedRecordings = new Map();
  let unsubscribe = null;
  try {
    const text = localStorage.getItem(EVENTS_KEY) || "[]";
    if (new TextEncoder().encode(text).byteLength <= 2 * 1024 * 1024) {
      const stored = JSON.parse(text);
    if (Array.isArray(stored)) events = stored.filter((item) => item && typeof item.id === "string").slice(-MAX_EVENTS);
    }
  } catch { events = []; }

  function nodes(graph) {
    return new Map((Array.isArray(graph?.nodes) ? graph.nodes : []).filter((node) => node && typeof node === "object" && !Array.isArray(node)).map((node) => [node.id, node]));
  }
  function setBounded(map, key, value, maximum) {
    if (!map.has(key) && map.size >= maximum) map.delete(map.keys().next().value);
    map.set(key, value);
  }
  function descendants(graph, start) {
    const result = new Set(), pending = [start];
    while (pending.length) {
      const id = pending.pop();
      for (const edge of graph.edges || []) {
        if (edge.from === id && !result.has(edge.to)) {
          result.add(edge.to);
          pending.push(edge.to);
        }
      }
    }
    return result;
  }
  function inspect(graph) {
    const errors = [], map = nodes(graph), motionNodes = [...map.values()].filter((n) => n.type === "browser_motion");
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
      return { supported: false, errors: ["Workflow graph is invalid."] };
    if (typeof graph.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(graph.id))
      errors.push("Browser workflow ID must use 1 to 64 letters, numbers, underscores, or hyphens.");
    if (graph.execution?.run_independently === false)
      errors.push("Callable-only workflows cannot run independently in the browser showcase.");
    if (graph.nodes.length > 64 || graph.edges.length > 128)
      errors.push("Browser workflow exceeds its local limit of 64 nodes or 128 connections.");
    if ([...map.keys()].some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) || map.size !== graph.nodes.length)
      errors.push("Browser workflow node IDs must be unique letters, numbers, underscores, or hyphens, up to 64 characters.");
    const supported = new Set(["camera", "browser_motion", "cooldown", "event", "notification", "capture", "record"]);
    const unsupported = [...map.values()].filter((node) => !supported.has(node.type));
    if (unsupported.length)
      errors.push(`Unsupported browser workflow node(s): ${unsupported.map((node) => `${node.type} (${node.id})`).join(", ")}. Browser showcase supports Camera, Browser motion, Cooldown, Event, Notification, Capture, and Record only.`);
    if (motionNodes.length !== 1)
      errors.push("Add exactly one Browser motion source. Face, YOLO, InsightFace, Python, and subflow execution are unavailable in browser showcase.");
    const cameras = [...map.values()].filter((n) => n.type === "camera");
    if (!cameras.length || cameras.some((n) => !n.params?.camera_id))
      errors.push("Choose a browser clip camera in every Camera node.");
    const actions = [...map.values()].filter((n) => ["event", "notification", "capture", "record"].includes(n.type));
    if (!actions.length) errors.push("Connect motion to at least one Event, Notification, Capture, or Record action.");
    for (const camera of cameras) {
      if (!(graph.edges || []).some((e) => e.from === camera.id && map.get(e.to)?.type === "browser_motion"))
        errors.push(`Connect Camera ${camera.id} to Browser motion.`);
    }
    for (const motion of motionNodes) {
      if (!Number.isFinite(+motion.params?.threshold) || +motion.params.threshold < 0 || +motion.params.threshold > 1)
        errors.push(`Browser motion ${motion.id} threshold must be between 0 and 1.`);
      const reachable = descendants(graph, motion.id);
      if (![...reachable].some((id) => ["event", "notification", "capture", "record"].includes(map.get(id)?.type)))
        errors.push("Connect Browser motion through optional Cooldown to an Event, Notification, Capture, or Record action.");
      for (const id of reachable) {
        const node = map.get(id);
        if (node?.type === "cooldown" && (!Number.isFinite(+node.params?.seconds) || +node.params.seconds < 0 || +node.params.seconds > 3600))
          errors.push(`Cooldown ${id} must be between 0 and 3,600 seconds.`);
        if (node?.type === "record" && !["start", "stop"].includes(node.params?.action))
          errors.push(`Record ${id} action must be Start or Stop.`);
        if (node?.type === "event") {
          if (!["none", "capture"].includes(node.params?.attachment || "none"))
            errors.push(`Event ${id} recording attachments are unavailable in browser showcase. Use a Record node for a time-limited clip or choose Capture.`);
          if (node.params?.duration_seconds !== undefined && (!Number.isInteger(+node.params.duration_seconds) || +node.params.duration_seconds < 1 || +node.params.duration_seconds > 300))
            errors.push(`Event ${id} duration must be a whole number from 1 to 300 seconds.`);
        }
      }
    }
    const seenEdges = new Set(), validEdge = (edge) => {
      if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string" || edge.from === edge.to || !map.has(edge.from) || !map.has(edge.to)) return false;
      const key = `${edge.from}|${edge.to}`;
      if (seenEdges.has(key)) return false;
      seenEdges.add(key);
      const from = map.get(edge.from), to = map.get(edge.to);
      return from.type === "camera" ? to.type === "browser_motion" : from.type !== "camera" && to.type !== "camera" && to.type !== "browser_motion" && outputFlow(from) && outputFlow(to);
    };
    if (graph.edges.some((edge) => !validEdge(edge))) errors.push("Browser workflow has an invalid, duplicate, or incompatible connection. Connect Camera to Browser motion, then connect motion flow to supported actions.");
    const adjacency = new Map([...map.keys()].map((id) => [id, []]));
    for (const edge of graph.edges) if (edge && map.has(edge.from) && map.has(edge.to)) adjacency.get(edge.from).push(edge.to);
    const visiting = new Set(), visited = new Set();
    function cycle(id) {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const next of adjacency.get(id) || []) if (cycle(next)) return true;
      visiting.delete(id); visited.add(id); return false;
    }
    if ([...map.keys()].some(cycle)) errors.push("Browser workflow contains a cycle.");
    return { supported: errors.length === 0, errors, capabilities: ["browser clip motion fraction", "cooldown", "in-app notification", "local capture", "time-limited local recording", "one-second per-camera action rate limit"] };
  }
  function outputFlow(node) {
    return ["browser_motion", "cooldown", "event", "notification", "capture", "record"].includes(node?.type);
  }
  function camerasFor(graph) {
    return (graph.nodes || []).filter((node) => node.type === "camera").map((node) => node.params.camera_id);
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify([...workflows.values()].map((g) => g.id))); }
    catch { throw Error("Browser workflow activation state could not be saved."); }
  }
  function persistEvents() {
    events = events.slice(-MAX_EVENTS);
    const stored = events.map((event) => ({
      ...event,
      media: (event.media || []).map(({ url, ...media }) => media),
    }));
    const text = JSON.stringify(stored);
    if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024)
      throw Error("Browser workflow event storage reached its 2 MiB limit.");
    localStorage.setItem(EVENTS_KEY, text);
  }
  function addEvent(graph, cameraId, cameraName, action, frame, media = []) {
    const createdAt = new Date().toISOString(),
      values = { workflow: graph.name, camera: cameraName || cameraId, date: createdAt.slice(0, 10), time: createdAt.slice(11, 19), node: action.id, kind: "workflow", label: "motion" },
      name = String(action.params?.name_pattern || `${graph.name} · {camera} · {date} {time}`).replace(/\{([a-z_]+)\}/gi, (token, key) => Object.hasOwn(values, key) ? values[key] : token).slice(0, 200),
      row = {
        id: `browser-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        created_at: createdAt,
        name,
        message: String(action.params?.message || "Browser motion matched").slice(0, 500),
        camera_id: String(cameraId).slice(0, 128),
        camera_name: String(cameraName || cameraId).slice(0, 128),
        kind: "workflow",
        workflow_id: graph.id,
        workflow_name: graph.name,
        node_id: action.id,
        motion_fraction: Number(frame.motion_fraction),
        media: media.slice(0, 4),
      };
    events.push(row);
    try { persistEvents(); }
    catch (error) { events.pop(); window.spyder?.notify?.(error.message); }
    return row;
  }
  async function stopOwnedRecording(owner) {
    const recording = ownedRecordings.get(owner);
    if (!recording) return false;
    clearTimeout(recording.timer);
    ownedRecordings.delete(owner);
    const status = await window.spyderBrowserMedia?.status?.();
    if (status?.session_id !== recording.session_id || status?.state !== "recording") return false;
    await window.spyderShowcase.request("/api/recordings/stop", {});
    return true;
  }
  async function stopSession(sessionId) {
    const status = await window.spyderBrowserMedia?.status?.();
    if (status?.session_id !== sessionId || status?.state !== "recording") return false;
    await window.spyderShowcase.request("/api/recordings/stop", {});
    return true;
  }
  async function removeLocal(id) {
    if (!workflows.has(id) && ![...ownedRecordings.keys()].some((key) => key.startsWith(`${id}:`))) return;
    workflows.delete(id);
    for (const key of [...cooldowns.keys()]) if (key.startsWith(`${id}:`)) cooldowns.delete(key);
    for (const key of [...rateLimits.keys()]) if (key.startsWith(`${id}:`)) rateLimits.delete(key);
    for (const key of [...ownedRecordings.keys()]) {
      if (!key.startsWith(`${id}:`)) continue;
      try { await stopOwnedRecording(key); }
      catch (error) { window.spyder?.notify?.(`Workflow recording could not stop: ${error.message}`); }
    }
    persist();
    if (!workflows.size) { unsubscribe?.(); unsubscribe = null; lastFrames.clear(); }
  }
  async function enable(graph) {
    const report = inspect(graph);
    if (!report.supported) throw Error(report.errors.join(" "));
    if (!window.spyderWorkflowStore) throw Error("Browser workflow storage is unavailable.");
    if (!window.spyderShowcase?.subscribeFrames) throw Error("Browser camera frame events are unavailable. Refresh the browser showcase before enabling workflows.");
    if (!window.spyderShowcase?.request) throw Error("Browser clip camera source is unavailable.");
    if (!window.spyderShowcase.fetch) throw Error("Browser clip camera list is unavailable.");
    const cameraResponse = await window.spyderShowcase.fetch("/api/cameras"),
      statuses = await cameraResponse.json(),
      available = new Set((Array.isArray(statuses) ? statuses : statuses?.cameras || []).map((camera) => String(camera.id)));
    const missing = camerasFor(graph).filter((id) => !available.has(String(id)));
    if (missing.length) throw Error(`Selected browser clip camera is unavailable: ${missing.join(", ")}. Choose an imported clip from the current camera list.`);
    if (!workflows.has(graph.id) && workflows.size >= 32)
      throw Error("Browser workflow runtime limit reached (32 enabled workflows). Disable one before enabling another.");
    const saved = { ...JSON.parse(JSON.stringify(graph)), enabled: true };
    await window.spyderWorkflowStore.save(saved, { preserveEnabled: true });
    workflows.set(saved.id, saved);
    try { persist(); } catch (error) {
      workflows.delete(saved.id);
      await window.spyderWorkflowStore.save({ ...saved, enabled: false });
      throw error;
    }
    ensureSubscription();
    return saved;
  }
  async function disable(id) {
    const graph = workflows.get(id) || await window.spyderWorkflowStore?.get(id);
    if (graph && window.spyderWorkflowStore)
      await window.spyderWorkflowStore.save({ ...graph, enabled: false });
    await removeLocal(id);
    return graph ? { ...graph, enabled: false } : null;
  }
  function ensureSubscription() {
    if (unsubscribe || !window.spyderShowcase?.subscribeFrames) return;
    unsubscribe = window.spyderShowcase.subscribeFrames(onFrame);
  }
  async function fire(graph, cameraId, action, frame) {
    if (workflows.get(graph.id) !== graph) return;
    const actionKey = `${graph.id}:${cameraId}:action:${action.id}`;
    if (frame.timestamp < (cooldowns.get(actionKey) || 0)) return;
    setBounded(cooldowns, actionKey, frame.timestamp + 1000, 4096);
    const message = action.params?.message || graph.name || "Browser motion detected";
    if (action.type === "notification") {
      window.spyder?.notify?.(`${action.params?.title || graph.name}: ${message}`);
    } else if (action.type === "event") {
      let media = [];
      if (action.params?.attachment === "capture") {
        const item = await window.spyderShowcase.request("/api/captures", { camera_ids: [cameraId] });
        if (workflows.get(graph.id) !== graph) return;
        if (item?.url && item?.kind === "capture") media = [{ id: item.id, kind: item.kind, filename: item.filename, url: item.url, size_bytes: item.size_bytes }];
      }
      if (workflows.get(graph.id) !== graph) return;
      addEvent(graph, cameraId, frame.camera.name, action, frame, media);
      window.spyder?.notify?.(`${graph.name}: ${message}`);
    } else if (action.type === "capture") {
      const item = await window.spyderShowcase?.request?.("/api/captures", { camera_ids: [cameraId] });
      if (workflows.get(graph.id) !== graph) return;
      if (item?.url && item?.kind === "capture")
        addEvent(graph, cameraId, frame.camera.name, { id: action.id, params: { message: "Browser motion capture saved", name_pattern: `${graph.name} · {camera} · {date} {time}` } }, frame, [{ id: item.id, kind: item.kind, filename: item.filename, url: item.url, size_bytes: item.size_bytes }]);
    } else if (action.type === "record") {
      const owner = `${graph.id}:${cameraId}:${action.id}`;
      if (action.params?.action === "stop") {
        if (!(await stopOwnedRecording(owner))) window.spyder?.notify?.("This workflow does not own the current recording session.");
      } else {
        if (ownedRecordings.has(owner)) return;
        if (!window.spyderBrowserMedia?.status)
          throw Error("Browser recording is unavailable. Load local browser media support first.");
        const status = await window.spyderBrowserMedia.status();
        if (workflows.get(graph.id) !== graph) return;
        if (["recording", "stopping"].includes(status?.state))
          throw Error("Recording is already active. Workflow will not take ownership of manual recording.");
        const response = await window.spyderShowcase.request("/api/recordings/start", { camera_ids: [cameraId] });
        if (typeof response?.session_id !== "string" || !response.session_id)
          throw Error("Browser recorder did not return a session ID. Workflow will not take ownership of this recording.");
        if (workflows.get(graph.id) !== graph) {
          await stopSession(response.session_id);
          return;
        }
        const event = [...descendants(graph, action.id)].map((id) => nodes(graph).get(id)).find((node) => node?.type === "event"),
          duration = Math.max(1, Math.min(300, Number(event?.params?.duration_seconds) || 10)),
          timer = setTimeout(() => {
            if (ownedRecordings.get(owner)?.timer !== timer) return;
            void stopOwnedRecording(owner).catch((error) => window.spyder?.notify?.(`Workflow recording stop failed: ${error.message}`));
          }, duration * 1000);
        ownedRecordings.set(owner, { timer, session_id: response.session_id });
      }
    }
  }
  function onFrame(frame) {
    if (!frame?.camera || !Number.isFinite(frame.motion_fraction) || !Number.isFinite(frame.frameId)) return;
    const cameraId = frame.camera.id, seenKey = String(cameraId);
    if (lastFrames.get(seenKey) === frame.frameId) return;
    lastFrames.set(seenKey, frame.frameId);
    while (lastFrames.size > 32) lastFrames.delete(lastFrames.keys().next().value);
    for (const graph of workflows.values()) {
      const map = nodes(graph);
      for (const camera of map.values()) {
        if (camera.type !== "camera" || camera.params?.camera_id !== cameraId) continue;
        for (const motion of map.values()) {
          if (motion.type !== "browser_motion" || !(graph.edges || []).some((e) => e.from === camera.id && e.to === motion.id)) continue;
          if (frame.motion_fraction < Number(motion.params.threshold ?? 0.1)) continue;
          const rateKey = `${graph.id}:${cameraId}:rate`;
          if (frame.timestamp < (rateLimits.get(rateKey) || 0)) continue;
          const adjacency = new Map([...map.keys()].map((id) => [id, []]));
          for (const edge of graph.edges || []) adjacency.get(edge.from)?.push(edge.to);
          const queue = [...(adjacency.get(motion.id) || [])], visited = new Set();
          let firstAction = true;
          while (queue.length) {
            const id = queue.shift();
            if (visited.has(id)) continue;
            visited.add(id);
            const node = map.get(id);
            if (!node) continue;
            if (node.type === "cooldown") {
              const key = `${graph.id}:${cameraId}:${node.id}`, until = cooldowns.get(key) || 0;
              if (frame.timestamp < until) continue;
              setBounded(cooldowns, key, frame.timestamp + Number(node.params.seconds || 0) * 1000, 4096);
            }
            if (["event", "notification", "capture", "record"].includes(node.type)) {
              if (firstAction) {
                setBounded(rateLimits, rateKey, frame.timestamp + 1000, 2048);
                firstAction = false;
              }
              void fire(graph, cameraId, node, frame).catch((error) => {
                if (workflows.get(graph.id) === graph)
                  window.spyder?.notify?.(`Workflow action failed: ${error.message}`);
              });
            }
            queue.push(...(adjacency.get(id) || []));
          }
        }
      }
    }
  }
  async function restore() {
    if (!window.spyderWorkflowStore) return;
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return; }
    if (!Array.isArray(ids)) return;
    for (const id of ids.slice(0, 32)) {
      try {
        const graph = await window.spyderWorkflowStore.get(id);
        if (graph?.enabled && inspect(graph).supported) workflows.set(id, graph);
      } catch { /* Keep unavailable saved workflows disabled. */ }
    }
    if (workflows.size) ensureSubscription();
  }
  async function request(path, data = {}) {
    if (path === "/api/events/delete") {
      const ids = new Set(Array.isArray(data.ids) ? data.ids.filter((id) => typeof id === "string") : []), before = events.length;
      events = events.filter((event) => !ids.has(event.id));
      persistEvents();
      return { deleted: before - events.length };
    }
    const rename = /^\/api\/events\/([^/]+)\/rename$/.exec(path);
    if (rename) {
      const id = decodeURIComponent(rename[1]), event = events.find((item) => item.id === id);
      if (!event) throw Error("Workflow event no longer exists.");
      if (typeof data.name !== "string" || !data.name.trim() || data.name.length > 200) throw Error("Event name must contain 1 to 200 characters.");
      event.name = data.name.trim();
      persistEvents();
      return { event: { ...event } };
    }
    return undefined;
  }
  async function fetch(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url;
    if (typeof url !== "string" || !url.split("?")[0].endsWith("/api/events") || (init.method || input?.method || "GET").toUpperCase() !== "GET") return undefined;
    return new Response(JSON.stringify({ events: [...events].reverse(), retention_limit: MAX_EVENTS, storage_error: null }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  window.spyderDemoWorkflowRuntime = { inspect, enable, disable, removeLocal, savedDisabled: removeLocal, request, fetch, active: () => [...workflows.values()].map((g) => g.id) };
  restore();
})();
