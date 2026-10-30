"use strict";
(() => {
  const TYPES = {
    camera: { label: "Camera", params: { camera_id: "" } },
    browser_motion: { label: "Browser motion", params: { threshold: 0.1, mog2_threshold:0.02, roi: [0,0,1,1] } },
    model: { label: "Model", params: { model_id: "builtin-scrfd-500mf" } },
    classifier: {
      label: "Classifier",
      params: {
        model_id: "",
        threshold: 0.5,
        output: "probabilities",
        preprocessing: "arcface",
        confirmations: 3,
        switch_confirmations: 5,
        margin: 0.15,
      },
    },
    detections: {
      label: "Detections",
      params: { engine: "any" },
    },
    filter: {
      label: "Filter",
      params: {
        label: "",
        confidence: 0.5,
        identity_source: "identity",
        identity: "",
        rules: [],
        match: "all",
      },
    },
    zone: { label: "Zone", params: { roi: [0, 0, 1, 1] } },
    count: { label: "Count", params: { minimum: 1 } },
    cooldown: { label: "Cooldown", params: { seconds: 10 } },
    event: {
      label: "Event",
      params: {
        message: "Detection matched",
        name_pattern: "{workflow} · {camera} · {date} {time} · {node}",
        attachment: "none",
        duration_seconds: 10,
        pre_event_seconds: 0,
      },
    },
    notification: {
      label: "Notification",
      params: { title: "SpyDER detection", message: "Matching face detected" },
    },
    preview: { label: "Preview", params: {} },
    capture: { label: "Capture", params: {} },
    record: { label: "Record", params: { action: "start" } },
    code: {
      label: "Code",
      params: { language: "python", source: "output = detections" },
    },
    subflow: {
      label: "Call workflow",
      params: { subflow_id: "", version: 1, arguments: {} },
    },
    subflow_input: { label: "Workflow input", params: {} },
    subflow_output: { label: "Workflow output", params: {} },
  };
  const NODE_GROUPS = [
    { label: "Inputs & models", types: ["camera", "browser_motion", "model", "classifier"] },
    {
      label: "Vision & conditions",
      types: ["detections", "filter", "zone", "count"],
    },
    {
      label: "Flow & code",
      types: ["cooldown", "code", "subflow", "subflow_input", "subflow_output"],
    },
    {
      label: "Views & actions",
      types: ["preview", "event", "notification", "capture", "record"],
    },
  ];
  function workflowHistory(graph) {
    return (
      graph?.history || {
        enabled: true,
        states: ["completed", "filtered", "error"],
        min_interval_seconds: 0,
        always_save_errors: true,
      }
    );
  }
  function validHistory(policy) {
    return (
      policy &&
      typeof policy === "object" &&
      !Array.isArray(policy) &&
      Object.keys(policy).sort().join() ===
        "always_save_errors,enabled,min_interval_seconds,states" &&
      typeof policy.enabled === "boolean" &&
      typeof policy.always_save_errors === "boolean" &&
      Number.isInteger(policy.min_interval_seconds) &&
      policy.min_interval_seconds >= 0 &&
      policy.min_interval_seconds <= 86400 &&
      Array.isArray(policy.states) &&
      policy.states.length > 0 &&
      policy.states.length <= 3 &&
      new Set(policy.states).size === policy.states.length &&
      policy.states.every((state) =>
        ["completed", "filtered", "error"].includes(state),
      )
    );
  }
  function workflowExecution(graph) {
    return {
      run_independently: graph.execution?.run_independently ?? true,
      allow_calls: graph.execution?.allow_calls ?? false,
      parameters: graph.execution?.parameters || [],
      description: graph.execution?.description || "",
    };
  }
  function paletteGroups(query = "") {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return NODE_GROUPS.map((group) => ({
      ...group,
      types: group.types.filter((type) =>
        words.every((word) =>
          `${TYPES[type].label} ${type} ${group.label}`
            .toLowerCase()
            .includes(word),
        ),
      ),
    })).filter((group) => group.types.length);
  }
  function modelPage(
    models,
    {
      query = "",
      engine = "all",
      labels = "all",
      sort = "name",
      page = 0,
      size = 8,
    } = {},
  ) {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = models.filter((model) => {
      const hasLabels = !!model.classes?.length;
      if (engine !== "all" && model.engine !== engine) return false;
      if (
        (labels === "available" && !hasLabels) ||
        (labels === "missing" && hasLabels)
      )
        return false;
      const text = [
        model.name,
        model.engine,
        model.path,
        model.metadata?.model_type,
        ...(model.classes || []),
      ]
        .join(" ")
        .toLowerCase();
      return words.every((word) => text.includes(word));
    });
    const byName = (a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        numeric: true,
        sensitivity: "base",
      }) || String(a.id).localeCompare(String(b.id));
    if (sort === "name-desc") filtered.sort((a, b) => -byName(a, b));
    else if (sort === "engine")
      filtered.sort(
        (a, b) =>
          String(a.engine).localeCompare(String(b.engine)) || byName(a, b),
      );
    else filtered.sort(byName);
    size = Math.max(1, Math.min(24, Math.floor(size) || 8));
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    page = Math.max(0, Math.min(pages - 1, Math.floor(page) || 0));
    return {
      models: filtered.slice(page * size, (page + 1) * size),
      page,
      pages,
      total: filtered.length,
      all: models.length,
      size,
    };
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const BUILTIN_MODELS = [
    {
      id: "builtin-scrfd-500mf",
      detector: "scrfd-500mf",
      name: "SCRFD 500MF · light default",
      engine: "insightface",
      classes: ["face"],
    },
    {
      id: "builtin-scrfd-2-5gf",
      detector: "scrfd-2.5gf",
      name: "SCRFD 2.5GF · balanced",
      engine: "insightface",
      classes: ["face"],
    },
    {
      id: "builtin-scrfd-10gf",
      detector: "scrfd-10gf",
      name: "SCRFD 10GF · heavier",
      engine: "insightface",
      classes: ["face"],
    },
  ];
  const builtinModel = (id) => BUILTIN_MODELS.find((model) => model.id === id);
  function migrateDetectorNodes(value) {
    const graph = clone(value);
    for (const item of graph.nodes)
      if (item.type === "classifier")
        item.params = { ...clone(TYPES.classifier.params), ...item.params };
    for (const detection of [...graph.nodes]) {
      if (
        detection.type !== "detections" ||
        detection.params.engine !== "insightface" ||
        !Object.hasOwn(detection.params, "detector")
      )
        continue;
      const connected = graph.edges.some(
        (edge) =>
          edge.to === detection.id && inputType(edge, graph.nodes) === "model",
      );
      if (connected) {
        delete detection.params.detector;
        continue;
      }
      const builtin = BUILTIN_MODELS.find(
        (model) => model.detector === detection.params.detector,
      );
      if (!builtin || graph.nodes.length >= 64 || graph.edges.length >= 128)
        continue;
      const stem = `detector-${detection.id}`.slice(0, 58);
      let id = stem,
        index = 1;
      while (graph.nodes.some((node) => node.id === id))
        id = `${stem}-${index++}`;
      graph.nodes.push({
        id,
        type: "model",
        x: clamp(detection.x - 240),
        y: clamp(detection.y + 150),
        params: { model_id: builtin.id },
      });
      graph.edges.push({ from: id, to: detection.id, input: "model" });
      delete detection.params.detector;
    }
    return graph;
  }

  const SIGNALS = {
    classes: ["Model classes", "strings"],
    labels: ["Detected classes", "strings"],
    identities: ["Recognized identities", "strings"],
    confidence: ["Highest confidence", "number"],
    count: ["Detection count", "integer"],
    camera_id: ["Camera ID", "string"],
    engine: ["Engine", "string"],
    model_id: ["Model ID", "string"],
  };
  function signalNames(n) {
    return n?.type === "model"
      ? ["classes", "engine", "model_id"]
      : n?.type === "classifier"
        ? ["classes", "model_id"]
        : n?.type === "camera"
          ? ["camera_id", "engine"]
          : [
              "classes",
              "labels",
              "identities",
              "confidence",
              "count",
              "camera_id",
              "engine",
            ];
  }
  function upstreamIds(graph, id) {
    const visited = new Set(),
      pending = [id];
    while (pending.length) {
      const next = pending.pop();
      for (const edge of graph.edges || [])
        if (edge.to === next && !visited.has(edge.from)) {
          visited.add(edge.from);
          pending.push(edge.from);
        }
    }
    visited.delete(id);
    return visited;
  }
  function fieldType(n, field) {
    if (n?.type === "filter") {
      if (["label", "identity"].includes(field)) return "strings";
      if (field === "confidence") return "number";
      const rule = /^rules\.(\d+)\.value$/.exec(field);
      if (
        rule &&
        ["is_unknown", "is_known"].includes(
          n.params.rules?.[+rule[1]]?.operator,
        )
      )
        return null;
      if (rule && n.params.rules?.[+rule[1]])
        return n.params.rules[+rule[1]].field === "confidence"
          ? "number"
          : "strings";
    }
    if (
      (n?.type === "event" && ["message", "name_pattern"].includes(field)) ||
      (n?.type === "notification" && ["title", "message"].includes(field))
    )
      return "text";
    if (
      (n?.type === "count" && field === "minimum") ||
      (n?.type === "cooldown" && field === "seconds")
    )
      return "integer";
    return null;
  }
  function canBind(graph, target, field, binding) {
    if (
      !binding ||
      typeof binding !== "object" ||
      Array.isArray(binding) ||
      Object.keys(binding).sort().join() !== "node,signal"
    )
      return false;
    const source = graph.nodes.find((n) => n.id === binding.node),
      type = fieldType(target, field),
      signal = SIGNALS[binding.signal]?.[1];
    return (
      !!source &&
      upstreamIds(graph, target.id).has(source.id) &&
      signalNames(source).includes(binding.signal) &&
      ((["text", "strings"].includes(type) &&
        ["string", "strings"].includes(signal)) ||
        type === signal)
    );
  }
  function pruneBindings(graph) {
    let removed = 0;
    for (const n of graph.nodes)
      for (const [field, binding] of Object.entries(n.bindings || {})) {
        if (!canBind(graph, n, field, binding)) {
          delete n.bindings[field];
          removed++;
        }
      }
    for (const n of graph.nodes)
      if (n.bindings && !Object.keys(n.bindings).length) delete n.bindings;
    return removed;
  }
  function formatNodeStatus(status) {
    const timestamp = `${status.camera_id ? ` · ${status.camera_id}` : ""}${status.last_run_at ? ` · ${status.last_run_at}` : ""}`;
    if (status.state === "error")
      return `Last run: error · ${status.error || "Unknown error"}${timestamp}`;
    if (status.state === "skipped")
      return `Last run: skipped · ${status.input_count || 0} in / ${status.output_count || 0} out${timestamp}`;
    return `Last run: OK · ${status.input_count || 0} in / ${status.output_count || 0} out${timestamp}`;
  }
  const clamp = (v) =>
    Math.max(0, Math.min(5000, Number.isFinite(+v) ? +v : 0));
  const VIEW_MIN = 0.25,
    VIEW_MAX = 2,
    clampViewScale = (value) =>
      Math.max(VIEW_MIN, Math.min(VIEW_MAX, +value || 1)),
    canvasDelta = (delta, scale = 1) => delta / clampViewScale(scale),
    canvasPoint = (client, origin, scale = 1) =>
      canvasDelta(client - origin, scale);
  const node = (type, x = 40, y = 40) => ({
    id: `node-${Math.random().toString(36).slice(2, 10)}`,
    type,
    x: clamp(x),
    y: clamp(y),
    params: clone(TYPES[type]?.params || {}),
  });
  const nodeSize = (n) =>
    n?.type === "preview"
      ? { width: 320, height: 340 }
      : { width: 164, height: 76 };
  const outputType = (n) =>
    n?.type === "camera"
      ? "camera"
      : n?.type === "browser_motion"
        ? "detections"
      : n?.type === "model"
        ? "model"
        : n?.type === "classifier"
          ? "classifier"
          : "detections";
  const inputType = (e, nodes) =>
    e.input || outputType(nodes.find((n) => n.id === e.from));
  function duplicateNode(graph, selectedId, offset = 36) {
    const source = graph.nodes.find((item) => item.id === selectedId);
    if (!source || graph.nodes.length >= 64) return null;
    const copy = clone(source),
      ids = new Set(graph.nodes.map((item) => item.id));
    const stem = `${source.id}-copy`.slice(0, 54);
    copy.id = stem;
    for (let index = 1; ids.has(copy.id); index++) copy.id = `${stem}-${index}`;
    copy.x = clamp(source.x + offset);
    copy.y = clamp(source.y + offset);
    if (copy.bindings)
      for (const binding of Object.values(copy.bindings))
        if (binding?.node === source.id) binding.node = copy.id;
    graph.nodes.push(copy);
    pruneBindings(graph);
    return copy;
  }
  function edgeFor(from, to, nodes) {
    const input = outputType(nodes.find((n) => n.id === from));
    return input === "detections" ? { from, to } : { from, to, input };
  }
  function accepts(source, target, input = outputType(source)) {
    if (
      !source ||
      !target ||
      source.id === target.id ||
      source.type === "preview" ||
      target.type === "subflow_input" ||
      ["camera", "model", "classifier"].includes(target.type)
    )
      return false;
    return (
      input === outputType(source) &&
      (target.type === "browser_motion"
        ? input === "camera"
        : target.type === "detections"
        ? ["camera", "model", "classifier", "detections"].includes(input) &&
          (input !== "classifier" || target.params?.engine === "insightface")
        : target.type === "preview"
          ? ["camera", "detections"].includes(input)
          : input === "detections")
    );
  }
  function encodeWorkflow(graph, models = []) {
    return JSON.stringify(
      {
        format: "spyder-workflow",
        version: 1,
        workflow: clone(graph),
        models: models
          .filter((m) =>
            graph.nodes.some(
              (n) =>
                ["model", "classifier"].includes(n.type) &&
                n.params.model_id === m.id,
            ),
          )
          .map(({ id, name, engine, classes }) => ({
            id,
            name,
            engine,
            classes,
          })),
      },
      null,
      2,
    );
  }
  function decodeWorkflow(text, cameras = [], models = []) {
    if (
      typeof text !== "string" ||
      new TextEncoder().encode(text).length > 1024 * 1024
    )
      throw Error("Workflow import exceeds 1 MiB.");
    const document = JSON.parse(text);
    if (
      document.format &&
      (document.format !== "spyder-workflow" || document.version !== 1)
    )
      throw Error("Unsupported workflow format or version.");
    const graph = clone(document.workflow || document);
    if (
      !graph ||
      typeof graph !== "object" ||
      Array.isArray(graph) ||
      !Array.isArray(graph.nodes) ||
      !Array.isArray(graph.edges) ||
      !Array.isArray(graph.camera_ids) ||
      typeof graph.name !== "string" ||
      !graph.name.trim() ||
      graph.name.length > 128
    )
      throw Error("Invalid workflow document.");
    if (
      Object.keys(graph).some(
        (k) =>
          ![
            "id",
            "name",
            "enabled",
            "camera_ids",
            "nodes",
            "edges",
            "execution",
            "callable_version",
            "history",
            "preset_clip_id",
          ].includes(k),
      )
    )
      throw Error("Unknown workflow field.");
    if(graph.preset_clip_id !== undefined && !approachMotion.clips().some(clip=>clip.id===graph.preset_clip_id))
      throw Error("Unknown approach preset scene.");
    if (graph.history !== undefined && !validHistory(graph.history))
      throw Error("Invalid workflow history settings.");
    if (
      graph.execution !== undefined &&
      (!graph.execution ||
        typeof graph.execution !== "object" ||
        Array.isArray(graph.execution) ||
        Object.keys(graph.execution).sort().join() !==
          "allow_calls,description,parameters,run_independently" ||
        typeof graph.execution.allow_calls !== "boolean" ||
        typeof graph.execution.run_independently !== "boolean" ||
        (!graph.execution.allow_calls && !graph.execution.run_independently) ||
        !Array.isArray(graph.execution.parameters) ||
        graph.execution.parameters.length > 64 ||
        typeof graph.execution.description !== "string" ||
        graph.execution.description.length > 1000)
    )
      throw Error("Invalid workflow execution settings.");
    if (
      graph.callable_version !== undefined &&
      (!graph.execution ||
        !Number.isInteger(graph.callable_version) ||
        graph.callable_version < 1 ||
        graph.callable_version > 100)
    )
      throw Error("Invalid published callable version.");
    const ids = new Set();
    for (const n of graph.nodes) {
      if (
        !n ||
        !["id,params,type,x,y", "bindings,id,params,type,x,y"].includes(
          Object.keys(n).sort().join(),
        ) ||
        typeof n.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(n.id) ||
        ids.has(n.id) ||
        !TYPES[n.type] ||
        !Number.isFinite(n.x) ||
        !Number.isFinite(n.y) ||
        n.x < 0 ||
        n.y < 0 ||
        n.x > 5000 ||
        n.y > 5000 ||
        !n.params ||
        typeof n.params !== "object" ||
        Array.isArray(n.params) ||
        Object.keys(n.params).some(
          (k) =>
            !Object.hasOwn(TYPES[n.type].params, k) &&
            !(n.type === "detections" && k === "detector"),
        )
      )
        throw Error("Invalid workflow node or parameter.");
      ids.add(n.id);
    }
    for (let index = 0; index < graph.edges.length; index++) {
      const edge = graph.edges[index];
      if (
        !edge ||
        typeof edge.from !== "string" ||
        typeof edge.to !== "string" ||
        (edge.input !== undefined && typeof edge.input !== "string") ||
        (edge.label !== undefined &&
          (typeof edge.label !== "string" || edge.label.length > 80))
      )
        throw Error("Invalid workflow connection.");
      graph.edges[index] = {
        from: edge.from,
        to: edge.to,
        ...(edge.input ? { input: edge.input } : {}),
        ...(edge.label ? { label: edge.label } : {}),
      };
    }
    for (const n of graph.nodes)
      if (n.type === "event")
        n.params = { ...clone(TYPES.event.params), ...n.params };
    const errors = validate(graph);
    if (errors.length) throw Error(errors.join(" "));
    graph.id = `workflow-${Math.random().toString(36).slice(2, 10)}`;
    graph.enabled = false;
    graph.camera_ids = graph.camera_ids.filter((id) =>
      cameras.some((c) => c.id === id),
    );
    const manifest = Array.isArray(document.models) ? document.models : [];
    for (const n of graph.nodes) {
      if (n.type === "classifier")
        n.params = { ...clone(TYPES.classifier.params), ...n.params };
      if (
        n.type === "camera" &&
        !cameras.some((c) => c.id === n.params.camera_id)
      )
        n.params.camera_id = "";
      if (
        ["model", "classifier"].includes(n.type) &&
        !builtinModel(n.params.model_id) &&
        !models.some((m) => m.id === n.params.model_id)
      ) {
        const ref = manifest.find((m) => m.id === n.params.model_id);
        n.params.model_id =
          models.find(
            (m) => ref && m.name === ref.name && m.engine === ref.engine,
          )?.id || "";
      }
    }
    return migrateDetectorNodes(graph);
  }
  function validate(graph) {
    const errors = [],
      nodes = Array.isArray(graph?.nodes) ? graph.nodes : [],
      ids = new Map(nodes.map((n) => [n.id, n]));
    if (nodes.length > 64)
      errors.push("Workflow can contain at most 64 nodes.");
    if ((graph?.edges || []).length > 128)
      errors.push("Workflow can contain at most 128 connections.");
    for (const n of nodes) {
      if (!TYPES[n.type]) errors.push(`Unknown node type: ${n.type}`);
      if(n.type === "browser_motion" && n.params?.mog2_threshold !== undefined && (!Number.isFinite(n.params.mog2_threshold) || n.params.mog2_threshold<0 || n.params.mog2_threshold>1))
        errors.push(`Browser motion ${n.id} MOG2 threshold must be between 0 and 1.`);
      if(n.type === "browser_motion" && n.params?.roi !== undefined && !approachMotion.validRoi(n.params.roi))
        errors.push(`Browser motion ${n.id} region must be normalized left, top, right, bottom coordinates.`);
      if (n.type === "browser_motion" && (!Number.isFinite(+n.params?.threshold) || +n.params.threshold < 0 || +n.params.threshold > 1))
        errors.push(`Browser motion ${n.id} threshold must be between 0 and 1.`);
      if (
        n.type === "subflow_input" &&
        n.params &&
        Object.keys(n.params).length
      )
        errors.push("Subflow input nodes do not accept settings.");
      if (
        n.type === "subflow_output" &&
        n.params &&
        Object.keys(n.params).length
      )
        errors.push("Subflow output nodes do not accept settings.");
      if (
        n.type === "subflow" &&
        (!n.params ||
          typeof n.params.subflow_id !== "string" ||
          !Number.isInteger(n.params.version) ||
          n.params.version < 1 ||
          !n.params.arguments ||
          typeof n.params.arguments !== "object" ||
          Array.isArray(n.params.arguments))
      )
        errors.push(
          "Choose a subflow version and provide arguments as an object.",
        );
    }
    const out = new Map(nodes.map((n) => [n.id, []]));
    for (const e of graph?.edges || [])
      if (
        e.label !== undefined &&
        (typeof e.label !== "string" || e.label.length > 80)
      )
        errors.push(
          "Connection labels must be plain text up to 80 characters.",
        );
      else if (!ids.has(e.from) || !ids.has(e.to))
        errors.push(`Edge references missing node: ${e.from} → ${e.to}`);
      else if (e.from === e.to) errors.push("A node cannot connect to itself.");
      else if (
        graph.edges.filter((x) => x.from === e.from && x.to === e.to).length > 1
      )
        errors.push("Duplicate connections are not allowed.");
      else {
        if (!accepts(ids.get(e.from), ids.get(e.to), inputType(e, nodes)))
          errors.push(
            "Incompatible connection: cameras and models connect to Detections; detection outputs connect to processing or action nodes.",
          );
        out.get(e.from).push(e.to);
      }
    const visiting = new Set(),
      done = new Set();
    function visit(id) {
      if (visiting.has(id)) return true;
      if (done.has(id)) return false;
      visiting.add(id);
      for (const next of out.get(id) || []) if (visit(next)) return true;
      visiting.delete(id);
      done.add(id);
      return false;
    }
    if ([...ids.keys()].some(visit)) errors.push("Workflow contains a cycle.");
    for (const n of nodes) {
      if (
        n.type === "filter" &&
        n.params?.identity_source === "class" &&
        n.params?.rules?.some((r) =>
          ["is_unknown", "is_known"].includes(r.operator),
        )
      )
        errors.push(
          "Is unknown / Is known requires Recognized identity as the source.",
        );
      if (n.type === "detections") {
        const modelInputs = (graph.edges || []).filter(
            (e) => e.to === n.id && inputType(e, nodes) === "model",
          ),
          classifierInputs = (graph.edges || []).filter(
            (e) => e.to === n.id && inputType(e, nodes) === "classifier",
          );
        if (
          n.params?.detector !== undefined &&
          ![
            "scrfd-500mf",
            "scrfd-2.5gf",
            "scrfd-10gf",
            "retinaface",
            "custom",
          ].includes(n.params.detector)
        )
          errors.push("Choose a supported InsightFace detector.");
        if (n.params?.engine === "insightface") {
          const detector =
            n.params.detector || (modelInputs.length ? "custom" : "camera");
          if (modelInputs.length && detector !== "custom")
            errors.push(
              "Custom InsightFace detector requires Custom detector selection.",
            );
          if (detector === "custom" && !modelInputs.length)
            errors.push(
              "Custom InsightFace detector requires a connected Model node.",
            );
          if (classifierInputs.length > 1)
            errors.push("InsightFace Detections accepts one Classifier node.");
        } else if (classifierInputs.length)
          errors.push(
            "Classifier nodes connect only to InsightFace Detections.",
          );
      }
      if (
        n.type === "classifier" &&
        (!Number.isFinite(n.params?.threshold) ||
          n.params.threshold <
            (n.params.model_id?.startsWith("gallery-") ? -1 : 0) ||
          n.params.threshold > 1 ||
          !["probabilities", "logits"].includes(n.params?.output) ||
          !["arcface", "embedded"].includes(n.params?.preprocessing) ||
          !Number.isInteger(n.params?.confirmations ?? 3) ||
          (n.params?.confirmations ?? 3) < 1 ||
          (n.params?.confirmations ?? 3) > 15 ||
          !Number.isInteger(n.params?.switch_confirmations ?? 5) ||
          (n.params?.switch_confirmations ?? 5) <
            (n.params?.confirmations ?? 3) ||
          (n.params?.switch_confirmations ?? 5) > 30 ||
          !Number.isFinite(n.params?.margin ?? 0.15) ||
          (n.params?.margin ?? 0.15) < 0 ||
          (n.params?.margin ?? 0.15) > 1)
      )
        errors.push(
          "Classifier threshold, stability settings, output mode, or preprocessing is invalid.",
        );
      if (
        n.type === "event" &&
        (typeof n.params?.name_pattern !== "string" ||
          n.params.name_pattern.length > 200 ||
          !["none", "capture", "recording"].includes(n.params?.attachment) ||
          !Number.isInteger(n.params?.duration_seconds) ||
          n.params.duration_seconds < 1 ||
          n.params.duration_seconds > 300 ||
          n.params?.pre_event_seconds === null ||
          !Number.isInteger(n.params?.pre_event_seconds ?? 0) ||
          (n.params?.pre_event_seconds ?? 0) < 0 ||
          (n.params?.pre_event_seconds ?? 0) > 30)
      )
        errors.push("Event name, attachment, or duration is invalid.");
      if (
        n.bindings !== undefined &&
        (!n.bindings ||
          typeof n.bindings !== "object" ||
          Array.isArray(n.bindings) ||
          Object.keys(n.bindings).length > 32)
      )
        errors.push("Invalid node data bindings (maximum 32).");
      else
        for (const [field, binding] of Object.entries(n.bindings || {}))
          if (!canBind(graph, n, field, binding))
            errors.push(
              `Invalid data link for ${n.type}.${field}: choose a compatible upstream signal.`,
            );
    }
    return [...new Set(errors)];
  }
  function faceTemplate() {
    const nodes = [
      node("detections", 40, 90),
      node("filter", 280, 90),
      node("cooldown", 520, 90),
      node("event", 760, 90),
    ];
    nodes[0].params.engine = "insightface";
    nodes[1].params.label = "face";
    nodes[2].params.seconds = 10;
    nodes[3].params.message = "Face detected";
    return {
      id: `workflow-${Math.random().toString(36).slice(2, 14)}`,
      name: "Face event",
      enabled: false,
      camera_ids: [],
      nodes,
      edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
    };
  }
  function browserMotionTemplate({ cameraId = "" } = {}) {
    const nodes = [
      node("camera", 40, 90),
      node("browser_motion", 280, 90),
      node("cooldown", 520, 90),
      node("event", 760, 90),
    ];
    nodes[0].params.camera_id = cameraId;
    nodes[1].params.threshold = 0.1;
    nodes[2].params.seconds = 10;
    Object.assign(nodes[3].params, {
      message: "Motion detected in browser clip",
      name_pattern: "Motion · {camera} · {date} {time}",
      attachment: "capture",
    });
    return {
      id: `workflow-${Math.random().toString(36).slice(2, 14)}`,
      name: "Browser clip motion event",
      enabled: false,
      camera_ids: cameraId ? [cameraId] : [],
      nodes,
      edges: nodes.slice(1).map((next, index) => ({
        from: nodes[index].id,
        to: next.id,
        ...(nodes[index].type === "camera" ? { input: "camera" } : {}),
      })),
    };
  }
  function insightfaceTemplate({
    cameraId = "",
    modelId = "",
    classifierId,
    label = "face",
    identity = "",
    confidence = 0.5,
    cooldown = 10,
  } = {}) {
    const legacyCustomDetector =
        classifierId === undefined || (!!modelId && !classifierId),
      nodes = legacyCustomDetector
        ? [
            node("camera", 40, 90),
            node("model", 40, 240),
            node("detections", 280, 90),
            node("filter", 520, 90),
            node("cooldown", 760, 90),
            node("notification", 1000, 90),
          ]
        : [
            node("camera", 40, 90),
            node("detections", 280, 90),
            ...(classifierId ? [node("classifier", 40, 410)] : []),
            node("filter", 520, 90),
            node("cooldown", 760, 90),
            node("notification", 1000, 90),
            node("model", 40, 240),
          ];
    nodes[0].params.camera_id = cameraId;
    const detection = nodes.find((item) => item.type === "detections"),
      filter = nodes.find((item) => item.type === "filter"),
      cooldownNode = nodes.find((item) => item.type === "cooldown"),
      model = nodes.find((item) => item.type === "model"),
      classifier = nodes.find((item) => item.type === "classifier");
    detection.params.engine = "insightface";
    if (legacyCustomDetector) {
      model.params.model_id = modelId;
      delete detection.params.detector;
    }
    if (!legacyCustomDetector) model.params.model_id = "builtin-scrfd-500mf";
    if (classifier) classifier.params.model_id = classifierId;
    Object.assign(filter.params, { label, identity, confidence });
    cooldownNode.params.seconds = cooldown;
    return {
      id: `workflow-${Math.random().toString(36).slice(2, 10)}`,
      name: "InsightFace detection alert",
      enabled: false,
      camera_ids: [],
      nodes,
      edges: [
        { from: nodes[0].id, to: detection.id, input: "camera" },
        ...(model
          ? [{ from: model.id, to: detection.id, input: "model" }]
          : []),
        ...(classifier
          ? [{ from: classifier.id, to: detection.id, input: "classifier" }]
          : []),
        { from: detection.id, to: filter.id },
        { from: filter.id, to: cooldownNode.id },
        {
          from: cooldownNode.id,
          to: nodes.find((item) => item.type === "notification").id,
        },
      ],
    };
  }
  function preEventTemplate({ cameraId = "", classifierId = "" } = {}) {
    const nodes = [
      node("camera", 40, 90),
      node("model", 40, 240),
      node("classifier", 40, 410),
      node("detections", 280, 90),
      node("filter", 520, 90),
      node("cooldown", 760, 90),
      node("event", 1000, 90),
    ];
    const [camera, model, classifier, detection, filter, cooldown, event] =
      nodes;
    camera.params.camera_id = cameraId;
    model.params.model_id = "builtin-scrfd-500mf";
    classifier.params.model_id = classifierId;
    detection.params.engine = "insightface";
    Object.assign(filter.params, {
      label: "face",
      confidence: 0.5,
      identity_source: "identity",
      rules: [{ field: "identity", operator: "is_unknown", value: "" }],
      match: "all",
    });
    cooldown.params.seconds = 45;
    Object.assign(event.params, {
      message: "Unknown face detected",
      attachment: "recording",
      pre_event_seconds: 10,
      duration_seconds: 20,
      name_pattern: "{camera} · Unknown face · {date} {time}",
    });
    return {
      id: `workflow-${Math.random().toString(36).slice(2, 10)}`,
      name: "Pre-event unknown face recording",
      enabled: false,
      camera_ids: [],
      nodes,
      edges: [
        { from: camera.id, to: detection.id, input: "camera" },
        { from: model.id, to: detection.id, input: "model" },
        { from: classifier.id, to: detection.id, input: "classifier" },
        { from: detection.id, to: filter.id },
        { from: filter.id, to: cooldown.id },
        { from: cooldown.id, to: event.id },
      ],
    };
  }
  const TEMPLATE_CATALOG = [
    {
      id: "pre-event-person",
      name: "Pre-event unknown face recording",
      category: "Recording",
      engine: "InsightFace",
      description:
        "Record the approach and aftermath when a face is rejected as unknown.",
      purpose: "Entrances, corridors, and activity evidence",
      details: "10s before · 20s after · 45s cooldown",
      requirements: [
        "Local InsightFace runtime",
        "SCRFD 500MF detector",
        "Compatible face classifier",
        "Running camera",
        "Idle recorder",
      ],
      setup:
        "Choose a compatible classifier and review its threshold/preprocessing. The filter uses Recognized identity / Is unknown. Unknown means the classifier rejected the face; pending identities do not trigger. Closed-set models cannot guarantee unknown-person rejection. The Event node records automatically; allow 10s for camera history to warm up.",
    },
    {
      id: "insightface-alert",
      name: "InsightFace detection alert",
      category: "Notifications",
      engine: "InsightFace",
      description:
        "Notify this computer when a face or selected identity matches your rules.",
      purpose: "Face detection and optional identity alerts",
      details: "SCRFD 500MF · 10s cooldown",
      requirements: [
        "Local InsightFace runtime",
        "Local detector weights",
        "Notification permission",
      ],
      setup:
        "Choose a camera and install the detector explicitly if needed. A compatible uploaded classifier is connected when available; choose an identity in Filter. Browser permission is requested when using notifications.",
    },
    {
      id: "face-event",
      name: "Face event log",
      category: "Events",
      engine: "InsightFace",
      description:
        "Log matching face detections as named events without recording a video.",
      purpose: "A simple event trail from an existing face pipeline",
      details: "Event log · 10s cooldown",
      requirements: ["Installed local app", "Configured InsightFace camera"],
      setup:
        "Select target cameras after loading. This template observes their existing InsightFace pipeline; it does not install or select a detector model.",
    },
    {
      id: "browser-clip-motion",
      name: "Browser clip motion event",
      category: "Browser showcase",
      engine: "Browser motion fraction",
      description:
        "Create a local event and frame capture when visible motion crosses a threshold in an imported browser clip.",
      purpose: "Review motion from a local clip without a vision model",
      details: "10s cooldown · frame capture attached",
      requirements: ["Browser showcase", "Imported local clip", "Camera running"],
      setup:
        "Choose the imported clip in Camera. Start that camera before enabling. This uses the showcase motion fraction and canvas frame only; it does not identify faces or objects.",
      showcaseOnly: true,
    },
  ];
  const approachMotion = typeof module === "object" && module.exports ? require("./browser-motion.js") : window.spyderBrowserMotion;
  TEMPLATE_CATALOG.push(...(approachMotion?.clips() || []).map(clip=>({
    id:"demo-approach-"+clip.id,name:"Approach · "+clip.motion_preset.name,category:"Home security motion",engine:"Browser ROI motion",showcaseOnly:true,
    description:clip.motion_preset.description,purpose:"Watch a reviewed approach area in "+clip.name,
    details:"6s cooldown · approach region · frame capture",requirements:["Browser showcase",clip.name,"Camera running"],
    setup:"Add the matching bundled demo scene. The Camera node selects it when available; otherwise choose it before enabling. This measures movement, not person recognition.",
  })));
  function templateEntries(query = "", demo = false) {
    const words = String(query)
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return TEMPLATE_CATALOG.filter((entry) => (demo || !entry.showcaseOnly) &&
      words.every((word) =>
        [
          entry.name,
          entry.category,
          entry.description,
          entry.purpose,
          entry.details,
          entry.engine,
          ...entry.requirements,
        ]
          .join(" ")
          .toLowerCase()
          .includes(word),
      ),
    );
  }
  function createWorkflowTemplate(id, context = {}) {
    const clip=approachMotion?.clips().find(clip=>id==="demo-approach-"+clip.id);
    if(clip) {
      const camera=context.cameras?.find(camera=>camera.demo_clip_id===clip.id);
      const graph=approachMotion.workflow(clip,camera?.id || "");
      graph.id=`workflow-${Math.random().toString(36).slice(2,14)}`;
      return graph;
    }
    if (id === "browser-clip-motion") return browserMotionTemplate(context);
    if (id === "pre-event-person") return preEventTemplate(context);
    if (id === "insightface-alert")
      return insightfaceTemplate({ classifierId: "", ...context });
    if (id === "face-event") return faceTemplate();
    throw new Error("Unknown workflow template");
  }
  const FIELD_HELP = {
    mog2_threshold:"Minimum foreground fraction inside the ROI for OpenCV MOG2. Use 0 to 1; 0.003 means 0.3%. It is separate from frame-difference sensitivity.",
    camera_id:
      "Choose a configured camera as this node's source. Connecting it to CAM supplies that camera's frames and detections; it does not start the camera.",
    model_id:
      "Select a local uploaded model or a built-in detector. Model OUT connects to MODEL IN. Classifier OUT connects to CLASSIFIER IN. Model weights must be available locally before activation.",
    engine:
      "Choose the detection engine. Any observes the camera's active engine. OpenCV uses the built-in person detector; YOLO and InsightFace need compatible local models.",
    threshold:
      "Minimum classifier score for accepting an identity. Accepts a number from 0 to 1. Higher values reject more uncertain classifications.",
    output:
      "Match the classifier's exported output: probabilities are normalized scores; logits require conversion. Choose the format used when the model was exported.",
    preprocessing:
      "Match the model's expected image preparation. ArcFace applies its normalization; Embedded is for models that already contain preprocessing.",
    confirmations:
      "Number of consecutive reliable results needed before showing a new identity. Accepts a whole number from 1 to 15.",
    switch_confirmations:
      "Consecutive results needed to switch an established identity. Accepts a whole number from the initial confirmation count to 30.",
    margin:
      "Minimum score advantage over the runner-up class. Accepts a number from 0 to 1; 0.15 means a 15 percentage-point lead.",
    label:
      "Match a detected class label, such as person or face. Select a model class when available, or type its exact label. Leave empty to accept any class.",
    confidence:
      "Minimum detection confidence, from 0 to 1. Zero also accepts detections with unknown scores. Detector scores may not be calibrated probabilities.",
    identity_source:
      "Choose whether identity matching reads the recognized identity or the model's class label. This changes which detection property is compared.",
    identity:
      "Match an identity name or model class, according to Identity source. Use an available dropdown choice or an exact custom name. Leave empty to accept any identity.",
    match:
      "All rules requires every additional rule to match (AND). Any rule accepts a detection matching at least one additional rule (OR).",
    roi: "Enter four comma-separated normalized coordinates: x1, y1, x2, y2. Values range from 0 to 1, with x1 < x2 and y1 < y2. The region limits which detections pass.",
    minimum:
      "Minimum number of matching detections needed to continue this branch. Accepts a whole number of at least 1.",
    seconds:
      "Minimum delay between actions for each camera and this cooldown node. Accepts seconds from 1 to 3600. Use enough time for recording clips to finish.",
    name_pattern:
      "Name saved events using text and tokens: {workflow}, {camera}, {date}, {time}, {node}, {kind}, {label}. Maximum 200 characters. Unknown tokens stay literal.",
    attachment:
      "Choose no media, a JPEG frame capture, or a timed recording attached to the event. Recording requires an idle local recorder; existing recordings are not interrupted.",
    duration_seconds:
      "Footage to record after the trigger, in whole seconds from 1 to 300. The clip is attached to the event after it finishes.",
    pre_event_seconds:
      "Footage requested before the trigger, in whole seconds from 0 to 30. Zero disables buffering. Enable the workflow and keep the camera running so local history can warm up.",
    message:
      "Text stored with an Event or displayed by a Notification. Accepts up to 500 characters. Compatible upstream signals can supply a live value.",
    title:
      "Browser/desktop notification title. Accepts 1 to 128 characters. Notification delivery needs permission and an open SpyDER page.",
    action:
      "Start adds this camera to recording. Stop releases recording owned by this workflow. Actions use the shared local recorder and do not stop manually owned recordings.",
    language:
      "Choose restricted Python or JavaScript for the Code node. Review imported code before enabling the workflow.",
    source:
      "Write code that assigns a detection list to output. Inputs are detections and read-only context. Up to 8000 characters; execution and output are bounded, with no imports, files, or network access.",
    rule_field:
      "Choose the detection property for this rule: Class compares label, Identity compares identity, and Confidence compares a numeric score.",
    rule_operator:
      "Choose the comparison. Is unknown requires an explicit rejected identity from recognition/classification; pending identities and detector-only faces do not match. Is known requires an accepted identity. Both require Recognized identity as the source and need no value. Other comparisons match class, identity, or confidence values.",
    rule_value:
      "Enter or select the class or identity to compare. Confidence comparisons accept a number from 0 to 1. Available model labels appear as choices. Is unknown and Is known have no value; this field stays disabled.",
    edge_label:
      "Optional connection label, up to 80 characters. This only describes the wire; it does not change the data or workflow behavior.",
    node_input:
      "Select a compatible upstream node, then choose Add IN connection. Multiple compatible inputs can be connected.",
    node_output:
      "Select a compatible downstream node, then choose Add OUT connection. One output can feed multiple branches.",
    test_input:
      "Enter a JSON array of sample detections for a local code test. This tests the code on sample data, without starting a camera or executing downstream action nodes.",
    subflow_id:
      "Choose a published reusable workflow. Each call shares the parent camera context and passes detection data through the selected version.",
    version:
      "Pin this call to an immutable published version. Review upgrades before selecting a newer version.",
    arguments:
      "Provide a JSON object mapping exposed parameter names to values. Values override published defaults for this call.",
  };
  function fieldHelpMarkup(
    html,
    node,
    scope = "params",
    decorate = (field) => field,
  ) {
    const escape = (value) =>
      String(value).replace(
        /[&<>"']/g,
        (char) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[char],
      );
    let count = 0;
    return html.replace(
      /<label\b([^>]*)>([\s\S]*?)<\/label>(\s*<p(?![^>]*\brole\s*=)(?:\s[^>]*)?>[\s\S]*?<\/p>)?(\s*<pre>[\s\S]*?<\/pre>)?/g,
      (whole, attributes, body, explanation = "", example = "") => {
        const control = /<(input|select|textarea)\b([^>]*)>/.exec(body);
        if (!control) return whole;
        const attrs = control[2];
        const param = /data-param="([^"]+)"/.exec(attrs)?.[1];
        const rule = /data-rule-key="([^"]+)"/.exec(attrs)?.[1];
        const key =
          param ||
          (rule
            ? `rule_${rule === "field" ? "field" : rule === "operator" ? "operator" : "value"}`
            : attrs.includes("data-edge-label")
              ? "edge_label"
              : attrs.includes("data-node-input")
                ? "node_input"
                : attrs.includes("data-node-output")
                  ? "node_output"
                  : attrs.includes("data-test-input")
                    ? "test_input"
                    : "");
        const caption =
          body
            .slice(0, control.index)
            .replace(/<[^>]*>/g, "")
            .trim() ||
          key.replaceAll("_", " ") ||
          "Field";
        const id = `we-help-${String(node.id).replace(/[^A-Za-z0-9_-]/g, "-")}-${scope}-${++count}`;
        const describedControl = /\baria-describedby="[^"]*"/.test(control[0])
          ? control[0].replace(
              /aria-describedby="([^"]*)"/,
              (_, ids) => `aria-describedby="${ids} ${id}"`,
            )
          : control[0].replace(/>$/, ` aria-describedby="${id}">`);
        const guided =
          `<span class="we-field-label">${body.slice(0, control.index)}</span>` +
          describedControl +
          body.slice(control.index + control[0].length);
        const details = explanation
          .replace(/^\s*<p[^>]*>/, "")
          .replace(/<\/p>$/, "");
        const help =
          (node?.type === "browser_motion" && key === "threshold"
            ? "Minimum real motion fraction from the current browser camera source. Accepts 0 to 1. This source does not detect or identify faces or objects."
            : node?.type === "cooldown" && key === "seconds"
              ? `${FIELD_HELP.seconds} Browser showcase also limits each workflow and camera to one action batch per second.`
              : node?.type === "record" && key === "action"
                ? `${FIELD_HELP.action} In browser showcase, recording uses nearest connected Event duration, or 10 seconds by default, and stops only the workflow-owned session.`
            : Object.hasOwn(FIELD_HELP, key)
              ? FIELD_HELP[key]
              : "") ||
          `Set ${caption}. ${control[1] === "select" ? "Choose an available option." : "Enter a value matching this field."}`;
        return decorate(
          `<div class="we-help-field"><label${attributes}>${guided}</label><button type="button" class="we-help-button" data-field-help="${id}" aria-label="Help for ${escape(caption)}" aria-expanded="false" aria-controls="${id}"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r=".8" fill="currentColor" stroke="none"/></svg></button><div class="we-field-tooltip" id="${id}" role="tooltip" hidden><strong>${escape(caption)}</strong><span>${escape(help)}</span>${details ? `<span>${details}</span>` : ""}${example}</div></div>`,
        );
      },
    );
  }
  if (typeof module !== "undefined" && module.exports)
    module.exports = {
      TYPES,
      workflowExecution,
      workflowHistory,
      FIELD_HELP,
      fieldHelpMarkup,
      NODE_GROUPS,
      paletteGroups,
      modelPage,
      nodeSize,
      clamp,
      clampViewScale,
      canvasDelta,
      canvasPoint,
      node,
      duplicateNode,
      validate,
      faceTemplate,
      insightfaceTemplate,
      preEventTemplate,
      TEMPLATE_CATALOG,
      templateEntries,
      createWorkflowTemplate,
      outputType,
      inputType,
      edgeFor,
      accepts,
      encodeWorkflow,
      decodeWorkflow,
      migrateDetectorNodes,
      signalNames,
      upstreamIds,
      fieldType,
      canBind,
      pruneBindings,
    };
  if (typeof window === "undefined") return;
  const esc = (v) =>
    String(v ?? "").replace(
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
  let dispose = () => {};
  window.spyderWorkflows = {
    mount(container) {
      this.unmount();
      if (!container) return;
      let graph,
        graphRevision = 0,
        notice = "",
        subflowEditing = null,
        subflowParents = [],
        subflowCatalog = [],
        workflows = [],
        workflowCounts = { total: 0, enabled: 0, disabled: 0 },
        managerHandle = null,
        managerGeneration = 0,
        cameras = [],
        events = [],
        dirty = false,
        selected = "",
        selectedEdge = "",
        reconnectChoice = null,
        chosenSignal = null,
        pendingSignalRefresh = false,
        busy = false,
        timer = 0,
        controller,
        mounted = true,
        drag = null,
        pointerDrag = null,
        wireDrag = null,
        panDrag = null,
        viewGraphId = null,
        viewScale = 1,
        settingsNode = "",
        codeError = "",
        testPane = false,
        testRunning = false,
        modalFocusReturn = null,
        modalGeneration = 0,
        undoStack = [],
        redoStack = [],
        snapshotLoaded = false,
        library = [],
        libraryBusy = false,
        libraryMessage = "",
        libraryQuery = "",
        libraryEngine = "all",
        libraryLabels = "all",
        librarySort = "name",
        libraryPageNumber = 0,
        removingModel = "",
        paletteQuery = "",
        libraryController,
        detectorCatalog = [],
        detectorMessage = "",
        detectorBusy = "",
        detectorController,
        debugTimer = 0,
        debugController = null,
        debugStates = {},
        copiedNode = null,
        pasteCount = 0,
        activeHelp = "",
        helpPinned = false,
        importGeneration = 0,
        templatePickerOpen = false,
        templateQuery = "",
        studioPanel = "",
        studioReturn = "",
        connectionsOpen = false;
      let activationReview = null,
        activationBusy = false,
        activationStage = "",
        activationMessage = "",
        activationError = false;
      const requestControllers = new Set();
      const openModelDetails = new Set();
      const collapsedPaletteGroups = new Set();
      const demo = !!window.spyderShowcase,
        key = "spyder.workflow-editor.draft",
        root = document.createElement("section");
      root.className = "workflow-editor";
      root.tabIndex = -1;
      container.replaceChildren(root);
      const studioScroll = new Map();
      function studioDialog(name, title, content) {
        return `<dialog id="we-studio-panel-${name}" class="we-studio-dialog we-studio-${name}" data-studio-panel="${name}" aria-labelledby="we-studio-${name}-title"><header><h3 id="we-studio-${name}-title">${title}</h3><button type="button" class="button secondary dialog-close" data-studio-close aria-label="Close ${title}"><svg class="icon" aria-hidden="true"><use href="/icons.svg#close"/></svg></button></header><div class="we-studio-content">${content}</div></dialog>`;
      }
      function focusStudioOpener() {
        const opener = studioReturn
          ? root.querySelector(`[data-studio-open="${studioReturn}"]`)
          : null;
        const menu = opener?.closest?.(".we-studio-menu");
        (opener && (!menu || menu.open)
          ? opener
          : root.querySelector(".we-studio-menu > summary"))?.focus?.({
          preventScroll: true,
        });
      }
      function closeStudio(redraw = false, restoreFocus = true) {
        const dialog = root.querySelector(`[data-studio-panel="${studioPanel}"]`);
        if (dialog) {
          studioScroll.set(studioPanel, dialog.querySelector?.(".we-studio-content")?.scrollTop || 0);
          dialog.close?.();
        }
        studioPanel = "";
        if (redraw) render(true);
        if (restoreFocus) focusStudioOpener();
      }
      const studioCancel = (event) => {
        if (!event.target.matches?.("[data-studio-panel]")) return;
        event.preventDefault();
        closeStudio(true);
      };
      function restoreStudio(focus) {
        if (!studioPanel) return;
        const dialog = root.querySelector(`[data-studio-panel="${studioPanel}"]`);
        if (!dialog?.showModal) return;
        dialog.showModal();
        const content = dialog.querySelector(".we-studio-content");
        content.scrollTop = studioScroll.get(studioPanel) || 0;
        const target = focus?.selector
          ? dialog.querySelector(focus.selector)
          : dialog.querySelector(studioPanel === "nodes" ? "[data-palette-search]" : studioPanel === "settings" ? "[data-name]" : studioPanel === "models" ? "[data-library-search]" : "[data-studio-close]");
        target?.focus?.({ preventScroll: true });
        if (focus?.start !== null && focus?.start !== undefined)
          target?.setSelectionRange?.(focus.start, focus.end);
      }
      function focusWorkflowMenu() {
        root.querySelector(".we-studio-menu > summary")?.focus?.({ preventScroll: true });
      }
      const cameraList = () => window.spyder?.cameras?.() || cameras,
        fresh = () => ({
          id: `workflow-${Math.random().toString(36).slice(2, 14)}`,
          name: "New workflow",
          enabled: false,
          camera_ids: [],
          nodes: [],
          edges: [],
        });
      window.spyderWorkflowTools?.mount?.({
        demo,
        onError: (message) => {
          issue(message);
          render(true);
        },
        onOpenLibrary: (mode) => openWorkflowManager(undefined, mode),
        getGraph: () => clone(graph),
        validateGraph: (value) => {
          decodeWorkflow(JSON.stringify(value));
        },
        getDrafts: () =>
          [graph, ...subflowParents.map((parent) => parent.graph)].map(clone),
        onInsertSubflow: (definition) => {
          if (busy || activationBusy || activationReview)
            throw Error(
              "Wait for the current workflow operation before adding a subflow.",
            );
          if (graph.nodes.length >= 64)
            throw Error(
              "This workflow already has 64 nodes. Remove a node before adding a subflow.",
            );
          subflowCatalog = [
            ...subflowCatalog.filter(
              (item) =>
                !(
                  item.id === definition.id &&
                  item.version === definition.version
                ),
            ),
            definition,
          ];
          add("subflow");
          const call = graph.nodes.find((item) => item.id === selected);
          call.params = {
            subflow_id: definition.id,
            version: definition.version,
            arguments: {},
          };
          settingsNode = call.id;
          issue(
            `${definition.name} v${definition.version} added. Connect its IN to detections and its OUT to the next node.`,
          );
          changed();
        },
        onEdit: async (definition) => {
          if (!graph || !definition?.graph) return;
          let editable;
          try {
            editable = await storedWorkflow(definition.id);
          } catch (error) {
            if (
              !demo &&
              !/404|not found|Unknown workflow/i.test(error.message)
            ) {
              issue(error.message);
              return;
            }
          }
          editable ||= {
            ...clone(definition.graph),
            id: definition.id,
            name: definition.name,
            enabled: false,
            camera_ids: [],
            execution: {
              run_independently: false,
              allow_calls: true,
              parameters: clone(definition.parameters),
              description: definition.description || "",
            },
          };
          if (!mounted) return;
          subflowParents.push({
            graph: clone(graph),
            editing: subflowEditing ? clone(subflowEditing) : null,
            dirty,
            undo: clone(undoStack),
            redo: clone(redoStack),
          });
          subflowEditing = {
            id: definition.id,
            name: definition.name,
            version: definition.version,
            definition: clone(definition),
          };
          controller?.abort();
          debugController?.abort();
          graph = clone(editable);
          subflowEditing.baseline = JSON.stringify(graph);
          selected = "";
          settingsNode = "";
          undoStack = [];
          redoStack = [];
          changed();
          root
            .querySelector("[data-subflow-back]")
            ?.focus?.({ preventScroll: true });
        },
        onCreateSubflow: (draft) => {
          subflowParents.push({
            graph: clone(graph),
            editing: subflowEditing ? clone(subflowEditing) : null,
            dirty,
            undo: clone(undoStack),
            redo: clone(redoStack),
          });
          subflowEditing = { id: "", name: draft.name, version: 0 };
          controller?.abort();
          debugController?.abort();
          graph = {
            ...clone(draft),
            execution: {
              run_independently: false,
              allow_calls: true,
              parameters: [],
              description: "",
            },
          };
          subflowEditing.baseline = JSON.stringify(graph);
          selected = "";
          settingsNode = "";
          undoStack = [];
          redoStack = [];
          changed();
          root
            .querySelector("[data-publish-subflow]")
            ?.focus?.({ preventScroll: true });
        },
        onDraftSaved: (draft) => {
          if (draft.id !== graph.id) return;
          graph = clone(draft);
          dirty = false;
          if (subflowEditing) subflowEditing.baseline = JSON.stringify(graph);
        },
        onPublished: (definition) => {
          if (graph.id === definition.id)
            graph.callable_version = definition.version;
          if (subflowEditing && graph.id === definition.id)
            subflowEditing = {
              id: definition.id,
              name: definition.name,
              version: definition.version,
              definition: clone(definition),
              baseline: JSON.stringify(graph),
            };
          window.spyderWorkflowTools
            ?.listSubflows?.()
            .then((items) => {
              if (mounted) {
                subflowCatalog = items || [];
                render(true);
              }
            })
            .catch((error) => issue(error.message));
          issue(
            `Callable version v${definition.version} published. Existing calls keep their selected version.`,
          );
          render(true);
        },
      });
      async function getJSON(url, signal) {
        const active = new AbortController(),
          abort = () => active.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) active.abort();
        requestControllers.add(active);
        const limit = setTimeout(abort, 10000);
        try {
          const response = await fetch(url, {
            cache: "no-store",
            signal: active.signal,
          });
          const data = await response.json();
          if (!response.ok)
            throw Error(data.error || "Workflow data unavailable.");
          return data;
        } finally {
          clearTimeout(limit);
          signal?.removeEventListener("abort", abort);
          requestControllers.delete(active);
        }
      }
      async function storedWorkflow(id) {
        const value = demo
          ? await window.spyderWorkflowStore?.get(id)
          : (await getJSON(`/api/workflows/${encodeURIComponent(id)}`))
              .workflow;
        if (!value)
          throw Error("Workflow no longer exists. Refresh the library.");
        return value;
      }
      function applyWorkflow(value, unsaved = false) {
        subflowParents = [];
        subflowEditing = null;
        window.spyderWorkflowTools?.restoreSubflowContext?.(null);
        controller?.abort();
        debugController?.abort();
        graph = migrateDetectorNodes(value);
        graphRevision++;
        dirty = unsaved;
        snapshotLoaded = true;
        selected = "";
        selectedEdge = "";
        settingsNode = "";
        chosenSignal = null;
        reconnectChoice = null;
        undoStack = [];
        redoStack = [];
        activationReview = null;
        activationMessage = "";
        activationError = false;
        if (demo)
          try {
            localStorage.setItem(
              subflowEditing
                ? `spyder.workflow-editor.subflow-${subflowEditing.id}`
                : key,
              JSON.stringify(graph),
            );
          } catch {
            issue(
              "Draft storage unavailable. Export your workflow to keep a copy.",
            );
          }
        render();
        visibilityChanged();
      }
      async function exportWorkflow(value) {
        const bundle = await window.spyderWorkflowTools?.exportBundle?.(
          clone(value),
        );
        const blob = new Blob(
            [
              bundle
                ? JSON.stringify(bundle, null, 2)
                : encodeWorkflow(value, library),
            ],
            {
              type: "application/json",
            },
          ),
          url = URL.createObjectURL(blob),
          link = document.createElement("a");
        link.href = url;
        link.download = `${value.name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "workflow"}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      function openWorkflowManager(initialDelete, initialMode = "") {
        if (busy || activationBusy || activationReview) return;
        if (!window.spyderWorkflowManager) {
          issue("Workflow manager is unavailable. Refresh the app.");
          return;
        }
        managerHandle?.close();
        const generation = ++managerGeneration,
          current = () => mounted && generation === managerGeneration;
        managerHandle = window.spyderWorkflowManager.open({
          demo,
          initialMode,
          currentId: () => graph.id,
          isDirty: () => dirty,
          cameras: cameraList,
          engines: ["opencv", "yolo", "insightface"],
          ...(initialDelete ? { initialDelete } : {}),
          onClose: () => {
            if (generation === managerGeneration) {
              managerGeneration++;
              managerHandle = null;
            }
          },
          onKeepEditing: () => root.querySelector("[data-save]")?.focus?.(),
          loadPage: async (params, options) => {
            const data = demo
              ? await window.spyderWorkflowStore.page(params, options)
              : await getJSON(
                  "/api/workflows/library?" +
                    new URLSearchParams(
                      Object.entries(params)
                        .filter(([, v]) => v !== undefined)
                        .map(([k, v]) => [k, v === "all" ? "" : v]),
                    ).toString(),
                  options?.signal,
                );
            if (current()) {
              workflowCounts = data.counts || workflowCounts;
              updateSnapshot();
            }
            return data;
          },
          onOpen: async (id) => {
            if (id === graph.id && !dirty) return true;
            const value = await storedWorkflow(id);
            if (!current()) return false;
            applyWorkflow(value);
            return true;
          },
          onCreate: async () => {
            if (!current()) return false;
            applyWorkflow(fresh());
            issue(
              "New disabled draft created. Save it to add it to the library.",
            );
            return true;
          },
          onCreateCallable: async () => {
            if (!current()) return false;
            const draft = window.spyderWorkflowTools.createSubflowDraft();
            draft.execution = {
              run_independently: false,
              allow_calls: true,
              parameters: [],
              description: "",
            };
            applyWorkflow(draft);
            issue(
              "New callable workflow draft. Connect its input and output, save, and publish a callable version.",
            );
            return true;
          },
          onCall: async (id) => {
            if (id === graph.id) throw Error("A workflow cannot call itself.");
            await window.spyderWorkflowTools.insertCall(id);
            return true;
          },
          onPublish: async (id) => {
            const saved = await storedWorkflow(id);
            if (!current()) return false;
            managerHandle?.close();
            window.spyderWorkflowTools.openPublish(saved);
            return false;
          },
          onDuplicate: async (id) => {
            const value = await storedWorkflow(id);
            if (!current()) return false;
            const copy = {
              ...clone(value),
              id: fresh().id,
              name: value.name.slice(0, 121) + " (copy)",
              enabled: false,
            };
            if (demo) await window.spyderWorkflowStore.save(copy);
            else await post("/api/workflows", { workflow: copy });
            if (!current()) return false;
            workflowCounts = {
              ...workflowCounts,
              total: workflowCounts.total + 1,
              disabled: workflowCounts.disabled + 1,
            };
            workflows = [copy];
            applyWorkflow(copy);
            issue("Disabled copy created. Review before enabling.");
            return true;
          },
          onToggle: async (id, enabled, confirm) => {
            if (demo) {
              const saved = await storedWorkflow(id);
              if (!current()) return false;
              if (enabled) {
                const errors = validate(saved),
                  capability = window.spyderDemoWorkflowRuntime?.inspect?.(saved);
                if (errors.length || !capability?.supported)
                  throw Error([...errors, ...(capability?.errors || ["Browser workflow runtime is unavailable."])].join(" "));
                await window.spyderDemoWorkflowRuntime.enable(saved);
              } else await window.spyderDemoWorkflowRuntime.disable(id);
              if (!current()) return false;
              const page = await window.spyderWorkflowStore.page({ size: 1 });
              workflowCounts = page.counts || workflowCounts;
              if (id === graph.id) graph.enabled = enabled;
              workflows = [...workflows.filter((item) => item.id !== id), { ...saved, enabled }];
              render(true);
              return true;
            }
            if (!current() || busy || activationBusy || activationReview)
              return false;
            activationBusy = true;
            try {
              const saved = await storedWorkflow(id);
              if (!current()) return false;
              if (saved.nodes.some((node) => node.type === "browser_motion"))
                throw Error("Browser motion nodes run only in the browser showcase. Replace this node before enabling in the installed app.");
              const workflow = { ...clone(saved), enabled };
              let disableMotion = false;
              if (enabled) {
                const preview = await post(
                  "/api/workflows/activation-preview",
                  { workflow },
                  15000,
                );
                if (!current()) return false;
                if (saved.nodes.some((node) => node.type === "notification"))
                  window.spyderNotifications?.useNode?.();
                const affected = (preview.cameras || []).filter(
                  (camera) =>
                    camera.disable_motion || camera.replaces_motion_pipeline,
                );
                if (
                  (preview.requires_motion_confirmation || affected.length) &&
                  !(await confirm({ name: saved.name, cameras: affected }))
                )
                  return false;
                if (!current()) return false;
                disableMotion = !!preview.requires_motion_confirmation;
              }
              let updated;
              try {
                updated = (
                  await post(
                    `/api/workflows/${encodeURIComponent(id)}/enabled`,
                    {
                      enabled,
                      expected_workflow: saved,
                      ...(disableMotion ? { disable_motion: true } : {}),
                    },
                    15000,
                  )
                ).workflow;
              } catch (error) {
                if (error.name !== "AbortError") throw error;
                try {
                  updated = await storedWorkflow(id);
                } catch {
                  throw Error(
                    "Response timed out. The request may have completed; refresh the library to verify its state.",
                  );
                }
                if (updated.enabled !== enabled)
                  throw Error(
                    "Response timed out. The request may still complete; refresh the library before retrying.",
                  );
              }
              if (!current()) return false;
              if (!updated || updated.id !== id || updated.enabled !== enabled)
                throw Error(
                  "Server did not confirm the requested state. Refresh the workflow library.",
                );
              if (graph.id === id) {
                graph.enabled = updated.enabled;
                graphRevision++;
                syncActivationControls();
              }
              issue(
                `Saved workflow ${enabled ? "enabled" : "disabled"}. Unsaved editor changes are retained.`,
              );
              return true;
            } finally {
              activationBusy = false;
              if (mounted) syncActivationControls();
            }
          },
          onRename: async (id, name) => {
            if (id === graph.id && dirty)
              throw Error(
                "Save your draft edits before renaming this workflow in the library.",
              );
            if (demo) {
              const value = await storedWorkflow(id);
              await window.spyderWorkflowStore.save({ ...value, name });
            } else
              await post(`/api/workflows/${encodeURIComponent(id)}/rename`, {
                name,
              });
            if (current() && id === graph.id) {
              controller?.abort();
              graph.name = name;
              graphRevision++;
              render(true);
            }
          },
          onDelete: async (id) => {
            if (id === graph.id && dirty)
              throw Error(
                "Save or export your draft edits before deleting this workflow.",
              );
            if (demo) await window.spyderWorkflowStore.remove(id);
            else
              await post(`/api/workflows/${encodeURIComponent(id)}/remove`, {});
            if (current() && id === graph.id) {
              workflows = [];
              applyWorkflow(fresh());
            }
          },
          onExport: async (id) => {
            const value = await storedWorkflow(id);
            if (current()) exportWorkflow(value);
          },
        });
      }
      const previewController = window.spyderWorkflowPreview?.create(root, {
        graph: () => graph,
        cameras: cameraList,
        demo,
      });
      function upstreamClasses(id) {
        const visited = new Set(),
          pending = [id],
          classes = new Set();
        while (pending.length) {
          const next = pending.pop();
          if (visited.has(next)) continue;
          visited.add(next);
          const n = graph.nodes.find((n) => n.id === next);
          if (n?.type === "model")
            for (const name of [...BUILTIN_MODELS, ...library].find(
              (m) => m.id === n.params.model_id,
            )?.classes || [])
              classes.add(name);
          for (const e of graph.edges) if (e.to === next) pending.push(e.from);
        }
        return [...classes].sort();
      }
      function upstreamClassifierClasses(id) {
        const visited = new Set(),
          pending = [id],
          classes = new Set();
        while (pending.length) {
          const next = pending.pop();
          if (visited.has(next)) continue;
          visited.add(next);
          const n = graph.nodes.find((n) => n.id === next);
          if (n?.type === "classifier")
            for (const name of [...BUILTIN_MODELS, ...library].find(
              (m) => m.id === n.params.model_id,
            )?.classes || [])
              classes.add(name);
          for (const e of graph.edges) if (e.to === next) pending.push(e.from);
        }
        return [...classes].sort();
      }
      function upstreamChoices(id) {
        return [
          ...new Set([
            ...upstreamClasses(id),
            ...upstreamClassifierClasses(id),
          ]),
        ].sort();
      }
      const classifierModels = () =>
        library.filter(
          (item) =>
            item.engine === "insightface" &&
            (item.metadata?.model_type === "face_gallery" ||
              item.metadata?.model_type === "face_classifier" ||
              item.metadata?.task === "classification" ||
              item.metadata?.label_semantics === "identity"),
        );
      function filterRules(n) {
        const classes = upstreamClasses(n.id),
          identities = upstreamClassifierClasses(n.id);
        return `<section class="we-filter-rules"><h4>Additional filter rules</h4><label>Match<select data-param="match"><option value="all" ${n.params.match !== "any" ? "selected" : ""}>All rules (AND)</option><option value="any" ${n.params.match === "any" ? "selected" : ""}>Any rule (OR)</option></select></label>${(
          n.params.rules || []
        )
          .map((r, i) => {
            const choices =
                r.field === "identity"
                  ? [...new Set([...classes, ...identities])].sort()
                  : classes,
              useClasses =
                choices.length && ["label", "identity"].includes(r.field);
            return `<div class="we-rule"><label>Field<select data-rule="${i}" data-rule-key="field">${["label", "identity", "confidence"].map((f) => `<option value="${f}" ${r.field === f ? "selected" : ""}>${{ label: "Class", identity: "Identity", confidence: "Confidence" }[f]}</option>`).join("")}</select></label><label>Condition<select data-rule="${i}" data-rule-key="operator">${(r.field === "confidence" ? ["gte", "lte"] : r.field === "identity" ? ["eq", "neq", "is_unknown", "is_known"] : ["eq", "neq"]).map((op) => `<option value="${op}" ${r.operator === op ? "selected" : ""} ${["is_unknown", "is_known"].includes(op) && n.params.identity_source === "class" ? "disabled" : ""}>${r.field === "identity" ? { eq: "If identity", neq: "If not identity", is_unknown: "Is unknown", is_known: "Is known" }[op] : { eq: "Is", neq: "Is not", gte: "At least", lte: "At most" }[op]}</option>`).join("")}</select></label><label>Value${["is_unknown", "is_known"].includes(r.operator) ? '<input data-rule="' + i + '" data-rule-key="value" value="" placeholder="No value needed" disabled>' : useClasses ? `<select data-rule="${i}" data-rule-key="value"><option value="">Choose ${r.field === "identity" ? "an identity" : "a class"}</option>${[...new Set([...choices, ...(r.value ? [r.value] : [])])].map((c) => `<option value="${esc(c)}" ${c === r.value ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>` : `<input data-rule="${i}" data-rule-key="value" value="${esc(r.value)}" ${r.field === "confidence" ? 'type="number" min="0" max="1" step="0.01"' : 'maxlength="128"'}>`}</label><button class="button secondary" data-remove-rule="${i}" aria-label="Remove filter rule ${i + 1}">Remove rule</button></div>`;
          })
          .join(
            "",
          )}<button class="button secondary" data-add-rule ${(n.params.rules || []).length >= 32 ? "disabled" : ""}>Add filter rule</button><p>${classes.length || identities.length ? "Class and classifier identity choices loaded from connected nodes." : "Connect a model or classifier through Detections to load choices; custom values stay available."}</p></section>`;
      }
      function nodeConnections(n) {
        const incoming = graph.edges.filter((e) => e.to === n.id),
          outgoing = graph.edges.filter((e) => e.from === n.id);
        const list = (edges) =>
          edges
            .map(
              (e) =>
                `<li>${esc(TYPES[graph.nodes.find((x) => x.id === (e.to === n.id ? e.from : e.to))?.type]?.label)} | ${esc(inputType(e, graph.nodes))}<button class="button secondary" data-delete-edge="${esc(e.from)}|${esc(e.to)}">Disconnect</button><label>Label<input data-edge-label="${esc(e.from)}|${esc(e.to)}" maxlength="80" value="${esc(e.label || "")}" placeholder="Optional label"></label></li>`,
            )
            .join("") || "<li>No connections</li>";
        const options = (direction) =>
          graph.nodes
            .filter((x) => (direction === "in" ? accepts(x, n) : accepts(n, x)))
            .map(
              (x) =>
                `<option value="${esc(x.id)}">${esc(TYPES[x.type]?.label)} | ${esc(x.id.slice(-4))}</option>`,
            )
            .join("");
        return `<section class="we-node-connections"><h4>IN connections (${incoming.length})</h4><ul>${list(incoming)}</ul>${!["camera", "model", "classifier"].includes(n.type) ? `<label>Add input<select data-node-input>${options("in")}</select></label><button class="button secondary" data-connect-in>Add IN connection</button>` : ""}<h4>OUT connections (${outgoing.length})</h4><ul>${list(outgoing)}</ul><label>Add output<select data-node-output>${options("out")}</select></label><button class="button secondary" data-connect-out>Add OUT connection</button><p>Connect multiple branches. Incoming detections are combined without duplicate detections, per camera.</p></section>`;
      }
      function signalPanel(n, direction) {
        const incoming = upstreamIds(graph, n.id);
        const sources =
          direction === "in"
            ? graph.nodes.filter((s) => incoming.has(s.id))
            : [n];
        return `<aside class="we-signals" aria-label="${direction === "in" ? "IN" : "OUT"} signals"><h4>${direction === "in" ? "IN · Upstream data" : "OUT · Available data"}</h4><p>${direction === "in" ? "Drag a live signal or class choice onto a setting. Or click it, then Use selected signal." : "Output schema. These signals can be linked in downstream node settings."}</p><p class="we-signal-note">Live values resolve per camera during execution. Class choices come from model metadata.</p>${
          sources
            .map((s) => {
              const descriptor = [...BUILTIN_MODELS, ...library].find(
                (m) => m.id === s.params.model_id,
              );
              const classes =
                s.type === "classifier"
                  ? upstreamClassifierClasses(s.id)
                  : upstreamClasses(s.id);
              return `<section><h5>${esc(TYPES[s.type]?.label)} <small>${esc(descriptor?.name || s.id.slice(-4))}</small></h5>${signalNames(
                s,
              )
                .map(
                  (name) =>
                    `<button type="button" class="we-signal ${chosenSignal?.node === s.id && chosenSignal?.signal === name && chosenSignal?.mode !== "fixed" ? "is-chosen" : ""}" draggable="true" data-signal-node="${esc(s.id)}" data-signal-name="${name}" aria-label="Select ${esc(SIGNALS[name][0])} from ${esc(TYPES[s.type]?.label)}"><strong>${esc(SIGNALS[name][0])}</strong><span>${SIGNALS[name][1]} · LIVE</span>${name === "classes" ? `<small>${esc(classes.slice(0, 12).join(", ") || "No class metadata")}</small>` : ""}</button>`,
                )
                .join(
                  "",
                )}${classes.length ? `<p>Fixed class choices</p><div class="we-class-chips">${classes.map((c) => `<button type="button" draggable="true" data-signal-node="${esc(s.id)}" data-signal-name="classes" data-signal-mode="fixed" data-signal-value="${esc(c)}" title="Use fixed class ${esc(c)}">${esc(c)}</button>`).join("")}</div>` : ""}</section>`;
            })
            .join("") || "<p>Connect an upstream node to see input signals.</p>"
        }</aside>`;
      }
      function mappedFields(n) {
        if (!n) return parameterFields(n);
        return fieldHelpMarkup(parameterFields(n), n, "params", (whole) => {
          const body = whole;
          const param = /data-param="([^"]+)"/.exec(body),
            rule = /data-rule="(\d+)" data-rule-key="value"/.exec(body);
          const field = param?.[1] || (rule ? `rules.${rule[1]}.value` : "");
          if (!fieldType(n, field)) return whole;
          const binding = n.bindings?.[field],
            source = graph.nodes.find((s) => s.id === binding?.node);
          const content = binding
            ? whole.replace(/<(input|select|textarea)\b/, "<$1 disabled")
            : whole;
          const compatible =
            chosenSignal &&
            (chosenSignal.mode === "fixed"
              ? upstreamIds(graph, n.id).has(chosenSignal.node) &&
                ["strings", "text"].includes(fieldType(n, field))
              : canBind(graph, n, field, {
                  node: chosenSignal.node,
                  signal: chosenSignal.signal,
                }));
          return `<div class="we-field-drop ${binding ? "is-linked" : ""}" data-bind-field="${esc(field)}">${content}${binding ? `<div class="we-binding"><span>LIVE · ${esc(TYPES[source?.type]?.label || binding.node)}.${esc(binding.signal)}</span><button type="button" class="button secondary" data-unbind="${esc(field)}" aria-label="Unlink ${esc(field)}">Unlink</button></div>` : "<small>Drop a compatible signal here</small>"}${compatible ? `<button type="button" class="button secondary we-use-signal" data-use-signal="${esc(field)}">Use selected ${chosenSignal.mode === "fixed" ? "class" : "signal"}</button>` : ""}</div>`;
        });
      }
      function signalFrom(element) {
        return {
          node: element.dataset.signalNode,
          signal: element.dataset.signalName,
          mode: element.dataset.signalMode || "live",
          value: element.dataset.signalValue,
        };
      }
      function refreshSignalPanels() {
        if (!settingsNode) return;
        if (drag?.signal) {
          pendingSignalRefresh = true;
          return;
        }
        const n = graph.nodes.find((n) => n.id === settingsNode);
        if (!n) return;
        const focused = document.activeElement?.closest?.("[data-signal-node]");
        const selection = focused ? signalFrom(focused) : null;
        for (const direction of ["in", "out"]) {
          const panel = root.querySelector(
            `.we-signals[aria-label="${direction.toUpperCase()} signals"]`,
          );
          if (panel) panel.outerHTML = signalPanel(n, direction);
        }
        if (selection)
          [...root.querySelectorAll("[data-signal-node]")]
            .find((el) => {
              const candidate = signalFrom(el);
              return (
                candidate.node === selection.node &&
                candidate.signal === selection.signal &&
                candidate.mode === selection.mode &&
                candidate.value === selection.value
              );
            })
            ?.focus?.({ preventScroll: true });
        pendingSignalRefresh = false;
      }
      function applySignal(field, signal) {
        const n = graph.nodes.find((n) => n.id === (settingsNode || selected));
        if (!n || !signal) return;
        const fixed = signal.mode === "fixed",
          binding = { node: signal.node, signal: signal.signal };
        if (
          !fixed &&
          !n.bindings?.[field] &&
          Object.keys(n.bindings || {}).length >= 32
        ) {
          issue("A node supports at most 32 live data links.");
          return;
        }
        if (
          fixed
            ? !upstreamIds(graph, n.id).has(signal.node) ||
              !upstreamChoices(signal.node).includes(signal.value) ||
              !["strings", "text"].includes(fieldType(n, field))
            : !canBind(graph, n, field, binding)
        ) {
          issue(
            "This field needs a compatible upstream signal. OUT signals belong in downstream settings.",
          );
          return;
        }
        remember();
        if (fixed) {
          if (n.bindings) delete n.bindings[field];
          const rule = /^rules\.(\d+)\.value$/.exec(field);
          if (rule) n.params.rules[+rule[1]].value = signal.value;
          else n.params[field] = signal.value;
        } else {
          n.bindings ||= {};
          n.bindings[field] = binding;
        }
        const rule = /^rules\.(\d+)\.value$/.exec(field);
        if (
          n.type === "filter" &&
          (field === "identity" ||
            (rule && n.params.rules[+rule[1]].field === "identity"))
        ) {
          if (["classes", "labels"].includes(signal.signal))
            n.params.identity_source = "class";
          else if (signal.signal === "identities")
            n.params.identity_source = "identity";
        }
        chosenSignal = null;
        notice = fixed
          ? "Fixed class assigned."
          : "Live data linked. Save or enable the workflow to apply it.";
        changed();
        root
          .querySelector(`[data-bind-field="${field}"] button`)
          ?.focus?.({ preventScroll: true });
      }
      function metadataSourcePanel(model) {
        const metadata = model.metadata || {},
          candidates = metadata.label_candidates || [];
        if (!candidates.length && !metadata.explanation) return "";
        const selected =
          metadata.resolution === "selected" ? metadata.label_source : "";
        return `<section class="we-metadata-source"><h4>Label metadata source</h4>${metadata.explanation ? `<p>${esc(metadata.explanation)}</p>` : ""}${Array.isArray(metadata.warnings) ? metadata.warnings.map((w) => `<p>${esc(w)}</p>`).join("") : ""}${candidates.length ? `<label>Source field<select data-label-source="${esc(model.id)}"><option value="" ${!selected ? "selected" : ""}>Automatic detection</option>${candidates.map((c) => `<option value="${esc(c.path)}" ${c.path === selected ? "selected" : ""}>${esc(c.path)} · ${c.count} labels · ${esc(c.confidence)}</option>`).join("")}</select></label><button class="button secondary" data-use-label-source="${esc(model.id)}" ${demo || libraryBusy ? "disabled" : ""}>Use label source</button><p>This replaces manual labels with the selected metadata source. Reading file metadata preserves manual labels.</p><details><summary>Discovered label fields</summary>${candidates.map((c) => `<p><b>${esc(c.path)}</b>: ${esc((c.preview || []).join(", "))}<br>${esc(c.reason)}</p>`).join("")}</details>` : "<p>No usable label lists found. Manual labels remain available.</p>"}</section>`;
      }
      function modelReferences(model) {
        const references = [...(model.usage?.references || [])];
        if (
          graph?.nodes.some(
            (n) =>
              ["model", "classifier"].includes(n.type) &&
              n.params.model_id === model.id,
          )
        )
          references.push(
            "Current draft: disconnect or remove its Model / Classifier node, then save.",
          );
        return [...new Set(references)];
      }
      function libraryResults() {
        const result = modelPage(
          library.filter(
            (item) => item.metadata?.model_type !== "face_gallery",
          ),
          {
            query: libraryQuery,
            engine: libraryEngine,
            labels: libraryLabels,
            sort: librarySort,
            page: libraryPageNumber,
          },
        );
        libraryPageNumber = result.page;
        const cards = result.models
          .map((m) => {
            const references = modelReferences(m),
              blocked = references.length > 0 || !!m.usage?.in_use;
            const classifier = m.metadata?.model_type === "face_classifier";
            const title = classifier ? "Classifier" : "Model";
            const count = m.classes?.length || 0;
            const labels =
              m.metadata?.label_semantics === "identity"
                ? "identities"
                : "classes";
            return `<article class="we-model-card" data-library-model="${esc(m.id)}"><header><div><h4>${esc(m.name)}</h4><small>${esc(m.engine.toUpperCase())} · ${esc(m.format || "model")} · ${esc(m.id.slice(0, 8))}</small></div><span class="we-model-role" title="Model role: ${esc(m.metadata?.model_type || "Model")}">${esc((m.metadata?.model_type || "Model").replaceAll("_", " "))}</span></header><p class="we-model-label-summary">${count} ${labels}${count ? ` · ${esc(m.classes.slice(0, 5).join(", "))}${count > 5 ? " …" : ""}` : " · Add labels or read metadata"}</p><div class="we-model-card-actions"><button class="button secondary" data-library-use="${esc(m.id)}" ${libraryBusy ? "disabled" : ""}>Add ${title} node</button><button class="button secondary we-model-remove" data-request-remove-model="${esc(m.id)}" ${demo || libraryBusy || blocked ? "disabled" : ""} title="${esc(blocked ? "Referenced by a camera or workflow. Remove its assignments first." : "Remove this model from the local library")}">Remove</button></div>${blocked ? `<p class="we-model-in-use">In use${references.length ? ` · ${esc(references[0])}` : ""}</p>` : ""}${removingModel === m.id ? `<section class="we-model-remove-confirm" role="group" aria-label="Confirm model removal"><b>Remove ${esc(m.name)}?</b><p>${m.uploaded ? "This deletes the uploaded model file from this computer." : "This removes the library entry. The registered source file is kept."}</p><div><button class="button secondary" data-cancel-remove-model>Cancel</button><button class="button primary" data-confirm-remove-model="${esc(m.id)}" ${demo || libraryBusy || blocked ? "disabled" : ""}>${m.uploaded ? "Delete uploaded model" : "Remove from library"}</button></div></section>` : ""}<details data-model-details="${esc(m.id)}" ${openModelDetails.has(m.id) ? "open" : ""}><summary>Details, labels & metadata</summary><p class="we-model-path">${esc(m.path)}</p><p>${esc(m.metadata?.inspection || m.inspection || m.status || "Registered")}</p>${m.metadata?.compatibility ? `<p>${esc(m.metadata.compatibility)}</p>` : ""}${m.metadata?.unknown_rejection ? `<p>${esc(m.metadata.unknown_rejection)}</p>` : ""}${m.metadata?.inspection_error ? `<p role="status">${esc(m.metadata.inspection_error)}</p>` : ""}${references.length ? `<ul>${references.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}<button class="button secondary" data-inspect-model="${esc(m.id)}" ${demo || libraryBusy ? "disabled" : ""}>Read file metadata</button>${metadataSourcePanel(m)}<label>${labels === "identities" ? "Identity" : "Class"} labels (comma separated)<input data-library-classes="${esc(m.id)}" value="${esc((m.classes || []).join(", "))}" ${demo || libraryBusy ? "disabled" : ""}></label><button class="button secondary" data-save-classes="${esc(m.id)}" ${demo || libraryBusy ? "disabled" : ""}>Save labels</button></details></article>`;
          })
          .join("");
        return `<p class="we-library-match" role="status">${result.total ? `${result.page * result.size + 1}–${Math.min((result.page + 1) * result.size, result.total)} of ${result.total}` : "0"} matching models · ${result.all} total</p><div class="we-library-list">${cards || `<p class="we-library-empty">${library.length ? "No models match these filters. Clear filters to see all models." : "No models registered. Add your first local model above."}</p>`}</div><nav class="we-library-pages" aria-label="Model library pages"><button class="button secondary" data-library-prev ${result.page === 0 ? "disabled" : ""}>Previous</button><span>Page ${result.page + 1} of ${result.pages}</span><button class="button secondary" data-library-next ${result.page + 1 >= result.pages ? "disabled" : ""}>Next</button></nav>`;
      }
      function refreshLibraryResults() {
        const results = root.querySelector("[data-library-results]");
        if (results) results.innerHTML = libraryResults();
        const status = root.querySelector("[data-library-status]");
        if (status) status.textContent = libraryMessage;
      }
      function paletteContents() {
        return (
          paletteGroups(paletteQuery)
            .map((group) => ({
              ...group,
              types: group.types.filter(
                (type) =>
                  (demo || type !== "browser_motion") &&
                  (subflowEditing ||
                    workflowExecution(graph).allow_calls ||
                    graph.nodes.some((item) => item.type === "subflow_input") ||
                    !["subflow_input", "subflow_output"].includes(type)),
              ),
            }))
            .filter((group) => group.types.length)
            .map(
              (group) =>
                `<details class="we-node-group" data-palette-group="${esc(group.label)}" ${paletteQuery || !collapsedPaletteGroups.has(group.label) ? "open" : ""}><summary>${esc(group.label)}<span>${group.types.length}</span></summary><div>${group.types.map((type) => `<button data-add="${type}" draggable="true">${esc(TYPES[type].label)}<span aria-hidden="true">+</span></button>`).join("")}</div></details>`,
            )
            .join("") ||
          '<p class="we-palette-empty" role="status">No matching nodes.</p>'
        );
      }
      function libraryPanel() {
        return `<section class="we-library" aria-labelledby="we-library-title"><header class="we-library-header"><div><h3 id="we-library-title">Local model library</h3><p>${demo ? "Showcase editing only. Native model upload and inference require the installed app." : "Connect a Model or Classifier node to Detections. Model assignments are managed by workflows."}</p></div><button class="button secondary" data-refresh-models ${demo || libraryBusy ? "disabled" : ""}>Refresh models & usage</button></header><details class="we-library-add"><summary>Add or register models</summary><div class="we-library-import"><label>Model engine<select data-library-engine><option value="yolo">YOLO</option><option value="insightface">InsightFace</option></select></label><label>Model name<input data-library-name maxlength="128" placeholder="e.g. Entrance faces"></label><label>Model file<input data-library-file type="file" accept=".onnx,.pt" ${demo || libraryBusy ? "disabled" : ""}></label><button class="button primary" data-upload-model ${demo || libraryBusy ? "disabled" : ""}>Upload model</button></div><details><summary>Register an existing file</summary><label>Local model path<input data-library-path placeholder="C:/models/detector.onnx"></label><button class="button secondary" data-register-model ${demo || libraryBusy ? "disabled" : ""}>Register local model</button><p>Registered files stay in their original location. Removing a registration keeps its source file.</p></details></details><div class="we-library-tools"><label class="we-library-search">Search models<input type="search" data-library-search value="${esc(libraryQuery)}" placeholder="Name, identity, class or file path" autocomplete="off"></label><label>Engine<select data-library-filter-engine>${[
          ["all", "All engines"],
          ["yolo", "YOLO"],
          ["insightface", "InsightFace"],
        ]
          .map(
            ([v, label]) =>
              `<option value="${v}" ${libraryEngine === v ? "selected" : ""}>${label}</option>`,
          )
          .join(
            "",
          )}</select></label><label>Labels<select data-library-filter-labels>${[
          ["all", "All models"],
          ["available", "With labels"],
          ["missing", "Needs labels"],
        ]
          .map(
            ([v, label]) =>
              `<option value="${v}" ${libraryLabels === v ? "selected" : ""}>${label}</option>`,
          )
          .join("")}</select></label><label>Sort<select data-library-sort>${[
          ["name", "Name A–Z"],
          ["name-desc", "Name Z–A"],
          ["engine", "Engine"],
        ]
          .map(
            ([v, label]) =>
              `<option value="${v}" ${librarySort === v ? "selected" : ""}>${label}</option>`,
          )
          .join(
            "",
          )}</select></label><button class="button secondary" data-library-clear>Clear filters</button></div><div data-library-results>${libraryResults()}</div><p role="status" data-library-status>${esc(libraryMessage)}</p></section>`;
      }

      function restoreModelForm(form, previousFocus = null) {
        const replacement = root.querySelector(".we-library-add");
        if (!form?.contains || !form.querySelectorAll || !replacement?.replaceWith) return;
        const focus = previousFocus || (form.contains(document.activeElement) ? document.activeElement : null);
        replacement.replaceWith(form);
        form.querySelectorAll("[data-library-file], [data-upload-model], [data-register-model]").forEach((control) => {
          control.disabled = demo || libraryBusy;
        });
        focus?.focus?.({ preventScroll: true });
      }

      function detectorChoice(n) {
        return n?.type === "model"
          ? builtinModel(n.params.model_id)?.detector || "custom"
          : "";
      }
      function detectorPanel(n) {
        const id = detectorChoice(n),
          item = detectorCatalog.find((detector) => detector.id === id),
          installable =
            ["scrfd-500mf", "scrfd-2.5gf", "scrfd-10gf"].includes(id) &&
            item?.downloadable !== false;
        const info = !id
          ? "Uses camera's active detection pipeline."
          : id === "custom"
            ? "Connect a local InsightFace Model node to MODEL IN."
            : id === "retinaface"
              ? "RetinaFace needs a compatible local ONNX model connected to MODEL IN. It is not a bundled download."
              : item?.available
                ? `Available locally${item.path ? ` · ${item.path}` : ""}.`
                : item?.hint ||
                  (detectorCatalog.length
                    ? "Detector files are not installed locally."
                    : "Checking local detector catalog…");
        return `<section class="we-detector-catalog"><h4>Local detector availability</h4><p>${esc(info)}</p>${item?.license ? `<p>License: ${esc(item.license)}</p>` : ""}${installable && item && !item.available ? `<p>Install downloads this detector once to this computer. Review its license terms before use.</p><button class="button secondary" data-install-detector="${esc(id)}" ${demo || !!detectorBusy ? "disabled" : ""}>${detectorBusy === id ? "Installing locally…" : "Install detector locally"}</button>` : ""}<button class="button secondary" data-refresh-detectors ${demo || !!detectorBusy ? "disabled" : ""}>Refresh local catalog</button>${detectorMessage ? `<p role="status">${esc(detectorMessage)}</p>` : ""}</section>`;
      }
      async function loadDetectorCatalog() {
        if (demo || !mounted) return;
        detectorController?.abort();
        const active = (detectorController = new AbortController()),
          timeout = setTimeout(() => active.abort(), 5000);
        try {
          const response = await fetch("/api/vision/detectors", {
            cache: "no-store",
            signal: active.signal,
          });
          const data = await response.json();
          if (!response.ok)
            throw Error(data.error || "Detector catalog unavailable.");
          if (!mounted || active !== detectorController) return;
          detectorCatalog = data.detectors || [];
          const node = graph?.nodes.find((item) => item.id === selected),
            panel = root.querySelector(".we-detector-catalog");
          if (node && panel) panel.outerHTML = detectorPanel(node);
        } catch (error) {
          if (mounted && error.name !== "AbortError") {
            detectorMessage = error.message;
            const status = root.querySelector(
              ".we-detector-catalog [role='status']",
            );
            if (status) status.textContent = detectorMessage;
          }
        } finally {
          clearTimeout(timeout);
        }
      }
      async function loadGalleryModels(active) {
        const timeout = setTimeout(() => active.abort(), 5000);
        try {
          const response = await fetch("/api/faces/classifiers", {
            cache: "no-store",
            signal: active.signal,
          });
          if (!response.ok) return;
          const data = await response.json();
          if (!mounted || active !== libraryController) return;
          const galleries = (data.models || []).filter(
            (item) => item.metadata?.model_type === "face_gallery",
          );
          library = library
            .filter((item) => item.metadata?.model_type !== "face_gallery")
            .concat(galleries);
          refreshSignalPanels();
        } catch {
          /* Native gallery storage does not block the model library. */
        } finally {
          clearTimeout(timeout);
        }
      }
      async function loadLibrary() {
        if (demo || !mounted) return;
        libraryController?.abort();
        const active = (libraryController = new AbortController());
        const timeout = setTimeout(() => active.abort(), 5000);
        try {
          const response = await fetch("/api/models", {
            cache: "no-store",
            signal: active.signal,
          });
          const data = await response.json();
          if (!response.ok)
            throw Error(data.error || "Model library unavailable.");
          if (!mounted || active !== libraryController) return;
          library = data.models || [];
          if (data.storage_error) libraryMessage = data.storage_error;
          // Keep active forms, ports, and drags stable while metadata arrives.
          const panel = root.querySelector(".we-library");
          if (panel) {
            const form = panel.querySelector?.(".we-library-add");
            const focus = form?.contains?.(document.activeElement) ? document.activeElement : null;
            panel.outerHTML = libraryPanel();
            restoreModelForm(form, focus);
          }
          refreshSignalPanels();
          loadGalleryModels(active);
        } catch (error) {
          if (mounted && error.name !== "AbortError") {
            libraryMessage = error.message;
            const status = root.querySelector("[data-library-status]");
            if (status) status.textContent = libraryMessage;
          }
        } finally {
          clearTimeout(timeout);
        }
      }
      async function removeLibraryModel(id) {
        if (demo || libraryBusy) return;
        const model = library.find((item) => item.id === id);
        if (!model) return;
        const references = modelReferences(model);
        if (references.length || model.usage?.in_use) {
          libraryMessage =
            "Model is in use. Remove its camera/workflow assignments and save first.";
          removingModel = "";
          refreshLibraryResults();
          return;
        }
        libraryBusy = true;
        libraryMessage = "Removing local model…";
        refreshLibraryResults();
        try {
          const result = await post(
            `/api/models/${encodeURIComponent(id)}/remove`,
            {},
          );
          if (!mounted) return;
          library = library.filter((item) => item.id !== id);
          openModelDetails.delete(id);
          removingModel = "";
          libraryMessage =
            result.cleanup_error ||
            (result.deleted_file
              ? "Uploaded model and its library entry deleted."
              : "Model removed from the library. Source file kept.");
          await loadLibrary();
        } catch (error) {
          if (!mounted) return;
          libraryMessage = error.message;
          await loadLibrary();
        } finally {
          libraryBusy = false;
          if (mounted) refreshLibraryResults();
        }
      }
      async function importModel(upload) {
        if (demo || libraryBusy) return;
        const engine =
            root.querySelector("[data-library-engine]").value || "yolo",
          name = root.querySelector("[data-library-name]").value.trim();
        const file = root.querySelector("[data-library-file]").files?.[0],
          path = root.querySelector("[data-library-path]").value.trim();
        if (upload && (!file || file.size > 256 * 1024 * 1024)) {
          issue("Choose a model file up to 256 MiB.");
          return;
        }
        libraryBusy = true;
        libraryMessage = "Importing locally...";
        const status = root.querySelector("[data-library-status]");
        if (status) status.textContent = libraryMessage;
        root
          .querySelectorAll("[data-upload-model],[data-register-model]")
          .forEach((b) => (b.disabled = true));
        const request = new AbortController();
        requestControllers.add(request);
        const timeout = setTimeout(() => request.abort(), 120000);
        try {
          let data;
          if (upload) {
            const response = await fetch(
              `/api/models/upload?filename=${encodeURIComponent(file.name)}&engine=${encodeURIComponent(engine)}&name=${encodeURIComponent(name || file.name)}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/octet-stream",
                  "X-Spyder-Control": "1",
                },
                body: file,
                signal: request.signal,
              },
            );
            data = await response.json();
            if (!response.ok) throw Error(data.error || "Model upload failed.");
          } else
            data = await post("/api/models/register", {
              path,
              engine,
              ...(name ? { name } : {}),
            });
          if (!mounted) return;
          libraryMessage =
            "Model registered. Select it in a Model node. Registration does not guarantee inference compatibility.";
          await loadLibrary();
          render(true);
        } catch (error) {
          if (mounted) {
            libraryMessage = error.message;
            issue(error.message);
          }
        } finally {
          clearTimeout(timeout);
          requestControllers.delete(request);
          libraryBusy = false;
          if (mounted) {
            const panel = root.querySelector(".we-library");
            if (panel) panel.outerHTML = libraryPanel();
          }
        }
      }
      // Display padding lets workflows near coordinate zero be centered without
      // changing persisted node coordinates or running out of room to pan.
      const canvasPadding = 1000;
      function centerCanvas(anchor) {
        const wrap = root.querySelector(".we-canvas-wrap");
        if (!wrap) return;
        const nodes = anchor ? [anchor] : graph?.nodes || [];
        const x = nodes.length
          ? (Math.min(...nodes.map((n) => clamp(n.x))) +
              Math.max(...nodes.map((n) => clamp(n.x) + nodeSize(n).width))) /
            2
          : 122;
        const y = nodes.length
          ? (Math.min(...nodes.map((n) => clamp(n.y))) +
              Math.max(...nodes.map((n) => clamp(n.y) + nodeSize(n).height))) /
            2
          : 98;
        wrap.scrollLeft = Math.max(
          0,
          (canvasPadding + x) * viewScale - (wrap.clientWidth || 800) / 2,
        );
        wrap.scrollTop = Math.max(
          0,
          (canvasPadding + y) * viewScale - (wrap.clientHeight || 320) / 2,
        );
      }
      function setViewScale(value) {
        const previousScale = viewScale;
        const wrap = root.querySelector(".we-canvas-wrap");
        const centerX = wrap
          ? (wrap.scrollLeft + wrap.clientWidth / 2) / previousScale
          : 0;
        const centerY = wrap
          ? (wrap.scrollTop + wrap.clientHeight / 2) / previousScale
          : 0;
        viewScale = clampViewScale(value);
        const canvas = root.querySelector("[data-canvas]");
        if (canvas) canvas.style.zoom = String(viewScale);
        if (wrap) {
          wrap.scrollLeft = centerX * viewScale - wrap.clientWidth / 2;
          wrap.scrollTop = centerY * viewScale - wrap.clientHeight / 2;
        }
        const status = root.querySelector("[data-zoom-level]");
        if (status) status.textContent = `${Math.round(viewScale * 100)}%`;
      }
      const portOffset = (input, target) =>
        target?.type === "detections"
          ? input === "camera"
            ? 16
            : input === "model"
              ? 38
              : input === "classifier"
                ? 60
                : 82
          : target?.type === "preview" && input === "camera"
            ? 16
            : 38;
      function wirePath(e) {
        const a = graph.nodes.find((n) => n.id === e.from),
          b = graph.nodes.find((n) => n.id === e.to);
        if (!a || !b) return "";
        const ax = canvasPadding + clamp(a.x) + nodeSize(a).width,
          ay = canvasPadding + clamp(a.y) + 38,
          bx = canvasPadding + clamp(b.x),
          by =
            canvasPadding +
            clamp(b.y) +
            portOffset(inputType(e, graph.nodes), b);
        return `M ${ax} ${ay} C ${ax + 41} ${ay}, ${bx - 40} ${by}, ${bx} ${by}`;
      }
      function syncEdgeLabels() {
        const canvas = root.querySelector("[data-canvas]");
        if (!canvas) return;
        for (const edge of graph.edges) {
          const a = graph.nodes.find((n) => n.id === edge.from),
            b = graph.nodes.find((n) => n.id === edge.to);
          const group = canvas
            .querySelector(`[data-wire="${edge.from}|${edge.to}"]`)
            ?.closest(".we-edge");
          if (!a || !b || !group) continue;
          let text = group.querySelector(".we-wire-label");
          if (!edge.label) {
            text?.remove();
            continue;
          }
          if (!text) {
            text = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "text",
            );
            text.setAttribute("class", "we-wire-label");
            group.append(text);
          }
          text.textContent = edge.label;
          text.setAttribute(
            "x",
            canvasPadding + (clamp(a.x) + nodeSize(a).width + clamp(b.x)) / 2,
          );
          text.setAttribute(
            "y",
            canvasPadding +
              (clamp(a.y) +
                38 +
                clamp(b.y) +
                portOffset(inputType(edge, graph.nodes), b)) /
                2 -
              8,
          );
        }
      }
      function wireActions(e) {
        const a = graph.nodes.find((n) => n.id === e.from),
          b = graph.nodes.find((n) => n.id === e.to);
        if (!a || !b) return "";
        const x =
          canvasPadding +
          (clamp(a.x) + nodeSize(a).width + clamp(b.x)) / 2 -
          22;
        const y =
          canvasPadding +
          (clamp(a.y) +
            38 +
            clamp(b.y) +
            portOffset(inputType(e, graph.nodes), b)) /
            2 -
          22;
        return `<foreignObject data-wire-actions="${esc(e.from)}|${esc(e.to)}" class="we-wire-actions" x="${x}" y="${y}" width="44" height="44"><button xmlns="http://www.w3.org/1999/xhtml" class="we-wire-trash" data-delete-edge="${esc(e.from)}|${esc(e.to)}" aria-label="Delete connection from ${esc(TYPES[a.type]?.label)} to ${esc(TYPES[b.type]?.label)}" title="Delete connection"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#close"/></svg></button></foreignObject>`;
      }
      function removeConnection(key) {
        const [from, to] = key.split("|");
        if (!graph.edges.some((e) => e.from === from && e.to === to)) return;
        remember();
        graph.edges = graph.edges.filter((e) => e.from !== from || e.to !== to);
        selectedEdge = "";
        reconnectChoice = null;
        const removed = pruneBindings(graph);
        notice = removed
          ? `Connection deleted. Cleared ${removed} data link(s) whose source is no longer upstream.`
          : "Connection deleted. Nodes kept.";
        changed();
      }
      function connectionPanel() {
        const endpoint = (id) => {
          const item = graph.nodes.find((node) => node.id === id);
          const label = TYPES[item?.type]?.label || item?.type || "Unavailable node";
          const summary = item ? nodeSummary(item) : "Node unavailable";
          return `<div class="we-connection-endpoint"><strong>${esc(label)}</strong>${summary !== item?.type && summary !== label ? `<small>${esc(summary)}</small>` : ""}<code title="Node ID: ${esc(id)}">${esc(id)}</code></div>`;
        };
        const inputLabels = { camera: "Camera input", model: "Model input", classifier: "Classifier input", detections: "Detection data" };
        const rows = graph.edges.map((edge) => {
          const from = graph.nodes.find((item) => item.id === edge.from);
          const to = graph.nodes.find((item) => item.id === edge.to);
          const fromLabel = TYPES[from?.type]?.label || edge.from;
          const toLabel = TYPES[to?.type]?.label || edge.to;
          return `<article class="we-connection-row" role="listitem"><div class="we-connection-route">${endpoint(edge.from)}<svg class="icon we-connection-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6"/></svg>${endpoint(edge.to)}</div><div class="we-connection-meta"><span class="we-connection-kind">${esc(inputLabels[inputType(edge, graph.nodes)] || "Data input")}</span>${edge.label ? `<span class="we-connection-label">${esc(edge.label)}</span>` : ""}</div><button type="button" class="button secondary we-edge-delete we-connection-remove" data-delete-edge="${esc(edge.from)}|${esc(edge.to)}" aria-label="Disconnect ${esc(fromLabel)} ${esc(edge.from)} from ${esc(toLabel)} ${esc(edge.to)}"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m9 15 6-6M7 7l-3 3a4 4 0 0 0 6 6l2-2m0-4 2-2a4 4 0 0 1 6 6l-3 3M3 3l18 18"/></svg><span>Disconnect</span></button></article>`;
        }).join("");
        return `<details class="we-connections-panel" data-connections-panel data-connections-workflow="${esc(graph.id)}" ${connectionsOpen ? "open" : ""}><summary><span>Connections</span><span class="we-connection-count">${graph.edges.length}</span></summary><div class="we-connections-help"><p>Disconnect removes only the link. Both nodes stay on the canvas.</p><button type="button" class="button secondary" data-undo ${undoStack.length ? "" : "disabled"}>Undo last edit</button></div>${rows ? `<div class="we-connection-list" role="list" aria-label="Workflow connections">${rows}</div>` : '<p class="we-connections-empty">No connections yet. Connect compatible ports on the canvas, or use Connect nodes above.</p>'}</details>`;
      }
      function beginReconnect(edge, e) {
        const source = graph.nodes.find((n) => n.id === edge.from);
        if (!source) return;
        reconnectChoice = null;
        wireDrag = {
          node: source.id,
          direction: "out",
          edge: clone(edge),
          x: canvasPadding + clamp(source.x) + nodeSize(source).width,
          y: canvasPadding + clamp(source.y) + 38,
          currentX: e.clientX,
          currentY: e.clientY,
          pointerId: e.pointerId,
        };
        root.querySelector(".we-wire-live")?.remove();
        try {
          root.setPointerCapture?.(e.pointerId);
        } catch {}
        e.preventDefault();
        issue(
          "Move the connection to another compatible IN port. Release on empty space to cancel.",
        );
      }
      function reconnectEdge(original, from, to, input) {
        const source = graph.nodes.find((n) => n.id === from),
          target = graph.nodes.find((n) => n.id === to);
        if (!accepts(source, target, input || outputType(source))) {
          issue("Choose a compatible IN port. Original connection kept.");
          render(true);
          return;
        }
        if (original.from === from && original.to === to) {
          render(true);
          return;
        }
        const candidate = clone(graph);
        candidate.edges = candidate.edges.filter(
          (e) => e.from !== original.from || e.to !== original.to,
        );
        const moved = {
            ...edgeFor(from, to, candidate.nodes),
            ...(original.label ? { label: original.label } : {}),
          },
          candidateTarget = candidate.nodes.find((n) => n.id === to);
        if (
          candidateTarget?.type === "detections" &&
          candidateTarget.params.engine === "insightface" &&
          inputType(moved, candidate.nodes) === "model"
        )
          delete candidateTarget.params.detector;
        candidate.edges.push(moved);
        const removed = pruneBindings(candidate),
          errors = validate(candidate);
        if (errors.length) {
          issue(errors.join(" ") + " Original connection kept.");
          render(true);
          return;
        }
        remember();
        graph = candidate;
        selectedEdge = "";
        notice = removed
          ? `Connection moved. Cleared ${removed} data link(s) whose source is no longer upstream.`
          : "Connection moved. Nodes kept.";
        changed();
      }
      function nodeSummary(n) {
        if (n.type === "browser_motion")
          return `${n.params?.roi ? "Region motion" : "Motion fraction"} ≥ ${(100*Number(n.params?.threshold ?? 0.1)).toFixed(1)}%`;
        if (
          n.type === "filter" &&
          n.params.rules?.some((r) => r.operator === "is_unknown")
        )
          return "Face · Is unknown";
        if (n.type === "event" && n.params.attachment === "recording")
          return `Record · ${n.params.pre_event_seconds || 0}s before · ${n.params.duration_seconds}s after`;
        if (n.type === "subflow") {
          const definition = subflowCatalog.find(
            (item) =>
              item.id === n.params.subflow_id &&
              item.version === n.params.version,
          );
          return definition
            ? `${definition.name} · v${n.params.version}`
            : n.params.subflow_id
              ? `Pinned v${n.params.version} · definition unavailable`
              : "Choose a reusable subflow";
        }
        if (n.type === "preview")
          return "Live branch monitor · CAM / DATA input";
        if (n.type === "camera")
          return (
            cameraList().find((c) => c.id === n.params.camera_id)?.name ||
            "Choose camera"
          );
        if (n.type === "model")
          return (
            builtinModel(n.params.model_id)?.name ||
            [...BUILTIN_MODELS, ...library].find(
              (m) => m.id === n.params.model_id,
            )?.name ||
            "Choose model"
          );
        if (n.type === "classifier")
          return (
            [...BUILTIN_MODELS, ...library].find(
              (m) => m.id === n.params.model_id,
            )?.name || "Choose classifier"
          );
        if (n.type === "detections" && n.params.engine === "insightface")
          return "Model IN · face detection";
        return n.type;
      }
      const templateContext = () => ({
        cameraId: cameraList()[0]?.id || "",
        cameras: cameraList(),
        classifierId: classifierModels()[0]?.id || "",
      });
      function templateThumbnail(entry) {
        const sample = createWorkflowTemplate(entry.id, templateContext());
        const width = Math.max(...sample.nodes.map((n) => n.x)) + 220;
        const height = Math.max(...sample.nodes.map((n) => n.y)) + 130;
        const wires = sample.edges
          .map((edge) => {
            const from = sample.nodes.find((n) => n.id === edge.from);
            const to = sample.nodes.find((n) => n.id === edge.to);
            return `<path d="M ${from.x + 160} ${from.y + 32} C ${from.x + 200} ${from.y + 32}, ${to.x - 40} ${to.y + 32}, ${to.x} ${to.y + 32}"/>`;
          })
          .join("");
        return `<svg class="we-template-thumbnail" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false"><g class="we-template-wires">${wires}</g>${sample.nodes.map((n) => `<g class="we-template-mini ${n.type === "event" || n.type === "notification" ? "is-action" : ""}"><rect x="${n.x}" y="${n.y}" width="160" height="64" rx="12"/><circle cx="${n.x}" cy="${n.y + 32}" r="5"/><circle cx="${n.x + 160}" cy="${n.y + 32}" r="5"/><text x="${n.x + 80}" y="${n.y + 38}" text-anchor="middle">${esc(TYPES[n.type].label)}</text></g>`).join("")}</svg>`;
      }
      function templateRows() {
        const entries = templateEntries(templateQuery, demo);
        return `<p class="we-template-count" role="status">${entries.length} ${entries.length === 1 ? "template" : "templates"}</p>${entries.map((entry) => `<article class="we-template-row" aria-labelledby="we-template-${entry.id}"><div class="we-template-preview">${templateThumbnail(entry)}<span>${esc(entry.category)}</span></div><div class="we-template-copy"><h4 id="we-template-${entry.id}">${esc(entry.name)}</h4><p>${esc(entry.description)}</p><p class="we-template-purpose"><strong>Best for:</strong> ${esc(entry.purpose)}</p><p class="we-template-timing">${esc(entry.details)} · ${createWorkflowTemplate(entry.id, templateContext()).nodes.length} nodes</p><ul class="we-template-requirements" aria-label="Requirements">${entry.requirements.map((value) => `<li>${esc(value)}</li>`).join("")}</ul><p class="we-template-setup">${esc(entry.setup)}</p></div><button type="button" class="button primary" data-load-template="${entry.id}" aria-label="Load ${esc(entry.name)}">Load template</button></article>`).join("") || '<p class="we-template-empty">No templates match. Try “recording”, “face”, or “InsightFace”.</p>'}`;
      }
      function templatePanel() {
        if (!templatePickerOpen) return "";
        return `<div class="we-modal-backdrop" data-template-modal><section class="we-modal we-template-modal" role="dialog" aria-modal="true" aria-labelledby="we-template-title" aria-describedby="we-template-help" tabindex="-1"><header><div><p class="eyebrow">START WITH A WORKFLOW</p><h3 id="we-template-title">Workflow templates</h3></div><button type="button" class="button secondary dialog-close" data-close-templates aria-label="Close templates"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#close"/></svg></button></header><details class="we-template-guidance"><summary>How templates work · Undo preserves your previous draft</summary><p id="we-template-help">Load a new disabled draft, then review its camera and settings before saving and enabling. Saved workflows stay intact. Undo restores your previous draft${dirty ? ", including its unsaved changes" : ""}.</p>${demo ? '<p class="we-demo">Showcase: templates are editable local drafts. Native detection, pre-event recording, and workflow actions require the installed app.</p>' : ""}</details><label class="we-template-search">Search templates<input type="search" data-template-search placeholder="Search by purpose, engine, or requirement" value="${esc(templateQuery)}" autocomplete="off"></label><div class="we-template-list" data-template-list>${templateRows()}</div><footer><span>Loads disabled. Review settings before enabling.</span><button type="button" class="button secondary" data-close-templates>Cancel</button></footer></section></div>`;
      }
      function closeTemplates() {
        templatePickerOpen = false;
        render(true);
        focusWorkflowMenu();
      }
      function historyPanel() {
        const policy = workflowHistory(graph);
        const preset =
          policy.states.length === 3
            ? "all"
            : policy.states.length === 1 && policy.states[0] === "error"
              ? "errors"
              : "custom";
        return `<details class="we-history-settings"><summary>History saving · ${!policy.enabled ? "Disabled" : preset === "errors" ? "Failures only" : preset === "all" ? "All outcomes" : "Custom outcomes"}${policy.enabled && policy.min_interval_seconds ? ` · interval ${policy.min_interval_seconds}s${policy.always_save_errors && policy.states.includes("error") ? " + errors always" : ""}` : ""}</summary><p>Applies when you save this workflow. Existing history is kept. Global collection and retention limits still apply. Called nodes are recorded inside the caller's execution, using the caller's rules.</p><div class="we-history-grid"><label class="we-history-check"><input type="checkbox" data-history-enabled ${policy.enabled ? "checked" : ""}>Save execution history for this workflow</label><label>Outcome preset<select data-history-preset><option value="all" ${preset === "all" ? "selected" : ""}>All executions</option><option value="errors" ${preset === "errors" ? "selected" : ""}>Failed / error executions only</option><option value="custom" disabled ${preset === "custom" ? "selected" : ""}>Custom outcomes (checkboxes below)</option></select></label><fieldset><legend>Outcomes to keep</legend>${[
          ["completed", "Completed"],
          ["filtered", "Filtered / no match"],
          ["error", "Failed / error"],
        ]
          .map(
            ([state, label]) =>
              `<label class="we-history-check"><input type="checkbox" data-history-state="${state}" ${policy.states.includes(state) ? "checked" : ""}>${label}</label>`,
          )
          .join(
            "",
          )}</fieldset><label>Minimum time between saved runs (seconds)<input type="number" min="0" max="86400" step="1" data-history-interval value="${policy.min_interval_seconds}"><small>0 saves every selected outcome. Shared across this workflow's cameras. The interval window resets when the app restarts.</small></label><label class="we-history-check"><input type="checkbox" data-history-errors ${policy.always_save_errors ? "checked" : ""}>Always keep selected errors, even during the interval</label></div><p>Rule-based skips are intentional and do not count as dropped history. Failures means execution errors, not an unrecognized person or a filter with no match. ${demo ? "Showcase: rules are saved locally with the draft; execution stays disabled." : ""}</p></details>`;
      }
      function executionPanel() {
        const settings = workflowExecution(graph),
          mode = settings.allow_calls
            ? settings.run_independently
              ? "both"
              : "callable"
            : "independent";
        const published = subflowCatalog
          .filter((item) => item.id === graph.id)
          .sort((a, b) => b.version - a.version)[0];
        const targets = graph.nodes.filter(
          (item) =>
            ![
              "camera",
              "model",
              "classifier",
              "preview",
              "subflow_input",
              "subflow_output",
            ].includes(item.type),
        );
        const preferred =
          targets.find((item) => item.type !== "detections") || targets[0];
        const options = (selected) =>
          targets
            .map(
              (item) =>
                `<option value="${esc(item.id)}" ${item.id === selected?.id ? "selected" : ""}>${esc(TYPES[item.type].label)} · ${esc(item.id.slice(-8))}</option>`,
            )
            .join("");
        const hasInterface = graph.nodes.some(
          (item) => item.type === "subflow_input",
        );
        return `<section class="we-execution-panel" aria-label="Workflow execution"><label>Execution mode<select data-workflow-mode><option value="independent" ${mode === "independent" ? "selected" : ""}>Independent</option><option value="callable" ${mode === "callable" ? "selected" : ""}>Callable only</option><option value="both" ${mode === "both" ? "selected" : ""}>Independent + callable</option></select></label><p>${mode === "callable" ? "Runs only when called by another workflow. Independent Enable/Disable does not control calls." : mode === "both" ? "Can run from its own cameras and from workflow calls. Both can produce actions; each invocation has separate state." : "Runs from its own configured cameras when enabled."} Mode changes apply when saved.</p>${settings.allow_calls ? `<details class="we-callable-settings" open><summary>Callable interface · ${published ? `published v${published.version}` : "not published yet"}</summary><p>Callers supply detections at Workflow input and receive the Workflow output branch. Independent camera triggers are excluded from calls. For a bridge-only independent workflow, select camera results in the Cameras panel.</p>${!hasInterface ? `<div class="we-callable-interface"><label>Start callable branch at<select data-call-entry>${options(preferred)}</select></label><label>Return after<select data-call-return>${options(targets.at(-1))}</select></label><button type="button" class="button secondary" data-prepare-callable>Add input / output</button></div>` : ""}<div class="we-callable-actions"><button type="button" class="button primary" data-publish-subflow ${busy || activationBusy ? "disabled" : ""}>Save &amp; publish callable version</button><small>Saving a draft does not upgrade existing callers. Publishing keeps older versions available.</small></div></details>` : ""}</section>`;
      }
      function parameterFields(n) {
        if (!n) return "<p>Select node to edit.</p>";
        if (n.type === "subflow") {
          const latest = subflowCatalog.find(
            (item) => item.id === n.params.subflow_id,
          );
          const definition = subflowCatalog.find(
            (item) =>
              item.id === n.params.subflow_id &&
              Number(item.version) === Number(n.params.version),
          );
          const definitions = [
            ...subflowCatalog
              .reduce((items, item) => {
                const prior = items.get(item.id);
                if (!prior || Number(item.version) > Number(prior.version))
                  items.set(item.id, item);
                return items;
              }, new Map())
              .values(),
          ].sort((a, b) => a.name.localeCompare(b.name));
          const args = Object.fromEntries(
            (definition?.parameters || []).map((parameter) => [
              parameter.name,
              n.params.arguments?.[parameter.name] ?? parameter.default ?? "",
            ]),
          );
          const argumentFields = (definition?.parameters || [])
            .map((parameter) => {
              const value = args[parameter.name],
                type = parameter.type;
              const control =
                type === "boolean"
                  ? `<input type="checkbox" data-subflow-arg="${esc(parameter.name)}" data-subflow-type="boolean" ${value ? "checked" : ""}>`
                  : `<input type="${["number", "integer"].includes(type) ? "number" : "text"}" ${type === "number" ? 'step="any"' : type === "integer" ? 'step="1"' : ""} data-subflow-arg="${esc(parameter.name)}" data-subflow-type="${esc(type)}" value="${esc(value)}">`;
              const overridden = Object.hasOwn(
                n.params.arguments || {},
                parameter.name,
              );
              return `<div class="we-subflow-argument"><label>${esc(parameter.name)}${control}</label><div class="we-subflow-argument-meta"><small data-subflow-inheritance>${overridden ? "Override for this call" : "Inherited default"} · ${esc(parameter.field)}</small><button type="button" class="button secondary" data-reset-subflow-arg="${esc(parameter.name)}" ${overridden ? "" : "disabled"}>Use default</button></div></div>`;
            })
            .join("");
          return `<label>Subflow<select data-subflow-id><option value="">Choose subflow</option>${definitions.map((item) => `<option value="${esc(item.id)}" data-version="${esc(item.version)}" ${item.id === n.params.subflow_id ? "selected" : ""}>${esc(item.name)} · latest v${esc(item.version)}</option>`).join("")}</select></label><p>Call pins a specific version. Inference and camera context are shared with the parent workflow.</p>${latest ? `<label>Version<select data-subflow-version>${[...(latest.versions || [latest.version])].map((version) => `<option value="${esc(version)}" ${Number(version) === Number(n.params.version) ? "selected" : ""}>v${esc(version)}${Number(version) === Number(latest.version) ? " · latest" : ""}</option>`).join("")}</select></label>` : ""}${definition ? `<fieldset class="we-subflow-arguments"><legend>Arguments</legend>${argumentFields || "<p>This version exposes no arguments.</p>"}<details><summary>Advanced JSON</summary><label>Arguments JSON<textarea data-subflow-arguments spellcheck="false">${esc(JSON.stringify(n.params.arguments || {}, null, 2))}</textarea></label></details><p>${esc(definition.description || "No description")}</p><button type="button" class="button secondary" data-open-subflow-definition>Open workflow</button></fieldset>` : `<p>${n.params.subflow_id ? `Pinned version v${esc(n.params.version)} is unavailable in the editor.` : "Choose a published subflow."}</p>${n.params.subflow_id ? `<button type="button" class="button secondary" data-load-pinned-subflow>Load pinned version v${esc(n.params.version)}</button>` : ""}`}`;
        }
        if (n.type === "subflow_input" || n.type === "subflow_output")
          return `<p>${n.type === "subflow_input" ? "Entry point for detections from the calling workflow." : "Return this branch's detections to the calling workflow."}</p>`;

        const identitySourceField =
          n.type === "filter" && !Object.hasOwn(n.params, "identity_source")
            ? '<label>Identity source<select data-param="identity_source"><option value="identity" selected>Recognized identity</option><option value="class">Model class</option></select></label>'
            : "";
        return (
          identitySourceField +
          (n.type === "notification"
            ? demo
              ? '<section class="we-notification-delivery"><h4>In-app notifications</h4><p role="status">Browser showcase displays alerts inside this page. Desktop notifications are unavailable.</p></section>'
              : `<section class="we-notification-delivery"><h4>PC / browser notifications</h4><p data-notification-status role="status">${esc(window.spyderNotifications?.desktopStatus?.() || "Desktop permission is requested when this Notification node is used.")}</p><button class="button secondary" data-notification-permission>${window.spyderNotifications?.desktopEnabled?.() ? "Disable desktop alerts" : "Enable desktop alerts"}</button><button class="button secondary" data-notification-test>Send test notification</button><p>Allow browser notifications to receive operating-system alerts while SpyDER is unfocused. Keep a SpyDER page open and disable pause when unfocused in System settings for continuous monitoring. In-app alerts remain available if permission is blocked.</p></section>`
            : "") +
          Object.entries(n.type==="browser_motion"?{...n.params,mog2_threshold:n.params.mog2_threshold??n.params.threshold}:n.params || {})
            .filter(([k]) => !["rules", "match"].includes(k))
            .map(([k, v]) => {
              if(n.type==="browser_motion" && k==="threshold")
                return `<label>Frame difference fraction in region<input data-param="threshold" type="number" min="0" max="1" step="0.001" value="${esc(v)}"></label><p>Changed pixels divided by pixels inside the approach region. 0.025 means 2.5%. This does not recognize a person.</p>`;
              if(n.type==="browser_motion" && k==="mog2_threshold")
                return `<label>MOG2 foreground fraction in region<input data-param="mog2_threshold" type="number" min="0" max="1" step="0.001" value="${esc(v)}"></label><p>Foreground pixels divided by the region area when this camera uses OpenCV MOG2. This differs from inter-frame change; 0.003 means 0.3%. Existing workflows without an override retain their original threshold.</p>`;
              if(n.type==="browser_motion" && k==="roi")
                return `<label>Approach area: left, top, right, bottom<input data-param="roi" value="${esc(v.join(","))}"></label><p>Four normalized coordinates from 0 to 1, relative to the tuned camera image. Movement outside this area does not trigger this node.</p>`;
              if (
                n.type === "event" &&
                k === "pre_event_seconds" &&
                n.params.attachment !== "recording"
              )
                return "";
              if (n.type === "model" && k === "model_id") {
                const weights = library.filter(
                  (item) => item.metadata?.model_type !== "face_gallery",
                );
                const choices = [...BUILTIN_MODELS, ...weights];
                return `<label>Model<select data-param="model_id"><option value="">Choose model</option><optgroup label="InsightFace built-in detectors">${BUILTIN_MODELS.map((model) => `<option value="${model.id}" ${v === model.id ? "selected" : ""}>${esc(model.name)}</option>`).join("")}</optgroup><optgroup label="Uploaded and registered models">${weights.map((model) => `<option value="${esc(model.id)}" ${v === model.id ? "selected" : ""}>${esc(model.name)} | ${esc(model.engine)}</option>`).join("")}</optgroup>${v && !choices.some((model) => model.id === v) ? `<option selected value="${esc(v)}">Unavailable: choose replacement</option>` : ""}</select></label><p>Choose the detector here, then connect Model OUT to Detections MODEL IN. For RetinaFace, select a compatible uploaded or registered ONNX detector.</p>${builtinModel(v) ? detectorPanel(n) : ""}`;
              }
              if (k === "camera_id" || k === "model_id") {
                const items =
                  k === "camera_id"
                    ? cameraList()
                    : n.type === "classifier"
                      ? classifierModels()
                      : library.filter(
                          (item) =>
                            item.metadata?.model_type !== "face_gallery",
                        );
                const modelLabel =
                  n.type === "classifier"
                    ? "InsightFace classifier or enrolled gallery"
                    : "Local model";
                return `<label>${k === "camera_id" ? "Camera source" : modelLabel}<select data-param="${k}"><option value="">Choose ${k === "camera_id" ? "camera" : n.type === "classifier" ? "classifier" : "model"}</option>${items.map((item) => `<option value="${esc(item.id)}" ${v === item.id ? "selected" : ""}>${esc(item.name || item.id)}${item.engine ? ` | ${esc(item.engine)}` : ""}</option>`).join("")}${v && !items.some((item) => item.id === v) ? `<option selected value="${esc(v)}">Unavailable: choose replacement</option>` : ""}</select></label>`;
              }
              if (n.type === "detections" && k === "detector") return "";
              const galleryClassifier =
                n.type === "classifier" &&
                library.some(
                  (item) =>
                    item.id === n.params.model_id &&
                    item.metadata?.model_type === "face_gallery",
                );
              if (
                galleryClassifier &&
                ["margin", "output", "preprocessing"].includes(k)
              )
                return "";
              if (n.type === "classifier" && k === "threshold")
                return `<label>${galleryClassifier ? "Gallery cosine similarity threshold" : "Classifier threshold"}<input data-param="threshold" type="number" min="${galleryClassifier ? -1 : 0}" max="1" step="0.01" value="${esc(v)}"></label>`;
              if (n.type === "classifier" && k === "confirmations")
                return `<label>Confirm identity after<input data-param="confirmations" type="number" min="1" max="15" step="1" value="${esc(v)}"></label><p>Consecutive reliable results on the same face. Higher counts reduce flickering and delay the first identity.</p>`;
              if (n.type === "classifier" && k === "switch_confirmations")
                return `<label>Confirm identity switch after<input data-param="switch_confirmations" type="number" min="1" max="30" step="1" value="${esc(v)}"></label><p>Require at least the initial confirmation count. Conflicting or uncertain results stay unlabelled; old names are not used for alerts.</p>`;
              if (n.type === "classifier" && k === "margin")
                return `<label>Minimum lead over runner-up<input data-param="margin" type="number" min="0" max="1" step="0.01" value="${esc(v)}"></label><p>Reject close competing classes even when the best class passes the threshold. Default 0.15 means a 15 percentage point lead. Closed-set probabilities can still be confidently wrong.</p>`;
              if (n.type === "classifier" && k === "output")
                return `<label>Classifier output<select data-param="output"><option value="probabilities" ${v === "probabilities" ? "selected" : ""}>Probabilities</option><option value="logits" ${v === "logits" ? "selected" : ""}>Logits</option></select></label>`;
              if (n.type === "classifier" && k === "preprocessing")
                return `<label>Classifier preprocessing<select data-param="preprocessing"><option value="arcface" ${v === "arcface" ? "selected" : ""}>ArcFace</option><option value="embedded" ${v === "embedded" ? "selected" : ""}>Embedded model preprocessing</option></select></label>`;
              if (n.type === "notification" && k === "message")
                return `<label>Alert message<textarea data-param="message" maxlength="500">${esc(v)}</textarea></label><p>Shown as an in-app alert on any workspace. Desktop alerts use this node’s browser notification permission controls. Keep this page open and the camera running.</p>`;
              if (n.type === "notification" && k === "title")
                return `<label>Alert title<input data-param="title" maxlength="128" value="${esc(v)}"></label>`;
              if (n.type === "event" && k === "name_pattern")
                return `<label>Event name pattern<input data-param="name_pattern" maxlength="200" value="${esc(v)}"></label><p>Tokens: {workflow}, {camera}, {date}, {time}, {node}, {kind}, {label}. Unknown tokens stay literal.</p>`;
              if (n.type === "event" && k === "attachment")
                return `<label>Attachment<select data-param="attachment"><option value="none" ${v === "none" ? "selected" : ""}>None</option><option value="capture" ${v === "capture" ? "selected" : ""}>Capture</option><option value="recording" ${demo ? "disabled" : ""} ${v === "recording" ? "selected" : ""}>Recording${demo ? " · installed app only" : ""}</option></select></label><p>${demo ? "Browser showcase attaches real frame captures. For timed video, connect a Record node; workflow never takes over a manual recording." : "Clips need an idle recorder. Existing recordings are never interrupted."}</p>`;
              if (n.type === "event" && k === "duration_seconds")
                return `<label>After trigger (seconds)<input data-param="duration_seconds" type="number" min="1" max="300" step="1" value="${esc(v)}"></label>`;
              if (n.type === "event" && k === "pre_event_seconds")
                return `<label>Before trigger (seconds)<input data-param="pre_event_seconds" type="number" min="0" max="30" step="1" value="${esc(v)}"></label><p>Set 0 to disable buffering. Pre-trigger history uses a best-effort 5 fps RAM buffer, up to 64 MiB total and 8 MiB per camera. Buffer warms after camera start and clears on start or reconnect. Applies only to cameras in enabled workflows. Requires installed local app; Cloudflare showcase cannot record pre-trigger video.</p>`;
              if (n.type === "filter" && k === "identity")
                return [
                  ...upstreamClasses(n.id),
                  ...upstreamClassifierClasses(n.id),
                ].length &&
                  ((n.params.identity_source || "identity") === "class" ||
                    upstreamClassifierClasses(n.id).length)
                  ? `<label>${(n.params.identity_source || "identity") === "class" ? (upstreamClassifierClasses(n.id).length ? "Classifier identity or model class" : "Model class") : "Classifier identity"}<select data-param="identity"><option value="">Any identity</option>${[...new Set([...(n.params.identity_source === "class" ? upstreamClasses(n.id) : []), ...upstreamClassifierClasses(n.id), ...(v ? [v] : [])])].map((c) => `<option value="${esc(c)}" ${c === v ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label><p>Classifier identity choices compare with detected identity. Existing custom values remain selectable.</p>`
                  : `<label>${n.params.identity_source === "class" ? "Model class (optional)" : "Recognized identity (optional)"}<input data-param="identity" value="${esc(v)}" placeholder="Leave empty to match any value"></label><p>${n.params.identity_source === "class" ? "No class metadata available. Enter a class label or add labels to the model library." : "Identity names require a configured recognition model and identity gallery."}</p>`;
              if (n.type === "filter" && k === "identity_source")
                return `<label>Identity source<select data-param="identity_source"><option value="identity" ${(v || "identity") === "identity" ? "selected" : ""}>Recognized identity</option><option value="class" ${v === "class" ? "selected" : ""}>Model class</option></select></label>`;
              if (k === "engine")
                return `<label>Detection engine<select data-param="engine">${["any", "opencv", "yolo", "insightface"].map((x) => `<option ${x === v ? "selected" : ""}>${x}</option>`).join("")}</select></label><p>${n.params.engine === "insightface" ? "Choose an InsightFace detector in a connected Model node. Model OUT connects to MODEL IN; Classifier OUT connects to CLASSIFIER IN." : n.params.engine === "opencv" ? "The built-in OpenCV person detector is configured when this workflow is enabled. No model file is needed." : "A connected Model node selects its engine and local weights. Any uses the camera's active pipeline."}</p>`;
              if (k === "action")
                return `<label>Recording action<select data-param="action">${["start", "stop"].map((x) => `<option ${x === v ? "selected" : ""}>${x}</option>`).join("")}</select></label>`;
              if (k === "language")
                return `<label>Language<select data-param="language"><option value="python" ${v === "python" ? "selected" : ""}>Python</option><option value="javascript" ${v === "javascript" ? "selected" : ""}>JavaScript</option></select></label>`;
              if (k === "source")
                return `<label class="we-code-label">${n.params.language === "javascript" ? "JavaScript" : "Python"} code<textarea data-param="source" maxlength="8000" spellcheck="false">${esc(v)}</textarea></label><p>Assign a detection list to output. Input: detections and read-only context. No imports or file access. No network. Runtime and output limits apply.</p><pre>${n.params.language === "javascript" ? "output = detections.filter(d =&gt; (d.confidence || 0) &gt;= 0.8);" : "output = []\nfor detection in detections:\n    if (detection.get('confidence') or 0) &gt;= 0.8:\n        output.append(detection)"}</pre>`;
              if (k === "label" && n.type === "filter") {
                const classes = upstreamClasses(n.id);
                if (classes.length)
                  return `<label>Class<select data-param="label"><option value="">Any class</option>${[...new Set([...classes, ...(v ? [v] : [])])].map((c) => `<option value="${esc(c)}" ${c === v ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>`;
              }
              if (k === "confidence")
                return `<label>Minimum confidence<input data-param="confidence" type="number" min="0" max="1" step="0.01" value="${esc(v)}"></label>`;
              if (k === "minimum")
                return `<label>Minimum count<input data-param="minimum" type="number" min="1" step="1" value="${esc(v)}"></label>`;
              if (k === "seconds")
                return `<label>Cooldown (seconds)<input data-param="seconds" type="number" min="1" max="3600" step="1" value="${esc(v)}"></label>`;
              return `<label>${k === "roi" ? "ROI x1, y1, x2, y2" : esc(k)}<input data-param="${esc(k)}" value="${esc(Array.isArray(v) ? v.join(",") : v)}" ${typeof v === "number" ? 'type="number" step="any"' : ""}></label>`;
            })
            .join("") +
          (n.type === "filter" ? filterRules(n) : "")
        );
      }
      function connectNodes(from, to, input) {
        const edge = edgeFor(from, to, graph.nodes);
        if (input) edge.input = input;
        if (graph.edges.some((e) => e.from === from && e.to === to)) {
          issue("These nodes are already connected.");
          return;
        }
        const candidate = clone(graph),
          target = graph.nodes.find((n) => n.id === to);
        if (
          target?.type === "detections" &&
          target.params.engine === "insightface" &&
          inputType(edge, graph.nodes) === "model"
        )
          delete candidate.nodes.find((n) => n.id === to).params.detector;
        candidate.edges.push(edge);
        const errors = validate(candidate);
        if (errors.length) {
          issue(errors.join(" "));
          return;
        }
        remember();
        graph = candidate;
        changed();
      }
      function closeFieldHelp() {
        if (!activeHelp) return;
        const tooltip = root.querySelector(`#${activeHelp}`);
        if (tooltip) tooltip.hidden = true;
        root
          .querySelector(`[data-field-help="${activeHelp}"]`)
          ?.setAttribute("aria-expanded", "false");
        activeHelp = "";
        helpPinned = false;
      }
      function showFieldHelp(button, pin = false) {
        const id = button.dataset.fieldHelp;
        if (!id) return;
        if (activeHelp !== id) closeFieldHelp();
        activeHelp = id;
        helpPinned = helpPinned || pin;
        const tooltip = root.querySelector(`#${id}`);
        if (!tooltip) return;
        tooltip.hidden = false;
        button.setAttribute("aria-expanded", "true");
        const anchor = button.getBoundingClientRect();
        tooltip.style.left = "12px";
        tooltip.style.top = "12px";
        const bounds = tooltip.getBoundingClientRect();
        const width =
          window.innerWidth || document.documentElement?.clientWidth || 800;
        const height =
          window.innerHeight || document.documentElement?.clientHeight || 600;
        tooltip.style.left = `${Math.max(12, Math.min(anchor.right - bounds.width, width - bounds.width - 12))}px`;
        tooltip.style.top = `${Math.max(12, anchor.bottom + bounds.height + 8 <= height - 12 ? anchor.bottom + 8 : anchor.top - bounds.height - 8)}px`;
      }
      const helpOver = (e) => {
        const button = e.target.closest?.("[data-field-help]");
        if (button) showFieldHelp(button);
      };
      const helpOut = (e) => {
        if (!activeHelp || helpPinned) return;
        const tooltip = root.querySelector(`#${activeHelp}`);
        const field = tooltip?.closest?.(".we-help-field");
        if (
          field?.contains?.(e.relatedTarget) ||
          field?.contains?.(document.activeElement)
        )
          return;
        closeFieldHelp();
      };
      const helpFocusOut = (e) => {
        if (!activeHelp) return;
        const field = root
          .querySelector(`#${activeHelp}`)
          ?.closest?.(".we-help-field");
        if (!field?.contains?.(e.relatedTarget)) closeFieldHelp();
      };
      const helpScroll = (e) => {
        if (!e.target.closest?.(".we-field-tooltip")) closeFieldHelp();
      };
      function render(preserveCanvas = false) {
        const modelForm = root.querySelector(".we-library-add");
        const connections = root.querySelector("[data-connections-panel]");
        if (connections && graph && connections.dataset?.connectionsWorkflow === graph.id)
          connectionsOpen = !!connections.open;
        else if (viewGraphId !== graph?.id) connectionsOpen = false;
        const viewportTools = `<div class="we-zoom-controls"><button class="button secondary" data-zoom-out aria-label="Zoom out">−</button><output data-zoom-level>${Math.round(viewScale * 100)}%</output><button class="button secondary" data-zoom-in aria-label="Zoom in">+</button><button class="button secondary" data-zoom-reset>Reset zoom</button><button class="button secondary" data-center>Center workflow</button></div>`;
        const activePanel = root.querySelector("[data-studio-panel][open]");
        if (activePanel)
          studioScroll.set(studioPanel, activePanel.querySelector?.(".we-studio-content")?.scrollTop || 0);
        const activeElement = document.activeElement;
        const focusAttribute = activePanel?.contains?.(activeElement)
          ? [...(activeElement.attributes || [])].find((attribute) => attribute.name.startsWith("data-"))
          : null;
        const studioFocus = focusAttribute
          ? { selector: `[${focusAttribute.name}="${CSS.escape(focusAttribute.value)}"]`, start: activeElement.selectionStart, end: activeElement.selectionEnd }
          : null;
        const historyOpen = root.querySelector(".we-history-settings")?.open;
        closeFieldHelp();
        const pickerFocus =
          templatePickerOpen &&
          document.activeElement?.closest?.("[data-template-modal]")
            ? {
                search: document.activeElement.matches(
                  "[data-template-search]",
                ),
                templateId: document.activeElement.dataset?.loadTemplate,
                start: document.activeElement.selectionStart,
                end: document.activeElement.selectionEnd,
                scroll:
                  root.querySelector("[data-template-list]")?.scrollTop || 0,
                guidance: root.querySelector(".we-template-guidance")?.open,
              }
            : null;
        const retainedCanvas = preserveCanvas
          ? root.querySelector("[data-canvas]")
          : null;
        const previousWrap = root.querySelector(".we-canvas-wrap");
        const canvasScroll = previousWrap
          ? [previousWrap.scrollLeft || 0, previousWrap.scrollTop || 0]
          : null;
        const canvasFocus = retainedCanvas?.contains?.(document.activeElement)
          ? document.activeElement
          : null;
        graph ||= fresh();
        for (const n of graph.nodes) {
          if (n.type === "classifier")
            n.params = { ...clone(TYPES.classifier.params), ...n.params };
          if (n.type === "event")
            n.params = { ...clone(TYPES.event.params), ...n.params };
        }
        const options = graph.nodes
          .map(
            (n) =>
              `<option value="${esc(n.id)}">${esc(TYPES[n.type]?.label || n.type)} · ${esc(n.id.slice(-4))}</option>`,
          )
          .join("");
        const selectedNode = graph.nodes.find((n) => n.id === selected);
        const cams = cameraList()
          .map(
            (c) =>
              `<label><input data-camera="${esc(c.id)}" type="checkbox" ${graph.camera_ids.includes(c.id) ? "checked" : ""}> ${esc(c.name || c.id)}</label>`,
          )
          .join("");
        const cards = graph.nodes
          .map((n) => {
            const ports =
              n.type === "preview"
                ? `<button class="we-port we-port-in we-preview-camera-port" data-port="in" data-input="camera" aria-label="Camera IN for Preview" title="CAM: connect a Camera node directly"></button><span class="we-preview-input-label we-preview-camera-label">CAM</span><button class="we-port we-port-in" data-port="in" data-input="detections" aria-label="Detection data IN for Preview" title="DATA: connect a detection or filter branch"></button><span class="we-preview-input-label we-preview-data-label">DATA</span>`
                : n.type === "detections"
                  ? `<button class="we-port we-port-in we-port-camera" data-port="in" data-input="camera" aria-label="Camera IN for Detections"></button><span class="we-port-label we-label-camera">CAM</span><button class="we-port we-port-in we-port-model" data-port="in" data-input="model" aria-label="Custom detector Model IN for Detections"></button><span class="we-port-label we-label-model">MODEL</span><button class="we-port we-port-in we-port-classifier" data-port="in" data-input="classifier" aria-label="Classifier IN for Detections"></button><span class="we-port-label we-label-classifier">CLASSIFIER</span><button class="we-port we-port-in we-port-data" data-port="in" data-input="detections" aria-label="Detection data IN for Detections"></button><span class="we-port-label we-label-data">DATA</span>`
                  : ["camera", "model", "classifier", "subflow_input"].includes(
                        n.type,
                      )
                    ? ""
                    : `<button class="we-port we-port-in" data-port="in" data-input="detections" aria-label="Connect to ${esc(TYPES[n.type]?.label || n.type)} input"></button>`;
            return `<article data-node="${esc(n.id)}" tabindex="0" aria-label="${esc(TYPES[n.type]?.label || n.type)} node. Double-click to edit settings." class="we-node we-node-${esc(n.type)} ${n.id === selected ? "selected" : ""}">${ports}<b>${esc(TYPES[n.type]?.label || n.type)}</b><small>${esc(nodeSummary(n))}</small>${debugStates[graph.id]?.nodes?.[n.id] ? `<small class="we-node-status">${esc(formatNodeStatus(debugStates[graph.id].nodes[n.id]))}</small>` : ""}${n.type === "preview" ? `<section class="we-preview" data-preview="${esc(n.id)}" aria-label="Live workflow preview"><div class="we-preview-screen"><canvas width="640" height="360" aria-label="Camera feed with workflow overlays"></canvas><span class="we-preview-placeholder">Preview paused</span></div><div class="we-preview-controls"><button type="button" data-preview-toggle aria-pressed="false">Start preview</button><label>Camera<select data-preview-camera aria-label="Preview camera"></select></label></div><p class="we-preview-status" role="status">Connect a Camera or detection branch.</p></section>` : n.type === "subflow_output" ? "" : `<button class="we-port we-port-out we-port-${outputType(n)}" data-port="out" aria-label="Connect from ${esc(TYPES[n.type]?.label || n.type)} output"></button>`}</article>`;
          })
          .join("");
        const canvasWidth = Math.max(
          2400,
          ...graph.nodes.map(
            (n) => clamp(n.x) + canvasPadding * 2 + nodeSize(n).width + 26,
          ),
        );
        const canvasHeight = Math.max(
          2200,
          ...graph.nodes.map(
            (n) => clamp(n.y) + canvasPadding * 2 + nodeSize(n).height + 24,
          ),
        );
        const paths = graph.edges
          .map(
            (e) =>
              `<g class="we-edge ${selectedEdge === `${e.from}|${e.to}` ? "selected" : ""}"><path class="we-wire-${esc(inputType(e, graph.nodes))}" data-wire="${esc(e.from)}|${esc(e.to)}" d="${wirePath(e)}"/><path class="we-wire-hit" data-wire="${esc(e.from)}|${esc(e.to)}" d="${wirePath(e)}"/>${e.label ? `<text class="we-wire-label" x="${canvasPadding + (clamp(graph.nodes.find((n) => n.id === e.from)?.x) + nodeSize(graph.nodes.find((n) => n.id === e.from)).width + clamp(graph.nodes.find((n) => n.id === e.to)?.x)) / 2}" y="${canvasPadding + (clamp(graph.nodes.find((n) => n.id === e.from)?.y) + 38 + clamp(graph.nodes.find((n) => n.id === e.to)?.y) + 38) / 2 - 8}">${esc(e.label)}</text>` : ""}${wireActions(e)}</g>`,
          )
          .join("");
        const params = mappedFields(selectedNode);
        const errors = validate(graph);
        const rootBridgePresent =
          !subflowEditing &&
          graph.nodes.some((item) =>
            ["subflow_input", "subflow_output"].includes(item.type),
          );
        const activationModal = activationReview
          ? `<div class="we-modal-backdrop" data-activation-modal><section class="we-modal we-activation-modal" role="dialog" aria-modal="true" aria-labelledby="we-activation-title"><header><h3 id="we-activation-title">Confirm workflow activation</h3></header><p>${activationReview.preview.cameras.some((c) => (c.disable_motion || c.replaces_motion_pipeline) && c.target_engine === "insightface") ? "Motion detection will be disabled to enable face detection on these cameras:" : "The connected models will replace the Motion pipeline on these cameras:"}</p><ul>${(
              activationReview.preview.cameras || []
            )
              .filter((c) => c.replaces_motion_pipeline || c.disable_motion)
              .map((c) => `<li>${esc(c.name || c.id)}</li>`)
              .join(
                "",
              )}</ul><p>Connected model selections will be applied. Cameras must be started separately.</p><div class="we-activation-actions"><button class="button secondary" data-activation-cancel ${activationBusy ? "disabled" : ""}>Cancel</button><button class="button primary" data-activation-confirm ${activationBusy ? "disabled" : ""}>${activationBusy ? "Enabling…" : "Confirm and enable workflow"}</button></div></section></div>`
          : "";
        const menu = `<details class="we-studio-menu"><summary aria-label="Workflow menu" title="Workflow menu"><svg class="icon" aria-hidden="true"><use href="/icons.svg#reorder"/></svg><span>Workflow</span></summary><div class="we-studio-menu-items" role="group" aria-label="Workflow actions"><button type="button" data-studio-open="settings" aria-haspopup="dialog">Workflow settings</button><button type="button" data-open-templates aria-haspopup="dialog" ${busy || activationBusy || activationReview ? "disabled" : ""}>Templates</button><button type="button" data-open-subflows>Call workflow</button><button type="button" data-open-history>Execution history</button><button type="button" data-studio-open="activity" aria-haspopup="dialog">Recent events</button><hr><button type="button" data-import>Import workflow</button><button type="button" data-export>Export workflow</button><button type="button" data-remove ${subflowEditing || rootBridgePresent || busy || activationBusy ? "disabled" : ""}>Delete workflow</button></div></details>`;
        const footer = `<footer class="we-studio-footer"><div class="we-studio-footer-actions"><button type="button" class="button secondary" data-edit-selected ${selectedNode ? "" : "disabled"}>Edit node</button><button class="button secondary" data-undo>Undo</button><button class="button secondary" data-redo>Redo</button><button class="button secondary" data-copy-node ${selectedNode ? "" : "disabled"}>Copy node</button><button class="button secondary" data-paste-node ${copiedNode && graph.nodes.length < 64 ? "" : "disabled"}>Paste node</button></div><p data-studio-summary role="status">${esc(notice) || (errors.length ? `${errors.length} validation issue(s). Use Inspect node to review.` : `${graph.nodes.length} nodes · ${graph.edges.length} connections · Double-click a node to edit`)}</p></footer>`;
        const settingsContent = `<label class="we-studio-name">Workflow name<input data-name maxlength="128" value="${esc(graph.name)}"></label><p>Save keeps your draft. Enable/Disable controls independent runs; calls from other workflows use their published versions.</p><section class="we-camera-panel"><h3>Cameras</h3><div class="we-cameras">${cams || "<p>No cameras configured.</p>"}</div></section>${executionPanel()}${historyPanel()}`;
        const inspectorContent = `<div class="we-connect"><b>Connect nodes</b><label>From<select data-from>${options}</select></label><label>To<select data-to>${options}</select></label><button class="button secondary" data-connect ${graph.nodes.length < 2 ? "disabled" : ""}>Connect</button></div><div class="we-inspector"><h3>Node parameters</h3><div class="we-parameter-fields">${settingsNode ? "<p>Settings open in dialog.</p>" : params}</div><div class="we-inspector-actions"><button type="button" class="button secondary" data-edit-selected ${selectedNode ? "" : "disabled"}>Edit node</button><button class="button secondary" data-delete-node ${selectedNode ? "" : "disabled"}>Remove node</button><button class="button secondary" data-copy-node ${selectedNode ? "" : "disabled"}>Copy selected node</button></div>${connectionPanel()}<p class="we-issues" role="status">${esc(notice) || (errors.length ? `Workflow has ${errors.length} validation issue(s). Review highlighted nodes before activation.` : "")}</p>${
          errors.length
            ? `<ul class="we-validation-summary">${errors
                .map((error) => {
                  const id = graph.nodes.find(
                    (item) => item.id && error.includes(item.id),
                  )?.id;
                  return `<li>${esc(error)}${id ? ` <button type="button" class="button secondary" data-focus-node="${esc(id)}">Review ${esc(TYPES[graph.nodes.find((item) => item.id === id)?.type]?.label || "node")} ${esc(id)}</button>` : ""}</li>`;
                })
                .join(
                  "",
                )}</ul><details class="we-validation-nodes"><summary>Review workflow nodes</summary>${graph.nodes.map((item) => `<button type="button" class="button secondary" data-focus-node="${esc(item.id)}">${esc(TYPES[item.type]?.label || item.type)} · ${esc(item.id)}</button>`).join(" ")}</details>`
            : ""
        }<p class="we-pipeline">Camera to CAM input. Model to MODEL input. Detection data to DATA input. Outputs accept multiple branches. One active model pipeline per camera; conflicting assignments are rejected.</p></div>`;
        root.innerHTML = `<h1 class="sr-only">Models &amp; workflows</h1><div class="we-studio-toolbar">${menu}<div class="we-studio-identity"><label>Workflow<button type="button" class="we-workflow-picker" data-workflow data-open-workflow-manager aria-haspopup="dialog" aria-label="Manage workflows. Current: ${esc(graph.name)}" ${busy || activationBusy || activationReview ? "disabled" : ""}><span data-workflow-label>${esc(graph.name)}</span><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><small data-workflow-count>${workflowCounts.total} saved · ${workflowCounts.enabled} enabled · Manage workflows</small></label><small data-draft-state>${dirty ? "Unsaved changes" : workflows.some((item) => item.id === graph.id) ? "Saved" : "Draft"}${demo ? " · Browser showcase" : " · Local runtime"}</small></div><div class="we-studio-primary"><button class="button primary" data-save ${busy || activationBusy || activationReview ? "disabled" : ""}>${busy ? "Saving…" : "Save workflow"}</button><div class="we-activation-control"><div class="we-activation-main"><button class="button ${graph.enabled ? "primary" : "secondary"}" data-activate ${(demo && !window.spyderDemoWorkflowRuntime) || !workflowExecution(graph).run_independently || busy || activationBusy || activationReview ? "disabled" : ""}>${activationBusy ? (activationStage === "checking" ? "Checking workflow…" : "Enabling workflow…") : graph.enabled ? "Disable workflow" : "Enable workflow"}</button><strong data-workflow-state>${!workflowExecution(graph).run_independently ? "Callable only" : graph.enabled ? "Browser workflow enabled" : "Independent execution disabled"}</strong></div></div></div></div>${subflowEditing ? `<div class="we-subflow-breadcrumb"><span>Editing called workflow: ${esc(graph.name)} · ${subflowEditing.version ? `v${esc(subflowEditing.version)}` : "draft"}</span><button class="button secondary" data-subflow-back>${subflowParents.at(-1)?.editing ? "Return to parent workflow" : "Return to workflow"}</button></div>` : ""}${demo ? '<p class="we-demo" role="status">Browser showcase runs local motion workflows on imported clips. Vision models, code, and subflows are unavailable.</p>' : ""}<div class="we-activation-status ${activationError ? "is-error" : ""}" data-activation-status role="${activationError ? "alert" : "status"}" tabindex="-1" ${activationMessage ? "" : "hidden"}>${esc(activationMessage)}</div><div class="we-main"><section class="we-workspace"><div class="we-canvas-tools"><div class="we-studio-tools"><button type="button" class="button primary" data-studio-open="nodes" aria-haspopup="dialog">+ Add node</button><button type="button" class="button secondary" data-studio-open="models" aria-haspopup="dialog">Models</button><button type="button" class="button secondary" data-studio-open="inspector" aria-haspopup="dialog">Inspect node</button></div></div>${
          reconnectChoice
            ? `<div class="we-reconnect-choice" role="status"><b>Drag the connection to move its IN end:</b>${graph.edges
                .filter(
                  (e) =>
                    e.to === reconnectChoice.node &&
                    inputType(e, graph.nodes) === reconnectChoice.input,
                )
                .map(
                  (e) =>
                    `<button class="button secondary" data-reconnect-edge="${esc(e.from)}|${esc(e.to)}">${esc(TYPES[graph.nodes.find((n) => n.id === e.from)?.type]?.label)} · ${esc(e.from.slice(-4))}</button>`,
                )
                .join(
                  "",
                )}<button class="button secondary" data-cancel-reconnect>Cancel</button></div>`
            : ""
        }<div class="we-canvas-stage"><div class="we-canvas-wrap" tabindex="0" role="region" aria-label="Workflow canvas. Drag background or use arrow keys to pan."><div class="we-canvas" data-canvas><svg class="we-wires" aria-label="Workflow connections">${paths}</svg>${cards || '<p class="we-empty">Add a node to start a workflow.</p>'}</div></div>${viewportTools}</div>${footer}</section></div>${studioDialog("nodes", "Add a node", `<aside class="we-sidebar"><section class="we-palette-panel" aria-labelledby="we-palette-title"><h3 id="we-palette-title">Node palette</h3><label class="we-palette-search">Search nodes<input type="search" data-palette-search value="${esc(paletteQuery)}" placeholder="Find a node or function" autocomplete="off"></label><div class="we-palette" tabindex="0" aria-label="Scrollable node palette">${paletteContents()}</div></section><p>Click a node to add it, or drag it onto the canvas.</p></aside>`)}${studioDialog("settings", "Workflow settings", settingsContent)}${studioDialog("inspector", "Inspect node", inspectorContent)}${studioDialog("activity", "Recent events", `<section class="we-events-panel"><h3>Events</h3><div class="we-events">${
          events
            .slice(-5)
            .reverse()
            .map(
              (e) =>
                `<p>${esc(e.message || "Detection event")}<small>${esc(e.camera_id || "")} · ${esc(e.created_at ? new Date(e.created_at * 1000).toLocaleTimeString() : "")}</small></p>`,
            )
            .join("") || "<p>No recent events.</p>"
        }</div></section><button type="button" class="button secondary" data-open-history>Open execution history</button>`)}<input type="file" accept=".json,application/json" data-import-file hidden>${activationModal}`;
        if (historyOpen) root.querySelector(".we-history-settings").open = true;
        if (retainedCanvas) {
          const replacement = root.querySelector("[data-canvas]");
          replacement?.replaceWith?.(retainedCanvas);
          retainedCanvas.querySelectorAll?.("[data-node]").forEach((card) => {
            card.classList.toggle("selected", card.dataset.node === selected);
            const status = statusFor(card.dataset.node),
              existing = card.querySelector(".we-node-status");
            if (status) {
              const line = existing || document.createElement("small");
              line.className = "we-node-status";
              line.textContent = formatNodeStatus(status);
              if (!existing) card.appendChild(line);
            } else existing?.remove?.();
          });
        }
        const positionedCanvas = root.querySelector("[data-canvas]");
        if (positionedCanvas) {
          positionedCanvas.style.width = `${canvasWidth}px`;
          positionedCanvas.style.height = `${canvasHeight}px`;
          positionedCanvas.style.zoom = String(viewScale);
          for (const item of graph.nodes) {
            const card = positionedCanvas.querySelector(
              `[data-node="${item.id}"]`,
            );
            if (card) {
              card.style.left = `${canvasPadding + clamp(item.x)}px`;
              card.style.top = `${canvasPadding + clamp(item.y)}px`;
              const detail = card.querySelector("small");
              if (detail) detail.textContent = nodeSummary(item);
            }
          }
        }
        syncEdgeLabels();
        if (canvasScroll) {
          const wrap = root.querySelector(".we-canvas-wrap");
          wrap.scrollLeft = canvasScroll[0];
          wrap.scrollTop = canvasScroll[1];
        }
        if (viewGraphId !== graph.id) {
          viewGraphId = graph.id;
          centerCanvas(graph.nodes[0]);
        }
        canvasFocus?.focus?.({ preventScroll: true });
        root.insertAdjacentHTML("beforeend", studioDialog("models", "Model library", libraryPanel()));
        restoreModelForm(modelForm);
        const settings = graph.nodes.find((n) => n.id === settingsNode);
        if (settings)
          root.insertAdjacentHTML(
            "beforeend",
            `<div class="we-modal-backdrop" data-settings-modal><section class="we-modal we-node-modal" role="dialog" aria-modal="true" aria-labelledby="we-settings-title"><header><h3 id="we-settings-title">${esc(TYPES[settings.type]?.label || settings.type)} settings</h3><button type="button" class="button secondary dialog-close" data-close-settings aria-label="Close settings"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#close"/></svg></button></header>${demo ? '<p class="we-debug-unavailable" role="status">Latest node status unavailable in showcase.</p>' : statusFor(settings.id) ? `<p class="we-node-latest-status" role="status">${esc(formatNodeStatus(statusFor(settings.id)))} · ${esc(statusFor(settings.id).last_run_at || "")}</p>` : '<p class="we-node-latest-status" role="status">No recent run status available.</p>'}<p data-signal-status role="status">${esc(notice)}</p><div class="we-node-layout">${signalPanel(settings, "in")}<section class="we-node-settings" aria-label="Node settings"><div class="we-parameter-fields">${selected === settings.id ? params : ""}</div>${fieldHelpMarkup(nodeConnections(settings), settings, "connections")}${settings.type === "code" ? `<div class="we-code-actions"><button class="button secondary" data-code-test ${demo ? "disabled" : ""}>Test code locally</button><span role="status">${esc(codeError)}</span></div>${testPane ? `<section data-test-pane><p>Runs locally. Sample detections are editable.</p>${fieldHelpMarkup(`<label>Sample detections JSON<textarea data-test-input>${esc(JSON.stringify([{ label: "person", confidence: 0.93, bbox: [20, 30, 90, 180] }], null, 2))}</textarea></label>`, settings, "test")}<button class="button primary" data-run-test ${testRunning ? "disabled" : ""}>${testRunning ? "Running…" : "Run test"}</button><pre data-test-result role="status"></pre></section>` : ""}` : ""}</section>${signalPanel(settings, "out")}</div><button class="button secondary" data-close-settings>Done</button></section></div>`,
          );
        root.insertAdjacentHTML("beforeend", templatePanel());
        if (templatePickerOpen) {
          for (const item of root.children?.[Symbol.iterator]
            ? root.children
            : []) {
            if (!item.matches?.("[data-template-modal]")) item.inert = true;
          }
        }
        if (pickerFocus) {
          const list = root.querySelector("[data-template-list]");
          if (list) list.scrollTop = pickerFocus.scroll;
          const guidance = root.querySelector(".we-template-guidance");
          if (guidance) guidance.open = !!pickerFocus.guidance;
          const focus = pickerFocus.search
            ? root.querySelector("[data-template-search]")
            : TEMPLATE_CATALOG.some(
                  (entry) => entry.id === pickerFocus.templateId,
                )
              ? root.querySelector(
                  `[data-load-template="${pickerFocus.templateId}"]`,
                )
              : root.querySelector("[data-close-templates]");
          focus?.focus?.({ preventScroll: true });
          if (pickerFocus.search && pickerFocus.start !== null)
            focus?.setSelectionRange?.(pickerFocus.start, pickerFocus.end);
        }
        previewController?.sync();
        if (wireDrag) {
          const canvas = root.querySelector("[data-canvas]"),
            rect = canvas?.getBoundingClientRect();
          if (rect) {
            const x = wireDrag.x,
              y = wireDrag.y,
              ex = canvasPoint(wireDrag.currentX, rect.left, viewScale),
              ey = canvasPoint(wireDrag.currentY, rect.top, viewScale);
            canvas
              .querySelector(".we-wires")
              ?.insertAdjacentHTML(
                "beforeend",
                `<path class="we-wire-live" d="M ${x} ${y} C ${x + 50} ${y}, ${ex - 50} ${ey}, ${ex} ${ey}"/>`,
              );
          }
        }
        root.querySelectorAll?.("[data-studio-open]")?.forEach((opener) => {
          opener.setAttribute("aria-controls", `we-studio-panel-${opener.dataset.studioOpen}`);
          opener.setAttribute("aria-expanded", String(opener.dataset.studioOpen === studioPanel));
        });
        restoreStudio(studioFocus);
      }
      const mark = () => {
          dirty = true;
          const draftState = root.querySelector("[data-draft-state]");
          if (draftState) draftState.textContent = `Unsaved changes · ${demo ? "Browser showcase" : "Local runtime"}`;
          graphRevision++;
          if (demo)
            try {
              localStorage.setItem(
                subflowEditing
                  ? `spyder.workflow-editor.subflow-${subflowEditing.id}`
                  : key,
                JSON.stringify(graph),
              );
            } catch {}
        },
        changed = () => {
          mark();
          render();
        },
        add = (type, x, y) => {
          if (!TYPES[type] || graph.nodes.length >= 64) return;
          if (type === "browser_motion" && !demo) {
            issue("Browser motion nodes run only in the browser showcase.");
            return;
          }
          if (type === "notification" && !demo)
            window.spyderNotifications?.useNode?.();
          const wrap = root.querySelector(".we-canvas-wrap");
          const first = !graph.nodes.length;
          x ??= first
            ? (wrap.scrollLeft || 0) +
              (wrap.clientWidth || 800) / 2 -
              canvasPadding -
              82
            : 40 + (graph.nodes.length % 5) * 220;
          y ??= first
            ? (wrap.scrollTop || 0) +
              (wrap.clientHeight || 320) / 2 -
              canvasPadding -
              38
            : 60 + Math.floor(graph.nodes.length / 5) * 150;
          const n = node(type, x, y);
          remember();
          graph.nodes.push(n);
          selected = n.id;
          changed();
          if (first) centerCanvas();
        },
        issue = (s) => {
          notice = s;
          const el = root.querySelector(".we-issues");
          if (el) el.textContent = s;
          const summary = root.querySelector("[data-studio-summary]");
          if (summary) summary.textContent = s;
          const modalStatus = root.querySelector("[data-signal-status]");
          if (modalStatus) modalStatus.textContent = s;
        };
      function remember() {
        if (!graph) return;
        undoStack.push(clone(graph));
        if (undoStack.length > 32) undoStack.shift();
        redoStack = [];
      }
      function restore(stack, other) {
        if (!stack.length) return;
        other.push(clone(graph));
        graph = stack.pop();
        selected = graph.nodes.some((n) => n.id === selected) ? selected : "";
        changed();
        (root.querySelector(`[data-node="${selected}"]`) || root).focus?.({
          preventScroll: true,
        });
      }
      async function post(url, body, timeout = 4000) {
        if (demo)
          throw Error("Workflow execution requires the installed local app.");
        const requestController = new AbortController(),
          limit = setTimeout(() => requestController.abort(), timeout);
        requestControllers.add(requestController);
        try {
          const r = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Spyder-Control": "1",
            },
            body: JSON.stringify(body),
            signal: requestController.signal,
          });
          const data = await r.json();
          if (!r.ok) throw Error(data.error || `Request failed (${r.status})`);
          if (
            url === "/api/workflows" ||
            /^\/api\/workflows\/[^/]+\/remove$/.test(url)
          )
            loadLibrary();
          return data;
        } finally {
          clearTimeout(limit);
          requestControllers.delete(requestController);
        }
      }
      function activationStatus(message, failed = false) {
        activationMessage = message;
        activationError = failed;
        issue(message);
      }
      function focusActivationError() {
        if (activationError) {
          const banner = root.querySelector("[data-activation-status]");
          banner?.focus?.({ preventScroll: true });
          banner?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
        }
      }
      function syncActivationControls() {
        const button = root.querySelector("[data-activate]"),
          status = root.querySelector("[data-workflow-state]");
        if (button) {
          button.textContent = graph.enabled
            ? "Disable workflow"
            : "Enable workflow";
          button.className = `button ${graph.enabled ? "primary" : "secondary"}`;
          button.disabled = !!(
            (demo && !window.spyderDemoWorkflowRuntime) ||
            !workflowExecution(graph).run_independently ||
            busy ||
            activationBusy ||
            activationReview
          );
        }
        if (status)
          status.textContent = !workflowExecution(graph).run_independently
            ? "Callable only"
            : graph.enabled
              ? "Independent execution enabled"
              : "Independent execution disabled";
      }
      const activationIsCurrent = (review) =>
        graphRevision === review.revision &&
        graph.id === review.workflow.id &&
        JSON.stringify({ ...graph, enabled: true }) === review.signature;
      async function reconcileActivation(id, error) {
        if (!mounted) return;
        if (error.name !== "AbortError") {
          activationStatus(error.message, true);
          return;
        }
        activationStatus(
          "Response timed out. Checking server workflow status…",
        );
        render();
        const active = new AbortController();
        requestControllers.add(active);
        const limit = setTimeout(() => active.abort(), 15000);
        try {
          const response = await fetch(
            `/api/workflows?current=${encodeURIComponent(id)}`,
            {
              cache: "no-store",
              signal: active.signal,
            },
          );
          if (!response.ok) throw Error("Workflow status unavailable");
          const data = await response.json();
          if (!mounted || graph.id !== id) return;
          workflows = data.workflows || [];
          graph.enabled = !!workflows.find((w) => w.id === id)?.enabled;
          dirty = true;
          activationStatus(
            `Response timed out. Server reports workflow ${graph.enabled ? "enabled" : "disabled"}. Draft edits are retained; review before saving.`,
            true,
          );
        } catch {
          if (mounted)
            activationStatus(
              "Response timed out; the request may have completed. Reload the page to verify workflow status.",
              true,
            );
        } finally {
          clearTimeout(limit);
          requestControllers.delete(active);
        }
      }
      async function commitActivation(disableMotion) {
        const review = activationReview;
        if (!review) return;
        if (!activationIsCurrent(review)) {
          activationReview = null;
          activationStatus(
            "Workflow changed during activation review. Review activation again.",
          );
          render();
          return;
        }
        if (activationBusy || busy) return;
        activationBusy = true;
        activationStage = "enabling";
        activationStatus("Enabling workflow…");
        try {
          render();
          await post(
            "/api/workflows",
            {
              workflow: review.workflow,
              ...(disableMotion ? { disable_motion: true } : {}),
            },
            15000,
          );
          if (!mounted) return;
          activationReview = null;
          if (graph.id === review.workflow.id) {
            graph.enabled = true;
            if (graphRevision === review.revision) {
              graph = clone(review.workflow);
              dirty = false;
            }
          }
          activationStatus(
            graphRevision === review.revision
              ? "Workflow enabled."
              : "Workflow enabled. Newer draft edits remain unsaved.",
          );
          await poll(false);
        } catch (error) {
          if (mounted) {
            activationReview = null;
            await reconcileActivation(review.workflow.id, error);
          }
        } finally {
          activationBusy = false;
          activationStage = "";
          if (mounted) {
            render();
            focusActivationError();
          }
        }
      }
      async function activate(candidate = graph) {
        if (demo) {
          if (busy || activationBusy || activationReview) return;
          const workflow = clone(candidate),
            errors = validate(workflow),
            capability = window.spyderDemoWorkflowRuntime?.inspect?.(workflow);
          if (errors.length || !capability?.supported) {
            activationStatus([...errors, ...(capability?.errors || ["Browser workflow runtime is unavailable."])].join(" "), true);
            render();
            focusActivationError();
            return;
          }
          activationBusy = true;
          activationStage = "enabling";
          activationStatus("Enabling browser workflow…");
          try {
            render();
            workflow.enabled = true;
            const saved = await window.spyderDemoWorkflowRuntime.enable(workflow);
            if (!mounted) return;
            graph = clone(saved);
            workflows = [...workflows.filter((item) => item.id !== saved.id), saved];
            workflowCounts = (await window.spyderWorkflowStore.page({ size: 1 })).counts || workflowCounts;
            dirty = false;
            activationStatus("Browser workflow enabled. Motion comes from camera clip frame analysis.");
          } catch (error) {
            if (mounted) activationStatus(error.message, true);
          } finally {
            activationBusy = false;
            activationStage = "";
            if (mounted) { render(); focusActivationError(); }
          }
          return;
        }
        if (busy || activationBusy || activationReview) return;
        const workflow = clone(candidate);
        if (workflow.nodes.some((item) => item.type === "browser_motion")) {
          activationStatus("Browser motion nodes run only in the browser showcase. Replace this node before activating in the installed app.", true);
          render();
          focusActivationError();
          return;
        }
        const errors = validate(workflow);
        if (errors.length) {
          activationStatus(errors.join(" "), true);
          render();
          focusActivationError();
          return;
        }
        workflow.enabled = true;
        const review = {
          workflow,
          revision: graphRevision,
          signature: JSON.stringify(workflow),
        };
        activationBusy = true;
        activationStage = "checking";
        activationStatus("Checking workflow compatibility…");
        settingsNode = "";
        try {
          render();
          const preview = await post(
            "/api/workflows/activation-preview",
            {
              workflow,
            },
            15000,
          );
          if (!mounted) return;
          if (!activationIsCurrent(review)) {
            activationStatus(
              "Workflow changed during activation preview. Review activation again.",
            );
            return;
          }
          const affected = (preview.cameras || []).filter(
            (camera) =>
              camera.replaces_motion_pipeline || camera.disable_motion,
          );
          if (preview.requires_motion_confirmation || affected.length) {
            activationReview = { ...review, preview };
            activationStatus(
              "Confirm camera motion changes before enabling this workflow.",
            );
          } else activationReview = { ...review, preview };
        } catch (error) {
          if (mounted)
            activationStatus(
              error.name === "AbortError"
                ? "Compatibility check timed out. No activation changes were applied; retry the compatibility check."
                : error.message,
              true,
            );
        } finally {
          activationBusy = false;
          activationStage = "";
          if (mounted) {
            if (
              activationReview &&
              !activationReview.preview.requires_motion_confirmation &&
              !(activationReview.preview.cameras || []).some(
                (camera) =>
                  camera.replaces_motion_pipeline || camera.disable_motion,
              )
            ) {
              commitActivation(false);
            } else {
              render();
              focusActivationError();
              if (activationReview)
                root.querySelector("[data-activation-cancel]")?.focus?.();
            }
          }
        }
      }
      async function deactivate() {
        if (busy || activationBusy || activationReview) return;
        if (demo) {
          if (!window.spyderDemoWorkflowRuntime) return;
          activationBusy = true;
          try {
            const disabled = await window.spyderDemoWorkflowRuntime.disable(graph.id);
            if (disabled) graph = clone(disabled);
            workflows = workflows.filter((item) => item.id !== graph.id);
            workflowCounts = (await window.spyderWorkflowStore.page({ size: 1 })).counts || workflowCounts;
            activationStatus("Browser workflow disabled.");
          } catch (error) {
            activationStatus(error.message, true);
          } finally {
            activationBusy = false;
            if (mounted) render();
          }
          return;
        }
        const workflow = clone(graph),
          revision = graphRevision;
        workflow.enabled = false;
        busy = true;
        render();
        try {
          await post("/api/workflows", { workflow }, 15000);
          if (!mounted) return;
          if (graph.id === workflow.id) {
            graph.enabled = false;
            if (graphRevision === revision) {
              graph = workflow;
              dirty = false;
            }
          }
          activationStatus(
            "Workflow disabled. Inference idles when unused; camera and model settings are preserved.",
          );
          await poll(false);
        } catch (error) {
          await reconcileActivation(workflow.id, error);
        } finally {
          busy = false;
          if (mounted) render();
        }
      }
      async function save() {
        if (!demo && graph.nodes.some((item) => item.type === "browser_motion")) {
          issue("Browser motion nodes run only in the browser showcase. Remove this node before saving in the installed app.");
          return;
        }
        if (
          !graph.execution &&
          graph.nodes.some((item) =>
            ["subflow_input", "subflow_output"].includes(item.type),
          )
        ) {
          issue(
            "Subflow input and output nodes are authoring bridges. Publish this graph as a subflow before saving a root workflow.",
          );
          return;
        }
        if (
          !demo &&
          graph.enabled &&
          graph.nodes.some((n) => n.type === "notification")
        )
          window.spyderNotifications?.useNode?.();
        if (graph.enabled) return activate(graph);
        const errors = validate(graph);
        if (errors.length) {
          issue(errors.join(" "));
          return;
        }
        if (demo) {
          if (!window.spyderWorkflowStore) {
            mark();
            issue("Draft saved in this browser. Workflow execution runtime is unavailable.");
            return;
          }
          if (busy) return;
          busy = true;
          const savedGraph = clone(graph),
            savedRevision = graphRevision;
          render(true);
          try {
            const saved = await window.spyderWorkflowStore.save(savedGraph);
            if (!mounted) return;
            workflows = [saved];
            if (graph.id === savedGraph.id && graphRevision === savedRevision)
              dirty = false;
            try {
              localStorage.setItem(
                subflowEditing
                  ? `spyder.workflow-editor.subflow-${subflowEditing.id}`
                  : key,
                JSON.stringify(graph),
              );
            } catch {
              /* IndexedDB save succeeded. */
            }
            const summary = await window.spyderWorkflowStore.page({ size: 1 });
            if (!mounted) return;
            workflowCounts = summary.counts || workflowCounts;
            if (subflowEditing && graph.id === savedGraph.id)
              subflowEditing.baseline = JSON.stringify(graph);
            const choices =
              await window.spyderWorkflowTools?.listSubflows?.(true);
            if (choices) subflowCatalog = choices;
            issue("Workflow saved in this browser.");
          } catch (error) {
            if (mounted) issue(error.message);
          } finally {
            busy = false;
            if (mounted) render(true);
          }
          return;
        }
        if (busy) return;
        busy = true;
        const savedGraph = clone(graph),
          savedRevision = graphRevision;
        render();
        try {
          await post("/api/workflows", { workflow: savedGraph });
          if (!mounted) return;
          if (graph.id === savedGraph.id && graphRevision === savedRevision)
            dirty = false;
          if (subflowEditing && graph.id === savedGraph.id)
            subflowEditing.baseline = JSON.stringify(graph);
          const choices =
            await window.spyderWorkflowTools?.listSubflows?.(true);
          if (choices) subflowCatalog = choices;
          issue("Workflow saved.");
          await poll(false);
        } catch (e) {
          if (mounted) issue(e.message);
        } finally {
          busy = false;
          if (mounted) render();
        }
      }
      function updateSnapshot() {
        const chooser = root.querySelector("[data-workflow]");
        if (chooser) {
          const label = root.querySelector("[data-workflow-label]");
          if (label) label.textContent = graph?.name || "New workflow";
          chooser.setAttribute(
            "aria-label",
            `Manage workflows. Current: ${graph?.name || "New workflow"}`,
          );
          const count = root.querySelector("[data-workflow-count]");
          if (count)
            count.textContent = `${workflowCounts.total} saved · ${workflowCounts.enabled} enabled · Manage workflows`;
        }
        const eventList = root.querySelector(".we-events");
        if (eventList)
          eventList.innerHTML =
            events
              .slice(-5)
              .reverse()
              .map(
                (e) =>
                  `<p>${esc(e.message || "Detection event")}<small>${esc(e.camera_id || "")} · ${esc(e.created_at ? new Date(e.created_at * 1000).toLocaleTimeString() : "")}</small></p>`,
              )
              .join("") || "<p>No recent events.</p>";
      }
      function visibleForStatus() {
        return (
          mounted &&
          !demo &&
          document.visibilityState !== "hidden" &&
          !container.hidden
        );
      }
      function updateDebugStatus() {
        for (const card of root.querySelectorAll(".we-node[data-node]")) {
          const status = statusFor(card.dataset.node);
          let line = card.querySelector(".we-node-status");
          if (!status) {
            line?.remove();
            continue;
          }
          if (!line) {
            line = document.createElement("small");
            line.className = "we-node-status";
            card.append(line);
          }
          const text = formatNodeStatus(status);
          line.textContent = text;
          line.title = text;
          line.dataset.state = status.state;
        }
        const latest = root.querySelector(".we-node-latest-status");
        if (latest)
          latest.textContent = statusFor(settingsNode)
            ? formatNodeStatus(statusFor(settingsNode))
            : "No recent run status available.";
      }
      async function pollDebug() {
        if (subflowEditing || !visibleForStatus() || debugController) return;
        const request = new AbortController();
        debugController = request;
        try {
          const response = await fetch(
            `/api/workflows/debug?workflow_id=${encodeURIComponent(graph.id)}`,
            {
              cache: "no-store",
              signal: request.signal,
            },
          );
          if (!response.ok) throw Error("Workflow debug data unavailable.");
          const data = await response.json();
          if (
            subflowEditing ||
            !visibleForStatus() ||
            debugController !== request
          )
            return;
          const nextStates = data.workflows || {};
          if (JSON.stringify(nextStates) !== JSON.stringify(debugStates)) {
            debugStates = nextStates;
            updateDebugStatus();
          }
        } catch {
          // Debug status is optional and does not affect workflow editing.
        } finally {
          if (debugController === request) {
            debugController = null;
            if (!subflowEditing && visibleForStatus()) {
              clearTimeout(debugTimer);
              debugTimer = setTimeout(pollDebug, 5000);
            }
          }
        }
      }
      const visibilityChanged = () => {
        clearTimeout(debugTimer);
        debugTimer = 0;
        debugController?.abort();
        debugController = null;
        if (visibleForStatus()) pollDebug();
      };
      function statusFor(id) {
        return debugStates[graph.id]?.nodes?.[id];
      }
      async function poll(schedule = true) {
        if (!mounted || demo || subflowEditing) return;
        controller?.abort();
        controller = new AbortController();
        const active = controller,
          limit = setTimeout(() => active.abort(), 4000);
        try {
          const r = await fetch(
              `/api/workflows?current=${encodeURIComponent(graph.id)}${!snapshotLoaded ? "&first=1" : ""}`,
              {
                cache: "no-store",
                signal: active.signal,
              },
            ),
            data = await r.json();
          if (!r.ok) throw Error(data.error || "Workflow data unavailable.");
          if (!mounted || subflowEditing || controller !== active) return;
          workflows = data.workflows || [];
          workflowCounts = data.counts || workflowCounts;
          events = data.events || [];
          if (data.storage_error)
            issue(
              "Workflow storage is unavailable. Existing file was preserved.",
            );
          else if (data.errors?.length)
            issue(
              data.errors[data.errors.length - 1].message ||
                "Workflow action failed.",
            );
          if (!busy && !activationBusy && !activationReview) {
            const saved = workflows.find((w) => w.id === graph?.id);
            if (saved)
              graph.enabled =
                workflowExecution(graph).run_independently && !!saved.enabled;
            syncActivationControls();
          }
          if (
            !dirty &&
            !busy &&
            !activationReview &&
            !activationBusy &&
            !templatePickerOpen
          ) {
            const latest = workflows.find((w) => w.id === graph?.id);
            if (latest) graph = migrateDetectorNodes(latest);
            else if (!snapshotLoaded && workflows[0])
              graph = migrateDetectorNodes(workflows[0]);
            if (!snapshotLoaded) {
              snapshotLoaded = true;
              render();
            } else updateSnapshot();
          }
        } catch (e) {
          if (mounted && e.name !== "AbortError") issue(e.message);
        } finally {
          clearTimeout(limit);
          if (mounted && schedule) timer = setTimeout(() => poll(true), 5000);
        }
      }
      const input = (e) => {
        if (e.target.matches?.("[data-template-search]")) {
          templateQuery = e.target.value.slice(0, 200);
          root.querySelector("[data-template-list]").innerHTML = templateRows();
          return;
        }

        const t = e.target;
        if (t.matches?.("[data-edge-label]")) {
          const [from, to] = t.dataset.edgeLabel.split("|");
          const edge = graph.edges.find(
            (item) => item.from === from && item.to === to,
          );
          if (edge) {
            const label = String(t.value).slice(0, 80);
            if (label) edge.label = label;
            else delete edge.label;
            mark();
            syncEdgeLabels();
          }
          return;
        }
        if (t.matches("[data-palette-search]")) {
          paletteQuery = t.value;
          const palette = root.querySelector(".we-palette");
          if (palette) palette.innerHTML = paletteContents();
          return;
        }
        if (t.matches("[data-library-search]")) {
          libraryQuery = t.value;
          libraryPageNumber = 0;
          removingModel = "";
          refreshLibraryResults();
          return;
        }
        if (t.matches("[data-name]")) {
          graph.name = t.value;
          mark();
          return;
        }
        if (t.matches("[data-rule]")) {
          const n = graph.nodes.find((n) => n.id === selected),
            rule = n?.params.rules?.[Number(t.dataset.rule)];
          if (!rule) return;
          const key = t.dataset.ruleKey;
          rule[key] =
            key === "value" && rule.field === "confidence"
              ? Number(t.value)
              : t.value;
          if (key === "field") {
            rule.operator = rule.field === "confidence" ? "gte" : "eq";
            rule.value = rule.field === "confidence" ? 0.5 : "";
            if (n.bindings) delete n.bindings[`rules.${t.dataset.rule}.value`];
          }
          if (
            key === "operator" &&
            ["is_unknown", "is_known"].includes(rule.operator)
          ) {
            rule.value = "";
            if (n.bindings) delete n.bindings[`rules.${t.dataset.rule}.value`];
          }
          mark();
          if (["field", "operator"].includes(key)) render(true);
          return;
        }
        if (!t.matches("[data-param]")) return;
        const n = graph.nodes.find((n) => n.id === selected);
        if (!n) return;
        const k = t.dataset.param,
          old = n.params[k];
        if (k === "model_id" && libraryBusy && removingModel) {
          t.value = old;
          return;
        }
        if (
          n.type === "detections" &&
          k === "engine" &&
          t.value !== "insightface" &&
          graph.edges.some(
            (edge) =>
              edge.to === n.id && inputType(edge, graph.nodes) === "classifier",
          )
        ) {
          t.value = old;
          issue("Disconnect Classifier IN before changing detection engine.");
          return;
        }
        if (k === "language" && t.value !== old) {
          if (
            n.params.source === "output = detections" ||
            n.params.source === "output = detections;"
          )
            n.params.source =
              t.value === "javascript"
                ? "output = detections;"
                : "output = detections";
          n.params.language = t.value;
          mark();
          render(true);
          return;
        }
        n.params[k] = Array.isArray(old)
          ? t.value.split(",").map(Number).slice(0, 4)
          : typeof old === "number" || (n.type==="browser_motion" && k==="mog2_threshold")
            ? Number(t.value)
            : t.value;
        if (
          n.type === "detections" &&
          k === "engine" &&
          t.value === "insightface" &&
          graph.edges.some(
            (edge) =>
              edge.to === n.id && inputType(edge, graph.nodes) === "model",
          )
        )
          delete n.params.detector;
        mark();
        if (
          [
            "camera_id",
            "model_id",
            "identity_source",
            "engine",
            "detector",
            "attachment",
          ].includes(k)
        ) {
          render();
          root
            .querySelector(`[data-param="${k}"]`)
            ?.focus?.({ preventScroll: true });
        }
      };
      const change = (e) => {
        const t = e.target;
        if (
          t.matches(
            "[data-history-enabled],[data-history-state],[data-history-preset],[data-history-interval],[data-history-errors]",
          )
        ) {
          const policy = clone(workflowHistory(graph));
          if (t.matches("[data-history-enabled]")) policy.enabled = t.checked;
          else if (t.matches("[data-history-errors]"))
            policy.always_save_errors = t.checked;
          else if (t.matches("[data-history-preset]")) {
            if (t.value === "all")
              policy.states = ["completed", "filtered", "error"];
            else if (t.value === "errors") policy.states = ["error"];
          } else if (t.matches("[data-history-state]")) {
            policy.states = t.checked
              ? [...new Set([...policy.states, t.dataset.historyState])]
              : policy.states.filter(
                  (state) => state !== t.dataset.historyState,
                );
          } else policy.min_interval_seconds = Number(t.value);
          if (
            !validHistory(policy) ||
            (t.matches("[data-history-interval]") && !t.value.trim())
          ) {
            issue(
              "Choose at least one outcome and a whole interval from 0 to 86400 seconds.",
            );
            if (t.type === "checkbox") t.checked = !t.checked;
            else if (t.matches("[data-history-interval]"))
              t.value = workflowHistory(graph).min_interval_seconds;
            return;
          }
          remember();
          graph.history = policy;
          mark();
          const currentPreset =
            policy.states.length === 3
              ? "all"
              : policy.states.length === 1 && policy.states[0] === "error"
                ? "errors"
                : "custom";
          root.querySelector("[data-history-preset]").value = currentPreset;
          root
            .querySelectorAll("[data-history-state]")
            .forEach(
              (control) =>
                (control.checked = policy.states.includes(
                  control.dataset.historyState,
                )),
            );
          root.querySelector(".we-history-settings summary").textContent =
            `History saving · ${!policy.enabled ? "Disabled" : currentPreset === "errors" ? "Failures only" : currentPreset === "all" ? "All outcomes" : "Custom outcomes"}${policy.enabled && policy.min_interval_seconds ? ` · interval ${policy.min_interval_seconds}s${policy.always_save_errors && policy.states.includes("error") ? " + errors always" : ""}` : ""}`;
          return;
        }
        if (t.matches("[data-workflow-mode]")) {
          remember();
          graph.execution = {
            ...workflowExecution(graph),
            run_independently: t.value !== "callable",
            allow_calls: t.value !== "independent",
          };
          if (!graph.execution.run_independently) graph.enabled = false;
          changed();
          return;
        }
        if (t.matches("[data-subflow-id]")) {
          const n = graph.nodes.find((item) => item.id === selected),
            version = Number(t.selectedOptions?.[0]?.dataset.version || 1),
            definition = subflowCatalog.find(
              (item) => item.id === t.value && Number(item.version) === version,
            );
          if (!n || n.type !== "subflow") return;
          n.params.subflow_id = t.value;
          n.params.version = version;
          n.params.arguments = {};
          changed();
          return;
        }
        if (t.matches("[data-subflow-arg]")) {
          const n = graph.nodes.find((item) => item.id === selected);
          if (!n?.params.arguments) return;
          const type = t.dataset.subflowType,
            value =
              type === "boolean"
                ? t.checked
                : ["number", "integer"].includes(type)
                  ? Number(t.value)
                  : t.value;
          if (
            ["number", "integer"].includes(type) &&
            (!t.value.trim() ||
              !Number.isFinite(value) ||
              (type === "integer" && !Number.isInteger(value)))
          ) {
            t.setCustomValidity?.("Enter a valid numeric value.");
            return;
          }
          t.setCustomValidity?.("");
          n.params.arguments[t.dataset.subflowArg] = value;
          const json = root.querySelector("[data-subflow-arguments]");
          if (json) json.value = JSON.stringify(n.params.arguments, null, 2);
          const row = t.closest(".we-subflow-argument");
          if (row) {
            row.querySelector("[data-subflow-inheritance]").textContent =
              "Override for this call";
            row.querySelector("[data-reset-subflow-arg]").disabled = false;
          }
          mark();
          return;
        }
        if (t.matches("[data-subflow-version]")) {
          const n = graph.nodes.find((item) => item.id === selected);
          if (!n) return;
          const version = Number(t.value),
            previous = n.params.version,
            currentGraph = graph;
          const apply = (definition) => {
            if (
              !mounted ||
              graph !== currentGraph ||
              n.params.version !== previous ||
              !definition
            )
              return;
            const compatible = (parameter) => {
              const value = n.params.arguments?.[parameter.name];
              return parameter.type === "boolean"
                ? typeof value === "boolean"
                : parameter.type === "integer"
                  ? Number.isInteger(value)
                  : parameter.type === "number"
                    ? typeof value === "number" && Number.isFinite(value)
                    : typeof value === "string";
            };
            const accepted = new Set(
              definition.parameters
                .filter(compatible)
                .map((parameter) => parameter.name),
            );
            const dropped = Object.keys(n.params.arguments || {}).filter(
              (name) => !accepted.has(name),
            );
            if (
              dropped.length &&
              !window.confirm(
                `Version ${version} cannot use these overrides: ${dropped.join(", ")}. Switch version and use its defaults for those settings?`,
              )
            ) {
              render(true);
              return;
            }
            remember();
            n.params.version = version;
            n.params.arguments = Object.fromEntries(
              Object.entries(n.params.arguments || {}).filter(([name]) =>
                accepted.has(name),
              ),
            );
            subflowCatalog = [
              ...subflowCatalog.filter(
                (item) =>
                  !(item.id === definition.id && item.version === version),
              ),
              definition,
            ];
            changed();
          };
          t.disabled = true;
          window.spyderWorkflowTools
            ?.getSubflow?.(n.params.subflow_id, version)
            .then(apply)
            .catch((error) => {
              issue(error.message);
              render(true);
            });
          return;
        }
        if (t.matches("[data-subflow-arguments]")) {
          const n = graph.nodes.find((item) => item.id === selected);
          if (!n) return;
          try {
            const value = JSON.parse(t.value);
            if (!value || Array.isArray(value) || typeof value !== "object")
              throw Error();
            n.params.arguments = value;
            t.setCustomValidity?.("");
            changed();
          } catch {
            t.setCustomValidity?.("Enter a JSON object.");
          }
          return;
        }
        if (
          t.matches(
            "[data-library-filter-engine],[data-library-filter-labels],[data-library-sort]",
          )
        ) {
          if (t.matches("[data-library-filter-engine]"))
            libraryEngine = t.value;
          else if (t.matches("[data-library-filter-labels]"))
            libraryLabels = t.value;
          else librarySort = t.value;
          libraryPageNumber = 0;
          removingModel = "";
          refreshLibraryResults();
          return;
        }
        if (t.matches("[data-edge-label]")) {
          render(true);
          return;
        }
        if (t.matches("[data-import-file]")) {
          const file = t.files?.[0],
            generation = ++importGeneration;
          if (!file) return;
          if (file.size > 1024 * 1024) {
            issue("Workflow import exceeds 1 MiB.");
            return;
          }
          file
            .text()
            .then(async (text) => {
              if (!mounted || generation !== importGeneration) return;
              const parsed = JSON.parse(text);
              let imported;
              if (parsed.format === "spyder-workflow-bundle") {
                for (const definition of parsed.subflows || [])
                  decodeWorkflow(
                    JSON.stringify({
                      format: "spyder-workflow",
                      version: 1,
                      workflow: definition.graph,
                    }),
                    [],
                    library,
                  );
                decodeWorkflow(
                  JSON.stringify({
                    format: "spyder-workflow",
                    version: 1,
                    workflow: parsed.workflow,
                  }),
                  cameraList(),
                  library,
                );
                const bundledGraph =
                  await window.spyderWorkflowTools?.importBundle?.(text);
                if (!bundledGraph)
                  throw Error("Workflow bundle import is unavailable.");
                imported = decodeWorkflow(
                  JSON.stringify({
                    format: "spyder-workflow",
                    version: 1,
                    workflow: bundledGraph,
                  }),
                  cameraList(),
                  library,
                );
                subflowCatalog =
                  (await window.spyderWorkflowTools?.listSubflows?.()) ||
                  subflowCatalog;
              } else imported = decodeWorkflow(text, cameraList(), library);
              remember();
              graph = imported;
              selected = "";
              settingsNode = "";
              notice =
                "Imported as a disabled draft. Reassign missing cameras/models, review code and actions, then save.";
              changed();
            })
            .catch((error) => {
              if (mounted && generation === importGeneration)
                issue(error.message);
            });
          return;
        }
        if (t.matches("[data-rule]")) {
          input(e);
          return;
        }
        if (t.matches("[data-camera]"))
          graph.camera_ids = t.checked
            ? [...new Set([...graph.camera_ids, t.dataset.camera])]
            : graph.camera_ids.filter((x) => x !== t.dataset.camera);
        else if (t.matches("[data-workflow]")) {
          const w = workflows.find((x) => x.id === t.value);
          if (t.value === "__new") {
            graph = fresh();
            dirty = false;
            undoStack = [];
            redoStack = [];
          } else if (w) {
            graph = migrateDetectorNodes(w);
            dirty = false;
            undoStack = [];
            redoStack = [];
            selected = "";
          }
        } else if (t.matches("[data-param]")) {
          input(e);
          return;
        } else return;
        changed();
      };
      const click = async (e) => {
        const openMenu = root.querySelector(".we-studio-menu[open]");
        if (openMenu && !openMenu.contains?.(e.target)) openMenu.open = false;
        if (e.target.matches?.("[data-studio-panel][open]")) {
          const bounds = e.target.getBoundingClientRect();
          if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) closeStudio(true);
          return;
        }
        const help = e.target.closest?.("[data-field-help]");
        if (help) {
          e.preventDefault();
          if (activeHelp === help.dataset.fieldHelp && helpPinned)
            closeFieldHelp();
          else showFieldHelp(help, true);
          return;
        }
        if (activeHelp && !e.target.closest?.(".we-field-tooltip"))
          closeFieldHelp();
        const signal = e.target.closest("[data-signal-node]");
        if (signal) {
          chosenSignal = signalFrom(signal);
          render(true);
          issue(
            "Signal selected. Choose Use selected signal beside a compatible field, or drag it onto the field.",
          );
          return;
        }
        const wire = e.target.closest("[data-wire]");
        if (wire) {
          selectedEdge = wire.dataset.wire;
          root
            .querySelectorAll(".we-edge")
            .forEach((g) =>
              g.classList.toggle(
                "selected",
                g.querySelector("[data-wire]")?.dataset.wire === selectedEdge,
              ),
            );
          return;
        }
        const b = e.target.closest("button");
        if (!b) return;
        const menu = b.closest?.(".we-studio-menu");
        if (menu) {
          menu.open = false;
          focusWorkflowMenu();
        }
        if (b.dataset.studioOpen) {
          if (!["nodes", "settings", "inspector", "models", "activity"].includes(b.dataset.studioOpen)) return;
          closeStudio(false, false);
          studioPanel = b.dataset.studioOpen;
          studioReturn = studioPanel;
          render(true);
          return;
        }
        if (b.dataset.studioClose !== undefined) {
          closeStudio(true);
          return;
        }
        if (b.dataset.editSelected !== undefined) {
          if (!selected) return;
          closeStudio(false, false);
          modalFocusReturn = root.querySelector(`[data-node="${selected}"]`);
          settingsNode = selected;
          if (!demo && graph.nodes.find((item) => item.id === selected)?.type === "notification") window.spyderNotifications?.useNode?.();
          testPane = false;
          render(true);
          root.querySelector("[data-close-settings]")?.focus?.();
          return;
        }
        if (studioPanel && ["openTemplates", "openWorkflowManager", "openSubflows", "openHistory", "publishSubflow", "openSubflowDefinition", "focusNode", "libraryUse", "activate", "remove"].some((key) => b.dataset[key] !== undefined)) closeStudio(false);
        if (b.dataset.refreshDetectors !== undefined) {
          await loadDetectorCatalog();
          return;
        }
        if (b.dataset.installDetector) {
          if (demo || detectorBusy) return;
          const id = b.dataset.installDetector;
          detectorBusy = id;
          detectorMessage = `Installing ${id} locally…`;
          render(true);
          try {
            const result = await post(
              `/api/vision/detectors/${encodeURIComponent(id)}/install`,
              {},
              120000,
            );
            detectorMessage =
              result.available || result.detector?.available
                ? `${id} is ready locally.`
                : result.status === "installing"
                  ? `${id} download started. Refresh local catalog to check status.`
                  : `${id} install request completed. Refresh local catalog to check status.`;
          } catch (error) {
            detectorMessage =
              error.name === "AbortError"
                ? `Install request timed out. ${id} download may continue; refresh local catalog to check availability.`
                : error.message;
          } finally {
            detectorBusy = "";
            render(true);
            await loadDetectorCatalog();
          }
          return;
        }
        if (b.dataset.useSignal !== undefined) {
          applySignal(b.dataset.useSignal, chosenSignal);
          return;
        }
        if (b.dataset.unbind !== undefined) {
          const n = graph.nodes.find(
            (n) => n.id === (settingsNode || selected),
          );
          if (n?.bindings?.[b.dataset.unbind]) {
            remember();
            delete n.bindings[b.dataset.unbind];
            chosenSignal = null;
            notice = "Data link removed. Literal setting restored.";
            changed();
          }
          return;
        }
        if (b.dataset.cancelReconnect !== undefined) {
          reconnectChoice = null;
          render(true);
          return;
        }
        if (b.dataset.activationCancel !== undefined) {
          if (activationBusy) return;
          activationReview = null;
          activationStatus(
            "Activation canceled. No workflow or camera changes were saved.",
          );
          render();
          root.querySelector("[data-activate]")?.focus?.();
          return;
        }
        if (b.dataset.activationConfirm !== undefined) {
          await commitActivation(true);
          return;
        }
        if (b.dataset.activate !== undefined) {
          if (graph.enabled) await deactivate();
          else {
            if (!demo && graph.nodes.some((n) => n.type === "notification"))
              window.spyderNotifications?.useNode?.();
            await activate();
          }
          return;
        }
        if (b.dataset.closeSettings !== undefined) {
          closeSettings();
          return;
        }
        if (b.dataset.prepareCallable !== undefined) {
          if (
            graph.nodes.some((item) =>
              ["subflow_input", "subflow_output"].includes(item.type),
            )
          ) {
            issue(
              "An interface already exists. Connect Workflow input to Workflow output through the callable branch.",
            );
            render(true);
            return;
          }
          if (graph.nodes.length > 62) {
            issue("Make room for two interface nodes first.");
            return;
          }
          remember();
          const entry = graph.nodes.find(
              (item) =>
                item.id === root.querySelector("[data-call-entry]")?.value,
            ),
            output = graph.nodes.find(
              (item) =>
                item.id === root.querySelector("[data-call-return]")?.value,
            );
          const input = node(
              "subflow_input",
              entry ? clamp(entry.x - 240) : 80,
              entry ? entry.y + 140 : 140,
            ),
            end = node(
              "subflow_output",
              output ? clamp(output.x + 240) : 400,
              output ? output.y + 140 : 140,
            );
          graph.nodes.push(input, end);
          if (entry && output)
            graph.edges.push(
              { from: input.id, to: entry.id },
              { from: output.id, to: end.id },
            );
          else graph.edges.push({ from: input.id, to: end.id });
          issue(
            "Callable interface added. Camera triggers remain independent; only the input-to-output branch is published.",
          );
          changed();
          return;
        }
        if (b.dataset.resetSubflowArg !== undefined) {
          const n = graph.nodes.find((item) => item.id === selected);
          if (n?.type === "subflow") {
            remember();
            delete n.params.arguments[b.dataset.resetSubflowArg];
            changed();
          }
          return;
        }
        if (b.dataset.openSubflows !== undefined) {
          window.spyderWorkflowTools?.setSubflowId?.(subflowEditing?.id);
          if (!demo)
            window.spyderWorkflowTools
              ?.listSubflows?.()
              .then((items) => {
                subflowCatalog = items || [];
                render(true);
              })
              .catch(() => {});
          openWorkflowManager(undefined, "callable");
        } else if (b.dataset.loadPinnedSubflow !== undefined) {
          const n = graph.nodes.find((item) => item.id === selected);
          if (n?.type === "subflow")
            window.spyderWorkflowTools
              ?.getSubflow?.(n.params.subflow_id, n.params.version)
              .then((definition) => {
                if (!mounted || !definition) return;
                subflowCatalog.push(definition);
                render(true);
              })
              .catch((error) => issue(error.message));
        } else if (b.dataset.openSubflowDefinition !== undefined) {
          const n = graph.nodes.find((item) => item.id === selected);
          if (n?.type === "subflow")
            window.spyderWorkflowTools?.openDefinition?.(
              n.params.subflow_id,
              n.params.version,
            );
        } else if (b.dataset.openHistory !== undefined) {
          window.spyderWorkflowTools?.openHistory?.({ workflow_id: graph.id });
        } else if (b.dataset.publishSubflow !== undefined) {
          window.spyderWorkflowTools?.setSubflowId?.(graph.id);
          window.spyderWorkflowTools?.openPublish?.(clone(graph));
        } else if (b.dataset.subflowBack !== undefined) {
          if (subflowParents.length) {
            if (
              subflowEditing?.baseline !== JSON.stringify(graph) &&
              !window.confirm(
                "Leave this workflow's unsaved changes? Save or publish first to keep them. Parent workflow edits will be restored.",
              )
            )
              return;
            const parent = subflowParents.pop();
            graph = parent.graph;
            subflowEditing = parent.editing;
            selected = "";
            settingsNode = "";
            undoStack = parent.undo;
            redoStack = parent.redo;
            dirty = parent.dirty;
            window.spyderWorkflowTools?.restoreSubflowContext?.(
              subflowEditing?.definition || null,
            );
            render();
            if (!subflowEditing) {
              poll();
              visibilityChanged();
            }
          }
        } else if (b.dataset.import !== undefined)
          root.querySelector("[data-import-file]").click();
        else if (b.dataset.openWorkflowManager !== undefined)
          openWorkflowManager();
        else if (b.dataset.export !== undefined) {
          exportWorkflow(graph);
        } else if (b.dataset.libraryUse) {
          if (libraryBusy || graph.nodes.length >= 64) return;
          const model = library.find(
            (item) => item.id === b.dataset.libraryUse,
          );
          if (!model) return;
          add(
            model.metadata?.model_type === "face_classifier"
              ? "classifier"
              : "model",
          );
          const created = graph.nodes.find((n) => n.id === selected);
          if (created && ["model", "classifier"].includes(created.type)) {
            created.params.model_id = model.id;
            changed();
            centerCanvas(created);
            root.querySelector(`[data-node="${created.id}"]`)?.focus?.({ preventScroll: true });
          }
        } else if (b.dataset.requestRemoveModel) {
          if (demo || libraryBusy) return;
          const model = library.find(
            (item) => item.id === b.dataset.requestRemoveModel,
          );
          if (!model) return;
          if (modelReferences(model).length || model.usage?.in_use) {
            libraryMessage =
              "Model is in use. Remove assignments and save first.";
            refreshLibraryResults();
            return;
          }
          removingModel = model.id;
          refreshLibraryResults();
          root.querySelector("[data-cancel-remove-model]")?.focus?.();
        } else if (b.dataset.confirmRemoveModel) {
          await removeLibraryModel(b.dataset.confirmRemoveModel);
        } else if (b.dataset.cancelRemoveModel !== undefined) {
          removingModel = "";
          refreshLibraryResults();
        } else if (
          b.dataset.libraryPrev !== undefined ||
          b.dataset.libraryNext !== undefined
        ) {
          libraryPageNumber += b.dataset.libraryPrev !== undefined ? -1 : 1;
          removingModel = "";
          refreshLibraryResults();
        } else if (b.dataset.libraryClear !== undefined) {
          libraryQuery = "";
          libraryEngine = "all";
          libraryLabels = "all";
          librarySort = "name";
          libraryPageNumber = 0;
          removingModel = "";
          const values = {
            "[data-library-search]": "",
            "[data-library-filter-engine]": "all",
            "[data-library-filter-labels]": "all",
            "[data-library-sort]": "name",
          };
          for (const [selector, value] of Object.entries(values)) {
            const field = root.querySelector(selector);
            if (field) field.value = value;
          }
          refreshLibraryResults();
        } else if (b.dataset.refreshModels !== undefined) {
          await loadLibrary();
          if (mounted) render(true);
        } else if (b.dataset.uploadModel !== undefined) importModel(true);
        else if (b.dataset.registerModel !== undefined) importModel(false);
        else if (b.dataset.inspectModel || b.dataset.useLabelSource) {
          if (demo || libraryBusy) return;
          const modelId = b.dataset.inspectModel || b.dataset.useLabelSource;
          const body = b.dataset.useLabelSource
            ? {
                label_source:
                  root.querySelector(`[data-label-source="${modelId}"]`)
                    .value || null,
              }
            : {};
          libraryBusy = true;
          libraryMessage = "Reading local ONNX metadata…";
          render(true);
          try {
            const descriptor = await post(
              `/api/models/${encodeURIComponent(modelId)}/inspect`,
              body,
              15000,
            );
            libraryMessage =
              descriptor.metadata?.inspection_error ||
              (["ambiguous", "unrecognized"].includes(
                descriptor.metadata?.resolution,
              )
                ? "Label candidates need review. Choose a Label metadata source."
                : `Read ${descriptor.classes?.length || 0} ${descriptor.metadata?.label_semantics === "identity" ? "identities" : "classes"} from model metadata.`);
            await loadLibrary();
          } catch (error) {
            libraryMessage =
              error.name === "AbortError"
                ? "Inspection timed out. Refresh models to check whether it completed."
                : error.message;
          } finally {
            libraryBusy = false;
            if (mounted) render(true);
          }
        } else if (b.dataset.saveClasses) {
          if (demo || libraryBusy) return;
          const id = b.dataset.saveClasses,
            classes = root
              .querySelector(`[data-library-classes="${id}"]`)
              .value.split(",")
              .map((x) => x.trim())
              .filter(Boolean);
          try {
            await post(`/api/models/${encodeURIComponent(id)}/metadata`, {
              classes,
            });
            await loadLibrary();
            render(true);
          } catch (error) {
            issue(error.message);
          }
        } else if (
          b.dataset.addRule !== undefined ||
          b.dataset.removeRule !== undefined
        ) {
          const n = graph.nodes.find((n) => n.id === selected);
          if (n?.type !== "filter") return;
          remember();
          n.params.rules ||= [];
          n.params.match ||= "all";
          if (b.dataset.addRule !== undefined && n.params.rules.length < 32)
            n.params.rules.push({
              field: "label",
              operator: "eq",
              value: upstreamClasses(n.id)[0] || "",
            });
          else if (b.dataset.removeRule !== undefined) {
            const index = Number(b.dataset.removeRule);
            n.params.rules.splice(index, 1);
            if (n.bindings) {
              const updated = {};
              for (const [field, binding] of Object.entries(n.bindings)) {
                const match = /^rules\.(\d+)\.value$/.exec(field);
                if (match && +match[1] === index) continue;
                updated[
                  match && +match[1] > index
                    ? `rules.${+match[1] - 1}.value`
                    : field
                ] = binding;
              }
              n.bindings = updated;
            }
          }
          changed();
        } else if (b.dataset.connectIn !== undefined)
          connectNodes(root.querySelector("[data-node-input]").value, selected);
        else if (b.dataset.connectOut !== undefined)
          connectNodes(
            selected,
            root.querySelector("[data-node-output]").value,
          );
        else if (b.dataset.zoomIn !== undefined) setViewScale(viewScale + 0.1);
        else if (b.dataset.zoomOut !== undefined) setViewScale(viewScale - 0.1);
        else if (b.dataset.zoomReset !== undefined) setViewScale(1);
        else if (b.dataset.center !== undefined) centerCanvas();
        else if (b.dataset.copyNode !== undefined) {
          copiedNode = graph.nodes.find((item) => item.id === selected)
            ? clone(graph.nodes.find((item) => item.id === selected))
            : null;
          render(true);
        } else if (b.dataset.pasteNode !== undefined) {
          if (!copiedNode || graph.nodes.length >= 64) return;
          remember();
          const fragment = { nodes: [clone(copiedNode)], edges: [] };
          const pasted = duplicateNode(
            fragment,
            copiedNode.id,
            36 * (pasteCount + 1),
          );
          pasteCount++;
          if (!pasted) return;
          graph.nodes.push(pasted);
          pruneBindings(graph);
          selected = pasted.id;
          mark();
          render();
          root
            .querySelector(`[data-node="${pasted.id}"]`)
            ?.focus?.({ preventScroll: true });
        } else if (b.dataset.focusNode !== undefined) {
          selected = b.dataset.focusNode;
          render(true);
          root.querySelector(`[data-node="${selected}"]`)?.focus?.();
        } else if (b.dataset.undo !== undefined) restore(undoStack, redoStack);
        else if (b.dataset.redo !== undefined) restore(redoStack, undoStack);
        else if (b.dataset.add) {
          closeStudio(false, false);
          add(b.dataset.add);
          centerCanvas(graph.nodes.find((item) => item.id === selected));
          root.querySelector(`[data-node="${selected}"]`)?.focus?.({ preventScroll: true });
        }
        else if (b.dataset.codeTest !== undefined) {
          if (demo) return;
          testPane = true;
          render(true);
          root.querySelector("[data-test-input]")?.focus?.();
        } else if (b.dataset.runTest !== undefined) {
          if (demo || testRunning) return;
          testRunning = true;
          b.disabled = true;
          b.textContent = "Running…";
          const runGeneration = ++modalGeneration;
          try {
            const detections = JSON.parse(
                root.querySelector("[data-test-input]").value,
              ),
              source =
                graph.nodes.find((n) => n.id === selected)?.params.source ||
                "output = detections";
            const data = await post("/api/workflows/code/test", {
              source,
              language:
                graph.nodes.find((n) => n.id === selected)?.params.language ||
                "python",
              detections,
              context: {
                camera_id: "preview",
                engine: "opencv",
                frame_size: [640, 360],
                sequence: 1,
              },
            });
            if (
              !mounted ||
              settingsNode !== selected ||
              !testPane ||
              runGeneration !== modalGeneration
            )
              return;
            codeError = "";
            root.querySelector("[data-test-result]").textContent =
              JSON.stringify(data.detections, null, 2);
          } catch (x) {
            if (
              mounted &&
              settingsNode === selected &&
              testPane &&
              runGeneration === modalGeneration
            ) {
              codeError = x.message;
              root.querySelector("[data-test-result]").textContent = x.message;
            }
          } finally {
            if (runGeneration === modalGeneration) testRunning = false;
          }
        } else if (b.dataset.openTemplates !== undefined) {
          if (busy || activationBusy || activationReview) return;
          templateQuery = "";
          templatePickerOpen = true;
          settingsNode = "";
          render(true);
          root.querySelector("[data-template-search]")?.focus?.();
        } else if (b.dataset.closeTemplates !== undefined) {
          closeTemplates();
        } else if (b.dataset.loadTemplate !== undefined) {
          if (!templatePickerOpen || busy || activationBusy || activationReview)
            return;
          const entry = TEMPLATE_CATALOG.find(
            (item) => item.id === b.dataset.loadTemplate,
          );
          if (!entry) return;
          remember();
          graph = createWorkflowTemplate(entry.id, templateContext());
          if (!demo && graph.nodes.some((item) => item.type === "notification"))
            window.spyderNotifications?.useNode?.();
          selected =
            graph.nodes.find(
              (n) =>
                n.type ===
                (entry.id === "pre-event-person" ? "event" : "filter"),
            )?.id || "";
          settingsNode = "";
          selectedEdge = "";
          reconnectChoice = null;
          templatePickerOpen = false;
          activationMessage = "";
          activationError = false;
          notice = `${entry.name} draft created. ${entry.setup} Review settings, save, then enable. Undo restores your previous draft.`;
          changed();
          focusWorkflowMenu();
        } else if (b.dataset.connect !== undefined) {
          connectNodes(
            root.querySelector("[data-from]").value,
            root.querySelector("[data-to]").value,
          );
        } else if (b.dataset.deleteNode !== undefined) {
          remember();
          graph.nodes = graph.nodes.filter((n) => n.id !== selected);
          graph.edges = graph.edges.filter(
            (x) => x.from !== selected && x.to !== selected,
          );
          selected = "";
          settingsNode = "";
          pruneBindings(graph);
          changed();
        } else if (b.dataset.deleteEdge) {
          removeConnection(b.dataset.deleteEdge);
        } else if (b.dataset.save !== undefined) save();
        else if (b.dataset.remove !== undefined && !busy)
          openWorkflowManager({
            id: graph.id,
            name: graph.name,
            enabled: graph.enabled,
          });
      };
      const select = (e) => {
        if (e.target.closest(".we-preview")) return;
        const card = e.target.closest("[data-node]");
        if (card) {
          selectedEdge = "";
          selected = card.dataset.node;
          render(true);
        }
      };
      const closeSettings = () => {
        modalGeneration++;
        testRunning = false;
        settingsNode = "";
        testPane = false;
        render(true);
        modalFocusReturn?.focus?.();
        modalFocusReturn = null;
      };
      const doubleClick = (e) => {
        if (e.target.closest(".we-preview")) return;
        const card = e.target.closest("[data-node]");
        if (!card) return;
        closeStudio(false, false);
        modalFocusReturn = card;
        selected = card.dataset.node;
        settingsNode = selected;
        if (
          !demo &&
          graph.nodes.find((n) => n.id === selected)?.type === "notification"
        )
          window.spyderNotifications?.useNode?.();
        testPane = false;
        render(true);
        root.querySelector("[data-close-settings]")?.focus?.();
      };
      const focusin = (e) => {
        const help = e.target.closest?.("[data-field-help]");
        if (help) showFieldHelp(help);
        if (
          e.target.matches?.(
            "[data-param],[data-rule],[data-camera],[data-name],[data-edge-label]",
          )
        )
          remember();
        if (e.target.matches?.("[data-delete-edge]"))
          selectedEdge = e.target.dataset.deleteEdge;
      };
      const keydown = (e) => {
        if (e.key === "Escape" && root.querySelector(".we-studio-menu")?.open) {
          e.preventDefault();
          root.querySelector(".we-studio-menu").open = false;
          focusWorkflowMenu();
          return;
        }
        if (e.key === "Escape" && activeHelp) {
          e.preventDefault();
          e.stopPropagation();
          closeFieldHelp();
          return;
        }
        if (e.key === "Escape" && studioPanel && e.target.closest?.("[data-studio-panel]")) {
          // An open select picker gets the first Escape; otherwise dismiss the
          // drawer even when a native search field contains a query.
          if (root.querySelector("[data-studio-panel][open] select:open")) return;
          e.preventDefault();
          closeStudio(true);
          return;
        }
        if (templatePickerOpen) {
          if (e.key === "Escape") {
            e.preventDefault();
            closeTemplates();
          } else if (e.key === "Tab") {
            const dialog = root.querySelector(
              "[data-template-modal] .we-template-modal",
            );
            const items = [
              ...(dialog?.querySelectorAll(
                "button:not([disabled]),input:not([disabled])",
              ) || []),
            ];
            const first = items[0],
              last = items.at(-1);
            if (
              first &&
              ((e.shiftKey && e.target === first) ||
                (!e.shiftKey && e.target === last))
            ) {
              e.preventDefault();
              (e.shiftKey ? last : first).focus();
            }
          }
          return;
        }

        const activationDialog = e.target.closest?.(
          "[data-activation-modal] .we-activation-modal",
        );
        if (activationDialog && e.key === "Escape") {
          e.preventDefault();
          if (activationBusy) return;
          activationReview = null;
          activationStatus(
            "Activation canceled. No workflow or camera changes were saved.",
          );
          render();
          root.querySelector("[data-activate]")?.focus?.();
          return;
        }
        if (activationDialog && e.key === "Tab") {
          const items = [
            ...activationDialog.querySelectorAll("button:not([disabled])"),
          ];
          if (items.length) {
            const first = items[0],
              last = items.at(-1);
            if (e.shiftKey && e.target === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && e.target === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }
        if (
          e.target.matches?.(".we-canvas-wrap") &&
          /^Arrow(Left|Right|Up|Down)$/.test(e.key)
        ) {
          e.preventDefault();
          const wrap = root.querySelector(".we-canvas-wrap");
          wrap.scrollLeft +=
            e.key === "ArrowRight" ? 60 : e.key === "ArrowLeft" ? -60 : 0;
          wrap.scrollTop +=
            e.key === "ArrowDown" ? 60 : e.key === "ArrowUp" ? -60 : 0;
          return;
        }
        if (e.key === "Escape" && settingsNode) {
          closeSettings();
          return;
        }
        const dialog = e.target.closest?.("[data-settings-modal] .we-modal");
        if (dialog && e.key === "Tab") {
          const items = [
            ...dialog.querySelectorAll(
              'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          ];
          if (items.length) {
            const first = items[0],
              last = items[items.length - 1];
            if (e.shiftKey && e.target === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && e.target === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }
        if (
          e.key === "Tab" &&
          !e.shiftKey &&
          e.target.matches("textarea[data-param='source']")
        ) {
          e.preventDefault();
          const t = e.target,
            a = t.selectionStart,
            b = t.selectionEnd;
          t.setRangeText("    ", a, b, "end");
          t.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (e.key === "Enter" && e.target.matches("[data-node]")) {
          e.preventDefault();
          closeStudio(false, false);
          modalFocusReturn = e.target;
          selected = e.target.dataset.node;
          settingsNode = selected;
          if (
            !demo &&
            graph.nodes.find((n) => n.id === selected)?.type === "notification"
          )
            window.spyderNotifications?.useNode?.();
          testPane = false;
          render(true);
          root.querySelector("[data-close-settings]")?.focus?.();
          return;
        }
        if (
          (e.ctrlKey || e.metaKey) &&
          !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName || "")
        ) {
          if (e.key.toLowerCase() === "c" && selected) {
            copiedNode = clone(
              graph.nodes.find((item) => item.id === selected),
            );
            pasteCount = 0;
            return;
          } else if (
            e.key.toLowerCase() === "v" &&
            copiedNode &&
            graph.nodes.length < 64
          ) {
            e.preventDefault();
            const fragment = { nodes: [clone(copiedNode)], edges: [] };
            const copy = duplicateNode(
              fragment,
              copiedNode.id,
              36 * (pasteCount + 1),
            );
            pasteCount++;
            if (!copy) return;
            remember();
            graph.nodes.push(copy);
            pruneBindings(graph);
            selected = copy.id;
            mark();
            render();
            root
              .querySelector(`[data-node="${copy.id}"]`)
              ?.focus?.({ preventScroll: true });
          } else if (e.key.toLowerCase() === "z") {
            e.preventDefault();
            restore(undoStack, redoStack);
          } else if (e.key.toLowerCase() === "y") {
            e.preventDefault();
            restore(redoStack, undoStack);
          }
        }
        if (
          e.key === "Delete" &&
          selectedEdge &&
          !/INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY/.test(e.target.tagName || "") &&
          !e.target.closest?.("[data-studio-panel], [data-settings-modal], [data-template-modal]")
        ) {
          removeConnection(selectedEdge);
          return;
        }
        if (
          e.key === "Delete" &&
          selected &&
          !/INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY/.test(e.target.tagName || "") &&
          !e.target.closest?.("[data-studio-panel], [data-settings-modal], [data-template-modal]")
        ) {
          remember();
          graph.nodes = graph.nodes.filter((n) => n.id !== selected);
          graph.edges = graph.edges.filter(
            (x) => x.from !== selected && x.to !== selected,
          );
          selected = "";
          settingsNode = "";
          pruneBindings(graph);
          changed();
        }
      };
      const start = (e) => {
        if (e.target.closest(".we-preview")) {
          e.preventDefault();
          return;
        }
        const signal = e.target.closest("[data-signal-node]");
        if (signal) {
          drag = { signal: signalFrom(signal) };
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "copy";
            e.dataTransfer.setData(
              "application/x-spyder-signal",
              JSON.stringify(drag.signal),
            );
            e.dataTransfer.setData(
              "text/plain",
              SIGNALS[drag.signal.signal]?.[0] || "Signal",
            );
          }
          return;
        }
        const p = e.target.closest("[data-add]"),
          n = e.target.closest("[data-node]");
        // Keep the native drag source mounted while releasing the canvas from
        // the modal drawer's inert background for the drop operation.
        if (p) closeStudio(false, false);
        drag = p
          ? { type: p.dataset.add }
          : n
            ? { node: n.dataset.node, x: e.clientX, y: e.clientY }
            : null;
        e.dataTransfer?.setData(
          "text/plain",
          p?.dataset.add || n?.dataset.node || "",
        );
      };
      const updateCanvas = () => {
        const canvas = root.querySelector("[data-canvas]");
        if (!canvas) return;
        canvas.style.width = `${Math.max(2400, ...graph.nodes.map((n) => clamp(n.x) + canvasPadding * 2 + nodeSize(n).width + 26))}px`;
        canvas.style.height = `${Math.max(2200, ...graph.nodes.map((n) => clamp(n.y) + canvasPadding * 2 + nodeSize(n).height + 24))}px`;
        for (const n of graph.nodes) {
          const card = canvas.querySelector(`[data-node="${n.id}"]`);
          if (card) {
            card.style.left = `${canvasPadding + clamp(n.x)}px`;
            card.style.top = `${canvasPadding + clamp(n.y)}px`;
          }
        }
        for (const edge of graph.edges) {
          const a = graph.nodes.find((n) => n.id === edge.from),
            b = graph.nodes.find((n) => n.id === edge.to),
            path = canvas.querySelector(
              `[data-wire="${edge.from}|${edge.to}"]`,
            );
          if (a && b && path) {
            const group = path.closest?.(".we-edge");
            if (group) {
              group
                .querySelectorAll("[data-wire]")
                .forEach((p) => p.setAttribute("d", wirePath(edge)));
              const actions = group.querySelector("[data-wire-actions]");
              actions?.setAttribute(
                "x",
                canvasPadding +
                  (clamp(a.x) + nodeSize(a).width + clamp(b.x)) / 2 -
                  22,
              );
              actions?.setAttribute(
                "y",
                canvasPadding +
                  (clamp(a.y) +
                    38 +
                    clamp(b.y) +
                    portOffset(inputType(edge, graph.nodes), b)) /
                    2 -
                  22,
              );
            } else path.setAttribute("d", wirePath(edge));
          }
        }
        syncEdgeLabels();
        if (wireDrag) {
          const svg = canvas.querySelector(".we-wires"),
            rect = canvas.getBoundingClientRect(),
            x = wireDrag.x,
            y = wireDrag.y,
            ex = canvasPoint(wireDrag.currentX, rect.left, viewScale),
            ey = canvasPoint(wireDrag.currentY, rect.top, viewScale);
          let path = svg.querySelector(".we-wire-live");
          if (!path) {
            svg.insertAdjacentHTML("beforeend", '<path class="we-wire-live"/>');
            path = svg.querySelector(".we-wire-live");
          }
          path?.setAttribute(
            "d",
            `M ${x} ${y} C ${x + 50} ${y}, ${ex - 50} ${ey}, ${ex} ${ey}`,
          );
        }
      };
      const pointerDown = (e) => {
        if (e.target.closest(".we-preview") && e.button !== 1) return;
        if (pointerDrag || wireDrag || panDrag) return;
        const reconnect = e.target.closest("[data-reconnect-edge]");
        if (reconnect && e.button === 0) {
          const edge = graph.edges.find(
            (x) => `${x.from}|${x.to}` === reconnect.dataset.reconnectEdge,
          );
          if (edge) beginReconnect(edge, e);
          return;
        }
        const canvas = e.target.closest("[data-canvas]");
        if (
          canvas &&
          (e.button === 1 ||
            (e.button === 0 &&
              !e.target.closest(
                "[data-node],[data-wire],button,input,textarea,select",
              )))
        ) {
          const wrap = root.querySelector(".we-canvas-wrap");
          panDrag = {
            pointerId: e.pointerId,
            sx: e.clientX,
            sy: e.clientY,
            left: wrap.scrollLeft || 0,
            top: wrap.scrollTop || 0,
          };
          wrap.classList.add("is-panning");
          wrap.focus?.({ preventScroll: true });
          try {
            root.setPointerCapture?.(e.pointerId);
          } catch {}
          e.preventDefault();
          return;
        }
        if (e.button !== 0) return;
        const port = e.target.closest("[data-port]"),
          card = e.target.closest("[data-node]");
        if (port && card) {
          const n = graph.nodes.find((x) => x.id === card.dataset.node);
          if (port.dataset.port === "in") {
            const incoming = graph.edges.filter(
              (x) =>
                x.to === n.id &&
                inputType(x, graph.nodes) ===
                  (port.dataset.input || "detections"),
            );
            const chosen =
              incoming.find((x) => `${x.from}|${x.to}` === selectedEdge) ||
              (incoming.length === 1 ? incoming[0] : null);
            if (chosen) {
              beginReconnect(chosen, e);
              return;
            }
            if (incoming.length > 1) {
              reconnectChoice = {
                node: n.id,
                input: port.dataset.input || "detections",
              };
              render(true);
              e.preventDefault();
              return;
            }
          }
          wireDrag = {
            node: n.id,
            direction: port.dataset.port,
            input: port.dataset.input,
            x:
              canvasPadding +
              clamp(n.x) +
              (port.dataset.port === "out" ? nodeSize(n).width : 0),
            y:
              canvasPadding +
              clamp(n.y) +
              (port.dataset.port === "in"
                ? portOffset(port.dataset.input || "detections", n)
                : 38),
            currentX: e.clientX,
            currentY: e.clientY,
            pointerId: e.pointerId,
          };
          root.querySelector(".we-wire-live")?.remove();
          try {
            root.setPointerCapture?.(e.pointerId);
          } catch {}
          e.preventDefault();
          return;
        }
        if (card && !e.target.closest("button")) {
          selected = card.dataset.node;
          const n = graph.nodes.find((x) => x.id === selected),
            historyLength = undoStack.length,
            undoBefore = undoStack.slice(),
            redoBefore = redoStack.slice();
          remember();
          pointerDrag = {
            id: n.id,
            sx: e.clientX,
            sy: e.clientY,
            x: n.x,
            y: n.y,
            moved: false,
            captured: false,
            pointerId: e.pointerId,
            before: clone(graph),
            historyLength,
            undoBefore,
            redoBefore,
          };
        }
      };
      const pointerMove = (e) => {
        if (panDrag && e.pointerId === panDrag.pointerId) {
          const wrap = root.querySelector(".we-canvas-wrap");
          wrap.scrollLeft = panDrag.left + panDrag.sx - e.clientX;
          wrap.scrollTop = panDrag.top + panDrag.sy - e.clientY;
          e.preventDefault();
          return;
        }
        if (pointerDrag && e.pointerId === pointerDrag.pointerId) {
          pointerDrag.moved ||=
            Math.abs(e.clientX - pointerDrag.sx) +
              Math.abs(e.clientY - pointerDrag.sy) >
            3;
          if (pointerDrag.moved && !pointerDrag.captured) {
            try {
              root.setPointerCapture?.(e.pointerId);
              pointerDrag.captured = true;
            } catch {}
          }
          if (pointerDrag.moved) e.preventDefault();
          const n = graph.nodes.find((x) => x.id === pointerDrag.id);
          if (n) {
            n.x = clamp(
              pointerDrag.x +
                canvasDelta(e.clientX - pointerDrag.sx, viewScale),
            );
            n.y = clamp(
              pointerDrag.y +
                canvasDelta(e.clientY - pointerDrag.sy, viewScale),
            );
          }
          if (pointerDrag.moved) updateCanvas();
        }
        if (wireDrag && e.pointerId === wireDrag.pointerId) {
          wireDrag.currentX = e.clientX;
          wireDrag.currentY = e.clientY;
          updateCanvas();
        }
      };
      const pointerUp = (e) => {
        if (panDrag) {
          if (e.pointerId !== undefined && e.pointerId !== panDrag.pointerId)
            return;
          root.querySelector(".we-canvas-wrap").classList.remove("is-panning");
          panDrag = null;
          try {
            if (root.hasPointerCapture?.(e.pointerId))
              root.releasePointerCapture(e.pointerId);
          } catch {}
          return;
        }
        if (
          e.pointerId !== undefined &&
          pointerDrag &&
          e.pointerId !== pointerDrag.pointerId
        )
          return;
        if (
          e.pointerId !== undefined &&
          wireDrag &&
          e.pointerId !== wireDrag.pointerId
        )
          return;
        const canceled = e.type === "pointercancel";
        if (pointerDrag) {
          if (canceled || !pointerDrag.moved) {
            graph = pointerDrag.before;
            undoStack = pointerDrag.undoBefore;
            redoStack = pointerDrag.redoBefore;
          } else mark();
          const moved = pointerDrag.moved;
          pointerDrag = null;
          if (canceled) render();
          else if (moved) render(true);
        }
        if (wireDrag) {
          const start = wireDrag,
            hit = !canceled
              ? document.elementFromPoint?.(e.clientX, e.clientY) || e.target
              : null,
            port = hit?.closest?.("[data-port]"),
            card = port?.closest?.("[data-node]"),
            endDirection = port?.dataset.port;
          const valid =
            card &&
            endDirection &&
            endDirection !== start.direction &&
            (!root.contains || root.contains(card));
          const from = valid
              ? start.direction === "out"
                ? start.node
                : card.dataset.node
              : "",
            to = valid
              ? start.direction === "out"
                ? card.dataset.node
                : start.node
              : "";
          root.querySelector(".we-wire-live")?.remove();
          wireDrag = null;
          if (start.edge) {
            if (from && to)
              reconnectEdge(start.edge, from, to, port?.dataset.input);
            else render(true);
          } else if (from && to)
            connectNodes(
              from,
              to,
              start.direction === "in" ? start.input : port?.dataset.input,
            );
          else render(true);
        }
        try {
          if (root.hasPointerCapture?.(e.pointerId))
            root.releasePointerCapture(e.pointerId);
        } catch {}
      };
      const over = (e) => {
        if (e.target.closest("[data-bind-field]") && drag?.signal) {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        } else if (e.target.closest("[data-canvas]")) e.preventDefault();
      };
      const drop = (e) => {
        e.preventDefault();
        const field = e.target.closest("[data-bind-field]");
        if (field) {
          let signal = drag?.signal;
          if (!signal) {
            try {
              const raw = e.dataTransfer?.getData(
                "application/x-spyder-signal",
              );
              if (raw && raw.length < 2048) signal = JSON.parse(raw);
            } catch {}
          }
          applySignal(field.dataset.bindField, signal);
          drag = null;
          return;
        }
        if (!e.target.closest("[data-canvas]")) {
          drag = null;
          return;
        }
        const canvas = root.querySelector("[data-canvas]"),
          r = canvas.getBoundingClientRect();
        if (drag?.type)
          add(
            drag.type,
            clamp(canvasPoint(e.clientX, r.left, viewScale) - canvasPadding),
            clamp(canvasPoint(e.clientY, r.top, viewScale) - canvasPadding),
          );
        else if (drag?.node) {
          const n = graph.nodes.find((x) => x.id === drag.node);
          if (n) {
            n.x = clamp(n.x + canvasDelta(e.clientX - drag.x, viewScale));
            n.y = clamp(n.y + canvasDelta(e.clientY - drag.y, viewScale));
            changed();
          }
        }
        drag = null;
      };
      const endDrag = () => {
        drag = null;
        if (pendingSignalRefresh) refreshSignalPanels();
      };
      let cameraSignature = "";
      const refreshCameras = () => {
        const current = JSON.stringify(cameraList().map((c) => [c.id, c.name]));
        if (current === cameraSignature) return;
        cameraSignature = current;
        render();
      };
      const toggleDetails = (e) => {
        if (e.target.matches?.("[data-connections-panel]"))
          connectionsOpen = e.target.open;
        if (e.target.matches?.("[data-palette-group]") && !paletteQuery) {
          if (e.target.open)
            collapsedPaletteGroups.delete(e.target.dataset.paletteGroup);
          else collapsedPaletteGroups.add(e.target.dataset.paletteGroup);
        }
        if (e.target.matches?.("[data-model-details]")) {
          if (e.target.open)
            openModelDetails.add(e.target.dataset.modelDetails);
          else openModelDetails.delete(e.target.dataset.modelDetails);
        }
      };
      document.addEventListener("visibilitychange", visibilityChanged);
      root.addEventListener("toggle", toggleDetails, true);
      root.addEventListener("cancel", studioCancel, true);
      root.addEventListener("input", input);
      root.addEventListener("change", change);
      root.addEventListener("click", click);
      root.addEventListener("click", select, true);
      root.addEventListener("dblclick", doubleClick);
      root.addEventListener("keydown", keydown);
      root.addEventListener("focusin", focusin);
      root.addEventListener("focusout", helpFocusOut);
      root.addEventListener("pointerover", helpOver);
      root.addEventListener("pointerout", helpOut);
      root.addEventListener("scroll", helpScroll, true);
      window.addEventListener("resize", closeFieldHelp);
      root.addEventListener("pointerdown", pointerDown);
      document.addEventListener("pointermove", pointerMove);
      document.addEventListener("pointerup", pointerUp);
      document.addEventListener("pointercancel", pointerUp);
      root.addEventListener("dragstart", start);
      root.addEventListener("dragend", endDrag);
      root.addEventListener("dragover", over);
      root.addEventListener("drop", drop);
      window.addEventListener("spyder:face-galleries-changed", loadLibrary);
      window.addEventListener("spyder:cameras", refreshCameras);
      if (demo)
        try {
          graph =
            JSON.parse(localStorage.getItem(key) || "null") || faceTemplate();
        } catch {
          graph = faceTemplate();
        }
      if (graph) graph = migrateDetectorNodes(graph);
      render();
      window.spyderWorkflowTools
        ?.listSubflows?.()
        .then((items) => {
          if (mounted) {
            subflowCatalog = items || [];
            render(true);
          }
        })
        .catch(() => {});
      cameraSignature = JSON.stringify(cameraList().map((c) => [c.id, c.name]));
      if (!demo) {
        loadLibrary();
        loadDetectorCatalog();
      }
      poll();
      pollDebug();
      if (demo && window.spyderWorkflowStore) {
        // Existing localStorage drafts remain editable; only Save adds them to the library.
        window.spyderWorkflowStore
          .page({ size: 1 })
          .then((data) => {
            if (mounted) {
              workflowCounts = data.counts || workflowCounts;
              updateSnapshot();
            }
          })
          .catch((error) => {
            if (mounted) issue(error.message);
          });
      }
      dispose = () => {
        mounted = false;
        window.spyderWorkflowTools?.closeAll?.();
        managerGeneration++;
        managerHandle?.close();
        managerHandle = null;
        clearTimeout(debugTimer);
        debugController?.abort();
        debugController = null;
        document.removeEventListener("visibilitychange", visibilityChanged);
        previewController?.destroy();
        const activePointer =
          pointerDrag?.pointerId ?? wireDrag?.pointerId ?? panDrag?.pointerId;
        if (pointerDrag) {
          if (pointerDrag.moved) graph = pointerDrag.before;
          undoStack.length = pointerDrag.historyLength;
        }
        pointerDrag = null;
        wireDrag = null;
        panDrag = null;
        try {
          if (
            activePointer !== undefined &&
            root.hasPointerCapture?.(activePointer)
          )
            root.releasePointerCapture(activePointer);
        } catch {}
        clearTimeout(timer);
        controller?.abort();
        libraryController?.abort();
        detectorController?.abort();
        importGeneration++;
        for (const request of requestControllers) request.abort();
        window.removeEventListener(
          "spyder:face-galleries-changed",
          loadLibrary,
        );
        window.removeEventListener("spyder:cameras", refreshCameras);
        root.removeEventListener("toggle", toggleDetails, true);
        root.removeEventListener("cancel", studioCancel, true);
        root.removeEventListener("input", input);
        root.removeEventListener("change", change);
        root.removeEventListener("click", click);
        root.removeEventListener("click", select, true);
        root.removeEventListener("dblclick", doubleClick);
        root.removeEventListener("keydown", keydown);
        root.removeEventListener("focusin", focusin);
        root.removeEventListener("focusout", helpFocusOut);
        root.removeEventListener("pointerover", helpOver);
        root.removeEventListener("pointerout", helpOut);
        root.removeEventListener("scroll", helpScroll, true);
        window.removeEventListener("resize", closeFieldHelp);
        closeFieldHelp();
        root.removeEventListener("pointerdown", pointerDown);
        document.removeEventListener("pointermove", pointerMove);
        document.removeEventListener("pointerup", pointerUp);
        document.removeEventListener("pointercancel", pointerUp);
        root.removeEventListener("dragstart", start);
        root.removeEventListener("dragend", endDrag);
        root.removeEventListener("dragover", over);
        root.removeEventListener("drop", drop);
        root.remove();
      };
    },
    unmount() {
      dispose();
      dispose = () => {};
    },
  };
  window.dispatchEvent(new Event("spyder:workflows-ready"));
})();

// Presentation only: keep the action text and existing event/data hooks intact.
// Locally bundled Lucide symbols also work in the offline/static showcase.
(() => {
  if (typeof MutationObserver === "undefined" || !document.body) return;
  const scope = ".workflow-editor, .workflow-manager, .wt-dialog";
  const icons = {
    save: "save", activate: "power", undo: "undo-2", redo: "redo-2",
    "edit-selected": "square-pen", "copy-node": "copy", "paste-node": "clipboard-paste",
    "zoom-in": "zoom-in", "zoom-out": "zoom-out", "zoom-reset": "rotate-ccw",
    center: "crosshair", "open-templates": "layout-template", "open-subflows": "workflow",
    "open-history": "history", import: "file-input", export: "file-output", remove: "trash-2",
    "delete-node": "trash-2", "delete-edge": "unplug", connect: "link-2",
    "connect-in": "log-in", "connect-out": "log-out", unbind: "link-2-off",
    "add-rule": "circle-plus", "remove-rule": "trash-2", "code-test": "flask-conical",
    "run-test": "play", "refresh-models": "refresh-cw", "refresh-detectors": "refresh-cw",
    "library-clear": "filter-x", "library-prev": "chevron-left", "library-next": "chevron-right",
    "library-use": "package-plus", "request-remove-model": "trash-2",
    "inspect-model": "file-search", "save-classes": "save", "use-label-source": "tags",
    "upload-model": "upload", "register-model": "file-plus-2", "install-detector": "download",
    "notification-test": "bell", "notification-permission": "shield-check",
    "publish-subflow": "upload", "prepare-callable": "workflow", "subflow-back": "chevron-left",
    "open-subflow-definition": "workflow", "load-pinned-subflow": "download",
    "reset-subflow-arg": "rotate-ccw", "hist-reset": "filter-x", "hist-refresh": "refresh-cw",
    "hist-prev": "chevron-left", "hist-next": "chevron-right",
    create: "circle-plus", "create-callable": "workflow", prev: "chevron-left", next: "chevron-right",
    "hist-settings": "settings-2", "hist-export": "download", "hist-export-selected": "download",
    "hist-delete-selected": "trash-2", "hist-open": "file-search", "hist-detail": "file-search",
    "hist-original": "workflow", "hist-replay": "play", "hist-node-inspector": "scan-search",
    "hist-overview": "list-video", "use-signal": "link-2", "call-entry": "log-in", "call-return": "log-out",
  };
  const panels = {nodes: "circle-plus", models: "boxes", inspector: "scan-search", settings: "settings-2", activity: "list-video"};
  const manager = {toggle: "power", open: "square-pen", call: "link-2", publish: "upload", rename: "square-pen", duplicate: "copy", export: "file-output", delete: "trash-2"};
  const records = new WeakMap();
  let active = null, tip = null, hideTimer;

  function enhance(button) {
    if (!button.closest(scope)) return;
    let icon = panels[button.dataset.studioOpen];
    for (const [key, value] of Object.entries(icons)) {
      if (button.hasAttribute(`data-${key}`)) { icon = value; break; }
    }
    if (button.closest(".workflow-manager")) icon ||= manager[button.dataset.action];
    if (button.hasAttribute("data-preview-toggle")) icon = button.getAttribute("aria-pressed") === "true" ? "pause" : "play";
    const text = button.textContent.trim();
    if (!icon || !text) return;
    // Power glyph shows the current state; the action label describes the click.
    if (button.hasAttribute("data-activate") || button.dataset.action === "toggle")
      icon = /^Disable/.test(text) ? "power" : "power-off";
    const old = records.get(button);
    if (old?.text === text && old.icon === icon && button.querySelector(".we-action-label")) return;
    // Menu entries retain visible labels; names, choices and confirmations stay text.
    const labelled = !!button.closest(".we-studio-menu-items, .wm-actions details");
    const label = button.hasAttribute("data-zoom-in") ? "Zoom in" : button.hasAttribute("data-zoom-out") ? "Zoom out" : button.hasAttribute("data-zoom-reset") ? "Reset zoom" : text.replace(/^\+\s*/, "");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("we-action-icon");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `/icons.svg#lucide-${icon}`);
    svg.append(use);
    const caption = document.createElement("span");
    caption.className = `we-action-label${labelled ? "" : " sr-only"}`;
    caption.textContent = text;
    button.replaceChildren(svg, caption);
    button.classList.toggle("we-action-button", !labelled);
    button.classList.toggle("we-action-labelled", labelled);
    if (!button.hasAttribute("aria-label") || old?.autoLabel === button.getAttribute("aria-label")) button.setAttribute("aria-label", label);
    records.set(button, {text, icon, label, autoLabel: old?.autoLabel || (!old && button.getAttribute("aria-label") === label ? label : null)});
    if (old?.autoLabel) records.get(button).autoLabel = label;
    // Custom short tooltip replaces the browser's delayed native title.
    if (button.title) {
      if (!button.hasAttribute("aria-description")) button.setAttribute("aria-description", button.title);
      button.removeAttribute("title");
    }
    if (active === button) hide();
  }

  function hide() {
    clearTimeout(hideTimer);
    if (active && tip) {
      const ids = (active.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== tip.id);
      if (ids.length) active.setAttribute("aria-describedby", ids.join(" "));
      else active.removeAttribute("aria-describedby");
    }
    active = null;
    if (!tip) return;
    if (typeof tip.hidePopover === "function" && tip.matches(":popover-open")) tip.hidePopover();
    tip.hidden = true;
  }
  function show(button) {
    clearTimeout(hideTimer);
    if (!records.has(button) || active === button) return;
    hide();
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "we-action-tooltip";
      tip.className = "we-action-tooltip";
      tip.setAttribute("role", "tooltip");
      tip.setAttribute("popover", "manual");
      document.body.append(tip);
    }
    active = button;
    tip.textContent = records.get(button).label;
    tip.hidden = false;
    if (typeof tip.showPopover === "function") tip.showPopover();
    else (button.closest("dialog[open]") || document.body).append(tip);
    const ids = new Set((button.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    ids.add(tip.id);
    button.setAttribute("aria-describedby", [...ids].join(" "));
    position(button);
  }
  function position(button) {
    const rect = button.getBoundingClientRect(), size = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(innerWidth - size.width - 8, rect.left + (rect.width - size.width) / 2))}px`;
    const top = rect.bottom + size.height + 16 < innerHeight ? rect.bottom + 8 : rect.top - size.height - 8;
    tip.style.top = `${Math.max(8, Math.min(innerHeight - size.height - 8, top))}px`;
  }
  document.addEventListener("pointerover", (event) => {
    if (tip?.contains(event.target)) { clearTimeout(hideTimer); return; }
    if (event.pointerType !== "touch") show(event.target.closest?.("button"));
  });
  document.addEventListener("pointerout", (event) => {
    if (active && !active.contains(event.relatedTarget) && !tip?.contains(event.relatedTarget)) hideTimer = setTimeout(hide, 120);
  });
  document.addEventListener("focusin", (event) => show(event.target.closest?.("button")));
  document.addEventListener("focusout", hide);
  document.addEventListener("click", hide);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); });
  document.addEventListener("scroll", () => {
    // Keyboard focus may scroll its button into view after focusin has fired.
    if (active && document.activeElement === active) {
      const rect = active.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < innerHeight) position(active);
      else hide();
    } else hide();
  }, true);
  window.addEventListener("resize", hide);
  const observer = new MutationObserver((mutations) => {
    const buttons = new Set();
    for (const mutation of mutations) {
      const parent = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      const owner = parent?.closest?.("button");
      if (owner) buttons.add(owner);
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches("button")) buttons.add(node);
        node.querySelectorAll("button").forEach((button) => buttons.add(button));
      }
    }
    buttons.forEach(enhance);
    if (active && (!active.isConnected || !active.getClientRects().length)) hide();
  });
  observer.observe(document.body, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-pressed"]});
  document.querySelectorAll(`${scope.split(", ").map((selector) => `${selector} button`).join(", ")}`).forEach(enhance);
})();
