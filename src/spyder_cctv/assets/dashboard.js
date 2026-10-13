"use strict";
const $ = (selector, root = document) => root.querySelector(selector);
const wall = $("#cameras");
const cards = new Map();
const pending = new Set();
let cameras = [];
let connected = false;
let focused = null;
let focusReturn = null;
let removing = null;
let refreshing = false;
let bulkPending = false;
const stateLabels = {
  running: "LIVE",
  starting: "CONNECTING",
  stopped: "PAUSED",
  stopping: "STOPPING",
  error: "OFFLINE",
};
const addDialog = $("#add-dialog");
const removeDialog = $("#remove-dialog");

function readPreference(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function savePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage may be disabled. */
  }
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const next = theme === "light" ? "dark" : "light";
  $("#theme").setAttribute("aria-label", "Switch to " + next + " mode");
  $("#theme").title = "Switch to " + next + " mode";
}
setTheme(readPreference("spyder-theme", "light") === "dark" ? "dark" : "light");
$("#theme").addEventListener("click", () => {
  const theme =
    document.documentElement.dataset.theme === "light" ? "dark" : "light";
  setTheme(theme);
  savePreference("spyder-theme", theme);
});
$("#density").value = readPreference("spyder-density", "auto");
if (!$("#density").value) $("#density").value = "auto";
function reflow() {
  const count = Math.max(1, cards.size);
  const minimum = { auto: 330, compact: 260, large: 520 }[$("#density").value];
  const available = Math.max(
    1,
    Math.floor((wall.clientWidth + 20) / (minimum + 20)),
  );
  const rows = Math.ceil(count / available);
  const columns = Math.max(1, Math.ceil(count / rows));
  wall.style.setProperty("--columns", columns);
  wall.dataset.density = $("#density").value;
}
new ResizeObserver(reflow).observe(wall);
$("#density").addEventListener("change", () => {
  savePreference("spyder-density", $("#density").value);
  reflow();
});
function notify(text) {
  const message = $("#message");
  message.textContent = text;
  message.hidden = !text;
}
async function api(path, data) {
  if (window.spyderShowcase)
    return window.spyderShowcase.request(path, data || {});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "X-Spyder-Control": "1", "Content-Type": "application/json" },
      body: JSON.stringify(data || {}),
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The request failed.");
    return result;
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error(
        "The camera server took too long. Check its status before retrying.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function control(id, action) {
  if (pending.has(id)) return;
  pending.add(id);
  render();
  try {
    await api("/api/cameras/" + id + "/" + action);
    notify("");
  } catch (error) {
    notify(error.message);
  } finally {
    pending.delete(id);
    await refresh();
  }
}
async function controlAll(action) {
  if (bulkPending) return;
  bulkPending = true;
  $("#start-all").disabled = $("#stop-all").disabled = true;
  const selected = cameras.filter((camera) =>
    action === "stop"
      ? ["running", "starting", "stopping"].includes(camera.state)
      : ["stopped", "error"].includes(camera.state),
  );
  const outcomes = await Promise.allSettled(
    selected.map((camera) => api("/api/cameras/" + camera.id + "/" + action)),
  );
  const failures = outcomes.filter((result) => result.status === "rejected");
  notify(
    failures.length
      ? failures.length +
          " camera control request(s) failed. " +
          failures[0].reason.message
      : "",
  );
  bulkPending = false;
  await refresh();
}
$("#start-all").addEventListener("click", () => controlAll("start"));
$("#stop-all").addEventListener("click", () => controlAll("stop"));

function leaveFocus() {
  if (focused) cards.get(focused)?.element.classList.remove("is-focused");
  focused = null;
  document.body.classList.remove("has-focus");
  $("#focus-toolbar").hidden = true;
  for (const element of document.querySelectorAll(
    ".topbar,.rail,.page-heading,.overview,.wall-toolbar,.wall-footer",
  ))
    element.inert = false;
  for (const card of cards.values()) card.element.inert = false;
  focusReturn?.focus();
  focusReturn = null;
}
function focusCamera(id, button) {
  if (focused === id) {
    leaveFocus();
    return;
  }
  leaveFocus();
  focused = id;
  focusReturn = button;
  const card = cards.get(id);
  card.element.classList.add("is-focused");
  document.body.classList.add("has-focus");
  $("#focus-toolbar").hidden = false;
  for (const element of document.querySelectorAll(
    ".topbar,.rail,.page-heading,.overview,.wall-toolbar,.wall-footer",
  ))
    element.inert = true;
  for (const [key, other] of cards) other.element.inert = key !== id;
  $("#leave-focus").focus();
}
$("#leave-focus").addEventListener("click", leaveFocus);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && focused) {
    event.preventDefault();
    leaveFocus();
  }
});
function askRemove(id) {
  removing = id;
  $("#remove-description").textContent =
    "Remove “" +
    cameras.find((camera) => camera.id === id).name +
    "” from your workspace?";
  removeDialog.showModal();
}
for (const button of document.querySelectorAll(".close-remove"))
  button.addEventListener("click", () => removeDialog.close());
