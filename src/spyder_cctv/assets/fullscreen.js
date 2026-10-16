/* One live wall; no duplicate capture or recording owners. */
(() => {
  "use strict";
  function layout(count, width, height, aspects = []) {
    count = Math.max(1, Math.floor(count || 1));
    width = Number.isFinite(width) ? Math.max(1, width) : 1;
    height = Number.isFinite(height) ? Math.max(1, height) : 1;
    const ratios = Array.from({ length: count }, (_, i) =>
      Number.isFinite(aspects[i]) && aspects[i] > 0 ? aspects[i] : 16 / 9,
    );
    // Fill rows horizontally on landscape and nearly square monitors. Portrait
    // screens remain free to stack feeds instead of making them unreadably thin.
    const horizontalFirst = width >= height * 0.9;
    let best = { columns: 1, rows: count };
    let score = -1;
    for (let columns = 1; columns <= count; columns++) {
      const rows = Math.ceil(count / columns);
      if (horizontalFirst && columns < rows) continue;
      const w = Math.max(1, (width - 6 * (columns - 1)) / columns);
      const h = Math.max(1, (height - 6 * (rows - 1)) / rows);
      const fitted = ratios.reduce(
        (sum, ratio) => sum + Math.min(w, h * ratio) ** 2 / ratio,
        0,
      );
      if (
        fitted > score + 0.00001 ||
        (Math.abs(fitted - score) < 0.00001 && rows < best.rows)
      ) {
        best = { columns, rows };
        score = fitted;
      }
    }
    return best;
  }
  if (typeof module !== "undefined") module.exports = { layout };
  if (typeof window === "undefined") return;
  const app = window.spyder;
  const find = (s) => document.querySelector(s);
  let active = false;
  let ownsFullscreen = false;
  let generation = 0;
  let noticeTimer;
  const entry = find("#fullscreen-wall");
  const chrome = document.createElement("div");
  chrome.id = "wall-chrome";
  chrome.hidden = true;
  chrome.innerHTML =
    '<button id="wall-nav-tab" class="wall-edge-tab left" aria-label="Open workspace navigation" aria-controls="wall-nav-panel" aria-expanded="false">Workspaces</button><aside id="wall-nav-panel" class="wall-drawer left" aria-label="Fullscreen workspaces" hidden><div class="wall-drawer-heading"><h2>Workspaces</h2><button class="icon-button" data-close="nav" aria-label="Close workspace navigation">×</button></div><nav id="wall-workspaces" aria-label="Fullscreen workspace navigation"></nav><button id="wall-exit" class="button secondary">Exit fullscreen wall</button></aside><button id="wall-tools-tab" class="wall-edge-tab right" aria-label="Open live view tools" aria-controls="wall-tools-panel" aria-expanded="false">Live tools</button><aside id="wall-tools-panel" class="wall-drawer right" aria-label="Live view tools" hidden><div class="wall-drawer-heading"><h2>Live tools</h2><button class="icon-button" data-close="tools" aria-label="Close live tools">×</button></div><p id="wall-live-summary" role="status"></p><section><h3>Live views</h3><div class="wall-tool-buttons"><button id="wall-start" class="button secondary">Start all</button><button id="wall-pause" class="button secondary">Pause unrecorded</button><button id="wall-fit" class="button secondary">Fit all feeds</button><button id="wall-fill" class="button secondary">Fill all tiles</button></div></section><section><h3>Camera settings</h3><label for="wall-camera-choice">Camera</label><select id="wall-camera-choice"></select><button id="wall-camera-settings" class="button secondary">Settings &amp; profiles</button><button id="wall-add" class="button secondary">Add camera</button></section><section><h3>Recording &amp; capture</h3><p id="wall-record-summary" role="status"></p><div class="wall-tool-buttons"><button id="wall-record" class="button primary">Record live feeds</button><button id="wall-stop-record" class="button secondary">Stop &amp; save</button><button id="wall-capture" class="button secondary">Capture live feeds</button></div></section><section><h3>Preferences</h3><button id="wall-theme" class="button secondary">Switch theme</button><label class="wall-idle"><input type="checkbox" id="wall-idle">Pause cameras when unfocused</label><p class="field-help">Hover a tile for controls. Tab reveals keyboard controls. Esc exits fullscreen.</p></section></aside><p id="wall-notice" class="message" role="status" hidden></p>';
  document.body.append(chrome);
  for (const button of chrome.querySelectorAll("[data-close]")) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(svg.namespaceURI, "use");
    use.setAttribute("href", "/icons.svg#close");
    svg.append(use);
    button.replaceChildren(svg);
  }
  for (const link of find("#workspace-nav").querySelectorAll("a")) {
    const copy = link.cloneNode(true);
    copy.querySelector("#rail-count")?.remove();
    copy.removeAttribute("aria-current");
    if (copy.dataset.workspace === "control-room")
      copy.setAttribute("aria-current", "page");
    copy.className = "workspace-link";
    copy.addEventListener("click", () => {
      panel("nav", false);
      if (copy.dataset.workspace !== "control-room") exit();
    });
    find("#wall-workspaces").append(copy);
  }
  const panelAnimations = new Map();
  function panel(name, open, restore = true) {
    const tab = find("#wall-" + name + "-tab");
    const drawer = find("#wall-" + name + "-panel");
    const previous = panelAnimations.get(drawer);
    const wasHidden = drawer.hidden;
    const style = getComputedStyle(drawer);
    const offset = name === "nav" ? "-20px" : "20px";
    const from = wasHidden
      ? { opacity: 0, transform: `translateX(${offset})` }
      : { opacity: style.opacity, transform: style.transform };
    previous?.cancel();
    panelAnimations.delete(drawer);
    if (!open && restore && drawer.contains(document.activeElement))
      tab.focus();
    tab.setAttribute("aria-expanded", String(open));
    drawer.inert = !open;
    drawer.setAttribute("aria-hidden", String(!open));
    if (
      !active ||
      (!open && wasHidden) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !drawer.animate
    ) {
      drawer.hidden = !open;
    } else {
      drawer.hidden = false;
      const animation = drawer.animate(
        [
          from,
          open
            ? { opacity: 1, transform: "translateX(0)" }
            : { opacity: 0, transform: `translateX(${offset})` },
        ],
        {
          duration: open ? 240 : 180,
          easing: "cubic-bezier(.22, 1, .36, 1)",
          fill: "both",
        },
      );
      panelAnimations.set(drawer, animation);
      animation.finished
        .then(() => {
          if (panelAnimations.get(drawer) !== animation) return;
          drawer.hidden = !open;
          panelAnimations.delete(drawer);
          animation.cancel();
        })
        .catch(() => {});
    }
    if (open) {
      panel(name === "nav" ? "tools" : "nav", false, false);
      drawer.querySelector("button").focus();
    }
  }
  for (const name of ["nav", "tools"]) {
    find("#wall-" + name + "-tab").addEventListener("click", () =>
      panel(
        name,
        find("#wall-" + name + "-tab").getAttribute("aria-expanded") !== "true",
      ),
    );
    chrome
      .querySelector('[data-close="' + name + '"]')
      .addEventListener("click", () => panel(name, false));
  }
  function announce(text) {
    clearTimeout(noticeTimer);
    find("#wall-notice").textContent = text;
    find("#wall-notice").hidden = !text;
    if (text)
      noticeTimer = setTimeout(() => {
        find("#wall-notice").hidden = true;
      }, 7000);
  }
  async function enter() {
    if (active) return;
    app.leaveFocus();
    active = true;
    const token = ++generation;
    document.body.classList.add("wall-fullscreen");
    chrome.hidden = false;
    entry.setAttribute("aria-pressed", "true");
    app.reflow();
    sync();
    find("#wall-tools-tab").focus();
    try {
      if (!document.documentElement.requestFullscreen)
        throw new Error("unsupported");
      await document.documentElement.requestFullscreen({
        navigationUI: "hide",
      });
      if (token !== generation || !active) {
        if (!active && document.fullscreenElement)
          await document.exitFullscreen();
        return;
      }
      ownsFullscreen = true;
      app.reflow();
    } catch {
      if (token === generation && active)
        announce(
          "Browser fullscreen unavailable. Camera wall view is active; use Exit to return.",
        );
    }
  }
  function exit() {
    if (!active) return;
    generation++;
    app.leaveFocus();
    active = false;
    document.body.classList.remove("wall-fullscreen");
    chrome.hidden = true;
    panel("nav", false, false);
    panel("tools", false, false);
    entry.setAttribute("aria-pressed", "false");
    if (ownsFullscreen && document.fullscreenElement)
      document.exitFullscreen().catch(() => {});
    ownsFullscreen = false;
    app.reflow();
    if (!find("#control-room").hidden) entry.focus({ preventScroll: true });
  }
  entry.addEventListener("click", enter);
  find("#wall-exit").addEventListener("click", exit);
  document.addEventListener("fullscreenchange", () => {
    if (active && ownsFullscreen && !document.fullscreenElement) exit();
    if (active) app.reflow();
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key !== "Escape" ||
        !active ||
        document.querySelector("dialog[open]")
      )
        return;
      if (document.body.classList.contains("has-focus")) {
        app.leaveFocus();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      exit();
    },
    { capture: true },
  );
  document.addEventListener("pointerdown", (event) => {
    if (
      !active ||
      chrome.contains(event.target) ||
      document.querySelector("dialog[open]")
    )
      return;
    panel("nav", false, false);
    panel("tools", false, false);
  });
  window.addEventListener("resize", () => {
    if (active) app.reflow();
  });
  window.addEventListener("spyder:notice", (event) => {
    if (active) announce(event.detail);
  });
  find("#wall-start").addEventListener("click", () =>
    find("#start-all").click(),
  );
  find("#wall-pause").addEventListener("click", () =>
    find("#stop-all").click(),
  );
  find("#wall-add").addEventListener("click", () =>
    find("#add-camera").click(),
  );
  find("#wall-theme").addEventListener("click", () => {
    find("#theme").click();
    sync();
  });
  find("#wall-camera-settings").addEventListener("click", () =>
    document.dispatchEvent(
      new CustomEvent("spyder:camera-settings", {
        detail: { id: find("#wall-camera-choice").value },
      }),
    ),
  );
  for (const fit of ["fit", "fill"])
    find("#wall-" + fit).addEventListener("click", () => {
      for (const card of document.querySelectorAll(".camera-card"))
        if (card.dataset.fit !== fit) card.querySelector(".fit-button").click();
    });
  find("#wall-record").addEventListener("click", () => app.media.recordLive());
  find("#wall-stop-record").addEventListener("click", () => app.media.stop());
  find("#wall-capture").addEventListener("click", () =>
    app.media.captureLive(),
  );
  find("#wall-idle").addEventListener("change", (event) => {
    const original = find("#release-idle");
    original.checked = event.target.checked;
    original.dispatchEvent(new Event("change", { bubbles: true }));
  });
  function sync() {
    if (!active) return;
    const cameras = app.cameras();
    const live = cameras.filter((c) => c.state === "running").length;
    find("#wall-live-summary").textContent =
      live + " live / " + cameras.length + " cameras";
    for (const [quick, original] of [
      ["wall-start", "start-all"],
      ["wall-pause", "stop-all"],
      ["wall-add", "add-camera"],
    ])
      find("#" + quick).disabled = find("#" + original).disabled;
    const select = find("#wall-camera-choice");
    const previous = select.value;
    const signature = JSON.stringify(cameras.map((c) => [c.id, c.name]));
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      select.replaceChildren();
      for (const c of cameras) select.append(new Option(c.name, c.id));
      if (cameras.some((c) => c.id === previous)) select.value = previous;
    }
    find("#wall-camera-settings").disabled =
      !select.value || find("#open-profiles").disabled;
    const idle = find("#release-idle");
    find("#wall-idle").checked = idle.checked;
    find("#wall-idle").disabled = idle.disabled;
    find("#wall-theme").textContent =
      document.documentElement.dataset.theme === "dark"
        ? "Switch to light mode"
        : "Switch to dark mode";
    const media = app.media.status();
    const recording = ["recording", "stopping"].includes(media.state);
    find("#wall-record-summary").textContent =
      media.error ||
      (recording
        ? "REC · " +
          Math.floor(media.elapsed_seconds) +
          "s · " +
          media.camera_ids.length +
          " views"
        : "No recording active");
    find("#wall-record").disabled = app.media.busy() || recording || !live;
    find("#wall-stop-record").disabled =
      app.media.busy() || media.state !== "recording";
    find("#wall-capture").disabled = app.media.busy() || !live;
  }
  window.addEventListener("spyder:cameras", sync);
  window.addEventListener("spyder:media", sync);
  window.spyderWall = { active: () => active, layout, enter, exit };
})();
