/* Browser-owned wall arrangements. No camera capture, model or recording ownership. */
(() => {
  "use strict";
  const MODES = ["auto", "grid", "featured", "sequence"];
  const RATIOS = ["16:9", "4:3", "1:1", "9:16"];
  const defaults = () => ({
    version: 1,
    name: "My arrangement",
    mode: "auto",
    columns: 2,
    fit: "fit",
    gap: 12,
    interval: 10,
    order: [],
    hidden: [],
    featured: "",
    dummies: [],
  });
  function validate(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.version !== 1
    )
      throw new Error("Use a SpyDER layout version 1 file.");
    const result = defaults();
    if (
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > 80
    )
      throw new Error("Layout names need 1–80 characters.");
    result.name = value.name.trim();
    if (!MODES.includes(value.mode) || !["fit", "fill"].includes(value.fit))
      throw new Error("Unsupported layout mode or image fit.");
    for (const [key, min, max] of [
      ["columns", 1, 6],
      ["gap", 0, 32],
      ["interval", 3, 120],
    ]) {
      if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
        throw new Error("Invalid " + key + ".");
      result[key] = value[key];
    }
    for (const key of ["order", "hidden"]) {
      if (
        !Array.isArray(value[key]) ||
        value[key].length > 256 ||
        value[key].some(
          (id) => typeof id !== "string" || !/^[\w-]{1,100}$/.test(id),
        )
      )
        throw new Error("Invalid camera selection.");
      result[key] = [...new Set(value[key])];
    }
    if (
      typeof value.featured !== "string" ||
      (value.featured && !/^[\w-]{1,100}$/.test(value.featured))
    )
      throw new Error("Invalid featured camera.");
    if (!Array.isArray(value.dummies) || value.dummies.length > 24)
      throw new Error("Use up to 24 dummy cameras.");
    const ids = new Set();
    result.dummies = value.dummies.map((d) => {
      if (
        !d ||
        !/^dummy-[\w-]{1,80}$/.test(d.id) ||
        ids.has(d.id) ||
        typeof d.name !== "string" ||
        !d.name.trim() ||
        d.name.length > 80 ||
        !RATIOS.includes(d.ratio)
      )
        throw new Error("Invalid dummy camera.");
      ids.add(d.id);
      return { id: d.id, name: d.name.trim(), ratio: d.ratio };
    });
    result.mode = value.mode;
    result.fit = value.fit;
    result.featured = value.featured;
    return result;
  }
  function ordered(config, cameras) {
    const hidden = new Set(config.hidden);
    const map = new Map(cameras.map((c) => [c.id, c]));
    const ids = [...new Set([...config.order, ...map.keys()])];
    return ids
      .filter((id) => map.has(id) && !hidden.has(id))
      .map((id) => map.get(id));
  }
  function geometry(config, count, width, height, fullscreen = false) {
    const limit = Math.max(
      1,
      Math.floor((Math.max(1, width) + config.gap) / (180 + config.gap)),
    );
    let columns =
      config.mode === "grid"
        ? Math.min(config.columns, count || 1)
        : Math.min(Math.ceil(Math.sqrt(count || 1)), count || 1);
    if (!fullscreen) columns = Math.min(columns, limit);
    if (config.mode === "sequence") {
      columns = 1;
      count = Math.min(1, count);
    }
    if (config.mode === "featured" && count > 1) columns = width < 540 ? 1 : 3;
    return {
      columns: Math.max(1, columns),
      rows: Math.max(
        1,
        Math.ceil(
          (count +
            (config.mode === "featured" && columns > 1 && count > 1 ? 3 : 0)) /
            Math.max(1, columns),
        ),
      ),
    };
  }
  if (typeof module !== "undefined")
    module.exports = { validate, defaults, ordered, geometry };
  if (typeof window === "undefined") return;

  const app = window.spyder;
  const $ = (s, root = document) => root.querySelector(s);
  const key =
    "spyder-layouts-v1-" + (window.spyderShowcase ? "showcase" : "local");
  let layouts = [],
    activeId = "",
    applied = null,
    draft = defaults(),
    root = null,
    dirty = false;
  let editingId = "";
  let layoutGeneration = 1;
  let rotationPaused = false;
  let rotation = 0,
    timer = null,
    dragging = null,
    signature = "",
    storageWarning = "";
  const dummyElements = new Map();
  function load() {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      if (!value) return;
      if (!Array.isArray(value.layouts) || value.layouts.length > 50)
        throw new Error("Invalid saved layouts.");
      const ids = new Set();
      layouts = value.layouts.map((item) => {
        if (!item || !/^layout-[\w-]+$/.test(item.id) || ids.has(item.id))
          throw new Error("Invalid layout identifier.");
        ids.add(item.id);
        return { id: item.id, config: validate(item.config) };
      });
      activeId = ids.has(value.activeId) ? value.activeId : "";
      applied = activeId ? validate(value.applied) : null;
      draft = applied ? structuredClone(applied) : defaults();
    } catch {
      layouts = [];
      activeId = "";
      applied = null;
      storageWarning =
        "Saved layouts could not be read. Import a backup or save a new arrangement.";
    }
  }
  load();
  function persist(nextLayouts, nextId, nextApplied) {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          layouts: nextLayouts,
          activeId: nextId,
          applied: nextApplied,
        }),
      );
    } catch {
      throw new Error(
        "Browser storage unavailable or full. Export a backup; changes have not been saved.",
      );
    }
    storageWarning = "";
    layouts = nextLayouts;
    activeId = nextId;
    applied = nextApplied;
  }
  const uid = (prefix) => prefix + "-" + crypto.randomUUID();
  function tell(text) {
    const node = root && $("#layout-status", root);
    if (node) node.textContent = text;
    else app.notify(text);
  }
  function button(label, action, primary = false) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "button " + (primary ? "primary" : "secondary");
    node.textContent = label;
    node.addEventListener("click", () => {
      try {
        action();
      } catch (error) {
        tell(error.message);
      }
    });
    return node;
  }
  function all(config) {
    return [
      ...app.cameras(),
      ...config.dummies.map((d) => ({ ...d, dummy: true, state: "running" })),
    ];
  }
  const escaped = (text) =>
    String(text).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c],
    );
  function dummyImage(camera, index) {
    const [w, h] = camera.ratio.split(":").map(Number);
    const height = Math.round((640 * h) / w);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${height}" viewBox="0 0 640 ${height}"><defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#F7D87F" opacity=".14"/></pattern></defs><rect width="640" height="${height}" fill="${index % 2 ? "#250a0a" : "#141313"}"/><rect width="640" height="${height}" fill="url(#grid)"/><circle cx="320" cy="${height / 2}" r="68" fill="none" stroke="#BE1A1A" stroke-width="5"/><path d="M230 ${height / 2}h180M320 ${height / 2 - 90}v180" stroke="#F7D87F" opacity=".6"/><text x="24" y="42" fill="#F7D87F" font-family="sans-serif" font-size="18">GENERATED · ${escaped(camera.ratio)}</text><text x="24" y="${height - 46}" fill="white" font-family="sans-serif" font-size="24">${escaped(camera.name)}</text><text x="24" y="${height - 20}" fill="#F8EBAB" font-family="sans-serif" font-size="14">LAYOUT SIMULATION · NO CAMERA ACCESS</text></svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  function arranged(config, cameras) {
    const visible = ordered(config, cameras);
    if (
      config.mode === "featured" &&
      visible.some((c) => c.id === config.featured)
    ) {
      const i = visible.findIndex((c) => c.id === config.featured);
      visible.unshift(...visible.splice(i, 1));
    }
    return visible;
  }
  function display(config) {
    const cameras = arranged(config, all(config));
    if (config.mode !== "sequence") return cameras;
    return cameras.length ? [cameras[rotation % cameras.length]] : [];
  }
  function applyGeometry(container, config, count, fullscreen) {
    const box = container.getBoundingClientRect();
    let grid = geometry(
      config,
      count,
      box.width || 800,
      box.height || 450,
      fullscreen,
    );
    if (config.mode === "auto" && fullscreen && window.spyderWall) {
      const style = getComputedStyle(container);
      const aspects = [...container.children]
        .filter((tile) => !tile.hidden)
        .map((tile) => {
          const image = $("img", tile);
          return image?.naturalWidth / image?.naturalHeight || 16 / 9;
        });
      grid = window.spyderWall.layout(
        count,
        box.width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
        box.height -
          parseFloat(style.paddingTop) -
          parseFloat(style.paddingBottom),
        aspects,
      );
    }
    container.style.setProperty("--columns", grid.columns);
    container.style.setProperty("--rows", grid.rows);
    container.style.setProperty("--layout-gap", config.gap + "px");
    container.dataset.layoutMode = config.mode;
    container.dataset.layoutFit = config.fit;
    container.dataset.layoutColumns = String(grid.columns);
  }
  function reflowWall() {
    const wall = $("#cameras");
    if (!wall) return false;
    for (const [id, element] of dummyElements) {
      if (!applied?.dummies.some((d) => d.id === id)) {
        element.remove();
        dummyElements.delete(id);
      }
    }
    $("#density").disabled = !!applied;
    $("#density").title = applied
      ? "Choose Automatic wall to use tile-size controls."
      : "";
    if (!applied) {
      wall.removeAttribute("data-layout-mode");
      wall.removeAttribute("data-layout-fit");
      wall.style.removeProperty("--layout-gap");
      for (const card of wall.querySelectorAll(".camera-card")) {
        card.hidden = false;
        card.classList.remove("layout-featured");
      }
      $("#wall-count").textContent = String(app.cameras().length);
      return false;
    }
    applied.dummies.forEach((camera, index) => {
      let element = dummyElements.get(camera.id);
      if (!element) {
        element = document.createElement("article");
        element.className = "camera-card dummy-camera";
        element.dataset.dummy = "true";
        element.dataset.id = camera.id;
        const stage = document.createElement("div");
        stage.className = "video-stage";
        const image = document.createElement("img");
        image.className = "camera-image";
        image.draggable = false;
        const tag = document.createElement("span");
        tag.className = "dummy-label";
        tag.textContent = "DUMMY · SIMULATED";
        stage.append(image, tag);
        element.append(stage);
        dummyElements.set(camera.id, element);
      }
      const image = $("img", element);
      image.alt = camera.name + " · generated dummy camera";
      const url = dummyImage(camera, index);
      if (image.getAttribute("src") !== url) image.src = url;
      $(".video-stage", element).style.aspectRatio = camera.ratio.replace(
        ":",
        "/",
      );
      wall.append(element);
    });
    const visible = display(applied);
    const ids = new Set(visible.map((c) => c.id));
    const featured = ids.has(applied.featured)
      ? applied.featured
      : visible[0]?.id;
    for (const card of wall.querySelectorAll(".camera-card")) {
      card.hidden = !ids.has(card.dataset.id);
      card.classList.toggle(
        "layout-featured",
        applied.mode === "featured" &&
          card.dataset.id === featured &&
          visible.length > 1,
      );
      if (
        ids.has(card.dataset.id) &&
        card.dataset.layoutGeneration !== String(layoutGeneration)
      ) {
        card.dataset.fit = applied.fit;
        card.dataset.layoutGeneration = String(layoutGeneration);
      }
    }
    for (const camera of visible) {
      const element = [...wall.children].find(
        (e) => e.dataset.id === camera.id,
      );
      if (element) wall.append(element);
    }
    applyGeometry(wall, applied, visible.length, !!window.spyderWall?.active());
    $("#empty").hidden = app.cameras().length > 0 || visible.length > 0;
    $("#wall-count").textContent = visible.length + " views";
    $("#wall-hint").textContent =
      applied.name.toUpperCase() +
      " · " +
      visible.length +
      " VIEWS" +
      (applied.dummies.length ? " · INCLUDES SIMULATIONS" : "");
    return true;
  }
  function scheduleRotation(reset = true) {
    clearInterval(timer);
    if (reset) {
      rotation = 0;
      rotationPaused = false;
    }
    if (typeof rotationControls !== "undefined") {
      syncRotationControls();
      pauseRotation.textContent = rotationPaused
        ? "Resume rotation"
        : "Pause rotation";
      pauseRotation.setAttribute("aria-pressed", String(rotationPaused));
    }
    if (
      applied?.mode === "sequence" &&
      !document.hidden &&
      ["", "#control-room"].includes(location.hash)
    )
      timer = setInterval(() => {
        if (document.hidden || rotationPaused || $("#control-room").hidden)
          return;
        rotation++;
        app.leaveFocus();
        app.reflow();
      }, applied.interval * 1000);
  }
  function quickMenu() {
    const select = $("#wall-layout-choice");
    if (!select) return;
    select.replaceChildren(new Option("Automatic wall", ""));
    for (const item of layouts)
      select.append(new Option(item.config.name, item.id));
    select.value = activeId;
    const fullscreenSelect = $("#wall-layout-fullscreen");
    if (fullscreenSelect) {
      fullscreenSelect.replaceChildren(
        ...[...select.options].map(
          (option) => new Option(option.text, option.value),
        ),
      );
      fullscreenSelect.value = activeId;
    }
  }
  function activate(id) {
    layoutGeneration++;
    const item = layouts.find((l) => l.id === id);
    persist(
      layouts,
      item?.id || "",
      item ? structuredClone(item.config) : null,
    );
    app.leaveFocus();
    scheduleRotation();
    quickMenu();
    app.reflow();
  }
  function changed() {
    dirty = true;
    preview();
    const status = $("#layout-status", root);
    status.textContent =
      "Draft changes · save and apply to update the Control Room.";
  }
  function preview() {
    if (!root?.isConnected) return;
    const container = $("#layout-preview", root),
      list = $("#layout-camera-list", root);
    const cameras = all(draft),
      visible = arranged(draft, cameras);
    container.replaceChildren();
    list.replaceChildren();
    const screenShape = $("#layout-viewport", root).value;
    const [screenWidth, screenHeight] = screenShape.split("/").map(Number);
    container.style.aspectRatio = screenShape;
    container.style.maxWidth = (660 * screenWidth) / screenHeight + "px";
    container.style.width = "100%";
    applyGeometry(
      container,
      draft,
      draft.mode === "sequence" ? Math.min(1, visible.length) : visible.length,
      false,
    );
    const featured = visible.some((c) => c.id === draft.featured)
      ? draft.featured
      : visible[0]?.id;
    const shown = draft.mode === "sequence" ? visible.slice(0, 1) : visible;
    for (const [index, camera] of shown.entries()) {
      const tile = document.createElement("div");
      tile.className = "layout-preview-tile";
      tile.dataset.camera = camera.id;
      tile.classList.toggle(
        "layout-featured",
        draft.mode === "featured" && camera.id === featured && shown.length > 1,
      );
      const url = camera.dummy
        ? dummyImage(camera, index)
        : app.frame(camera.id);
      const image = document.createElement("img");
      image.alt = "";
      image.draggable = false;
      if (url) image.src = url;
      else image.hidden = true;
      const label = document.createElement("span");
      label.textContent =
        camera.name + (camera.dummy ? " · DUMMY" : " · " + camera.state);
      tile.append(image, label);
      container.append(tile);
    }
    if (!shown.length)
      container.textContent =
        "Add dummy cameras or show a connected camera to compose this wall.";
    const map = new Map(cameras.map((c) => [c.id, c]));
    const order = [...new Set([...draft.order, ...map.keys()])];
    const featuredSelect = $("#layout-featured", root);
    featuredSelect.replaceChildren(new Option("First visible camera", ""));
    for (const camera of cameras)
      featuredSelect.append(new Option(camera.name, camera.id));
    featuredSelect.value = draft.featured;
    for (const id of order) {
      const camera = map.get(id);
      const row = document.createElement("div");
      row.className = "layout-camera-row";
      row.draggable = true;
      row.dataset.id = id;
      row.addEventListener("dragstart", (event) => {
        dragging = id;
        event.dataTransfer.setData("text/plain", id);
        event.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        if (dragging && dragging !== id) {
          const next = order.filter((x) => x !== dragging);
          next.splice(next.indexOf(id), 0, dragging);
          draft.order = next;
          dragging = null;
          changed();
        }
      });
      row.addEventListener("dragend", () => {
        dragging = null;
      });
      const label = document.createElement("label");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = !draft.hidden.includes(id);
      check.addEventListener("change", () => {
        draft.hidden = draft.hidden.filter((x) => x !== id);
        if (!check.checked) draft.hidden.push(id);
        changed();
      });
      const title = document.createElement("span");
      title.textContent = camera
        ? camera.name + (camera.dummy ? " · dummy" : "")
        : id + " · unavailable";
      label.append(check, title);
      row.append(label);
      const actions = document.createElement("div");
      actions.className = "layout-row-actions";
      for (const [direction, text] of [
        [-1, "Move up"],
        [1, "Move down"],
      ]) {
        const move = button(text, () => {
          const i = order.indexOf(id);
          const j = i + direction;
          if (j < 0 || j >= order.length) return;
          [order[i], order[j]] = [order[j], order[i]];
          draft.order = order;
          changed();
          const destination = [...$("#layout-camera-list", root).children].find(
            (e) => e.dataset.id === id,
          );
          destination
            ?.querySelectorAll("button")
            [direction === -1 ? 0 : 1]?.focus();
        });
        move.disabled =
          order.indexOf(id) + direction < 0 ||
          order.indexOf(id) + direction >= order.length;
        actions.append(move);
      }
      if (camera?.dummy || !camera)
        actions.append(
          button("Remove", () => {
            draft.dummies = draft.dummies.filter((d) => d.id !== id);
            draft.order = order.filter((x) => x !== id);
            draft.hidden = draft.hidden.filter((x) => x !== id);
            if (draft.featured === id) draft.featured = "";
            changed();
          }),
        );
      if (!camera) {
        const replacement = document.createElement("select");
        replacement.setAttribute(
          "aria-label",
          "Replace unavailable camera " + id,
        );
        replacement.append(new Option("Assign a camera...", ""));
        for (const available of cameras)
          replacement.append(new Option(available.name, available.id));
        replacement.addEventListener("change", () => {
          const nextId = replacement.value;
          if (!nextId) return;
          draft.order = [
            ...new Set(order.map((value) => (value === id ? nextId : value))),
          ];
          draft.hidden = [
            ...new Set(
              draft.hidden.map((value) => (value === id ? nextId : value)),
            ),
          ];
          if (draft.featured === id) draft.featured = nextId;
          changed();
        });
        row.append(replacement);
      }
      row.append(actions);
      list.append(row);
    }
    $("#layout-count", root).textContent =
      visible.length +
      " visible · " +
      draft.dummies.length +
      "/24 dummy cameras";
  }
  function fill() {
    $("#layout-name", root).value = draft.name;
    for (const name of ["mode", "columns", "fit", "gap", "interval"])
      $("#layout-" + name, root).value = draft[name];
    preview();
  }
  function save(apply) {
    draft.name = $("#layout-name", root).value;
    const config = validate(draft);
    const id = $("#layout-saved", root).value || uid("layout");
    if (!layouts.some((l) => l.id === id) && layouts.length >= 50)
      throw new Error("Save up to 50 layouts. Delete an unused layout first.");
    if (
      layouts.some(
        (l) =>
          l.id !== id &&
          l.config.name.toLowerCase() === config.name.toLowerCase(),
      )
    )
      throw new Error(
        "Another layout uses that name. Choose a different name.",
      );
    const next = [...layouts.filter((l) => l.id !== id), { id, config }];
    persist(
      next,
      apply ? id : activeId,
      apply ? structuredClone(config) : applied,
    );
    dirty = false;
    savedMenu(id);
    quickMenu();
    if (apply) {
      layoutGeneration++;
      app.leaveFocus();
      scheduleRotation();
      app.reflow();
    }
    tell(
      apply
        ? "Saved and applied to the Control Room and fullscreen wall."
        : "Layout saved. The active wall is unchanged until applied.",
    );
  }
  function savedMenu(selected = "") {
    const select = $("#layout-saved", root);
    select.replaceChildren(new Option("New arrangement", ""));
    for (const item of layouts)
      select.append(
        new Option(
          item.config.name + (item.id === activeId ? " · active" : ""),
          item.id,
        ),
      );
    select.value = selected;
    editingId = selected;
  }
  function mount(container) {
    root = container;
    signature = "";
    dirty = false;
    draft = structuredClone(
      layouts.find((l) => l.id === activeId)?.config || applied || defaults(),
    );
    root.innerHTML = `<div class="layout-studio"><section class="workspace-panel layout-editor"><div class="layout-title"><div><p class="eyebrow">WALL DESIGNER</p><h2>Every angle, in its place.</h2></div><span id="layout-count" class="field-help"></span></div><p class="workspace-description">Arrange real feeds and generated dummy cameras. Save named walls, feature an entrance or rotate through your views. Layouts belong to this browser.</p><div class="layout-fields"><label>Saved arrangements<select id="layout-saved"></select></label><label>Name<input id="layout-name" maxlength="80" required /></label></div><div id="layout-preset-actions" class="layout-actions"></div><div class="layout-fields"><label>Arrangement<select id="layout-mode"><option value="auto">Automatic grid</option><option value="grid">Fixed columns</option><option value="featured">Featured camera</option><option value="sequence">Rotating single view</option></select></label><label>Preferred columns<select id="layout-columns"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option></select></label><label>Image fit<select id="layout-fit"><option value="fit">Fit · preserve whole image</option><option value="fill">Fill · crop edges</option></select></label><label>Tile spacing (px)<input id="layout-gap" type="number" min="0" max="32" /></label><label>Rotation interval (seconds)<input id="layout-interval" type="number" min="3" max="120" /></label><label>Featured camera<select id="layout-featured"></select></label></div><div class="layout-preview-heading"><h3>Wall preview</h3><label>Screen shape<select id="layout-viewport"><option value="16 / 9">Desktop · 16:9</option><option value="4 / 3">Monitor · 4:3</option><option value="1 / 1">Square</option><option value="9 / 16">Mobile · portrait</option></select></label></div><div id="layout-preview" class="layout-preview" aria-label="Layout simulation"></div><p class="field-help">Fixed columns adapt on narrow screens. Featured view stacks on mobile. Rotation starts after applying. Hiding a camera changes only the wall; capture, CV and recording keep their own settings.</p><div id="layout-save-actions" class="layout-actions"></div><p id="layout-status" role="status" aria-live="polite"></p></section><aside><section class="workspace-panel"><h2>Camera lineup</h2><p class="field-help">Drag rows to reorder, or use Move up / Move down. Uncheck a camera to hide it from this arrangement.</p><div id="layout-camera-list" class="layout-camera-list"></div></section><section class="workspace-panel"><h2>Simulation cameras</h2><p class="field-help">Generated locally. No permission prompts, camera access, server processing or recordings. Up to 24 per arrangement.</p><div class="layout-fields"><label>Name prefix<input id="dummy-name" value="Demo camera" maxlength="60" /></label><label>Camera shape<select id="dummy-ratio"><option>16:9</option><option>4:3</option><option>1:1</option><option>9:16</option></select></label><label>How many?<input id="dummy-count" type="number" min="1" max="24" value="4" /></label></div><div id="layout-dummy-actions" class="layout-actions"></div><p class="field-help">Save and apply to place dummy cameras in the Control Room. Remove them here or use Automatic wall to return to real cameras.</p></section></aside></div>`;
    savedMenu(activeId);
    fill();
    $("#layout-saved", root).addEventListener("change", (event) => {
      if (dirty && !confirm("Discard unsaved layout changes?")) {
        event.target.value = editingId;
        return;
      }
      editingId = event.target.value;
      draft = structuredClone(
        layouts.find((l) => l.id === editingId)?.config || defaults(),
      );
      dirty = false;
      fill();
      tell("Loaded as draft. Save and apply to update the wall.");
    });
    $("#layout-name", root).addEventListener("input", (event) => {
      draft.name = event.target.value;
      dirty = true;
    });
    for (const name of [
      "mode",
      "columns",
      "fit",
      "gap",
      "interval",
      "featured",
    ])
      $("#layout-" + name, root).addEventListener("change", (event) => {
        draft[name] = ["columns", "gap", "interval"].includes(name)
          ? Number(event.target.value)
          : event.target.value;
        changed();
      });
    $("#layout-viewport", root).addEventListener("change", preview);
    for (const [label, mode, columns] of [
      ["Auto grid", "auto", 2],
      ["2 × 2 grid", "grid", 2],
      ["3-column wall", "grid", 3],
      ["Featured view", "featured", 3],
      ["Rotate views", "sequence", 1],
    ])
      $("#layout-preset-actions", root).append(
        button(label, () => {
          draft.mode = mode;
          draft.columns = columns;
          fill();
          changed();
        }),
      );
    const actions = $("#layout-save-actions", root);
    actions.append(
      button("Save & apply", () => save(true), true),
      button("Save draft", () => save(false)),
      button("Duplicate", () => {
        draft.name = draft.name.slice(0, 70) + " copy";
        savedMenu("");
        fill();
        changed();
      }),
      button("Delete layout", () => {
        const id = $("#layout-saved", root).value;
        if (!id) throw new Error("Select a saved layout first.");
        if (
          !confirm(
            "Delete this saved layout? Camera sources and recordings are kept.",
          )
        )
          return;
        const next = layouts.filter((l) => l.id !== id);
        persist(
          next,
          activeId === id ? "" : activeId,
          activeId === id ? null : applied,
        );
        draft = defaults();
        dirty = false;
        savedMenu();
        fill();
        quickMenu();
        scheduleRotation();
        app.reflow();
        tell("Layout deleted.");
      }),
      button("Export layout", () => {
        draft.name = $("#layout-name", root).value;
        const config = validate(draft);
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(config, null, 2)], {
            type: "application/json",
          }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download =
          config.name.replace(/[^\w-]+/g, "-") + ".spyder-layout.json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
      button("Import layout", () => $("#layout-import", root).click()),
    );
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.id = "layout-import";
    input.hidden = true;
    actions.append(input);
    input.addEventListener("change", async () => {
      try {
        const mounted = root;
        const file = input.files[0];
        if (!file) return;
        if (file.size > 128 * 1024)
          throw new Error("Layout files must be smaller than 128 KiB.");
        const config = validate(JSON.parse(await file.text()));
        if (root !== mounted || !root?.isConnected) return;
        draft = config;
        savedMenu();
        fill();
        changed();
        tell(
          "Imported as a draft. Review camera mappings, then save and apply.",
        );
      } catch (error) {
        tell(error.message);
      } finally {
        input.value = "";
      }
    });
    $("#layout-dummy-actions", root).append(
      button(
        "Add dummy cameras",
        () => {
          const count = Number($("#dummy-count", root).value);
          if (
            !Number.isInteger(count) ||
            count < 1 ||
            count + draft.dummies.length > 24
          )
            throw new Error("Choose 1–24 cameras, up to 24 total.");
          const prefix = $("#dummy-name", root).value.trim() || "Demo camera";
          const start = draft.dummies.length;
          draft.order = [
            ...new Set([...draft.order, ...all(draft).map((c) => c.id)]),
          ];
          for (let i = 0; i < count; i++) {
            const camera = {
              id: uid("dummy"),
              name: prefix + " " + (start + i + 1),
              ratio: $("#dummy-ratio", root).value,
            };
            draft.dummies.push(camera);
            draft.order.push(camera.id);
          }
          changed();
        },
        true,
      ),
      button("Remove all dummies", () => {
        const ids = new Set(draft.dummies.map((d) => d.id));
        draft.order = draft.order.filter((id) => !ids.has(id));
        draft.hidden = draft.hidden.filter((id) => !ids.has(id));
        if (ids.has(draft.featured)) draft.featured = "";
        draft.dummies = [];
        changed();
      }),
    );
    if (storageWarning) tell(storageWarning);
    else if (applied && JSON.stringify(draft) !== JSON.stringify(applied))
      tell(
        "Saved draft loaded. The Control Room still uses the previously applied settings.",
      );
  }
  function unmount() {
    root = null;
    dragging = null;
  }
  const rotationControls = document.createElement("div");
  rotationControls.className = "layout-actions layout-rotation-controls";
  const pauseRotation = button("Pause rotation", () => {
    rotationPaused = !rotationPaused;
    pauseRotation.textContent = rotationPaused
      ? "Resume rotation"
      : "Pause rotation";
    pauseRotation.setAttribute("aria-pressed", String(rotationPaused));
    syncRotationControls();
  });
  const nextRotation = button("Next view", () => {
    rotation++;
    app.leaveFocus();
    app.reflow();
  });
  rotationControls.append(pauseRotation, nextRotation);
  $(".wall-controls").append(rotationControls);
  function syncRotationControls() {
    rotationControls.hidden = applied?.mode !== "sequence";
    const controls = $("#wall-rotation-controls");
    if (controls) controls.hidden = rotationControls.hidden;
    const pause = $("#wall-rotation-pause");
    if (pause) {
      pause.textContent = rotationPaused ? "Resume rotation" : "Pause rotation";
      pause.setAttribute("aria-pressed", String(rotationPaused));
    }
  }
  const quickLabel = document.createElement("label");
  quickLabel.className = "density-label";
  quickLabel.textContent = "Arrangement";
  const quick = document.createElement("select");
  quick.id = "wall-layout-choice";
  quickLabel.append(quick);
  $(".wall-controls").prepend(quickLabel);
  $(".wall-controls").append(
    button("Edit layouts", () => {
      location.hash = "layouts";
    }),
  );
  quick.addEventListener("change", () => {
    try {
      activate(quick.value);
    } catch (error) {
      app.notify(error.message);
      quickMenu();
    }
  });
  window.addEventListener("spyder:cameras", () => {
    app.reflow();
    if (root?.isConnected) {
      const next = JSON.stringify(
        app.cameras().map((c) => [c.id, c.name, c.state]),
      );
      if (next !== signature) {
        signature = next;
        preview();
      }
    }
  });
  window.addEventListener("spyder:frame", (event) => {
    if (!root?.isConnected) return;
    for (const tile of $("#layout-preview", root).children)
      if (tile.dataset.camera === event.detail.id) {
        const image = $("img", tile);
        image.hidden = false;
        image.src = event.detail.url;
      }
  });
  window.addEventListener("resize", () => {
    if (root?.isConnected) preview();
  });
  window.addEventListener("pagehide", () => clearInterval(timer));
  window.addEventListener("pageshow", () => scheduleRotation(false));
  window.addEventListener("hashchange", () => scheduleRotation(false));
  document.addEventListener("visibilitychange", () => scheduleRotation(false));
  function installFullscreen() {
    const tools = $("#wall-tools-panel");
    if (!tools || $("#wall-layout-fullscreen")) return;
    const section = document.createElement("section");
    const title = document.createElement("h3");
    title.textContent = "Wall arrangement";
    const label = document.createElement("label");
    label.textContent = "Saved wall";
    const select = document.createElement("select");
    select.id = "wall-layout-fullscreen";
    label.append(select);
    select.addEventListener("change", () => {
      try {
        activate(select.value);
      } catch (error) {
        app.notify(error.message);
        quickMenu();
      }
    });
    const controls = document.createElement("div");
    controls.id = "wall-rotation-controls";
    controls.className = "wall-tool-buttons";
    const pause = button("Pause rotation", () => pauseRotation.click());
    pause.id = "wall-rotation-pause";
    controls.append(
      pause,
      button("Next view", () => nextRotation.click()),
    );
    section.append(title, label, controls);
    tools.append(section);
    quickMenu();
    syncRotationControls();
  }
  window.addEventListener("spyder:wall-ready", installFullscreen);
  window.spyderLayouts = { mount, unmount, reflow: reflowWall };
  quickMenu();
  scheduleRotation();
  app.reflow();
})();
