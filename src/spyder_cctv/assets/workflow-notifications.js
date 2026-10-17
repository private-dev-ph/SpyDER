/* Local workflow alerts: independent of the currently selected workspace. */
(() => {
  "use strict";
  function createFeed(deliver) {
    let session = null;
    const seen = new Set();
    function valid(item) {
      return (
        item &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        item.id.length <= 128 &&
        typeof item.title === "string" &&
        item.title.length <= 128 &&
        typeof item.message === "string" &&
        item.message.length <= 500 &&
        typeof item.camera_id === "string"
      );
    }
    return {
      accept(data) {
        if (
          !data ||
          typeof data.session_id !== "string" ||
          !Array.isArray(data.notifications)
        )
          throw Error("Invalid notification snapshot");
        const items = data.notifications.slice(-100).filter(valid);
        if (session !== data.session_id) {
          session = data.session_id;
          seen.clear();
          items.forEach((item) => seen.add(item.id));
          return [];
        }
        const fresh = [];
        for (const item of items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          fresh.push(item);
          deliver(item);
        }
        while (seen.size > 256) seen.delete(seen.values().next().value);
        return fresh;
      },
    };
  }
  if (typeof module !== "undefined" && module.exports)
    module.exports = { createFeed };
  if (typeof window === "undefined") return;
  const key = "spyder.workflow.desktop-alerts";
  let preference = null,
    prompted = false,
    permissionRequest = null,
    enabled = false,
    stopped = false,
    timer,
    controller;
  try {
    const stored = localStorage.getItem(key);
    preference = stored === "1" ? true : stored === "0" ? false : null;
    enabled = preference === true;
  } catch {}
  const available = () => "Notification" in window && window.isSecureContext;
  const desktopEnabled = () =>
    enabled && available() && window.Notification.permission === "granted";
  const savePreference = () => {
    preference = enabled;
    try {
      localStorage.setItem(key, enabled ? "1" : "0");
    } catch {}
  };
  const stack = document.createElement("section");
  stack.className = "workflow-alerts";
  stack.setAttribute("role", "log");
  stack.setAttribute("aria-live", "polite");
  stack.setAttribute("aria-label", "Workflow notifications");
  document.body.append(stack);
  function show(item) {
    const card = document.createElement("article"),
      title = document.createElement("strong"),
      message = document.createElement("p"),
      source = document.createElement("small"),
      close = document.createElement("button");
    card.className = "workflow-alert";
    title.textContent = item.title;
    message.textContent = item.message;
    const camera = window.spyder
      ?.cameras?.()
      .find((camera) => camera.id === item.camera_id);
    source.textContent = `${camera?.name || item.camera_id}${item.workflow_name ? ` | ${item.workflow_name}` : ""}`;
    close.className = "icon-button";
    close.setAttribute("aria-label", "Dismiss notification");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"),
      use = document.createElementNS(svg.namespaceURI, "use");
    svg.classList.add("icon");
    svg.setAttribute("aria-hidden", "true");
    use.setAttribute("href", "/icons.svg#close");
    svg.append(use);
    close.append(svg);
    close.addEventListener("click", () => card.remove());
    card.append(title, message, source, close);
    stack.append(card);
    while (stack.children.length > 5) stack.firstElementChild.remove();
    setTimeout(() => card.remove(), 15000);
    if (desktopEnabled()) {
      try {
        const alert = new window.Notification(item.title, {
          body: `${item.message}\n${camera?.name || item.camera_id}`,
          tag: `spyder-${item.id}`,
          icon: "/spyder-emblem.png",
          renotify: false,
        });
        alert.onclick = () => {
          window.focus();
          location.hash = "#control-room";
          alert.close();
        };
      } catch {
        enabled = false;
        savePreference();
      }
    }
  }
  const feed = createFeed(show);
  async function poll() {
    if (stopped || window.spyderShowcase) return;
    const active = (controller = new AbortController());
    const timeout = setTimeout(() => active.abort(), 4000);
    try {
      const response = await fetch("/api/workflows/notifications", {
        cache: "no-store",
        signal: active.signal,
      });
      if (!response.ok) throw Error("Notifications unavailable");
      const data = await response.json();
      if (!stopped && controller === active) {
        feed.accept(data);
        window.dispatchEvent(
          new CustomEvent("spyder:activity-snapshot", { detail: data }),
        );
      }
    } catch {
      /* Keep other camera features usable during a connection failure. */
    } finally {
      clearTimeout(timeout);
      if (!stopped) timer = setTimeout(poll, 2000);
    }
  }
  function desktopStatus() {
    if (window.spyderShowcase)
      return "Desktop alerts require the installed local app.";
    if (!available())
      return "Desktop notifications are unavailable in this browser context. In-app alerts remain available.";
    if (window.Notification.permission === "denied")
      return "Notifications are blocked. Allow notifications for this site in your browser settings.";
    if (desktopEnabled())
      return "Desktop notifications enabled for this browser. Keep a SpyDER page open to receive alerts.";
    return window.Notification.permission === "granted"
      ? "Browser permission granted; desktop notifications are switched off."
      : "Notification permission is requested only when adding or using a Notification node.";
  }
  function refreshControls() {
    for (const button of document.querySelectorAll?.(
      "[data-notification-permission]",
    ) || []) {
      button.textContent = desktopEnabled()
        ? "Disable desktop alerts"
        : "Enable desktop alerts";
      button.disabled = !!permissionRequest || !!window.spyderShowcase;
    }
    for (const status of document.querySelectorAll?.(
      "[data-notification-status]",
    ) || [])
      status.textContent = desktopStatus();
  }
  function enableDesktop(automatic = false) {
    if (window.spyderShowcase || !available()) return Promise.resolve(false);
    if (permissionRequest) return permissionRequest;
    if (desktopEnabled()) return Promise.resolve(true);
    if (automatic && (preference === false || prompted))
      return Promise.resolve(desktopEnabled());
    if (window.Notification.permission === "denied") {
      enabled = false;
      savePreference();
      refreshControls();
      return Promise.resolve(false);
    }
    let request;
    try {
      // Call the browser API synchronously in the originating user gesture.
      if (window.Notification.permission === "granted")
        request = Promise.resolve("granted");
      else {
        prompted = true;
        request = window.Notification.requestPermission();
      }
    } catch {
      return Promise.resolve(false);
    }
    permissionRequest = Promise.resolve(request)
      .then((permission) => {
        enabled = permission === "granted";
        if (permission !== "default") savePreference();
        window.spyder?.notify?.(
          enabled
            ? "Desktop alerts enabled. Keep this page open and the camera running."
            : "Desktop permission was not granted. In-app alerts remain enabled.",
        );
        return enabled;
      })
      .catch(() => {
        window.spyder?.notify?.(
          "Desktop alerts could not be enabled. In-app alerts remain enabled.",
        );
        return false;
      })
      .finally(() => {
        permissionRequest = null;
        refreshControls();
      });
    refreshControls();
    return permissionRequest;
  }
  function useNode() {
    return enableDesktop(true);
  }
  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.("[data-notification-permission]"),
      test = event.target.closest?.("[data-notification-test]");
    if (!button && !test) return;
    if (window.spyderShowcase) {
      window.spyder?.notify?.(
        "Desktop workflow alerts run in the installed local app.",
      );
      return;
    }
    if (button && desktopEnabled()) {
      enabled = false;
      savePreference();
      button.textContent = "Enable desktop alerts";
      refreshControls();
      window.spyder?.notify?.(
        "Desktop alerts disabled. In-app alerts remain enabled.",
      );
      return;
    }
    if (!available()) {
      window.spyder?.notify?.(desktopStatus());
      return;
    }
    if (button) button.disabled = true;
    const permitted = await enableDesktop(false);
    if (button) {
      button.disabled = false;
      button.textContent = desktopEnabled()
        ? "Disable desktop alerts"
        : "Enable desktop alerts";
    }
    if (test && permitted) {
      try {
        const alert = new window.Notification("SpyDER test notification", {
          body: "Desktop workflow alerts are enabled.",
          tag: "spyder-notification-test",
          icon: "/spyder-emblem.png",
        });
        alert.onclick = () => {
          window.focus();
          alert.close();
        };
        window.spyder?.notify?.(
          "Test notification sent to your browser. If hidden, check OS notification settings.",
        );
      } catch {
        window.spyder?.notify?.(
          "Desktop notification delivery is unavailable. In-app alerts remain enabled.",
        );
      }
    } else if (!permitted) window.spyder?.notify?.(desktopStatus());
  });
  window.addEventListener("storage", (event) => {
    if (event.key === key) {
      preference =
        event.newValue === "1" ? true : event.newValue === "0" ? false : null;
      enabled = preference === true;
      refreshControls();
    }
  });
  window.addEventListener("pagehide", () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      stopped = false;
      poll();
    }
  });
  window.spyderNotifications = { desktopEnabled, desktopStatus, useNode };
  poll();
})();
