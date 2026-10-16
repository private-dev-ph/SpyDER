"use strict";
(() => {
  const TYPES = {
    camera: { label: "Camera", params: { camera_id: "" } },
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
    event: { label: "Event", params: { message: "Detection matched" } },
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
  };
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
      if (rule && n.params.rules?.[+rule[1]])
        return n.params.rules[+rule[1]].field === "confidence"
          ? "number"
          : "strings";
    }
    if (
      (n?.type === "event" && field === "message") ||
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
  const clamp = (v) =>
    Math.max(0, Math.min(5000, Number.isFinite(+v) ? +v : 0));
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
      : n?.type === "model"
        ? "model"
        : n?.type === "classifier"
          ? "classifier"
          : "detections";
  const inputType = (e, nodes) =>
    e.input || outputType(nodes.find((n) => n.id === e.from));
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
      ["camera", "model", "classifier"].includes(target.type)
    )
      return false;
    return (
      input === outputType(source) &&
      (target.type === "detections"
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
          !["id", "name", "enabled", "camera_ids", "nodes", "edges"].includes(
            k,
          ),
      )
    )
      throw Error("Unknown workflow field.");
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
    for (const e of graph.edges)
      if (
        !e ||
        !["from,to", "from,input,to"].includes(Object.keys(e).sort().join()) ||
        typeof e.from !== "string" ||
        typeof e.to !== "string"
      )
        throw Error("Invalid workflow connection.");
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
    for (const n of nodes)
      if (!TYPES[n.type]) errors.push(`Unknown node type: ${n.type}`);
    const out = new Map(nodes.map((n) => [n.id, []]));
    for (const e of graph?.edges || [])
      if (!ids.has(e.from) || !ids.has(e.to))
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
          n.params.threshold < 0 ||
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
      id: `workflow-${Math.random().toString(36).slice(2, 8)}`,
      name: "Face event",
      enabled: false,
      camera_ids: [],
      nodes,
      edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })),
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
  if (typeof module !== "undefined" && module.exports)
    module.exports = {
      TYPES,
      nodeSize,
      clamp,
      node,
      validate,
      faceTemplate,
      insightfaceTemplate,
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
        workflows = [],
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
        settingsNode = "",
        codeError = "",
        testPane = false,
        testRunning = false,
        modalFocusReturn = null,
        modalGeneration = 0,
        undoStack = [],
        redoStack = [],
        modelCamera = "",
        modelConfig = null,
        modelDraft = null,
        modelRevision = 0,
        modelState = "",
        runtimeState = "",
        modelDirty = false,
        modelBusy = false,
        modelController,
        snapshotLoaded = false,
        library = [],
        libraryBusy = false,
        libraryMessage = "",
        libraryController,
        detectorCatalog = [],
        detectorMessage = "",
        detectorBusy = "",
        detectorController,
        importGeneration = 0;
      let activationReview = null,
        activationBusy = false,
        activationStage = "",
        activationMessage = "",
        activationError = false;
      const requestControllers = new Set();
      const demo = !!window.spyderShowcase,
        key = "spyder.workflow-editor.draft",
        root = document.createElement("section");
      root.className = "workflow-editor";
      root.tabIndex = -1;
      container.replaceChildren(root);
      const cameraList = () => window.spyder?.cameras?.() || cameras,
        fresh = () => ({
          id: `workflow-${Math.random().toString(36).slice(2, 8)}`,
          name: "New workflow",
          enabled: false,
          camera_ids: [],
          nodes: [],
          edges: [],
        });
      const previewController = window.spyderWorkflowPreview?.create(root, {
        graph: () => graph,
        cameras: cameraList,
        demo,
      });
      const defaultModel = () => ({
        engine: "none",
        model: "",
        device: "cpu",
        inference_fps: 5,
        confidence: 0.5,
        input_size: 640,
        max_detections: 100,
        recognition_enabled: false,
        recognition_model: "",
        identity_gallery: "",
        recognition_threshold: 0.65,
      });
      function draftFrom(data) {
        const s = data?.settings || {},
          d = defaultModel();
        d.engine =
          data?.pipeline === "vision"
            ? s.engine || "opencv"
            : data?.pipeline || "none";
        for (const k of [
          "model",
          "device",
          "inference_fps",
          "confidence",
          "input_size",
          "max_detections",
          "recognition_model",
          "identity_gallery",
          "recognition_threshold",
        ])
          if (s[k] !== undefined && s[k] !== null) d[k] = s[k];
        d.recognition_enabled = !!(s.recognition_model && s.identity_gallery);
        return d;
      }
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
            (item.metadata?.model_type === "face_classifier" ||
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
            return `<div class="we-rule"><label>Field<select data-rule="${i}" data-rule-key="field">${["label", "identity", "confidence"].map((f) => `<option value="${f}" ${r.field === f ? "selected" : ""}>${{ label: "Class", identity: "Identity", confidence: "Confidence" }[f]}</option>`).join("")}</select></label><label>Condition<select data-rule="${i}" data-rule-key="operator">${(r.field === "confidence" ? ["gte", "lte"] : ["eq", "neq"]).map((op) => `<option value="${op}" ${r.operator === op ? "selected" : ""}>${r.field === "identity" ? (op === "eq" ? "If identity" : "If not identity") : { eq: "Is", neq: "Is not", gte: "At least", lte: "At most" }[op]}</option>`).join("")}</select></label><label>Value${useClasses ? `<select data-rule="${i}" data-rule-key="value"><option value="">Choose ${r.field === "identity" ? "an identity" : "a class"}</option>${[...new Set([...choices, ...(r.value ? [r.value] : [])])].map((c) => `<option value="${esc(c)}" ${c === r.value ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>` : `<input data-rule="${i}" data-rule-key="value" value="${esc(r.value)}" ${r.field === "confidence" ? 'type="number" min="0" max="1" step="0.01"' : 'maxlength="128"'}>`}</label><button class="button secondary" data-remove-rule="${i}" aria-label="Remove filter rule ${i + 1}">Remove rule</button></div>`;
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
                `<li>${esc(TYPES[graph.nodes.find((x) => x.id === (e.to === n.id ? e.from : e.to))?.type]?.label)} | ${esc(inputType(e, graph.nodes))}<button class="button secondary" data-delete-edge="${esc(e.from)}|${esc(e.to)}">Disconnect</button></li>`,
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
        const html = parameterFields(n);
        if (!n) return html;
        return html.replace(
          /<label([^>]*)>([\s\S]*?)<\/label>/g,
          (whole, attributes, body) => {
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
            return `<div class="we-field-drop ${binding ? "is-linked" : ""}" data-bind-field="${esc(field)}">${content}${binding ? `<div class="we-binding"><span>LIVE · ${esc(TYPES[source?.type]?.label || binding.node)}.${esc(binding.signal)}</span><button type="button" data-unbind="${esc(field)}" aria-label="Unlink ${esc(field)}">Unlink</button></div>` : "<small>Drop a compatible signal here</small>"}${compatible ? `<button type="button" class="button secondary we-use-signal" data-use-signal="${esc(field)}">Use selected ${chosenSignal.mode === "fixed" ? "class" : "signal"}</button>` : ""}</div>`;
          },
        );
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
      function libraryPanel() {
        return `<section class="we-library"><h3>Local model library</h3><button class="button secondary" data-refresh-models ${demo || libraryBusy ? "disabled" : ""}>Refresh models and classes</button><p>${demo ? "Showcase: model choices and workflows stay in this browser. Native model upload and inference require the installed app." : "Uploaded models persist across restarts and are shared by local instances using the same data folder. Registering an existing file keeps its original path. Connect a Model node to Detections."}</p><div class="we-library-import"><label>Model engine<select data-library-engine><option value="yolo">YOLO</option><option value="insightface">InsightFace</option></select></label><label>Model name<input data-library-name maxlength="128" placeholder="e.g. Entrance faces"></label><label>Model file<input data-library-file type="file" accept=".onnx,.pt" ${demo || libraryBusy ? "disabled" : ""}></label><button class="button primary" data-upload-model ${demo || libraryBusy ? "disabled" : ""}>Upload model</button></div><details><summary>Register existing file on this computer</summary><label>Local model path<input data-library-path placeholder="C:/models/detector.onnx"></label><button class="button secondary" data-register-model ${demo || libraryBusy ? "disabled" : ""}>Register local model</button></details><div class="we-library-list">${library.map((m) => `<article><b>${esc(m.name)}</b><span>${esc(m.engine)} | ${m.classes?.length || 0} ${m.metadata?.label_semantics === "identity" ? "identities" : "classes"} | ${esc(m.metadata?.inspection || m.inspection || m.status || "Registered")}</span>${m.metadata?.model_type ? `<p>Model role: ${esc(m.metadata.model_type)}${m.metadata.input_size ? ` · input ${esc(m.metadata.input_size)}` : ""}</p>` : ""}${m.metadata?.compatibility ? `<p class="we-model-help">${esc(m.metadata.compatibility)}</p>` : ""}${m.metadata?.unknown_rejection ? `<p>Unknown identity handling: ${esc(m.metadata.unknown_rejection)}</p>` : ""}${m.metadata?.inspection_error ? `<p>${esc(m.metadata.inspection_error)}</p>` : ""}${metadataSourcePanel(m)}<button class="button secondary" data-inspect-model="${esc(m.id)}" ${demo || libraryBusy ? "disabled" : ""}>Read file metadata</button><label>${m.metadata?.label_semantics === "identity" ? "Identity" : "Class"} labels (comma separated)<input data-library-classes="${esc(m.id)}" value="${esc((m.classes || []).join(", "))}"></label><button class="button secondary" data-save-classes="${esc(m.id)}" ${demo || libraryBusy ? "disabled" : ""}>Save labels</button></article>`).join("") || "<p>No models registered. Uploaded models remain local.</p>"}</div><p role="status" data-library-status>${esc(libraryMessage)}</p></section>`;
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
          if (panel) panel.outerHTML = libraryPanel();
          refreshSignalPanels();
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
      function modelPanel() {
        const c = cameraList();
        if (!modelCamera || !c.some((x) => x.id === modelCamera))
          modelCamera = c[0]?.id || "";
        const d = modelDraft || defaultModel(),
          engine = d.engine;
        return `<section class="we-models"><h3>Camera model pipeline</h3><p class="we-model-help">Model files stay on this computer. Saving changes applies camera configuration. Set engine to Disabled to turn off model pipeline.</p><div class="we-model-grid"><label>Camera<select data-model-camera>${c.map((x) => `<option value="${esc(x.id)}" ${x.id === modelCamera ? "selected" : ""}>${esc(x.name || x.id)}</option>`).join("")}</select></label><label>Detection engine<select data-model-engine><option value="none" ${engine === "none" ? "selected" : ""}>Disabled</option><option value="opencv" ${engine === "opencv" ? "selected" : ""}>OpenCV</option><option value="yolo" ${engine === "yolo" ? "selected" : ""}>YOLO</option><option value="insightface" ${engine === "insightface" ? "selected" : ""}>InsightFace</option></select></label><label>Model path<input data-model-path value="${esc(d.model)}" placeholder="Local model file path" ${engine === "none" || engine === "opencv" ? "disabled" : ""}></label><label>Device<select data-model-device><option ${d.device === "cpu" ? "selected" : ""}>cpu</option><option ${d.device === "cuda:0" ? "selected" : ""}>cuda:0</option></select></label><label>Inference FPS<input data-model-fps type="number" min="0.1" max="30" step="0.1" value="${esc(d.inference_fps)}"></label><label>Confidence<input data-model-confidence type="number" min="0" max="1" step="0.01" value="${esc(d.confidence)}"></label><label>Input size<input data-model-size type="number" min="128" max="1280" step="32" value="${esc(d.input_size)}"></label><label>Maximum detections<input data-model-max type="number" min="1" max="500" value="${esc(d.max_detections)}"></label><label class="we-model-advanced"><input data-recognition type="checkbox" ${d.recognition_enabled ? "checked" : ""}> InsightFace recognition fields</label><div class="we-model-grid we-model-advanced" data-recognition-fields ${d.recognition_enabled && engine === "insightface" ? "" : "hidden"}><label>Recognition ONNX path<input data-recognition-model value="${esc(d.recognition_model)}"></label><label>Identity gallery JSON path<input data-gallery value="${esc(d.identity_gallery)}"></label><label>Recognition threshold<input data-recognition-threshold type="number" min="0" max="1" step="0.01" value="${esc(d.recognition_threshold)}"></label></div></div><div class="we-model-actions"><button class="button primary" data-apply-model ${demo || modelBusy || !modelCamera ? "disabled" : ""}>${modelBusy ? "Applying…" : "Apply model configuration"}</button><span class="we-model-state" role="status">${esc(modelState)}</span></div><p class="we-runtime">${esc(runtimeState)}</p></section>`;
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
          canvasPadding + x - (wrap.clientWidth || 800) / 2,
        );
        wrap.scrollTop = Math.max(
          0,
          canvasPadding + y - (wrap.clientHeight || 320) / 2,
        );
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
      function wireActions(e) {
        const a = graph.nodes.find((n) => n.id === e.from),
          b = graph.nodes.find((n) => n.id === e.to);
        if (!a || !b) return "";
        const x =
          canvasPadding +
          (clamp(a.x) + nodeSize(a).width + clamp(b.x)) / 2 -
          16;
        const y =
          canvasPadding +
          (clamp(a.y) +
            38 +
            clamp(b.y) +
            portOffset(inputType(e, graph.nodes), b)) /
            2 -
          16;
        return `<foreignObject data-wire-actions="${esc(e.from)}|${esc(e.to)}" class="we-wire-actions" x="${x}" y="${y}" width="32" height="32"><button xmlns="http://www.w3.org/1999/xhtml" class="we-wire-trash" data-delete-edge="${esc(e.from)}|${esc(e.to)}" aria-label="Delete connection from ${esc(TYPES[a.type]?.label)} to ${esc(TYPES[b.type]?.label)}" title="Delete connection"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7"/></svg></button></foreignObject>`;
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
        const moved = edgeFor(from, to, candidate.nodes),
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
      function parameterFields(n) {
        if (!n) return "<p>Select node to edit.</p>";

        const identitySourceField =
          n.type === "filter" && !Object.hasOwn(n.params, "identity_source")
            ? '<label>Identity source<select data-param="identity_source"><option value="identity" selected>Recognized identity</option><option value="class">Model class</option></select></label>'
            : "";
        return (
          identitySourceField +
          (n.type === "notification"
            ? `<section class="we-notification-delivery"><h4>PC / browser notifications</h4><p data-notification-status role="status">${esc(window.spyderNotifications?.desktopStatus?.() || "Desktop permission is requested when this Notification node is used.")}</p><button class="button secondary" data-notification-permission ${demo ? "disabled" : ""}>${window.spyderNotifications?.desktopEnabled?.() ? "Disable desktop alerts" : "Enable desktop alerts"}</button><button class="button secondary" data-notification-test ${demo ? "disabled" : ""}>Send test notification</button><p>Allow browser notifications to receive operating-system alerts while SpyDER is unfocused. Keep a SpyDER page open and disable pause when unfocused in System settings for continuous monitoring. In-app alerts remain available if permission is blocked.</p></section>`
            : "") +
          Object.entries(n.params || {})
            .filter(([k]) => !["rules", "match"].includes(k))
            .map(([k, v]) => {
              if (n.type === "model" && k === "model_id") {
                const choices = [...BUILTIN_MODELS, ...library];
                return `<label>Model<select data-param="model_id"><option value="">Choose model</option><optgroup label="InsightFace built-in detectors">${BUILTIN_MODELS.map((model) => `<option value="${model.id}" ${v === model.id ? "selected" : ""}>${esc(model.name)}</option>`).join("")}</optgroup><optgroup label="Uploaded and registered models">${library.map((model) => `<option value="${esc(model.id)}" ${v === model.id ? "selected" : ""}>${esc(model.name)} | ${esc(model.engine)}</option>`).join("")}</optgroup>${v && !choices.some((model) => model.id === v) ? `<option selected value="${esc(v)}">Unavailable: choose replacement</option>` : ""}</select></label><p>Choose the detector here, then connect Model OUT to Detections MODEL IN. For RetinaFace, select a compatible uploaded or registered ONNX detector.</p>${builtinModel(v) ? detectorPanel(n) : ""}`;
              }
              if (k === "camera_id" || k === "model_id") {
                const items =
                  k === "camera_id"
                    ? cameraList()
                    : n.type === "classifier"
                      ? classifierModels()
                      : library;
                const modelLabel =
                  n.type === "classifier"
                    ? "InsightFace classifier"
                    : "Local model";
                return `<label>${k === "camera_id" ? "Camera source" : modelLabel}<select data-param="${k}"><option value="">Choose ${k === "camera_id" ? "camera" : n.type === "classifier" ? "classifier" : "model"}</option>${items.map((item) => `<option value="${esc(item.id)}" ${v === item.id ? "selected" : ""}>${esc(item.name || item.id)}${item.engine ? ` | ${esc(item.engine)}` : ""}</option>`).join("")}${v && !items.some((item) => item.id === v) ? `<option selected value="${esc(v)}">Unavailable: choose replacement</option>` : ""}</select></label>`;
              }
              if (n.type === "detections" && k === "detector") return "";
              if (n.type === "classifier" && k === "threshold")
                return `<label>Classifier threshold<input data-param="threshold" type="number" min="0" max="1" step="0.01" value="${esc(v)}"></label>`;
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
                return `<label>Detection engine<select data-param="engine">${["any", "opencv", "yolo", "insightface"].map((x) => `<option ${x === v ? "selected" : ""}>${x}</option>`).join("")}</select></label><p>${n.params.engine === "insightface" ? "Choose an InsightFace detector in a connected Model node. Model OUT connects to MODEL IN; Classifier OUT connects to CLASSIFIER IN." : "A connected Model node selects its engine and local weights. Without one, use the camera's active pipeline."}</p>`;
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
      function render(preserveCanvas = false) {
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
                  : ["camera", "model", "classifier"].includes(n.type)
                    ? ""
                    : `<button class="we-port we-port-in" data-port="in" data-input="detections" aria-label="Connect to ${esc(TYPES[n.type]?.label || n.type)} input"></button>`;
            return `<article data-node="${esc(n.id)}" tabindex="0" aria-label="${esc(TYPES[n.type]?.label || n.type)} node. Double-click to edit settings." class="we-node we-node-${esc(n.type)} ${n.id === selected ? "selected" : ""}">${ports}<b>${esc(TYPES[n.type]?.label || n.type)}</b><small>${esc(nodeSummary(n))}</small>${n.type === "preview" ? `<section class="we-preview" data-preview="${esc(n.id)}" aria-label="Live workflow preview"><div class="we-preview-screen"><canvas width="640" height="360" aria-label="Camera feed with workflow overlays"></canvas><span class="we-preview-placeholder">Preview paused</span></div><div class="we-preview-controls"><button type="button" data-preview-toggle aria-pressed="false">Start preview</button><label>Camera<select data-preview-camera aria-label="Preview camera"></select></label></div><p class="we-preview-status" role="status">Connect a Camera or detection branch.</p></section>` : `<button class="we-port we-port-out we-port-${outputType(n)}" data-port="out" aria-label="Connect from ${esc(TYPES[n.type]?.label || n.type)} output"></button>`}</article>`;
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
              `<g class="we-edge ${selectedEdge === `${e.from}|${e.to}` ? "selected" : ""}"><path class="we-wire-${esc(inputType(e, graph.nodes))}" data-wire="${esc(e.from)}|${esc(e.to)}" d="${wirePath(e)}"/><path class="we-wire-hit" data-wire="${esc(e.from)}|${esc(e.to)}" d="${wirePath(e)}"/>${wireActions(e)}</g>`,
          )
          .join("");
        const params = mappedFields(selectedNode);
        const errors = validate(graph);
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
        root.innerHTML = `<header class="we-header"><div><p class="eyebrow">LOCAL RULE BUILDER</p><h2>Workflow editor</h2><p>Connect cameras, models and detection rules. Everything runs on this computer.</p></div><span class="we-badge">${demo ? "Demo editing only" : "Local workflow"}</span></header>${demo ? '<p class="we-demo" role="status">Demo editing only. Draft saves stay in this browser. Execution disabled.</p>' : ""}<div class="we-toolbar"><label>Workflow<select data-workflow>${workflows.map((w) => `<option value="${esc(w.id)}" ${w.id === graph.id ? "selected" : ""}>${esc(w.name)}</option>`).join("")}<option value="__new">New workflow</option></select></label><label>Name<input data-name value="${esc(graph.name)}"></label><div class="we-activation-control"><button class="button ${graph.enabled ? "secondary" : "primary"}" data-activate ${demo || busy || activationBusy || activationReview ? "disabled" : ""}>${activationBusy ? (activationStage === "checking" ? "Checking workflow…" : "Enabling workflow…") : graph.enabled ? "Disable workflow" : "Enable workflow"}</button><strong data-workflow-state>${graph.enabled ? "Workflow enabled" : "Workflow disabled"}</strong><span>Disabling stops workflow actions; camera model settings stay active.</span></div><button class="button secondary" data-insightface-template>InsightFace notification template</button><button class="button secondary" data-template>Use Face event template</button><button class="button secondary" data-undo>Undo</button><button class="button secondary" data-redo>Redo</button><button class="button primary" data-save ${busy || activationBusy || activationReview ? "disabled" : ""}>${busy ? "Saving…" : "Save workflow"}</button><button class="button secondary" data-remove ${demo || busy || activationBusy ? "disabled" : ""}>Delete workflow</button><button class="button secondary" data-export>Export workflow</button><button class="button secondary" data-import>Import workflow</button><input type="file" accept=".json,application/json" data-import-file hidden></div><div class="we-activation-status ${activationError ? "is-error" : ""}" data-activation-status role="${activationError ? "alert" : "status"}" tabindex="-1" ${activationMessage ? "" : "hidden"}>${esc(activationMessage)}</div><div class="we-main"><aside class="we-sidebar"><h3>Node palette</h3><p>Click a node to add it.</p><div class="we-palette">${Object.entries(
          TYPES,
        )
          .map(
            ([t, s]) =>
              `<button data-add="${t}">${s.label}<span>+</span></button>`,
          )
          .join(
            "",
          )}</div><h3>Cameras</h3><div class="we-cameras">${cams || "<p>No cameras configured.</p>"}</div><h3>Events</h3><div class="we-events">${
          events
            .slice(-5)
            .reverse()
            .map(
              (e) =>
                `<p>${esc(e.message || "Detection event")}<small>${esc(e.camera_id || "")} · ${esc(e.created_at ? new Date(e.created_at * 1000).toLocaleTimeString() : "")}</small></p>`,
            )
            .join("") || "<p>No recent events.</p>"
        }</div></aside><section class="we-workspace"><div class="we-canvas-tools"><span>Drag empty space to pan. Middle-drag anywhere on the canvas.</span><button class="button secondary" data-center>Center workflow</button></div>${
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
        }<div class="we-canvas-wrap" tabindex="0" role="region" aria-label="Workflow canvas. Drag background or use arrow keys to pan."><div class="we-canvas" data-canvas><svg class="we-wires" aria-label="Workflow connections">${paths}</svg>${cards || '<p class="we-empty">Add a node to start a workflow.</p>'}</div></div><div class="we-connect"><b>Connect nodes</b><label>From<select data-from>${options}</select></label><label>To<select data-to>${options}</select></label><button class="button secondary" data-connect ${graph.nodes.length < 2 ? "disabled" : ""}>Connect</button></div><div class="we-inspector"><h3>Node parameters</h3>${settingsNode ? "<p>Settings open in dialog.</p>" : params}<button class="button secondary" data-delete-node ${selectedNode ? "" : "disabled"}>Remove node</button><h3>Connections</h3><div>${graph.edges.map((e) => `<p>${esc(graph.nodes.find((n) => n.id === e.from)?.type || e.from)} → ${esc(graph.nodes.find((n) => n.id === e.to)?.type || e.to)} <button data-delete-edge="${esc(e.from)}|${esc(e.to)}" aria-label="Remove connection">×</button></p>`).join("") || "<p>No connections.</p>"}</div><p class="we-issues" role="status">${esc(notice) || errors.map(esc).join(" ")}</p><p class="we-pipeline">Camera to CAM input. Model to MODEL input. Detection data to DATA input. Outputs accept multiple branches. One active model pipeline per camera; conflicting assignments are rejected.</p></div></section></div>${activationModal}`;
        if (retainedCanvas) {
          const replacement = root.querySelector("[data-canvas]");
          replacement?.replaceWith?.(retainedCanvas);
          retainedCanvas
            .querySelectorAll?.("[data-node]")
            .forEach((card) =>
              card.classList.toggle("selected", card.dataset.node === selected),
            );
        }
        const positionedCanvas = root.querySelector("[data-canvas]");
        if (positionedCanvas) {
          positionedCanvas.style.width = `${canvasWidth}px`;
          positionedCanvas.style.height = `${canvasHeight}px`;
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
        root.insertAdjacentHTML("beforeend", libraryPanel() + modelPanel());
        const settings = graph.nodes.find((n) => n.id === settingsNode);
        if (settings)
          root.insertAdjacentHTML(
            "beforeend",
            `<div class="we-modal-backdrop" data-settings-modal><section class="we-modal we-node-modal" role="dialog" aria-modal="true" aria-labelledby="we-settings-title"><header><h3 id="we-settings-title">${esc(TYPES[settings.type]?.label || settings.type)} settings</h3><button data-close-settings aria-label="Close settings">Close</button></header><p data-signal-status role="status">${esc(notice)}</p><div class="we-node-layout">${signalPanel(settings, "in")}<section class="we-node-settings" aria-label="Node settings">${selected === settings.id ? params : ""}${nodeConnections(settings)}${settings.type === "code" ? `<div class="we-code-actions"><button class="button secondary" data-code-test ${demo ? "disabled" : ""}>Test code locally</button><span role="status">${esc(codeError)}</span></div>${testPane ? `<section data-test-pane><p>Runs locally. Sample detections are editable.</p><label>Sample detections JSON<textarea data-test-input>${esc(JSON.stringify([{ label: "person", confidence: 0.93, bbox: [20, 30, 90, 180] }], null, 2))}</textarea></label><button class="button primary" data-run-test ${testRunning ? "disabled" : ""}>${testRunning ? "Running…" : "Run test"}</button><pre data-test-result role="status"></pre></section>` : ""}` : ""}</section>${signalPanel(settings, "out")}</div><button class="button secondary" data-close-settings>Done</button></section></div>`,
          );
        previewController?.sync();
        if (wireDrag) {
          const canvas = root.querySelector("[data-canvas]"),
            rect = canvas?.getBoundingClientRect();
          if (rect) {
            const x = wireDrag.x,
              y = wireDrag.y,
              ex = wireDrag.currentX - rect.left,
              ey = wireDrag.currentY - rect.top;
            canvas
              .querySelector(".we-wires")
              ?.insertAdjacentHTML(
                "beforeend",
                `<path class="we-wire-live" d="M ${x} ${y} C ${x + 50} ${y}, ${ex - 50} ${ey}, ${ex} ${ey}"/>`,
              );
          }
        }
      }
      const mark = () => {
          dirty = true;
          graphRevision++;
          if (demo)
            try {
              localStorage.setItem(key, JSON.stringify(graph));
            } catch {}
        },
        changed = () => {
          mark();
          render();
        },
        add = (type, x, y) => {
          if (!TYPES[type] || graph.nodes.length >= 64) return;
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
          return data;
        } finally {
          clearTimeout(limit);
          requestControllers.delete(requestController);
        }
      }
      function syncModelDraft() {
        if (!modelDraft) modelDraft = defaultModel();
        const value = (q) => root.querySelector(q)?.value ?? "";
        modelDraft.engine = value("[data-model-engine]") || "none";
        modelDraft.model = value("[data-model-path]");
        modelDraft.device = value("[data-model-device]") || "cpu";
        modelDraft.inference_fps = Number(value("[data-model-fps]"));
        modelDraft.confidence = Number(value("[data-model-confidence]"));
        modelDraft.input_size = Number(value("[data-model-size]"));
        modelDraft.max_detections = Number(value("[data-model-max]"));
        modelDraft.recognition_enabled =
          !!root.querySelector("[data-recognition]")?.checked;
        modelDraft.recognition_model = value("[data-recognition-model]");
        modelDraft.identity_gallery = value("[data-gallery]");
        modelDraft.recognition_threshold = Number(
          value("[data-recognition-threshold]"),
        );
        modelDirty = true;
        modelRevision++;
      }
      async function applyModel() {
        if (demo || modelBusy || !modelCamera) return;
        syncModelDraft();
        const snapshot = clone(modelDraft),
          cameraId = modelCamera,
          revision = modelRevision,
          engine = snapshot.engine;
        let settings = null;
        if (engine !== "none") {
          settings = {
            engine,
            device: snapshot.device,
            inference_fps: snapshot.inference_fps,
            confidence: snapshot.confidence,
            input_size: snapshot.input_size,
            max_detections: snapshot.max_detections,
          };
          if (engine !== "opencv") settings.model = snapshot.model.trim();
          if (engine === "insightface" && snapshot.recognition_enabled) {
            settings.recognition_model =
              snapshot.recognition_model.trim() || null;
            settings.identity_gallery =
              snapshot.identity_gallery.trim() || null;
            settings.recognition_threshold = snapshot.recognition_threshold;
          }
        }
        const errors = [];
        if (settings) {
          if (
            !Number.isFinite(settings.inference_fps) ||
            settings.inference_fps < 0.1 ||
            settings.inference_fps > 30
          )
            errors.push("Inference FPS must be 0.1–30.");
          if (
            !Number.isFinite(settings.confidence) ||
            settings.confidence < 0 ||
            settings.confidence > 1
          )
            errors.push("Confidence must be 0–1.");
          if (
            !Number.isInteger(settings.input_size) ||
            settings.input_size < 128 ||
            settings.input_size > 1280 ||
            settings.input_size % 32
          )
            errors.push(
              "Input size must be a multiple of 32 from 128 to 1280.",
            );
          if (
            !Number.isInteger(settings.max_detections) ||
            settings.max_detections < 1 ||
            settings.max_detections > 500
          )
            errors.push("Maximum detections must be 1–500.");
          if (engine !== "opencv" && !settings.model)
            errors.push("Enter a local model path.");
          if (
            engine === "insightface" &&
            snapshot.recognition_enabled &&
            (!settings.recognition_model || !settings.identity_gallery)
          )
            errors.push(
              "Recognition requires both ONNX model and identity gallery paths.",
            );
          if (
            engine === "insightface" &&
            snapshot.recognition_enabled &&
            (!Number.isFinite(settings.recognition_threshold) ||
              settings.recognition_threshold < 0 ||
              settings.recognition_threshold > 1)
          )
            errors.push("Recognition threshold must be 0–1.");
        }
        if (settings && engine !== "yolo" && settings.device !== "cpu") {
          errors.push("Only YOLO supports GPU device selection.");
        }
        if (errors.length) {
          modelState = errors.join(" ");
          render();
          return;
        }
        modelBusy = true;
        modelState = "Applying camera configuration…";
        render();
        const active = new AbortController(),
          limit = setTimeout(() => active.abort(), 4000);
        modelController?.abort();
        modelController = active;
        try {
          const response = await fetch(
              `/api/cameras/${encodeURIComponent(cameraId)}/vision`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Spyder-Control": "1",
                },
                body: JSON.stringify({ settings }),
                signal: active.signal,
              },
            ),
            data = await response.json().catch(() => ({}));
          if (!response.ok)
            throw Error(data.error || `Request failed (${response.status})`);
          if (!mounted || modelCamera !== cameraId) return;
          if (modelRevision === revision) {
            modelConfig = data;
            modelDraft = draftFrom(data);
            modelDirty = false;
          }
          runtimeState = data.runtime?.message || data.runtime?.state || "";
          modelState = `Applied. Pipeline: ${data.pipeline || "none"}`;
        } catch (e) {
          if (mounted && modelCamera === cameraId)
            modelState =
              e.name === "AbortError" ? "Request timed out." : e.message;
        } finally {
          clearTimeout(limit);
          if (mounted && modelCamera === cameraId) {
            modelBusy = false;
            render();
          }
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
          button.className = `button ${graph.enabled ? "secondary" : "primary"}`;
          button.disabled = !!(
            demo ||
            busy ||
            activationBusy ||
            activationReview
          );
        }
        if (status)
          status.textContent = graph.enabled
            ? "Workflow enabled"
            : "Workflow disabled";
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
          const response = await fetch("/api/workflows", {
            cache: "no-store",
            signal: active.signal,
          });
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
          activationStatus("Workflow execution is disabled in showcase mode.");
          return;
        }
        if (busy || activationBusy || activationReview) return;
        const workflow = clone(candidate);
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
        if (demo || busy || activationBusy || activationReview) return;
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
            "Workflow disabled. Camera model settings stay active.",
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
          mark();
          issue("Draft saved in this browser. Execution disabled.");
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
          issue("Workflow saved.");
          await poll(false);
        } catch (e) {
          if (mounted) issue(e.message);
        } finally {
          busy = false;
          if (mounted) render();
        }
      }
      async function loadModel() {
        if (demo || !modelCamera || !mounted) return;
        const cameraId = modelCamera;
        modelController?.abort();
        modelController = new AbortController();
        const active = modelController,
          limit = setTimeout(() => active.abort(), 4000);
        try {
          const r = await fetch(
              `/api/cameras/${encodeURIComponent(cameraId)}/vision`,
              { cache: "no-store", signal: active.signal },
            ),
            data = await r.json();
          if (!r.ok)
            throw Error(data.error || "Camera model settings unavailable.");
          if (
            !mounted ||
            modelController !== active ||
            modelCamera !== cameraId
          )
            return;
          runtimeState = data.runtime?.message || data.runtime?.state || "";
          const liveStatus = root.querySelector(".we-runtime");
          if (liveStatus) liveStatus.textContent = runtimeState;
          if (!modelDirty) {
            const first = !modelDraft;
            modelConfig = data;
            modelDraft = draftFrom(data);
            runtimeState = data.runtime?.message || data.runtime?.state || "";
            modelState = `Pipeline: ${data.pipeline || "none"}`;
            const status = root.querySelector(".we-runtime");
            if (status) status.textContent = runtimeState;
            const state = root.querySelector(".we-model-state");
            if (state) state.textContent = modelState;
            if (first) {
              if (settingsNode || pointerDrag || wireDrag || panDrag) {
                const panel = root.querySelector(".we-models");
                if (panel) panel.outerHTML = modelPanel();
              } else render(true);
            }
          }
        } catch (e) {
          if (mounted && modelCamera === cameraId && e.name !== "AbortError") {
            modelState = e.message;
            const state = root.querySelector(".we-model-state");
            if (state) state.textContent = modelState;
          }
        } finally {
          clearTimeout(limit);
        }
      }
      function updateSnapshot() {
        const chooser = root.querySelector("[data-workflow]");
        if (chooser) {
          const current = graph?.id || "";
          chooser.innerHTML =
            workflows
              .map(
                (w) =>
                  `<option value="${esc(w.id)}" ${w.id === current ? "selected" : ""}>${esc(w.name)}</option>`,
              )
              .join("") + `<option value="__new">New workflow</option>`;
          chooser.value = current;
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
      async function poll(schedule = true) {
        if (!mounted || demo) return;
        controller?.abort();
        controller = new AbortController();
        const active = controller,
          limit = setTimeout(() => active.abort(), 4000);
        try {
          const r = await fetch("/api/workflows", {
              cache: "no-store",
              signal: active.signal,
            }),
            data = await r.json();
          if (!r.ok) throw Error(data.error || "Workflow data unavailable.");
          if (!mounted || controller !== active) return;
          workflows = data.workflows || [];
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
          if (!modelBusy) loadModel();
          if (!busy && !activationBusy && !activationReview) {
            const saved = workflows.find((w) => w.id === graph?.id);
            if (saved) graph.enabled = !!saved.enabled;
            syncActivationControls();
          }
          if (
            !dirty &&
            !busy &&
            !modelDirty &&
            !activationReview &&
            !activationBusy
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
        const t = e.target;
        if (t.matches("[data-model-engine]")) {
          syncModelDraft();
          const selectedEngine = t.value,
            path = root.querySelector("[data-model-path]"),
            recognitionFields = root.querySelector("[data-recognition-fields]");
          if (path)
            path.disabled =
              selectedEngine === "none" || selectedEngine === "opencv";
          if (recognitionFields)
            recognitionFields.hidden = selectedEngine !== "insightface";
          return;
        }
        if (
          t.matches(
            "[data-model-path],[data-model-device],[data-model-fps],[data-model-confidence],[data-model-size],[data-model-max],[data-recognition-model],[data-gallery],[data-recognition-threshold],[data-recognition]",
          )
        ) {
          syncModelDraft();
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
          mark();
          if (key === "field") render(true);
          return;
        }
        if (!t.matches("[data-param]")) return;
        const n = graph.nodes.find((n) => n.id === selected);
        if (!n) return;
        const k = t.dataset.param,
          old = n.params[k];
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
          : typeof old === "number"
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
            .then((text) => {
              if (!mounted || generation !== importGeneration) return;
              const imported = decodeWorkflow(text, cameraList(), library);
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
        } else if (t.matches("[data-model-camera]")) {
          modelCamera = t.value;
          modelBusy = false;
          modelDirty = false;
          modelDraft = null;
          modelConfig = null;
          modelState = "Loading camera settings…";
          modelController?.abort();
          render();
          loadModel();
          return;
        } else if (t.matches("[data-model-engine]")) {
          input(e);
          return;
        } else if (t.matches("[data-recognition]")) {
          syncModelDraft();
          const pane = root.querySelector("[data-recognition-fields]");
          if (pane)
            pane.hidden =
              !t.checked ||
              root.querySelector("[data-model-engine]")?.value !==
                "insightface";
          return;
        } else if (
          t.matches(
            "[data-model-path],[data-model-device],[data-model-fps],[data-model-confidence],[data-model-size],[data-model-max],[data-recognition-model],[data-gallery],[data-recognition-threshold]",
          )
        ) {
          syncModelDraft();
          return;
        } else if (t.matches("[data-param]")) {
          input(e);
          return;
        } else return;
        changed();
      };
      const click = async (e) => {
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
        if (b.dataset.import !== undefined)
          root.querySelector("[data-import-file]").click();
        else if (b.dataset.export !== undefined) {
          const blob = new Blob([encodeWorkflow(graph, library)], {
              type: "application/json",
            }),
            url = URL.createObjectURL(blob),
            link = document.createElement("a");
          link.href = url;
          link.download = `${graph.name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "workflow"}.json`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
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
        else if (b.dataset.center !== undefined) centerCanvas();
        else if (b.dataset.undo !== undefined) restore(undoStack, redoStack);
        else if (b.dataset.redo !== undefined) restore(redoStack, undoStack);
        else if (b.dataset.add) add(b.dataset.add);
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
        } else if (b.dataset.applyModel !== undefined) applyModel();
        else if (b.dataset.insightfaceTemplate !== undefined) {
          if (!demo) window.spyderNotifications?.useNode?.();
          remember();
          graph = insightfaceTemplate({
            cameraId: cameraList()[0]?.id || "",
            classifierId: classifierModels()[0]?.id || "",
          });
          selected = graph.nodes.find((n) => n.type === "filter").id;
          settingsNode = "";
          notice =
            "InsightFace alert draft created with SCRFD 500MF. Choose Camera and Filter settings. A connected classifier supplies identity choices. Add one from the palette if needed.";
          changed();
        } else if (b.dataset.template !== undefined) {
          remember();
          graph = faceTemplate();
          selected = "";
          changed();
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
        else if (b.dataset.remove !== undefined && !demo && !busy) {
          busy = true;
          try {
            await post(
              `/api/workflows/${encodeURIComponent(graph.id)}/remove`,
              {},
            );
            graph = fresh();
            dirty = false;
            await poll(false);
          } catch (x) {
            issue(x.message);
          } finally {
            busy = false;
            render();
          }
        }
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
        if (
          e.target.matches?.(
            "[data-param],[data-rule],[data-camera],[data-name]",
          )
        )
          remember();
        if (e.target.matches?.("[data-delete-edge]"))
          selectedEdge = e.target.dataset.deleteEdge;
      };
      const keydown = (e) => {
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
          if (e.key.toLowerCase() === "z") {
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
          !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName || "")
        ) {
          removeConnection(selectedEdge);
          return;
        }
        if (
          e.key === "Delete" &&
          selected &&
          !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName || "")
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
                  16,
              );
              actions?.setAttribute(
                "y",
                canvasPadding +
                  (clamp(a.y) +
                    38 +
                    clamp(b.y) +
                    portOffset(inputType(edge, graph.nodes), b)) /
                    2 -
                  16,
              );
            } else path.setAttribute("d", wirePath(edge));
          }
        }
        if (wireDrag) {
          const svg = canvas.querySelector(".we-wires"),
            rect = canvas.getBoundingClientRect(),
            x = wireDrag.x,
            y = wireDrag.y,
            ex = wireDrag.currentX - rect.left,
            ey = wireDrag.currentY - rect.top;
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
            n.x = clamp(pointerDrag.x + e.clientX - pointerDrag.sx);
            n.y = clamp(pointerDrag.y + e.clientY - pointerDrag.sy);
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
            clamp(e.clientX - r.left - canvasPadding),
            clamp(e.clientY - r.top - canvasPadding),
          );
        else if (drag?.node) {
          const n = graph.nodes.find((x) => x.id === drag.node);
          if (n) {
            n.x = clamp(n.x + e.clientX - drag.x);
            n.y = clamp(n.y + e.clientY - drag.y);
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
        const needsLoad = !modelCamera && cameraList().length > 0;
        if (needsLoad) {
          modelCamera = cameraList()[0].id;
          modelDirty = false;
          modelDraft = null;
          modelConfig = null;
        }
        render();
        if (needsLoad && !demo) loadModel();
      };
      root.addEventListener("input", input);
      root.addEventListener("change", change);
      root.addEventListener("click", click);
      root.addEventListener("click", select, true);
      root.addEventListener("dblclick", doubleClick);
      root.addEventListener("keydown", keydown);
      root.addEventListener("focusin", focusin);
      root.addEventListener("pointerdown", pointerDown);
      document.addEventListener("pointermove", pointerMove);
      document.addEventListener("pointerup", pointerUp);
      document.addEventListener("pointercancel", pointerUp);
      root.addEventListener("dragstart", start);
      root.addEventListener("dragend", endDrag);
      root.addEventListener("dragover", over);
      root.addEventListener("drop", drop);
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
      cameraSignature = JSON.stringify(cameraList().map((c) => [c.id, c.name]));
      if (!demo) {
        loadModel();
        loadLibrary();
        loadDetectorCatalog();
      }
      poll();
      dispose = () => {
        mounted = false;
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
        modelController?.abort();
        libraryController?.abort();
        detectorController?.abort();
        importGeneration++;
        for (const request of requestControllers) request.abort();
        window.removeEventListener("spyder:cameras", refreshCameras);
        root.removeEventListener("input", input);
        root.removeEventListener("change", change);
        root.removeEventListener("click", click);
        root.removeEventListener("click", select, true);
        root.removeEventListener("dblclick", doubleClick);
        root.removeEventListener("keydown", keydown);
        root.removeEventListener("focusin", focusin);
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
