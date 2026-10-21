const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = options.bubbles;
  }
}

class FakeElement {
  constructor(tag = "span") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.className = "";
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.clientLeft = 0;
    this.clientTop = 0;
    this.classList = {
      add: (name) => {
        if (!this.className.split(/\s+/).includes(name))
          this.className += ` ${name}`;
      },
      remove: (name) => {
        this.className = this.className
          .split(/\s+/)
          .filter((item) => item !== name)
          .join(" ");
      },
    };
    this.style = {};
    this.listeners = {};
    this.textContent = "";
    this.nodeType = 1;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
  }
  getAttribute(key) {
    return this.attributes[key] ?? null;
  }
  matches(selector) {
    if (selector === "[data-number-stepper]")
      return "data-number-stepper" in this.attributes;
    if (selector === ":disabled") {
      if (this.disabled) return true;
      for (let node = this.parentElement; node; node = node.parentElement) {
        if (node.tagName === "FIELDSET" && node.disabled) return true;
      }
    }
    return false;
  }
  closest(selector) {
    if (
      selector === ".number-stepper-button" &&
      this.className.includes("number-stepper-button")
    )
      return this;
    return this.parentElement?.closest(selector) || null;
  }
  get nextElementSibling() {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get isConnected() {
    return Boolean(this.parentElement);
  }
  get offsetWidth() {
    return this.matches("[data-number-stepper]") ? 80 : 500;
  }
  get offsetHeight() {
    return this.matches("[data-number-stepper]") ? 40 : 500;
  }
  getBoundingClientRect() {
    return (
      this.rect || {
        left: 0,
        top: 0,
        right: 500,
        bottom: 500,
        width: 500,
        height: 500,
      }
    );
  }
  getClientRects() {
    return this.hidden ? [] : [this.getBoundingClientRect()];
  }
  contains(node) {
    return (
      this === node || this.children.some((child) => child.contains?.(node))
    );
  }
  get previousElementSibling() {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) - 1] || null;
  }
  after(node) {
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    node.parentElement = this.parentElement;
    siblings.splice(index + 1, 0, node);
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children || []) {
        if (
          child instanceof FakeInput &&
          child.type === "number" &&
          selector.includes('input[type="number"]')
        )
          found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  addEventListener(type, callback) {
    this.listeners[type] = callback;
  }
  dispatchEvent(event) {
    this.dispatched.push(event.type);
    this.listeners[event.type]?.({ target: this });
  }
}

class FakeInput extends FakeElement {
  constructor(attrs = {}) {
    super("input");
    Object.assign(this, {
      type: "number",
      value: "",
      id: "",
      name: "",
      title: "",
      disabled: false,
      readOnly: false,
      labels: [],
    });
    this.dispatched = [];
    this.focusCount = 0;
    this.dataset = {};
    this.attrs = { ...attrs };
    Object.assign(this, attrs);
    this.step = attrs.step || "1";
    this.rect = attrs.rect || {
      left: 40,
      top: 60,
      right: 240,
      bottom: 102,
      width: 200,
      height: 42,
    };
    this.clientLeft = 0;
    this.clientTop = 0;
    this.clientRight = 0;
    this.clientBottom = 0;
    this.scrollLeft = 0;
    this.scrollTop = 0;
  }
  getAttribute(key) {
    return this.attrs[key] ?? null;
  }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
  }
  cloneNode() {
    const clone = new FakeInput({
      ...this.attrs,
      type: this.type,
      value: this.value,
      step: this.step,
      min: this.min,
      max: this.max,
    });
    clone.dataset = { ...this.dataset };
    return clone;
  }
  focus() {
    this.focusCount++;
    this.onfocus?.();
  }
  stepUp() {
    this.#step(1);
  }
  stepDown() {
    this.#step(-1);
  }
  #step(direction) {
    if (this.step === "any") throw new Error("InvalidStateError");
    const amount = Number(this.step);
    if (!(amount > 0)) throw new Error("InvalidStateError");
    const min =
      this.min === undefined || this.min === "" ? 0 : Number(this.min);
    const base = this.min === undefined || this.min === "" ? 0 : min;
    const current =
      this.value === ""
        ? direction > 0
          ? base - amount
          : base
        : Number(this.value);
    let next = current + direction * amount;
    if (direction > 0 && this.max !== undefined && next > Number(this.max))
      return;
    if (direction < 0 && this.min !== undefined && next < Number(this.min))
      return;
    const decimals = Math.max(
      (String(amount).split(".")[1] || "").length,
      (String(current).split(".")[1] || "").length,
    );
    next = Number(next.toFixed(decimals));
    this.value = String(next);
  }
}

