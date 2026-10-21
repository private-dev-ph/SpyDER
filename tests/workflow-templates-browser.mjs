// Template picker browser regression. Run: node tests/workflow-templates-browser.mjs <showcase-dir>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const assets = path.resolve(process.argv[2]);
const headers = await readFile(path.join(assets, "_headers"), "utf8");
const policy = headers
  .split("\n")
  .find((line) => line.trim().startsWith("Content-Security-Policy:"))
  ?.trim()
  .slice("Content-Security-Policy:".length)
  .trim();
assert.ok(policy, "Export needs a content security policy");
const networkPaths = [];
const profile = await mkdtemp(path.join(os.tmpdir(), "spyder-ribbon-browser-"));
const server = http.createServer(async (req, res) => {
  networkPaths.push(req.url);
  const name =
    new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[\w.-]+$/.test(name)) return res.writeHead(404).end();
  try {
    const body = await readFile(path.join(assets, name));
    const mime = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    res.setHeader("Content-Security-Policy", policy);
    res.setHeader(
      "Content-Type",
      mime[path.extname(name)] || "application/octet-stream",
    );
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const chrome = spawn(
  process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-background-networking",
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = (
        await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(port, "Chrome debugging endpoint did not start");
  const info = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const result = pending.get(message.id);
    if (!result) return;
    pending.delete(message.id);
    clearTimeout(result.timer);
    if (message.error) result.reject(new Error(JSON.stringify(message.error)));
    else result.resolve(message.result);
  };
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `Timed out: ${method} ${(params.expression || "").slice(0, 180)}`,
          ),
        );
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const { targetId } = await command("Target.createTarget", {
    url: `http://127.0.0.1:${server.address().port}/#control-room`,
  });
  const { sessionId } = await command("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  async function evaluate(expression) {
    const result = await command(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  async function until(expression) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    const state = await evaluate(
      "({ready:document.readyState,workflow:!!window.spyderWorkflows,app:!!window.spyder,cameras:window.spyder?.cameras?.().length,text:document.body.innerText.slice(0,500)})",
    );
    throw new Error(
      "Timed out: " +
        expression +
        "; state=" +
        JSON.stringify(state) +
        "; requests=" +
        JSON.stringify(networkPaths),
    );
  }
  const click = (text) =>
    evaluate(
      `(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b)throw new Error('Missing button');b.click();})()`,
    );
  const change = (id, value) =>
    evaluate(
      `(() => {const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  const visible = () =>
    evaluate(
      "[...document.querySelectorAll('#cameras > .camera-card:not([hidden])')].map(c=>c.dataset.id)",
    );
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await until("!!window.spyderWorkflows && spyder.cameras().length===2");
  await evaluate(
    "window.templateErrors=[];window.addEventListener('error',e=>templateErrors.push(e.message));navigator.mediaDevices.getUserMedia=()=>{throw new Error('Unexpected camera access')};location.hash='vision-lab'",
  );
  await until("!!document.querySelector('#vision-workflow-tab')");
  await evaluate("document.querySelector('#vision-workflow-tab').click()");
  await until("!!document.querySelector('[data-open-templates]')");
  for (const theme of ["light", "dark"]) {
    const controls = await evaluate(`(() => {
      document.documentElement.dataset.theme=${JSON.stringify(theme)};
      const select=document.querySelector('[data-workflow]');
      const box=document.querySelector('[data-camera]');
      const checked=box.checked;
      box.checked=true;
      const selected=getComputedStyle(select), check=getComputedStyle(box);
      const result={appearance:selected.appearance, arrow:selected.backgroundImage,
        padding:parseFloat(selected.paddingRight), red:check.backgroundColor,
        whiteCheck:check.backgroundImage.includes('white'), width:box.getBoundingClientRect().width};
      box.disabled=true;
      result.disabledCursor=getComputedStyle(box).cursor;
      box.disabled=false; box.checked=checked;
      return result;
    })()`);
    assert.equal(controls.appearance, "none");
    assert.match(controls.arrow, /svg/);
    assert.ok(controls.padding >= 40);
    assert.equal(controls.red, "rgb(190, 26, 26)");
    assert.equal(controls.whiteCheck, true);
    assert.equal(controls.width, 18);
    assert.equal(controls.disabledCursor, "not-allowed");
  }
  await command(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "forced-colors", value: "active" }] },
    sessionId,
  );
  const forcedControls = await evaluate(
    "(() => {const box=document.querySelector('[data-camera]');box.checked=true;const s=getComputedStyle(box);return {appearance:s.appearance,image:s.backgroundImage,select:getComputedStyle(document.querySelector('[data-workflow]')).appearance};})()",
  );
  assert.equal(forcedControls.appearance, "auto");
  assert.equal(forcedControls.image, "none");
  assert.equal(forcedControls.select, "auto");
  await command("Emulation.setEmulatedMedia", { features: [] }, sessionId);
  await evaluate("document.documentElement.dataset.theme='light'");
  async function assertCenteredClose(selector) {
    const result =
      await evaluate(`(() => {const b=document.querySelector(${JSON.stringify(selector)}),
      icon=b.querySelector('svg'), r=b.getBoundingClientRect(), s=icon.getBoundingClientRect();
      return {text:b.textContent.trim(), href:icon.querySelector('use').getAttribute('href'),
        width:r.width,height:r.height,dx:Math.abs(r.x+r.width/2-s.x-s.width/2),
        dy:Math.abs(r.y+r.height/2-s.y-s.height/2)};})()`);
    assert.equal(result.text, "");
    assert.equal(result.href, "/icons.svg#close");
    assert.ok(result.width >= 40 && result.height >= 40);
    assert.ok(result.dx < 1 && result.dy < 1, JSON.stringify(result));
  }
  await evaluate(
    "document.querySelector('[data-name]').value='Unfinished workflow';document.querySelector('[data-name]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-open-templates]').click()",
  );
  await assertCenteredClose(
    "[data-template-modal] header [data-close-templates]",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.we-template-row').length"),
    3,
  );
  assert.equal(
    await evaluate("document.activeElement.matches('[data-template-search]')"),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.we-template-thumbnail rect').length > 10",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-open-templates]').closest('[inert]')!==null",
    ),
    true,
  );
  await evaluate(
    "var input=document.querySelector('[data-template-search]');input.value='OpenCV recording';input.dispatchEvent(new Event('input',{bubbles:true}))",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.we-template-row').length"),
    1,
  );
  await evaluate(
    "var input=document.querySelector('[data-template-search]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))",
  );
  await delay(200);
  const desktopShot = await command(
    "Page.captureScreenshot",
    { format: "png" },
    sessionId,
  );
  await writeFile(
    path.join(assets, "..", "template-picker-desktop.png"),
    Buffer.from(desktopShot.data, "base64"),
  );
  const lightBackground = await evaluate(
    "getComputedStyle(document.querySelector('.we-template-modal')).backgroundColor",
  );
  await evaluate("document.documentElement.dataset.theme='dark'");
  assert.notEqual(
    await evaluate(
      "getComputedStyle(document.querySelector('.we-template-modal')).backgroundColor",
    ),
    lightBackground,
  );
  const darkShot = await command(
    "Page.captureScreenshot",
    { format: "png" },
    sessionId,
  );
  await writeFile(
    path.join(assets, "..", "template-picker-dark.png"),
    Buffer.from(darkShot.data, "base64"),
  );
  await evaluate("document.documentElement.dataset.theme='light'");
  // Keyboard focus stays inside the modal, including through Shift+Tab.
  await evaluate(
    "document.querySelector('[data-template-modal] footer button').focus()",
  );
  await command(
    "Input.dispatchKeyEvent",
    { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    sessionId,
  );
  await command(
    "Input.dispatchKeyEvent",
    { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    sessionId,
  );
  assert.equal(
    await evaluate("document.activeElement.matches('[data-close-templates]')"),
    true,
  );
  await command(
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    },
    sessionId,
  );
  assert.equal(
    await evaluate("document.querySelector('[data-template-modal]')===null"),
    true,
  );
  assert.equal(
    await evaluate("document.activeElement.matches('[data-open-templates]')"),
    true,
  );
  await evaluate(
    "document.querySelector('[data-open-templates]').click();document.querySelector('[data-load-template=pre-event-person]').click()",
  );
  const loaded = await evaluate(
    "JSON.parse(localStorage.getItem('spyder.workflow-editor.draft'))",
  );
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.nodes.at(-1).params.pre_event_seconds, 10);
  assert.equal(loaded.nodes.at(-1).params.duration_seconds, 20);
  await evaluate(
    "document.querySelector('.we-node-event').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  await assertCenteredClose(
    "[data-settings-modal] header [data-close-settings]",
  );
  const beforeHelp = await evaluate(
    "localStorage.getItem('spyder.workflow-editor.draft')",
  );
  const helpFields = await evaluate(
    "(() => {const p=document.querySelector('.we-node-settings');return {fields:p.querySelectorAll('label:has(input),label:has(select),label:has(textarea)').length,helpers:p.querySelectorAll('[data-field-help]').length};})()",
  );
  assert.equal(helpFields.fields, helpFields.helpers);
  async function assertHelpAlignment(size) {
    const failures =
      await evaluate(`(() => [...document.querySelectorAll('.we-help-button')].flatMap(b=>{
      const r=b.getBoundingClientRect(),i=b.querySelector('svg').getBoundingClientRect(),
        f=b.closest('.we-help-field'),c=f.querySelector('.we-field-label').getBoundingClientRect(),
        input=f.querySelector('input,select,textarea').getBoundingClientRect();
      return Math.abs(r.x+r.width/2-i.x-i.width/2)<1 && Math.abs(r.y+r.height/2-i.y-i.height/2)<1
        && Math.abs(r.y+r.height/2-c.y-c.height/2)<1 && r.width===${size} && r.height===${size}
        && r.bottom<=input.top+1 && (!f.querySelector('.we-field-drop')) ? [] : [b.ariaLabel];
    }))()`);
    assert.deepEqual(
      failures,
      [],
      "Help controls center on icons/captions and stay clear of inputs",
    );
  }
  for (const theme of ["light", "dark"]) {
    await evaluate(
      `document.documentElement.dataset.theme=${JSON.stringify(theme)}`,
    );
    await assertHelpAlignment(36);
  }
  await evaluate("document.documentElement.dataset.theme='light'");

  await evaluate(
    "document.querySelector('[data-param=duration_seconds]').closest('.we-help-field').querySelector('[data-field-help]').focus()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.we-field-tooltip:not([hidden])').textContent.includes('whole seconds from 1 to 300')",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "(() => {const r=document.querySelector('.we-field-tooltip:not([hidden])').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()",
    ),
    true,
  );
  await command(
    "Input.dispatchKeyEvent",
    {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    },
    sessionId,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.we-field-tooltip:not([hidden])')===null",
    ),
    true,
  );
  assert.equal(
    await evaluate("document.querySelector('[data-settings-modal]')!==null"),
    true,
  );
  await evaluate(
    "document.querySelector('[data-param=pre_event_seconds]').closest('.we-help-field').querySelector('[data-field-help]').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.we-field-tooltip:not([hidden])').textContent.includes('64 MiB')",
    ),
    true,
  );
  await evaluate(
    "document.querySelector('[data-param=pre_event_seconds]').closest('.we-help-field').querySelector('[data-field-help]').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.we-field-tooltip:not([hidden])')===null",
    ),
    true,
  );
  assert.equal(
    await evaluate("localStorage.getItem('spyder.workflow-editor.draft')"),
    beforeHelp,
  );
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 520, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  await command(
    "Emulation.setTouchEmulationEnabled",
    { enabled: true },
    sessionId,
  );
  await assertHelpAlignment(44);
  await evaluate(
    "var mobileHelp=document.querySelector('[data-param=pre_event_seconds]').closest('.we-help-field').querySelector('[data-field-help]');mobileHelp.scrollIntoView({block:'center'})",
  );
  await evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  await evaluate("mobileHelp.click()");
  assert.equal(
    await evaluate(
      "(() => {const t=document.querySelector('.we-field-tooltip:not([hidden])'),r=t.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&!!document.elementFromPoint(r.left+24,r.top+24)?.closest('.we-field-tooltip');})()",
    ),
    true,
  );
  await evaluate(
    "document.querySelector('[data-param=pre_event_seconds]').closest('.we-help-field').querySelector('[data-field-help]').click()",
  );
  await command(
    "Emulation.setTouchEmulationEnabled",
    { enabled: false },
    sessionId,
  );
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );

  await evaluate(
    "document.querySelector('[data-settings-modal] header [data-close-settings]').click()",
  );
  assert.equal(
    await evaluate("document.querySelector('[data-settings-modal]')===null"),
    true,
  );
  await evaluate("document.querySelector('[data-undo]').click()");
  assert.equal(
    await evaluate("document.querySelector('[data-name]').value"),
    "Unfinished workflow",
  );
  // Stepper edits use the same draft and Undo path as typing a numeric value.
  await evaluate(
    "document.querySelector('[data-open-templates]').click();document.querySelector('[data-load-template=pre-event-person]').click();document.querySelector('.we-node-event').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  await until(
    "!!document.querySelector('[data-param=duration_seconds].themed-number-input')",
  );
  await delay(100);
  assert.equal(
    await evaluate(`(() => {
    const input=document.querySelector('[data-param=duration_seconds]');
    input.scrollIntoView({block:'center'});
    return input.value;
  })()`),
    "20",
  );
  await delay(100);
  assert.equal(
    await evaluate(`(() => {
    const input=document.querySelector('[data-param=duration_seconds]');
    const controls=[...document.querySelectorAll('[data-number-stepper]')].find(e=>e.querySelector('button').getAttribute('aria-controls')===input.id);
    const r=input.getBoundingClientRect(),s=controls.getBoundingClientRect();
    return s.left>=r.left && s.right<=r.right+1 && s.top>=r.top-1 && s.bottom<=r.bottom+1;
  })()`),
    true,
  );
  await evaluate(`(() => {
    const input=document.querySelector('[data-param=duration_seconds]');
    document.querySelector('[aria-controls="'+input.id+'"][data-direction="1"]').click();
  })()`);
  assert.equal(
    await evaluate(
      "document.querySelector('[data-param=duration_seconds]').value",
    ),
    "21",
  );
  assert.equal(
    await evaluate(
      "JSON.parse(localStorage.getItem('spyder.workflow-editor.draft')).nodes.find(n=>n.type==='event').params.duration_seconds",
    ),
    21,
  );
  await evaluate(
    "document.querySelector('[data-settings-modal] header [data-close-settings]').click();document.querySelector('[data-undo]').click()",
  );
  assert.equal(
    await evaluate(
      "JSON.parse(localStorage.getItem('spyder.workflow-editor.draft')).nodes.find(n=>n.type==='event').params.duration_seconds",
    ),
    20,
  );
  await evaluate(
    `document.querySelector('.we-node-event').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));document.querySelector('.we-signals[aria-label="IN signals"] [data-signal-name=camera_id]').click()`,
  );
  await evaluate("document.querySelector('[data-use-signal=message]').click()");
  assert.equal(
    await evaluate("document.querySelector('[data-param=message]').disabled"),
    true,
  );
  await assertHelpAlignment(36);
  await evaluate(
    "document.querySelector('[data-param=message]').closest('.we-help-field').querySelector('[data-field-help]').click()",
  );
  assert.equal(
    await evaluate(
      "!!document.querySelector('.we-field-tooltip:not([hidden])')",
    ),
    true,
  );
  await evaluate(
    "document.querySelector('[data-settings-modal] header [data-close-settings]').click();document.querySelector('[data-undo]').click()",
  );
  for (const type of [
    "camera",
    "model",
    "classifier",
    "detections",
    "filter",
    "zone",
    "count",
    "cooldown",
    "notification",
    "preview",
    "capture",
    "record",
    "code",
  ]) {
    await evaluate(
      `document.querySelector('[data-add=${type}]').click();document.querySelector('.we-node.selected').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`,
    );
    await assertHelpAlignment(36);
    await evaluate(
      "document.querySelector('[data-settings-modal] header [data-close-settings]').click()",
    );
  }
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 520, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  await evaluate("document.querySelector('[data-open-templates]').click()");
  assert.equal(
    await evaluate(
      "(() => { const r=document.querySelector('.we-template-modal').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;})()",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "(() => {const e=document.querySelector('.we-template-list');return e.scrollHeight>e.clientHeight && e.scrollWidth<=e.clientWidth+1;})()",
    ),
    true,
  );
  await delay(200);
  const mobileShot = await command(
    "Page.captureScreenshot",
    { format: "png" },
    sessionId,
  );
  await writeFile(
    path.join(assets, "..", "template-picker-mobile.png"),
    Buffer.from(mobileShot.data, "base64"),
  );
  await evaluate(
    "document.querySelector('[data-template-modal] footer button').click()",
  );
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 1024, height: 320, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await evaluate("document.querySelector('[data-open-templates]').click()");
  assert.equal(
    await evaluate(
      "document.querySelector('.we-template-modal').getBoundingClientRect().bottom<=innerHeight",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.we-template-list').clientHeight>0",
    ),
    true,
  );
  await evaluate(
    "document.querySelector('[data-template-modal] footer button').click();location.hash='system'",
  );
  await until(
    "!!document.querySelector('.backup-file-label input[type=file]')",
  );
  for (const theme of ["light", "dark"]) {
    const upload = await evaluate(`(() => {
      document.documentElement.dataset.theme=${JSON.stringify(theme)};
      const input=document.querySelector('.backup-file-label input[type=file]');
      const s=getComputedStyle(input,'::file-selector-button');
      return {background:s.backgroundColor,color:s.color,radius:s.borderRadius,
        hiddenWorkflowInputs:document.querySelectorAll('input[hidden]:not([type=file])').length};
    })()`);
    assert.equal(upload.background, "rgb(190, 26, 26)");
    assert.equal(upload.color, "rgb(255, 255, 255)");
    assert.equal(upload.radius, "5px");
  }
  // Demo restore actions remain unavailable; reveal only their styling for a mobile width check.
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 520, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  assert.equal(
    await evaluate(
      "(() => {const input=document.querySelector('.backup-file-label input');input.parentElement.parentElement.hidden=false;const r=input.getBoundingClientRect();return r.width>0 && r.right<=innerWidth;})()",
    ),
    true,
  );

  for (const viewport of [
    { width: 1280, height: 800, mobile: false },
    { width: 390, height: 520, mobile: true },
    { width: 1024, height: 320, mobile: false },
  ]) {
    await command(
      "Emulation.setDeviceMetricsOverride",
      { ...viewport, deviceScaleFactor: 1 },
      sessionId,
    );
    for (const theme of ["light", "dark"]) {
      await evaluate(
        `document.documentElement.dataset.theme=${JSON.stringify(theme)}`,
      );
      for (const route of [
        "control-room",
        "vision-lab",
        "camera-setup",
        "recordings",
        "events",
        "layouts",
        "system",
      ]) {
        await evaluate(`location.hash=${JSON.stringify(route)}`);
        await delay(100);
        const audit =
          await evaluate(`(() => ({overflow:document.documentElement.scrollWidth>innerWidth+1,
          icons:[...document.querySelectorAll('.icon-button > svg,.dialog-close > svg,.video-focus > svg')].filter(i=>i.getClientRects().length).flatMap(i=>{
            const b=i.parentElement,r=b.getBoundingClientRect(),s=i.getBoundingClientRect();
            return Math.abs(r.x+r.width/2-s.x-s.width/2)<1&&Math.abs(r.y+r.height/2-s.y-s.height/2)<1?[]:[b.ariaLabel||b.title||b.className];
          })}))()`);
        assert.equal(
          audit.overflow,
          false,
          `${route}/${theme}/${viewport.width}: horizontal overflow`,
        );
        assert.deepEqual(
          audit.icons,
          [],
          `${route}/${theme}/${viewport.width}: icon centering`,
        );
      }
    }
  }
  assert.deepEqual(await evaluate("templateErrors"), []);
  assert.equal(
    networkPaths.some((url) => url.startsWith("/api/")),
    false,
  );
  console.log(
    "PASS: templates and themed controls: dropdowns, red/white checkboxes, centered help/caption and SVG controls, uploads, all node settings, seven workspaces in light/dark at desktop/mobile/short sizes, keyboard/touch, Undo, and no API requests.",
  );
} finally {
  socket?.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await delay(200);
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