$("#confirm-remove").addEventListener("click", async () => {
  const button = $("#confirm-remove");
  button.disabled = true;
  try {
    await api("/api/cameras/" + removing + "/remove");
    if (focused === removing) leaveFocus();
    removeDialog.close();
    notify(
      window.spyderShowcase
        ? "Camera removed from this tab."
        : "Camera removed. Your workspace is saved.",
    );
    await refresh();
  } catch (error) {
    removeDialog.close();
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});

function sourceTypeChanged() {
  if (window.spyderShowcase) return window.spyderShowcase.configureSource();
  const type = $("#source-type").value;
  const input = $("#camera-source");
  input.value = type === "webcam" ? "0" : "";
  input.type =
    type === "webcam" ? "number" : type === "network" ? "url" : "text";
  input.placeholder =
    type === "network"
      ? "rtsp://camera-address/stream"
      : type === "file"
        ? "C:/Videos/entrance.mp4"
        : "";
  input.autocomplete = "off";
  $("#source-label").textContent = {
    webcam: "Device index",
    network: "Stream URL",
    file: "Video file path",
  }[type];
  $("#source-help").textContent = {
    webcam:
      "First webcam is 0, second is 1. Each source can be connected once.",
    network:
      "Use an RTSP, RTSPS, HTTP or HTTPS stream. Credentials are kept in your local configuration.",
    file: "Use an absolute path, or a path relative to your configuration folder. Playback stops at the end.",
  }[type];
}
$("#source-type").addEventListener("change", sourceTypeChanged);
function openAdd() {
  $("#add-form").reset();
  sourceTypeChanged();
  const used = new Set(cameras.map((camera) => camera.source_label));
  let device = 0;
  while (used.has("Webcam " + device)) device++;
  if (!window.spyderShowcase) $("#camera-source").value = device;
  $("#form-error").hidden = true;
  addDialog.showModal();
}
$("#add-camera").addEventListener("click", openAdd);
$("#empty-add").addEventListener("click", openAdd);
for (const button of document.querySelectorAll(".close-dialog"))
  button.addEventListener("click", () => addDialog.close());
$("#add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#camera-name").value.trim();
  const type = $("#source-type").value;
  const value = $("#camera-source").value.trim();
  const error = $("#form-error");
  error.hidden = true;
  if (!name) {
    error.textContent = "Give this camera a name.";
    error.hidden = false;
    return;
  }
  if (type === "network" && !/^(rtsp|rtsps|http|https):\/\/.+/i.test(value)) {
    error.textContent = "Use an RTSP, RTSPS, HTTP or HTTPS stream URL.";
    error.hidden = false;
    return;
  }
  const button = $("#connect-camera");
  button.disabled = true;
  try {
    const result = await api("/api/cameras", {
      name,
      source: window.spyderShowcase
        ? window.spyderShowcase.readSource()
        : type === "webcam"
          ? Number(value)
          : value,
      fps: Number($("#camera-fps").value),
      pipeline: $("#camera-pipeline").value,
      autostart: $("#camera-autostart").checked,
    });
    addDialog.close();
    notify(
      "“" +
        result.name +
        (window.spyderShowcase
          ? "” added to this tab’s workspace."
          : "” added. Your camera list is saved automatically."),
    );
    await refresh();
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

function createCard(camera) {
  const element =
    $("#camera-template").content.firstElementChild.cloneNode(true);
  element.dataset.id = camera.id;
  element.dataset.fit = "fit";
  const card = {
    element,
    camera,
    timer: null,
    controller: null,
    url: null,
    loading: false,
    lastFrame: null,
  };
  $(".toggle-camera", element).addEventListener("click", () =>
    control(
      camera.id,
      ["running", "starting"].includes(card.camera.state) ? "stop" : "start",
    ),
  );
  $(".remove-camera", element).addEventListener("click", () =>
    askRemove(camera.id),
  );
  $(".settings-camera", element).addEventListener("click", () => {
    document.dispatchEvent(
      new CustomEvent("spyder:camera-settings", { detail: { id: camera.id } }),
    );
  });
  $(".video-focus", element).addEventListener("click", (event) =>
    focusCamera(camera.id, event.currentTarget),
  );
  $(".fit-button", element).addEventListener("click", (event) => {
    const fill = element.dataset.fit !== "fill";
    element.dataset.fit = fill ? "fill" : "fit";
    event.currentTarget.textContent = fill ? "Fill" : "Fit";
    event.currentTarget.setAttribute("aria-pressed", String(fill));
  });
  $(".camera-image", element).addEventListener("load", () => {
    if (card.camera.state === "running" && card.url && connected) {
      $(".camera-image", element).hidden = false;
      $(".video-placeholder", element).hidden = true;
    }
  });
  cards.set(camera.id, card);
  wall.append(element);
  return card;
}
function stopFrame(card) {
  clearTimeout(card.timer);
  card.timer = null;
  card.controller?.abort();
  card.controller = null;
  if (card.url) URL.revokeObjectURL(card.url);
  card.url = null;
  card.lastFrame = null;
  const image = $(".camera-image", card.element);
  image.hidden = true;
  image.removeAttribute("src");
  $(".video-placeholder", card.element).hidden = false;
}
async function loadFrame(card) {
  card.timer = null;
  if (
    card.loading ||
    !connected ||
    document.hidden ||
    card.camera.state !== "running" ||
    !cards.has(card.camera.id)
  )
    return;
  if (focused && focused !== card.camera.id) {
    card.timer = setTimeout(() => loadFrame(card), 500);
    return;
  }
  card.loading = true;
  const controller = new AbortController();
  card.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await (window.spyderShowcase?.fetch || fetch)(
      "/api/cameras/" + card.camera.id + "/frame",
      {
        cache: "no-store",
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error("Frame unavailable");
    const blob = await response.blob();
    if (
      card.camera.state !== "running" ||
      !connected ||
      !cards.has(card.camera.id)
    )
      return;
    const url = URL.createObjectURL(blob);
    const old = card.url;
    card.url = url;
    card.lastFrame = Date.now();
    $(".camera-image", card.element).src = url;
    document.dispatchEvent(
      new CustomEvent("spyder:frame", { detail: { id: card.camera.id, url } }),
    );
    if (old) URL.revokeObjectURL(old);
  } catch {
    if (card.lastFrame && Date.now() - card.lastFrame > 3000) {
      $(".camera-image", card.element).hidden = true;
      $(".video-placeholder", card.element).hidden = false;
      $(".video-placeholder strong", card.element).textContent =
        "Waiting for a fresh frame";
    }
  } finally {
    clearTimeout(timeout);
    if (card.controller === controller) card.controller = null;
    card.loading = false;
    if (
      cards.has(card.camera.id) &&
      connected &&
      card.camera.state === "running"
    ) {
      // Limit aggregate preview load as the number of cameras grows; never overlap frame requests.
      const interval = Math.max(120, Math.min(1000, cards.size * 45));
      card.timer = setTimeout(() => loadFrame(card), interval);
    }
  }
}
function render() {
  const present = new Set(cameras.map((camera) => camera.id));
  for (const [id, card] of cards)
    if (!present.has(id)) {
      if (focused === id) leaveFocus();
      stopFrame(card);
      card.element.remove();
      cards.delete(id);
    }
  cameras.forEach((camera, index) => {
    const card = cards.get(camera.id) || createCard(camera);
    card.camera = camera;
    const element = card.element;
    element.dataset.state = connected ? camera.state : "disconnected";
    $(".camera-number", element).textContent = String(index + 1).padStart(
      2,
      "0",
    );
    $(".camera-name", element).textContent = camera.name;
    $(".camera-name", element).title = camera.name;
    $(".camera-source", element).textContent =
      camera.source_label + " · " + camera.fps + " FPS cap";
    $(".camera-state span", element).textContent = connected
      ? stateLabels[camera.state] || camera.state
      : "DISCONNECTED";
    $(".camera-image", element).alt = "Live camera: " + camera.name;
    $(".video-caption", element).textContent = camera.name;
    $(".video-focus", element).setAttribute(
      "aria-label",
      "Focus " + camera.name,
    );
    $(".remove-camera", element).setAttribute(
      "aria-label",
      "Remove " + camera.name,
    );
    const toggle = $(".toggle-camera", element);
    toggle.textContent =
      camera.state === "error"
        ? "Retry"
        : ["running", "starting"].includes(camera.state)
          ? "Pause"
          : "Start";
    toggle.setAttribute("aria-label", toggle.textContent + " " + camera.name);
    toggle.disabled =
      !connected || pending.has(camera.id) || camera.state === "stopping";
    $(".remove-camera", element).disabled =
      !connected || pending.has(camera.id);
    $(".settings-camera", element).disabled = !connected;
    $(".settings-camera", element).setAttribute(
      "aria-label",
      "Settings for " + camera.name,
    );
    const profileLabel =
      camera.profile_name ||
      (camera.profile_id ? "Saved profile" : "Custom settings");
    $(".camera-profile", element).textContent =
      profileLabel +
      (["pending", "scheduled", "partial"].includes(camera.settings_state)
        ? " · " + camera.settings_state
        : "");
    $(".camera-profile", element).title = $(
      ".camera-profile",
      element,
    ).textContent;
    const fraction = camera.metadata.motion_fraction || 0;
    element.dataset.motion =
      connected && fraction > 0.02 && camera.state === "running"
        ? "active"
        : "quiet";
    $(".motion-reading span", element).textContent = !connected
      ? "Preview unavailable"
      : camera.state === "running"
        ? camera.pipeline === "motion"
          ? (fraction > 0.02 ? "Motion " : "Quiet scene · ") +
            (fraction * 100).toFixed(1) +
            "%"
          : "Video only"
        : camera.state === "error"
          ? "Connection needs attention"
          : "Not streaming";
    $(".video-placeholder strong", element).textContent = !connected
      ? "Server disconnected"
      : {
          stopped: "Your camera is paused",
          starting: "Connecting your camera…",
          stopping: "Stopping the feed…",
          error: "Camera unavailable",
          running: "Waiting for your first frame…",
        }[camera.state];
    $(".video-placeholder p", element).textContent = !connected
      ? "Start the application to bring your workspace back online."
      : camera.state === "error"
        ? "Check the device, stream address or camera permissions. Then retry."
        : camera.state === "stopped"
          ? "Press Start to bring this view online."
          : "Each camera connects independently.";
    if (camera.state === "running" && connected) {
      if (!card.loading && !card.timer) loadFrame(card);
    } else {
      stopFrame(card);
    }
  });
  const live = cameras.filter((camera) => camera.state === "running").length;
  const attention = cameras.filter((camera) => camera.state === "error").length;
  $("#total-count").textContent = String(cameras.length).padStart(2, "0");
  $("#live-count").textContent = String(connected ? live : 0).padStart(2, "0");
  $("#attention-count").textContent = connected
    ? String(attention).padStart(2, "0")
    : "—";
  $("#attention-note").textContent = !connected
    ? "Server disconnected"
    : attention
      ? "Check offline cameras below"
      : "All systems clear";
  $("#wall-count").textContent = $("#rail-count").textContent = cameras.length;
  $("#empty").hidden = cameras.length > 0;
  $("#wall-hint").textContent = cameras.length
    ? "AUTO LAYOUT · " +
      cameras.length +
      " VIEW" +
      (cameras.length === 1 ? "" : "S")
    : "Add cameras to begin";
  $("#start-all").disabled =
    bulkPending ||
    !connected ||
    !cameras.some((camera) => ["stopped", "error"].includes(camera.state));
  $("#stop-all").disabled =
    bulkPending ||
    !connected ||
    !cameras.some((camera) => ["running", "starting"].includes(camera.state));
  $("#add-camera").disabled = $("#empty-add").disabled = !connected;
  $("#open-profiles").disabled = !connected;
  $("#connection").textContent = connected
    ? window.spyderShowcase
      ? "Browser workspace ready"
      : "Local server online"
    : "Server disconnected";
  reflow();
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await (window.spyderShowcase?.fetch || fetch)(
      "/api/cameras",
      {
        cache: "no-store",
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error("Status unavailable");
    cameras = await response.json();
    if (!connected) notify("");
    connected = true;
  } catch {
    connected = false;
    notify(
      "Connection lost. Camera previews are paused until the local server returns.",
    );
  } finally {
    clearTimeout(timeout);
    refreshing = false;
    render();
  }
}
async function poll() {
  await refresh();
  setTimeout(poll, document.hidden ? 3000 : 750);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refresh();
    for (const card of cards.values())
      if (!card.timer && !card.loading) loadFrame(card);
  } else {
    for (const card of cards.values()) {
      clearTimeout(card.timer);
      card.timer = null;
      card.controller?.abort();
    }
  }
});
function clock() {
  const now = new Date();
  $("#clock").textContent =
    now.toLocaleDateString(undefined, { month: "short", day: "2-digit" }) +
    " / " +
    now.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  $("#clock").dateTime = now.toISOString();
}
clock();
setInterval(clock, 10000);
window.spyder = {
  request: api,
  refresh,
  notify,
  cameras: () => cameras,
  frame: (id) => cards.get(id)?.url,
};
poll();