function fixture() {
  const handlers = {};
  const document = new FakeElement("document");
  document.documentElement = new FakeElement("html");
  document.activeElement = null;
  document.append(document.documentElement);
  document.listeners = handlers;
  document.createElement = (tag) => new FakeElement(tag);
  document.getElementById = (id) =>
    document
      .querySelectorAll('input[type="number"]')
      .find((input) => input.id === id) || null;
  document.querySelectorAll = (selector) =>
    document.documentElement.querySelectorAll(selector);
  document.addEventListener = (type, callback) => {
    handlers[type] = callback;
  };
  const observer = {
    observe(target, options) {
      this.target = target;
      this.options = options;
    },
  };
  const context = {
    document,
    HTMLInputElement: FakeInput,
    Node: { ELEMENT_NODE: 1 },
    Event: FakeEvent,
    getComputedStyle: () => ({ direction: "ltr", visibility: "visible" }),
    requestAnimationFrame: (callback) => {
      callback();
      return 0;
    },
    window: { addEventListener() {} },
    MutationObserver: class {
      constructor(callback) {
        observer.callback = callback;
      }
      observe(target, options) {
        observer.observe(target, options);
      }
    },
    console,
  };
  vm.runInNewContext(
    fs.readFileSync("src/spyder_cctv/assets/form-controls.js", "utf8"),
    context,
  );
  const add = (input) => {
    input.onfocus = () => handlers.focusin?.({ target: input });
    document.documentElement.append(input);
    observer.callback([{ addedNodes: [input] }]);
  };
  const click = (input, direction) => {
    const controls =
      input.labels[0]?.nextElementSibling || input.nextElementSibling;
    const button = controls.children.find(
      (item) => item.dataset.direction === String(direction),
    );
    handlers.click({
      target: button,
      preventDefault() {
        this.prevented = true;
      },
    });
    return button;
  };
  return { document, observer, handlers, add, click };
}

test("native steps preserve decimal precision, limits, and input/change events", () => {
  const f = fixture();
  const input = new FakeInput({
    id: "ratio",
    value: "0.2",
    min: "0",
    max: "0.4",
    step: "0.1",
    name: "ratio",
  });
  const originalData = { custom: "kept" };
  input.dataset = { ...originalData };
  f.add(input);
  assert.equal(
    input.nextElementSibling.children[0].getAttribute("aria-controls"),
    "ratio",
  );
  assert.deepEqual(input.dataset, originalData);
  f.click(input, 1);
  assert.equal(input.value, "0.3");
  assert.deepEqual(input.dispatched, ["input", "change"]);
  f.click(input, 1);
  assert.equal(input.value, "0.4");
  const up = input.nextElementSibling.children[1];
  assert.equal(up.disabled, true);
  f.click(input, 1);
  assert.equal(input.value, "0.4");
  f.click(input, -1);
  assert.equal(input.value, "0.3");
});

