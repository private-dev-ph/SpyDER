(() => {
  "use strict";

  const initialized = new WeakSet();
  const controlsByInput = new WeakMap();
  const inputsByButton = new WeakMap();
  const hostByInput = new WeakMap();
  const inputsByHost = new WeakMap();
  const styledHosts = new WeakSet();
  const fields = new Set();
  const pendingPositions = new Set();
  let nextId = 0;
  let positionFrame = 0;
  let layoutObserver = null;

  function fieldName(input) {
    const explicit = input.getAttribute("aria-label") || input.title;
    if (explicit) return explicit.trim();
    const labels = input.labels ? [...input.labels] : [];
    return (
      labels.map((label) => label.textContent.trim()).find(Boolean) ||
      input.name ||
      "value"
    );
  }

  function anchorFor(input) {
    const label =
      input.labels && [...input.labels].find((item) => item.contains(input));
    return label || input;
  }

  function hostFor(input) {
    return anchorFor(input).parentElement;
  }

  function makeButtons(input) {
    const controls = document.createElement("span");
    controls.className = "number-stepper";
    controls.setAttribute("data-number-stepper", "");
    const label = fieldName(input);
    if (!input.id) {
      let id;
      do id = `number-input-${++nextId}`;
      while (document.getElementById(id));
      input.id = id;
    }
    for (const [direction, text] of [
      [-1, "−"],
      [1, "+"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "number-stepper-button";
      button.textContent = text;
      button.setAttribute(
        "aria-label",
        `${direction < 0 ? "Decrease" : "Increase"} ${label}`,
      );
      button.setAttribute("aria-controls", input.id);
      button.dataset.direction = String(direction);
      inputsByButton.set(button, input);
      controls.append(button);
    }
    return controls;
  }

  function placeControls(input, controls) {
    const anchor = anchorFor(input);
    const host = anchor.parentElement;
    releaseHost(input);
    if (
      getComputedStyle(host).position === "static" &&
      !host.classList.contains("number-input-stepper-anchor")
    ) {
      host.classList.add("number-input-stepper-anchor");
      styledHosts.add(host);
    }
    anchor.after(controls);
    hostByInput.set(input, host);
    let inputs = inputsByHost.get(host);
    if (!inputs) inputsByHost.set(host, (inputs = new Set()));
    inputs.add(input);
    layoutObserver?.observe(input);
  }

  function releaseHost(input) {
    const host = hostByInput.get(input);
    if (!host) return;
    const inputs = inputsByHost.get(host);
    inputs?.delete(input);
    if (inputs?.size === 0) {
      inputsByHost.delete(host);
      if (styledHosts.has(host)) {
        host.classList.remove("number-input-stepper-anchor");
        styledHosts.delete(host);
      }
    }
    hostByInput.delete(input);
  }

  function enhance(input) {
    if (!(input instanceof HTMLInputElement)) return;
    if (input.type !== "number") {
      if (initialized.has(input)) removeControls(input);
      return;
    }
    if (initialized.has(input)) {
      let controls = controlsByInput.get(input);
      if (
        !controls ||
        !controls.isConnected ||
        controls.parentElement !== hostFor(input)
      ) {
        controls?.remove();
        controls ||= makeButtons(input);
        placeControls(input, controls);
        controlsByInput.set(input, controls);
      }
      syncButtons(input, controlsByInput.get(input));
      schedulePosition(input);
      return;
    }
    initialized.add(input);
    fields.add(input);
    input.classList.add("themed-number-input");
    const controls = makeButtons(input);
    placeControls(input, controls);
    controlsByInput.set(input, controls);
    syncButtons(input, controls);
    schedulePosition(input);
  }

  function removeControls(input) {
    controlsByInput.get(input)?.remove();
    controlsByInput.delete(input);
    releaseHost(input);
    initialized.delete(input);
    fields.delete(input);
    pendingPositions.delete(input);
    layoutObserver?.unobserve(input);
    input.classList.remove("themed-number-input");
  }

  function setVisibility(input, controls) {
    if (!controls) return false;
    const rendered =
      input.isConnected &&
      input.getClientRects().length > 0 &&
      getComputedStyle(input).visibility !== "hidden";
    controls.hidden = !rendered;
    return rendered;
  }

  function positionControls(input, controls) {
    if (!controls?.isConnected || !setVisibility(input, controls)) return;
    const host = hostByInput.get(input);
    const field = input.getBoundingClientRect();
    const bounds = host.getBoundingClientRect();
    const hostStyle = getComputedStyle(host);
    // offsetWidth/Height round fractional grid sizes, creating false scaling.
    const usedSize = (axis, edges, fallback) => {
      let size = parseFloat(hostStyle[axis]);
      if (!Number.isFinite(size)) return fallback;
      if (hostStyle.boxSizing !== "border-box")
        for (const edge of edges) size += parseFloat(hostStyle[edge]) || 0;
      return size;
    };
    const hostWidth = usedSize("width", ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"], host.offsetWidth);
    const hostHeight = usedSize("height", ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"], host.offsetHeight);
    const scaleX = bounds.width / (hostWidth || bounds.width) || 1;
    const scaleY = bounds.height / (hostHeight || bounds.height) || 1;
    const width = controls.offsetWidth;
    const style = getComputedStyle(input);
    const rtl = style.direction === "rtl";
    const left = rtl
      ? field.left - bounds.left
      : field.right - bounds.left - width * scaleX;
    const top = field.top - bounds.top;
    controls.style.height = `${field.height / scaleY}px`;
    controls.style.direction = style.direction;
    const topRadius = (rtl ? style.borderTopLeftRadius : style.borderTopRightRadius) || "7px";
    const bottomRadius = (rtl ? style.borderBottomLeftRadius : style.borderBottomRightRadius) || "7px";
    controls.style.borderRadius = rtl
      ? `${topRadius} 0 0 ${bottomRadius}`
      : `0 ${topRadius} ${bottomRadius} 0`;
    controls.style.left = `${left / scaleX + host.scrollLeft - (parseFloat(hostStyle.borderLeftWidth) || host.clientLeft)}px`;
    controls.style.top = `${top / scaleY + host.scrollTop - (parseFloat(hostStyle.borderTopWidth) || host.clientTop)}px`;
  }

  function schedulePosition(input) {
    if (!controlsByInput.has(input)) return;
    pendingPositions.add(input);
    if (positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      for (const item of pendingPositions)
        positionControls(item, controlsByInput.get(item));
      pendingPositions.clear();
    });
  }

  function scheduleAllPositions() {
    for (const input of fields) schedulePosition(input);
  }

  function scan(root) {
    if (root instanceof HTMLInputElement) enhance(root);
    root.querySelectorAll?.('input[type="number"]').forEach(enhance);
  }

  function step(input, direction) {
    if (input.matches(":disabled") || input.readOnly) return false;
    const before = input.value;
    try {
      if (input.step === "any") {
        const fallbackStep = Number(input.dataset.step) || 1;
        const originalStep = input.getAttribute("step");
        input.step = String(fallbackStep);
        try {
          direction > 0 ? input.stepUp() : input.stepDown();
        } finally {
          if (originalStep === null) input.removeAttribute("step");
          else input.step = originalStep;
        }
      } else {
        direction > 0 ? input.stepUp() : input.stepDown();
      }
    } catch {
      return false;
    }
    if (input.value === before) return false;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    syncButtons(input, controlsByInput.get(input));
    return true;
  }

  function syncButtons(input, controls) {
    if (!controls?.matches("[data-number-stepper]")) return;
    for (const button of controls.children) {
      let disabled = input.matches(":disabled") || input.readOnly;
      if (!disabled) {
        const probe = input.cloneNode();
        const direction = Number(button.dataset.direction);
        try {
          if (probe.step === "any")
            probe.step = String(Number(probe.dataset.step) || 1);
          direction > 0 ? probe.stepUp() : probe.stepDown();
          disabled = probe.value === input.value;
        } catch {
          disabled = true;
        }
      }
      if (disabled && button === document.activeElement) input.focus();
      button.disabled = disabled;
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.(".number-stepper-button");
    if (!button) return;
    const input = inputsByButton.get(button);
    if (!(input instanceof HTMLInputElement) || input.type !== "number") return;
    event.preventDefault();
    input.focus();
    step(input, Number(button.dataset.direction));
  });

  document.addEventListener("mousedown", (event) => {
    if (event.target.closest?.(".number-stepper-button"))
      event.preventDefault();
  });

  for (const eventName of ["input", "change"]) {
    document.addEventListener(eventName, (event) => {
      const input = event.target;
      if (input instanceof HTMLInputElement && input.type === "number") {
        syncButtons(input, controlsByInput.get(input));
      }
    });
  }

  window.addEventListener("resize", scheduleAllPositions);
  window.addEventListener("scroll", scheduleAllPositions, true);

  layoutObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((records) => {
          for (const record of records) {
            if (record.target instanceof HTMLInputElement)
              schedulePosition(record.target);
          }
        });

  scan(document);
  new MutationObserver((records) => {
    for (const record of records) {
      if (
        record.type === "attributes" &&
        record.target instanceof HTMLInputElement
      ) {
        const input = record.target;
        if (input.type === "number") {
          enhance(input);
          syncButtons(input, controlsByInput.get(input));
        } else if (initialized.has(input)) {
          removeControls(input);
        }
      }
      if (
        record.type === "attributes" &&
        record.attributeName === "disabled" &&
        !(record.target instanceof HTMLInputElement)
      ) {
        record.target
          .querySelectorAll?.('input[type="number"].themed-number-input')
          .forEach((input) => {
            syncButtons(input, controlsByInput.get(input));
          });
      }
      if (
        record.type === "attributes" &&
        ["hidden", "class", "style"].includes(record.attributeName)
      ) {
        const affected =
          record.target instanceof HTMLInputElement
            ? [record.target]
            : record.target.querySelectorAll?.(
                'input[type="number"].themed-number-input',
              ) || [];
        for (const input of affected) schedulePosition(input);
      }
      if (record.type === "childList") {
        const affected =
          record.target instanceof HTMLInputElement
            ? [record.target]
            : record.target.querySelectorAll?.(
                'input[type="number"].themed-number-input',
              ) || [];
        for (const input of affected) schedulePosition(input);
      }
      for (const node of record.addedNodes || []) {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      }
      for (const node of record.removedNodes || []) {
        if (node.nodeType !== Node.ELEMENT_NODE || node.isConnected) continue;
        const removedInputs = [
          ...(node instanceof HTMLInputElement ? [node] : []),
          ...(node.querySelectorAll?.(
            'input[type="number"], input.themed-number-input',
          ) || []),
        ];
        for (const input of removedInputs) {
          if (initialized.has(input) && !input.isConnected)
            removeControls(input);
        }
      }
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      "disabled",
      "readonly",
      "min",
      "max",
      "step",
      "data-step",
      "value",
      "type",
      "hidden",
      "class",
      "style",
    ],
    childList: true,
    subtree: true,
  });
})();
