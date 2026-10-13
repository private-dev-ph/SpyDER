/* Presence is a lease, not a recording command. */
(() => {
  "use strict";
  const app = window.spyder;
  const control = document.querySelector("#release-idle");
  const note = document.querySelector("#activity-note");
  const clientId = crypto.randomUUID();
  let release = true;
  let revision = 0;
  let timer;
  let controller;
  try {
    release = localStorage.getItem("spyder-release-idle") !== "false";
  } catch {
    /* Tab-only setting. */
  }
  control.checked = release;
  const focused = () =>
    document.visibilityState === "visible" && document.hasFocus();
  function updateNote() {
    note.textContent = release
      ? focused()
        ? "Unrecorded cameras release when this view is away"
        : "Away · idle cameras release automatically"
      : "Keep cameras active while this tab is open";
  }
  async function publish(leaving = false) {
    clearTimeout(timer);
    const token = ++revision;
    const data = {
      client_id: clientId,
      active: !leaving && focused(),
      release_when_idle: leaving || release,
    };
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const timeout = setTimeout(() => current.abort(), 4000);
    updateNote();
    try {
      if (window.spyderShowcase)
        await window.spyderShowcase.request("/api/presence", data);
      else {
        const response = await fetch("/api/presence", {
          method: "POST",
          headers: {
            "X-Spyder-Control": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(data),
          signal: current.signal,
          keepalive: true,
        });
        if (!response.ok) throw new Error("Presence unavailable");
        const policy = await response.json();
        if (policy.idle_policy === false) {
          control.disabled = true;
          control.checked = false;
          note.textContent = "Continuous server mode · cameras stay active";
        } else {
          control.disabled = false;
          control.checked = release;
        }
      }
      if (token === revision && !leaving) {
        app.refresh();
        note.classList.remove("error");
      }
    } catch (error) {
      if (token === revision && error.name !== "AbortError" && !leaving) {
        note.textContent = "Camera release connection unavailable · retrying";
        note.classList.add("error");
      }
    } finally {
      clearTimeout(timeout);
      if (token === revision && !leaving) timer = setTimeout(publish, 5000);
    }
  }
  control.addEventListener("change", () => {
    release = control.checked;
    try {
      localStorage.setItem("spyder-release-idle", String(release));
    } catch {
      /* Keep tab setting. */
    }
    publish();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== "spyder-release-idle") return;
    release = event.newValue !== "false";
    control.checked = release;
    publish();
  });
  window.addEventListener("focus", () => publish());
  window.addEventListener("blur", () => publish());
  document.addEventListener("visibilitychange", () => publish());
  window.addEventListener("pagehide", () => publish(true));
  window.addEventListener("pageshow", () => publish());
  publish();
})();