test("empty and step=any fields use native stepping with explicit fallback", () => {
  const f = fixture();
  const empty = new FakeInput({ min: "2", max: "4", step: "1", value: "" });
  f.add(empty);
  f.click(empty, 1);
  assert.equal(empty.value, "2");

  const any = new FakeInput({ value: "0.2", step: "any" });
  any.dataset.step = "0.05";
  f.add(any);
  f.click(any, 1);
  assert.equal(any.value, "0.25");
  assert.equal(any.step, "any");
});

test("disabled and readonly fields stay unchanged; dynamic fields receive controls", () => {
  const f = fixture();
  const disabled = new FakeInput({ value: "1", disabled: true });
  const readonly = new FakeInput({ value: "1", readOnly: true });
  f.add(disabled);
  f.add(readonly);
  assert.equal(disabled.nextElementSibling.children[0].disabled, true);
  assert.equal(readonly.nextElementSibling.children[1].disabled, true);
  f.click(disabled, 1);
  f.click(readonly, 1);
  assert.equal(disabled.value, "1");
  assert.equal(readonly.value, "1");

  const dynamic = new FakeInput({ value: "1", step: "0.25" });
  f.add(dynamic);
  f.click(dynamic, -1);
  assert.equal(dynamic.value, "0.75");
  assert.equal(dynamic.focusCount, 1);
});

test("disabled fieldsets disable descendant steppers and resync when enabled", () => {
  const f = fixture();
  const fieldset = new FakeElement("fieldset");
  fieldset.disabled = true;
  const input = new FakeInput({ value: "2", step: "1" });
  fieldset.append(input);
  f.document.documentElement.append(fieldset);
  f.observer.callback([{ addedNodes: [fieldset] }]);
  const plus = input.nextElementSibling.children[1];
  assert.equal(plus.disabled, true);
  f.click(input, 1);
  assert.equal(input.value, "2");
  assert.deepEqual(input.dispatched, []);

  fieldset.disabled = false;
  f.observer.callback([
    {
      type: "attributes",
      target: fieldset,
      attributeName: "disabled",
      addedNodes: [],
    },
  ]);
  assert.equal(plus.disabled, false);
  f.click(input, 1);
  assert.equal(input.value, "3");
  assert.deepEqual(input.dispatched, ["input", "change"]);
});

test("wrapped labels remain intact and controls keep their own accessible names", () => {
  const f = fixture();
  const label = new FakeElement("label");
  label.textContent = "Exposure";
  const input = new FakeInput({ value: "4", step: "1" });
  input.labels = [label];
  label.append(input);
  f.document.documentElement.append(label);
  f.observer.callback([{ addedNodes: [label] }]);
  const controls = label.nextElementSibling;
  assert.equal(controls.parentElement, f.document.documentElement);
  assert.equal(label.children.length, 1);
  assert.equal(
    controls.children[0].getAttribute("aria-label"),
    "Decrease Exposure",
  );
  assert.equal(
    controls.children[1].getAttribute("aria-label"),
    "Increase Exposure",
  );
  assert.equal(controls.style.left, "160px");
  assert.equal(controls.style.top, "61px");
});

test("duplicate ids do not redirect controls and attribute changes update limits", () => {
  const f = fixture();
  const first = new FakeInput({ id: "same", value: "2", max: "5", step: "1" });
  const second = new FakeInput({ id: "same", value: "4", max: "5", step: "1" });
  f.add(first);
  f.add(second);
  f.click(second, 1);
  assert.equal(first.value, "2");
  assert.equal(second.value, "5");
  assert.equal(second.nextElementSibling.children[1].disabled, true);

  second.readOnly = true;
  f.observer.callback([
    {
      type: "attributes",
      target: second,
      attributeName: "readonly",
      addedNodes: [],
    },
  ]);
  assert.equal(second.nextElementSibling.children[0].disabled, true);
  second.readOnly = false;
  f.observer.callback([
    {
      type: "attributes",
      target: second,
      attributeName: "readonly",
      addedNodes: [],
    },
  ]);
  assert.equal(second.nextElementSibling.children[0].disabled, false);
});
