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
    pinned: [],
    autoPriority: false,
    activitySources: ["motion", "cv", "events"],
    activityHold: 10,
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
    if (value.pinned !== undefined) {
      if (
        !Array.isArray(value.pinned) ||
        value.pinned.length > 256 ||
        value.pinned.some(
          (id) => typeof id !== "string" || !/^[\w-]{1,100}$/.test(id),
        )
      )
        throw new Error("Invalid pinned cameras.");
      result.pinned = [...new Set(value.pinned)];
    }
    if (
      value.autoPriority !== undefined &&
      typeof value.autoPriority !== "boolean"
    )
      throw new Error("Invalid activity priority.");
    result.autoPriority = value.autoPriority ?? false;
    if (value.activitySources !== undefined) {
      if (
        !Array.isArray(value.activitySources) ||
        value.activitySources.some(
          (source) => !["motion", "cv", "events"].includes(source),
        )
      )
        throw new Error("Invalid activity sources.");
      result.activitySources = [...new Set(value.activitySources)];
    }
    if (value.activityHold !== undefined) {
      if (
        !Number.isInteger(value.activityHold) ||
        value.activityHold < 3 ||
        value.activityHold > 120
      )
        throw new Error("Activity hold must be 3–120 seconds.");
      result.activityHold = value.activityHold;
    }
    result.hidden = result.hidden.filter((id) => !result.pinned.includes(id));
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
      count = Math.min(count, (config.pinned?.length || 0) + 1);
      columns = Math.min(columns, count || 1);
    }
    if (config.mode === "featured" && count > 1) columns = width < 540 ? 1 : 3;
    let featuredRows = 0;
    if (config.mode === "featured" && columns > 1 && count > 1) {
      const occupied = new Set();
      let cursor = 0;
      for (let index = 0; index < count; index++) {
        const span = index === (config.featuredIndex || 0) ? 2 : 1;
        while (true) {
          const row = Math.floor(cursor / columns),
            col = cursor % columns;
          let free = col + span <= columns;
          for (let y = 0; y < span && free; y++)
            for (let x = 0; x < span; x++)
              if (occupied.has((row + y) * columns + col + x)) free = false;
          if (free) {
            for (let y = 0; y < span; y++)
              for (let x = 0; x < span; x++)
                occupied.add((row + y) * columns + col + x);
            featuredRows = Math.max(featuredRows, row + span);
            cursor += span;
            break;
          }
          cursor++;
        }
      }
    }
    return {
      columns: Math.max(1, columns),
      rows: Math.max(
        1,
        featuredRows,
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
  const policy = window.spyderWallOrder;
  const activityRanks = new policy.ActivityRanks();
  let wallConnected = true;
  let ranks = new Map(),
    reorderDraft = null,
    wallDragging = null;
  let dragTarget = null;
  const registeredCards = new WeakSet();
  const pinButtons = new Map();
  const dockTiles = new Map();
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
    return policy.order(config, cameras, ranks);
  }
  function display(config) {
    return policy.order(
      config,
      all(config),
      reorderDraft ? new Map() : ranks,
      config.mode === "sequence" && !reorderDraft ? rotation : null,
    );
  }
  function applyGeometry(container, config, count, fullscreen) {
    const box = container.getBoundingClientRect();
    let grid = geometry(
      {
        ...config,
        featuredIndex: Math.max(
          0,
          [...container.children]
            .filter((tile) => !tile.hidden)
            .findIndex((tile) => tile.classList.contains("layout-featured")),
        ),
      },
      count,
      box.width || 800,
      box.height || 450,
      fullscreen,
    );
    if (
      (config.mode === "auto" || config.mode === "sequence") &&
      fullscreen &&
      window.spyderWall
    ) {
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
    const config = reorderDraft ? { ...reorderDraft, mode: "grid" } : applied;
    installCardControls(wall);
    for (const [id, element] of dummyElements) {
      if (!config?.dummies.some((d) => d.id === id)) {
        element.remove();
        dummyElements.delete(id);
      }
    }
    $("#density").disabled = !!config;
    $("#density").title = config
      ? "Choose Automatic wall to use tile-size controls."
      : "";
    if (!config) {
      wall.removeAttribute("data-layout-mode");
      wall.removeAttribute("data-layout-fit");
      wall.style.removeProperty("--layout-gap");
      for (const card of wall.querySelectorAll(".camera-card")) {
        card.hidden = false;
        card.classList.remove("layout-featured");
      }
      $("#wall-count").textContent = String(app.cameras().length);
      syncControls();
      syncDock([]);
      return false;
    }
    config.dummies.forEach((camera, index) => {
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
      if (element.parentNode !== wall) wall.append(element);
    });
    installCardControls(wall);
    const visible = display(config);
    const ids = new Set(visible.map((c) => c.id));
    const featured = ids.has(config.featured)
      ? config.featured
      : visible[0]?.id;
    for (const card of wall.querySelectorAll(".camera-card")) {
      card.hidden = !ids.has(card.dataset.id);
      card.classList.toggle(
        "layout-featured",
        config.mode === "featured" &&
          card.dataset.id === featured &&
          visible.length > 1,
      );
      if (
        ids.has(card.dataset.id) &&
        card.dataset.layoutGeneration !== String(layoutGeneration)
      ) {
        card.dataset.fit = config.fit;
        card.dataset.layoutGeneration = String(layoutGeneration);
      }
    }
    const elements = new Map(
      [...wall.children].map((element) => [element.dataset.id, element]),
    );
    let previous = null;
    for (const camera of visible) {
      const element = elements.get(camera.id);
      if (
        element &&
        (previous
          ? previous.nextElementSibling !== element
          : wall.firstElementChild !== element)
      )
        wall.insertBefore(
          element,
          previous ? previous.nextElementSibling : wall.firstElementChild,
        );
      if (element) previous = element;
    }
    applyGeometry(wall, config, visible.length, !!window.spyderWall?.active());
    $("#empty").hidden = app.cameras().length > 0 || visible.length > 0;
    $("#wall-count").textContent = visible.length + " views";
    $("#wall-hint").textContent =
      config.name.toUpperCase() +
      " · " +
      visible.length +
      " VIEWS" +
      (config.dummies.length ? " · INCLUDES SIMULATIONS" : "");
    syncControls();
    syncDock(visible);
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
        if (
          document.hidden ||
          rotationPaused ||
          reorderDraft ||
          $("#control-room").hidden
        )
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
    reorderDraft = null;
    activityRanks.clear();
    ranks = new Map();
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
    applyGeometry(container, draft, shown.length, false);
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
          draft.pinned = [...new Set([...draft.pinned, dragging])];
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
      check.checked = !draft.hidden.includes(id) || draft.pinned.includes(id);
      check.disabled = draft.pinned.includes(id);
      check.title = check.disabled
        ? "Unpin this camera before hiding it."
        : "Show in this wall";
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
          draft.pinned = [...new Set([...draft.pinned, id])];
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
            draft.pinned = draft.pinned.filter((value) => value !== id);
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
          draft.pinned = [
            ...new Set(
              draft.pinned.map((value) => (value === id ? nextId : value)),
            ),
          ];
          if (draft.featured === id) draft.featured = nextId;
          changed();
        });
        row.append(replacement);
      }
      const pin = button(draft.pinned.includes(id) ? "Unpin" : "Pin", () => {
        draft.pinned = draft.pinned.includes(id)
          ? draft.pinned.filter((value) => value !== id)
          : [...draft.pinned, id];
        draft.hidden = draft.hidden.filter((value) => value !== id);
        draft.order = order;
        changed();
      });
      pin.prepend(svgIcon("pin"));
      pin.setAttribute("aria-pressed", String(draft.pinned.includes(id)));
      actions.append(pin);
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
    $("#layout-priority-enabled", root).checked = draft.autoPriority;
    $("#layout-priority-hold", root).value = draft.activityHold;
    for (const source of ["motion", "cv", "events"])
      $("#layout-source-" + source, root).checked =
        draft.activitySources.includes(source);
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
      activityRanks.clear();
      ranks = new Map();
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
    root.innerHTML = `<div class="layout-studio"><section class="workspace-panel layout-editor"><div class="layout-title"><div><p class="eyebrow">WALL DESIGNER</p><h2>Every angle, in its place.</h2></div><span id="layout-count" class="field-help"></span></div><p class="workspace-description">Arrange real feeds and generated dummy cameras. Save named walls, feature an entrance or rotate through your views. Layouts belong to this browser.</p><div class="layout-fields"><label>Saved arrangements<select id="layout-saved"></select></label><label>Name<input id="layout-name" maxlength="80" required /></label></div><div id="layout-preset-actions" class="layout-actions"></div><div class="layout-fields"><label>Arrangement<select id="layout-mode"><option value="auto">Automatic grid</option><option value="grid">Fixed columns</option><option value="featured">Featured camera</option><option value="sequence">Rotating single view</option></select></label><label>Preferred columns<select id="layout-columns"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option></select></label><label>Image fit<select id="layout-fit"><option value="fit">Fit · preserve whole image</option><option value="fill">Fill · crop edges</option></select></label><label>Tile spacing (px)<input id="layout-gap" type="number" min="0" max="32" /></label><label>Rotation interval (seconds)<input id="layout-interval" type="number" min="3" max="120" /></label><label>Featured camera<select id="layout-featured"></select></label></div><fieldset class="layout-priority-settings"><legend>Activity priority</legend><label><input id="layout-priority-enabled" type="checkbox" /> Move active unpinned cameras forward</label><div class="layout-priority-sources"><label><input id="layout-source-motion" type="checkbox" /> Movement / motion regions</label><label><input id="layout-source-cv" type="checkbox" /> CV detections</label><label><input id="layout-source-events" type="checkbox" /> Workflow events / notifications</label></div><label>Keep priority after activity ends (seconds)<input id="layout-priority-hold" type="number" min="3" max="120" /></label><p class="field-help">Pinned cameras keep their slots and override hidden/rotation settings. Activity must be fresh; idle cameras return to manual order after the hold period. Pins also appear in a small dock when you scroll past them.</p></fieldset><div class="layout-preview-heading"><h3>Wall preview</h3><label>Screen shape<select id="layout-viewport"><option value="16 / 9">Desktop · 16:9</option><option value="4 / 3">Monitor · 4:3</option><option value="1 / 1">Square</option><option value="9 / 16">Mobile · portrait</option></select></label></div><div id="layout-preview" class="layout-preview" aria-label="Layout simulation"></div><p class="field-help">Fixed columns adapt on narrow screens. Featured view stacks on mobile. Rotation starts after applying. Hiding a camera changes only the wall; capture, CV and recording keep their own settings.</p><div id="layout-save-actions" class="layout-actions"></div><p id="layout-status" role="status" aria-live="polite"></p></section><aside><section class="workspace-panel"><h2>Camera lineup</h2><p class="field-help">Drag rows to reorder, or use Move up / Move down. Uncheck a camera to hide it from this arrangement.</p><div id="layout-camera-list" class="layout-camera-list"></div></section><section class="workspace-panel"><h2>Simulation cameras</h2><p class="field-help">Generated locally. No permission prompts, camera access, server processing or recordings. Up to 24 per arrangement.</p><div class="layout-fields"><label>Name prefix<input id="dummy-name" value="Demo camera" maxlength="60" /></label><label>Camera shape<select id="dummy-ratio"><option>16:9</option><option>4:3</option><option>1:1</option><option>9:16</option></select></label><label>How many?<input id="dummy-count" type="number" min="1" max="24" value="4" /></label></div><div id="layout-dummy-actions" class="layout-actions"></div><p class="field-help">Save and apply to place dummy cameras in the Control Room. Remove them here or use Automatic wall to return to real cameras.</p></section></aside></div>`;
    savedMenu(activeId);
    fill();
    $("#layout-priority-enabled", root).addEventListener("change", (event) => {
      draft.autoPriority = event.target.checked;
      changed();
    });
    $("#layout-priority-hold", root).addEventListener("change", (event) => {
      draft.activityHold = Number(event.target.value);
      changed();
    });
    for (const source of ["motion", "cv", "events"])
      $("#layout-source-" + source, root).addEventListener(
        "change",
        (event) => {
          draft.activitySources = draft.activitySources.filter(
            (value) => value !== source,
          );
          if (event.target.checked) draft.activitySources.push(source);
          changed();
        },
      );
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
  window.addEventListener("spyder:cameras", (event) => {
    wallConnected = event.detail?.connected !== false;
    if (!wallConnected) {
      activityRanks.clear();
      ranks = new Map();
    } else if (applied?.autoPriority)
      ranks = activityRanks.update(app.cameras(), applied, Date.now());
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
  document.addEventListener("spyder:frame", (event) => {
    const dock = dockTiles.get(event.detail.id);
    if (dock) {
      const image = $("img", dock);
      image.src = event.detail.url;
      image.hidden = false;
    }
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
    const reorder = button("Reorder cameras", beginReorder);
    reorder.id = "fullscreen-reorder";
    const priority = document.createElement("label");
    priority.className = "wall-priority-toggle";
    const toggle = document.createElement("input");
    toggle.id = "fullscreen-activity-priority";
    toggle.type = "checkbox";
    toggle.addEventListener("change", () => {
      priorityToggle.checked = toggle.checked;
      priorityToggle.dispatchEvent(new Event("change"));
    });
    priority.append(toggle, document.createTextNode("Activity first"));
    section.append(title, label, controls, reorder, priority);
    tools.append(section);
    quickMenu();
    syncRotationControls();
  }
  window.addEventListener("spyder:wall-ready", installFullscreen);
  function liveConfig() {
    if (applied) return structuredClone(applied);
    const config = defaults();
    config.name = "Control Room arrangement";
    let suffix = 2;
    while (
      layouts.some(
        (item) => item.config.name.toLowerCase() === config.name.toLowerCase(),
      )
    )
      config.name = "Control Room arrangement " + suffix++;
    config.order = app.cameras().map((camera) => camera.id);
    return config;
  }
  function commitLive(config) {
    const clean = validate(config),
      id = activeId || uid("layout");
    if (!activeId && layouts.length >= 50)
      throw new Error(
        "Delete an unused layout before saving wall preferences.",
      );
    const existing = layouts.find((item) => item.id === id);
    let saved = clean;
    if (existing && applied) {
      saved = structuredClone(existing.config);
      for (const key of Object.keys(clean))
        if (JSON.stringify(clean[key]) !== JSON.stringify(applied[key]))
          saved[key] = structuredClone(clean[key]);
      saved = validate(saved);
    }
    persist(
      [...layouts.filter((item) => item.id !== id), { id, config: saved }],
      id,
      clean,
    );
    layoutGeneration++;
    quickMenu();
    scheduleRotation(false);
    app.reflow();
  }
  function pinCamera(id) {
    const config = reorderDraft || liveConfig();
    if (!reorderDraft)
      config.order = [
        ...new Set([
          ...policy
            .order(config, all(config), ranks)
            .map((camera) => camera.id),
          ...config.order,
        ]),
      ];
    const pinned = config.pinned.includes(id);
    config.pinned = pinned
      ? config.pinned.filter((value) => value !== id)
      : [...config.pinned, id];
    config.hidden = config.hidden.filter((value) => value !== id);
    if (reorderDraft) {
      app.reflow();
      app.notify("Pin change is a draft. Apply order & pins to save.");
    } else {
      commitLive(config);
      app.notify(
        pinned
          ? "Camera unpinned."
          : "Camera pinned in this position. Pinned views stay visible during rotation and in the scroll dock.",
      );
    }
  }
  function beginReorder() {
    app.leaveFocus();
    reorderDraft = liveConfig();
    reorderDraft.order = [
      ...new Set([
        ...policy
          .order(reorderDraft, all(reorderDraft), ranks)
          .map((camera) => camera.id),
        ...reorderDraft.order,
      ]),
    ];
    app.reflow();
    syncControls();
  }
  function cancelReorder() {
    reorderDraft = null;
    wallDragging = null;
    clearDropTarget();
    app.reflow();
    syncControls();
  }
  function applyReorder() {
    try {
      const config = reorderDraft;
      if (!config) return;
      commitLive(config);
      reorderDraft = null;
      wallDragging = null;
      clearDropTarget();
      app.reflow();
      syncControls();
      app.notify("Camera order and pins saved. Moved cameras are pinned.");
    } catch (error) {
      app.notify(error.message);
    }
  }
  function moveCamera(id, targetId, after = false) {
    if (!reorderDraft) return;
    reorderDraft = policy.moveAndPin(reorderDraft, id, targetId, after);
    app.reflow();
  }
  function svgIcon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(svg.namespaceURI, "use");
    use.setAttribute("href", "/icons.svg#" + name);
    svg.append(use);
    return svg;
  }
  function clearDropTarget() {
    if (dragTarget) {
      dragTarget.removeAttribute("data-drop-side");
      dragTarget = null;
    }
  }
  function dropPosition(target, event) {
    const box = target.getBoundingClientRect();
    return event.clientX > box.left + box.width / 2;
  }
  function installCardControls(wall) {
    const present = new Set();
    for (const card of wall.querySelectorAll(".camera-card")) {
      const id = card.dataset.id;
      present.add(id);
      card.querySelector(".camera-image")?.setAttribute("draggable", "false");
      if (registeredCards.has(card)) continue;
      registeredCards.add(card);
      const tools = document.createElement("div");
      tools.className = "tile-priority-tools";
      const pin = button("", () => pinCamera(id));
      pin.className = "tile-pin icon-button";
      pin.append(svgIcon("pin"));
      tools.append(pin);
      pinButtons.set(id, { card, pin });
      const handle = button("", () => {});
      handle.className = "tile-drag-handle icon-button";
      handle.dataset.dragHandle = "true";
      handle.append(svgIcon("reorder"));
      handle.setAttribute("aria-label", "Drag this camera to reorder");
      tools.append(handle);
      for (const [delta, label, glyph] of [
        [-1, "Move camera earlier", "arrow-left"],
        [1, "Move camera later", "arrow-right"],
      ]) {
        const move = button("", () => {
          if (!reorderDraft) return;
          const ids = policy
            .baseOrder(reorderDraft, all(reorderDraft))
            .map((camera) => camera.id);
          const index = ids.indexOf(id);
          const target = ids[index + delta];
          if (target) moveCamera(id, target, delta > 0);
          move.focus();
        });
        move.className = "tile-order-step icon-button";
        move.setAttribute("aria-label", label);
        move.append(svgIcon(glyph));
        tools.append(move);
      }
      card.querySelector(".video-stage").append(tools);
      card.addEventListener("dragstart", (event) => {
        if (
          !reorderDraft ||
          (event.target.closest("button,input,select,a") &&
            !event.target.closest("[data-drag-handle]"))
        ) {
          event.preventDefault();
          return;
        }
        wallDragging = id;
        event.dataTransfer.setData("text/plain", id);
        event.dataTransfer.effectAllowed = "move";
        card.classList.add("is-dragging");
      });
      card.addEventListener("dragover", (event) => {
        if (!reorderDraft || !wallDragging || wallDragging === id) return;
        event.preventDefault();
        clearDropTarget();
        dragTarget = card;
        card.dataset.dropSide = dropPosition(card, event) ? "after" : "before";
        event.dataTransfer.dropEffect = "move";
      });
      card.addEventListener("drop", (event) => {
        if (!wallDragging || !reorderDraft) return;
        event.preventDefault();
        moveCamera(wallDragging, id, dropPosition(card, event));
        wallDragging = null;
        clearDropTarget();
      });
      card.addEventListener("dragend", () => {
        wallDragging = null;
        clearDropTarget();
        card.classList.remove("is-dragging");
      });
      let pointer = null;
      handle.addEventListener("pointerdown", (event) => {
        if (!reorderDraft || event.pointerType === "mouse") return;
        pointer = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          moved: false,
        };
        handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener("pointermove", (event) => {
        if (!pointer || pointer.id !== event.pointerId) return;
        if (
          Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) <
            8 &&
          !pointer.moved
        )
          return;
        pointer.moved = true;
        const target = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest("#cameras>.camera-card");
        clearDropTarget();
        if (target && target !== card) {
          dragTarget = target;
          target.dataset.dropSide = dropPosition(target, event)
            ? "after"
            : "before";
        }
        if (!window.spyderWall?.active()) {
          if (event.clientY < 100) window.scrollBy(0, -20);
          else if (event.clientY > innerHeight - 70) window.scrollBy(0, 20);
        }
      });
      handle.addEventListener("pointerup", (event) => {
        if (pointer?.id !== event.pointerId) return;
        if (pointer.moved && dragTarget)
          moveCamera(
            id,
            dragTarget.dataset.id,
            dropPosition(dragTarget, event),
          );
        pointer = null;
        clearDropTarget();
      });
      handle.addEventListener("pointercancel", () => {
        pointer = null;
        clearDropTarget();
      });
    }
    for (const [id, entry] of pinButtons)
      if (!present.has(id)) {
        pinObserver?.unobserve(entry.card);
        pinButtons.delete(id);
      }
  }
  function syncControls() {
    const config = reorderDraft || applied;
    document.body.classList.toggle("wall-reordering", !!reorderDraft);
    reorderBanner.hidden = !reorderDraft;
    reorderButton.disabled = !!reorderDraft;
    priorityToggle.checked = !!config?.autoPriority;
    priorityToggle.disabled = !!reorderDraft;
    for (const [id, { card, pin }] of pinButtons) {
      const pinned = !!config?.pinned.includes(id);
      card.dataset.pinned = String(pinned);
      card.draggable = !!reorderDraft;
      pin.setAttribute("aria-pressed", String(pinned));
      pin.setAttribute(
        "aria-label",
        (pinned ? "Unpin " : "Pin ") +
          (card.querySelector(".camera-name")?.textContent ||
            config?.dummies.find((camera) => camera.id === id)?.name ||
            id),
      );
      pin.title = pinned ? "Unpin camera" : "Pin camera in this position";
      card.dataset.prioritized = String(
        !!config?.autoPriority && ranks.has(id) && !pinned,
      );
    }
    $("#fullscreen-reorder")?.setAttribute(
      "aria-pressed",
      String(!!reorderDraft),
    );
    const check = $("#fullscreen-activity-priority");
    if (check) {
      check.checked = priorityToggle.checked;
      check.disabled = priorityToggle.disabled;
    }
    updateDockVisibility();
  }
  function syncDock(visible) {
    const config = reorderDraft || applied;
    const pins = new Set(config?.pinned || []);
    const cameras = visible.filter((camera) => pins.has(camera.id));
    const current = new Set(cameras.map((camera) => camera.id));
    for (const [id, tile] of dockTiles)
      if (!current.has(id)) {
        tile.remove();
        dockTiles.delete(id);
        pinVisible.delete(id);
        const card = pinButtons.get(id)?.card;
        if (card) pinObserver?.unobserve(card);
      }
    for (const camera of cameras) {
      let tile = dockTiles.get(camera.id);
      if (!tile) {
        tile = button("", () => {
          pinButtons.get(camera.id)?.card.scrollIntoView({
            block: "center",
            behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
              .matches
              ? "instant"
              : "smooth",
          });
        });
        tile.className = "pinned-dock-tile";
        const image = document.createElement("img");
        image.alt = "";
        image.draggable = false;
        const label = document.createElement("span");
        tile.append(image, label);
        dockTiles.set(camera.id, tile);
        dockGrid.append(tile);
        const card = pinButtons.get(camera.id)?.card;
        if (card) pinObserver?.observe(card);
      }
      tile.setAttribute("aria-label", "Show pinned camera " + camera.name);
      $("span", tile).textContent =
        camera.name +
        (camera.dummy
          ? " · DUMMY"
          : camera.state === "running"
            ? ""
            : " · " + camera.state.toUpperCase());
      let url = camera.dummy
        ? pinButtons
            .get(camera.id)
            ?.card.querySelector(".camera-image")
            ?.getAttribute("src")
        : app.frame(camera.id);
      if (
        pinButtons.get(camera.id)?.card.querySelector(".camera-image")?.hidden
      )
        url = null;
      const image = $("img", tile);
      if (url && image.getAttribute("src") !== url) {
        image.src = url;
        image.hidden = false;
      } else if (!url) {
        image.removeAttribute("src");
        image.hidden = true;
      }
    }
    dockGrid.style.setProperty(
      "--dock-columns",
      Math.max(
        1,
        Math.min(cameras.length, Math.ceil(Math.sqrt(cameras.length * 3.5))),
      ),
    );
    updateDockVisibility();
  }
  function updateDockVisibility() {
    pinDock.hidden =
      !dockTiles.size ||
      !!reorderDraft ||
      !!window.spyderWall?.active() ||
      document.hidden ||
      $("#control-room").hidden ||
      document.body.classList.contains("has-focus") ||
      ![...dockTiles.keys()].some((id) => pinVisible.get(id) === false);
  }
  const pinVisible = new Map();
  const pinObserver =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries)
              pinVisible.set(
                entry.target.dataset.id,
                entry.isIntersecting && entry.intersectionRatio >= 0.65,
              );
            updateDockVisibility();
          },
          { threshold: [0, 0.65], rootMargin: "-70px 0px -10px 0px" },
        )
      : null;
  const pinDock = document.createElement("section");
  pinDock.className = "pinned-dock";
  pinDock.hidden = true;
  pinDock.setAttribute("aria-label", "Pinned camera views");
  const dockTitle = document.createElement("strong");
  dockTitle.textContent = "Pinned views";
  const dockGrid = document.createElement("div");
  dockGrid.className = "pinned-dock-grid";
  pinDock.append(dockTitle, dockGrid);
  document.body.append(pinDock);
  const reorderBanner = document.createElement("section");
  reorderBanner.className = "wall-reorder-banner";
  reorderBanner.hidden = true;
  reorderBanner.setAttribute("aria-label", "Reorder camera wall");
  const reorderHint = document.createElement("span");
  reorderHint.textContent =
    "Drag tiles or use their arrow buttons. Moved cameras will be pinned. Activity movement is paused.";
  reorderBanner.append(
    reorderHint,
    button("Apply order & pins", applyReorder, true),
    button("Cancel", cancelReorder),
  );
  document.body.append(reorderBanner);
  const reorderButton = button("Reorder cameras", beginReorder);
  reorderButton.id = "wall-reorder";
  reorderButton.prepend(svgIcon("reorder"));
  $(".wall-controls").append(reorderButton);
  const priorityLabel = document.createElement("label");
  priorityLabel.className = "wall-priority-toggle";
  const priorityToggle = document.createElement("input");
  priorityToggle.type = "checkbox";
  priorityToggle.id = "wall-activity-priority";
  priorityLabel.append(
    priorityToggle,
    document.createTextNode("Activity first"),
  );
  $(".wall-controls").append(priorityLabel);
  priorityToggle.addEventListener("change", () => {
    try {
      const config = liveConfig();
      config.autoPriority = priorityToggle.checked;
      commitLive(config);
      app.notify(
        config.autoPriority
          ? "Activity priority enabled. Pinned slots stay fixed."
          : "Activity priority disabled. Manual camera order restored.",
      );
    } catch (error) {
      app.notify(error.message);
      syncControls();
    }
  });
  const activityFeed = new policy.ActivityFeed();
  window.addEventListener("spyder:activity-snapshot", (event) => {
    const fresh = activityFeed.accept(
      event.detail,
      Date.now(),
      (applied?.activityHold || 10) * 1000,
    );
    if (
      !wallConnected ||
      !applied?.autoPriority ||
      !applied.activitySources.includes("events")
    )
      return;
    for (const item of fresh)
      activityRanks.event(item.camera_id, item.created_at * 1000);
    if (fresh.length) {
      ranks = activityRanks.update(app.cameras(), applied, Date.now());
      app.reflow();
    }
  });
  window.addEventListener(
    "scroll",
    () => {
      if (!pinObserver) {
        for (const [id, { card }] of pinButtons) {
          const box = card.getBoundingClientRect();
          pinVisible.set(id, box.top >= 70 && box.bottom <= innerHeight);
        }
        updateDockVisibility();
      }
    },
    { passive: true },
  );
  window.addEventListener("hashchange", () => {
    if (reorderDraft && !["", "#control-room"].includes(location.hash))
      cancelReorder();
    updateDockVisibility();
  });
  document.addEventListener("visibilitychange", updateDockVisibility);

  window.spyderLayouts = { mount, unmount, reflow: reflowWall };
  quickMenu();
  scheduleRotation();
  app.reflow();
})();
