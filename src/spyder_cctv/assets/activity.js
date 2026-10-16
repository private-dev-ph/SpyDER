/* Camera focus policy and presence lease. */
(() => {
  "use strict";
  const app = window.spyder;
  const note = document.querySelector("#activity-note");
  const storageKey = "spyder-pause-unfocused";
  const legacyKey = "spyder-release-idle";
  const showcase = Boolean(window.spyderShowcase);
  const clientId = crypto.randomUUID();
  let state = {
    pause_when_unfocused: true,
    configured: false,
    storage_error: null,
    loading: true,
    saved: false,
    continuous: false,
  };
  let focused = () =>
    document.visibilityState === "visible" && document.hasFocus();
  let revision = 0;
  let mutation = 0;
  let timer;
  let preferenceTimer;
  let pageLeaving = false;
  let controller;
  let pending = false;
  let saveError = false;
  const subscribers = new Set();

  function controls() {
    return [
      document.querySelector("#release-idle"),
      document.querySelector("#wall-idle"),
      document.querySelector("#system-pause-unfocused"),
    ].filter(Boolean);
  }
  function notify() {
    for (const control of controls()) {
      control.checked = state.continuous ? false : state.pause_when_unfocused;
      control.disabled =
        state.continuous || state.loading || pending || !state.saved;
    }
    const view = { ...state };
    view.saving = pending;
    view.saveError = saveError;
    for (const subscriber of subscribers) subscriber(view);
    window.dispatchEvent(
      new CustomEvent("spyder:activity-preference", { detail: view }),
    );
    updateNote();
  }
  function updateNote() {
    if (!note) return;
    if (state.continuous) {
      note.textContent = "Continuous server mode · cameras stay active";
      note.classList.remove("error");
      return;
    }
    if (saveError)
      note.textContent = "Could not save camera preference · reverted";
    else if (state.loading) note.textContent = "Loading camera preference…";
    else if (!state.saved)
      note.textContent = "Camera preference unavailable · retrying";
    else if (pending) note.textContent = "Saving camera preference…";
    else if (showcase)
      note.textContent = "Saved in this browser · showcase presence only";
    else if (state.storage_error)
      note.textContent =
        "Preference storage unavailable · changes may not persist";
    else
      note.textContent = state.pause_when_unfocused
        ? "Saved on this computer · cameras pause when this page loses focus"
        : "Saved on this computer · cameras keep running while the local server runs";
    if ((state.storage_error || saveError) && note && state.saved)
      note.classList.add("error");
    else note?.classList.remove("error");
  }
  function setState(next) {
    state = { ...state, ...next };
    notify();
  }
  function mirror(value) {
    try {
      localStorage.setItem(storageKey, String(value));
    } catch {
      /* Server policy remains authoritative. */
    }
  }
  async function preferenceRequest(method, value) {
    const response = await fetch("/api/preferences", {
      method,
      headers: {
        "X-Spyder-Control": "1",
        "Content-Type": "application/json",
      },
      ...(method === "POST" ? { body: JSON.stringify(value) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error("Camera preference unavailable");
    const result = await response.json();
    if (
      typeof result.pause_when_unfocused !== "boolean" ||
      typeof result.configured !== "boolean"
    )
      throw new Error("Camera preference response invalid");
    return result;
  }
  function applyServer(result) {
    setState({
      pause_when_unfocused: result.pause_when_unfocused,
      configured: result.configured,
      storage_error: result.storage_error || null,
      loading: false,
      saved: true,
    });
    mirror(result.pause_when_unfocused);
  }
  async function loadPreference(initial = false) {
    if (pending || pageLeaving) return;
    const token = mutation;
    try {
      const result = await preferenceRequest("GET");
      if (token !== mutation) return;
      if (initial && !result.configured) {
        let legacy = null;
        try {
          legacy = localStorage.getItem(legacyKey);
        } catch {
          /* No browser storage available. */
        }
        if (legacy === "false") {
          const migrated = await preferenceRequest("POST", {
            pause_when_unfocused: false,
          });
          if (token !== mutation) return;
          applyServer(migrated);
          return;
        }
      }
      applyServer(result);
    } catch {
      if (token !== mutation) return;
      setState({ loading: false, saved: false, storage_error: null });
    }
  }
  async function savePreference(value) {
    if (pending || !state.saved || state.loading || state.continuous) return;
    const previous = state.pause_when_unfocused;
    const token = ++mutation;
    pending = true;
    saveError = false;
    setState({ pause_when_unfocused: value });
    try {
      if (showcase) {
        mirror(value);
        setState({ configured: true, storage_error: null, saved: true });
      } else {
        const result = await preferenceRequest("POST", {
          pause_when_unfocused: value,
        });
        if (token !== mutation) return;
        applyServer(result);
      }
      publish();
    } catch {
      if (token === mutation) {
        saveError = true;
        setState({
          pause_when_unfocused: previous,
          saved: true,
        });
        note?.classList.add("error");
        mirror(previous);
      }
    } finally {
      if (token === mutation) {
        pending = false;
        notify();
      }
    }
  }
  function presenceBody(leaving = false) {
    return {
      client_id: clientId,
      active: !leaving && focused(),
      release_when_idle: leaving || state.pause_when_unfocused,
    };
  }
  async function publish(leaving = false) {
    if (pageLeaving && !leaving) return;
    clearTimeout(timer);
    const token = ++revision;
    const data = presenceBody(leaving);
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const timeout = setTimeout(() => current.abort(), 4000);
    try {
      if (showcase) await window.spyderShowcase.request("/api/presence", data);
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
        if (token === revision && !leaving && policy.idle_policy === false)
          setState({ continuous: true });
      }
      if (token === revision && !leaving) {
        app.refresh();
        note?.classList.remove("error");
      }
    } catch (error) {
      if (token === revision && error.name !== "AbortError" && !leaving) {
        if (note) {
          note.textContent = "Camera connection unavailable · retrying";
          note.classList.add("error");
        }
      }
    } finally {
      clearTimeout(timeout);
      if (token === revision && !leaving) timer = setTimeout(publish, 5000);
    }
  }
  document.addEventListener("change", (event) => {
    if (!event.target.matches?.("#release-idle, #system-pause-unfocused"))
      return;
    const value = event.target.checked;
    for (const control of controls()) control.checked = value;
    savePreference(value);
  });
  window.addEventListener("storage", (event) => {
    if (
      event.key === legacyKey &&
      !state.configured &&
      event.newValue === "false"
    ) {
      if (showcase) savePreference(false);
      else loadPreference();
    } else if (event.key === storageKey) {
      if (showcase) {
        if (!pending && event.newValue !== null)
          setState({
            pause_when_unfocused: event.newValue !== "false",
            configured: true,
            saved: true,
            loading: false,
          });
      } else loadPreference();
    }
  });
  window.addEventListener("focus", () => publish());
  window.addEventListener("blur", () => publish());
  document.addEventListener("visibilitychange", () => publish());
  window.addEventListener("pagehide", () => {
    pageLeaving = true;
    clearInterval(preferenceTimer);
    preferenceTimer = null;
    publish(true);
  });
  window.addEventListener("pageshow", () => {
    pageLeaving = false;
    if (!showcase && preferenceTimer === null)
      preferenceTimer = setInterval(() => loadPreference(), 5000);
    if (!showcase) loadPreference();
    publish();
  });
  window.spyderActivity = {
    getState: () => ({ ...state, saving: pending, saveError }),
    subscribe(callback) {
      subscribers.add(callback);
      callback({ ...state });
      return () => subscribers.delete(callback);
    },
    refresh: () => (showcase ? Promise.resolve() : loadPreference()),
  };
  if (showcase) {
    let saved = null;
    try {
      saved = localStorage.getItem(storageKey);
      if (saved === null) saved = localStorage.getItem(legacyKey);
    } catch {
      /* Showcase works without persistent browser storage. */
    }
    state = {
      pause_when_unfocused: saved !== "false",
      configured: saved !== null,
      storage_error: null,
      loading: false,
      saved: true,
    };
    mirror(state.pause_when_unfocused);
    notify();
    publish();
  } else {
    notify();
    loadPreference(true).finally(() => publish());
    preferenceTimer = setInterval(() => loadPreference(), 5000);
  }
})();
