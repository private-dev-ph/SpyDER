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
    url: `http://127.0.0.1:${server.address().port}/#vision-lab`,
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
    for (let i = 0; i < 200; i++) {
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
  const openStudioPanel = async (name) => {
    await evaluate(
      `document.querySelector('.we-studio-menu').open=true;document.querySelector('[data-studio-open="${name}"]').click()`,
    );
    await until(
      `document.querySelector('dialog[data-studio-panel="${name}"]')?.open`,
    );
  };
  async function assertDrawerFill(name, selector, context) {
    const fit = await evaluate(`(() => {
      const dialog=document.querySelector('dialog[data-studio-panel="${name}"]'),content=dialog.querySelector('.we-studio-content'),panel=dialog.querySelector('${selector}');
      const p=panel.getBoundingClientRect(),c=content.getBoundingClientRect(),list=panel.querySelector('.we-palette');
      if(list) list.scrollTop=list.scrollHeight;
      return {panel:{width:p.width,height:p.height,left:p.left,right:p.right,top:p.top,bottom:p.bottom},content:{width:c.width,height:c.height,left:c.left,right:c.right,top:c.top,bottom:c.bottom},
        inset:{left:p.left-c.left,right:c.right-p.right,top:p.top-c.top,bottom:c.bottom-p.bottom},
        palette:list?{clientHeight:list.clientHeight,scrollHeight:list.scrollHeight,scrollTop:list.scrollTop,overflowY:getComputedStyle(list).overflowY}:null};
    })()`);
    assert.ok(fit.inset.left >= -1 && fit.inset.left <= 20 && fit.inset.right >= -1 && fit.inset.right <= 20, `${context}: drawer panel should fill content width ${JSON.stringify(fit)}`);
    assert.ok(fit.inset.top >= -1 && fit.inset.top <= 24 && fit.inset.bottom >= -1 && fit.inset.bottom <= 24, `${context}: drawer panel should use content height ${JSON.stringify(fit)}`);
    if (fit.palette) {
      assert.ok(fit.palette.clientHeight > 0, `${context}: palette has no available height`);
      assert.ok(fit.palette.scrollHeight > fit.palette.clientHeight, `${context}: palette should scroll at available height ${JSON.stringify(fit.palette)}`);
      assert.ok(fit.palette.scrollTop > 0, `${context}: palette cannot scroll`);
      assert.ok(["auto", "scroll"].includes(fit.palette.overflowY), `${context}: palette overflow is not scrollable`);
    }
  }
  async function assertLibraryFitsContent(context) {
    const fit = await evaluate(`(() => {
      const dialog=document.querySelector('dialog[data-studio-panel="models"]'),content=dialog.querySelector('.we-studio-content'),panel=dialog.querySelector('.we-library');
      const p=panel.getBoundingClientRect(),c=content.getBoundingClientRect();
      content.scrollTop=content.scrollHeight;
      const pages=dialog.querySelector('.we-library-pages').getBoundingClientRect();
      return {content:{left:c.left,right:c.right,top:c.top,bottom:c.bottom,height:content.clientHeight,scrollHeight:content.scrollHeight,scrollTop:content.scrollTop,overflowY:getComputedStyle(content).overflowY},
        panel:{left:p.left,right:p.right,top:p.top,bottom:p.bottom},pages:{top:pages.top,bottom:pages.bottom}};
    })()`);
    assert.ok(fit.panel.left >= fit.content.left - 2 && fit.panel.right <= fit.content.right + 2, `${context}: model library width exceeds drawer ${JSON.stringify(fit)}`);
    assert.ok(fit.content.scrollHeight > fit.content.height && fit.content.scrollTop > 0, `${context}: outer drawer cannot scroll to full library ${JSON.stringify(fit)}`);
    assert.ok(["auto", "scroll"].includes(fit.content.overflowY), `${context}: drawer content overflow is not scrollable`);
    assert.ok(fit.pages.bottom <= fit.content.bottom + 2, `${context}: model list pagination cannot be reached at drawer bottom ${JSON.stringify(fit)}`);
  }
  const closeStudioPanel = async (name) => {
    await evaluate(
      `document.querySelector('dialog[data-studio-panel="${name}"] [data-studio-close]').click()`,
    );
    await until(
      `!document.querySelector('dialog[data-studio-panel="${name}"]')?.open`,
    );
  };
  const openTemplates = async () => {
    await evaluate("document.querySelector('.we-studio-menu').open=true");
    await evaluate("document.querySelector('[data-open-templates]').click()");
    await until("!!document.querySelector('[data-template-modal]')");
  };
  const pressEscape = async () => {
    await command(
      "Input.dispatchKeyEvent",
      { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
      sessionId,
    );
    await command(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      sessionId,
    );
  };
  const pressDelete = async () => {
    await command(
      "Input.dispatchKeyEvent",
      { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
      sessionId,
    );
    await command(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
      sessionId,
    );
  };
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await until("!!window.spyder && spyder.cameras().length===2");
  await until("document.querySelector('#vision-mode-content')?.childElementCount>0");
  await evaluate(
    "window.templateErrors=[];window.addEventListener('error',e=>templateErrors.push(e.message));navigator.mediaDevices.getUserMedia=()=>{throw new Error('Unexpected camera access')};location.hash='vision-lab'",
  );
  await until("spyder.cameras().length===2 && !!document.querySelector('#vision-workflow-tab')");
  await command("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"no-preference"}]}, sessionId);
  assert.equal(await evaluate(`(() => {
    document.querySelector('#vision-gallery-tab').click();
    const panel=document.querySelector('#vision-mode-content');
    const running=panel.getAnimations().length;
    document.querySelector('#vision-motion-tab').click();
    return running===1 && panel.getAnimations().length===1;
  })()`),true,"Rapid section switching replaces the incoming animation");
  await command("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"reduce"}]}, sessionId);
  assert.equal(await evaluate(`(() => {document.querySelector('#vision-gallery-tab').click();return document.querySelector('#vision-mode-content').getAnimations().length===0;})()`),true,"Reduced motion skips section animation");
  await evaluate("document.querySelector('#vision-motion-tab').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
  assert.equal(await evaluate("document.activeElement.id"),"vision-gallery-tab","Vision navigator supports End key");
  assert.equal(await evaluate("document.querySelector('#vision-gallery-tab').getAttribute('aria-selected')"),"true","Focused tab retains selected state until activation");
  await command("Emulation.setEmulatedMedia", {features:[]}, sessionId);
  await evaluate("document.querySelector('#vision-workflow-tab').click()");
  await until("!!document.querySelector('[data-open-templates]')");
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('dialog[data-studio-panel]')].every(dialog=>!dialog.open)",
    ),
    true,
    "Studio drawers start closed",
  );
  const initialCanvas = await evaluate(`(() => {
    const canvas=document.querySelector('.we-canvas-wrap').getBoundingClientRect();
    return {width:canvas.width,height:canvas.height,nodes:document.querySelectorAll('.we-canvas [data-node]').length,
      draft:localStorage.getItem('spyder.workflow-editor.draft')};
  })()`);
  assert.ok(initialCanvas.width >= 500 && initialCanvas.height >= 240, JSON.stringify(initialCanvas));
  await openStudioPanel("nodes");
  assert.equal(
    await evaluate("document.querySelector('[data-studio-open=inspector]').textContent.trim()"),
    "Inspect node",
    "Visible inspector action is named Inspect node",
  );
  assert.equal(
    await evaluate("document.querySelector('dialog[data-studio-panel=inspector] header h3').textContent.trim()"),
    "Inspect node",
    "Inspector dialog title is named Inspect node",
  );
  await assertDrawerFill("nodes", ".we-sidebar", "desktop Nodes drawer");
  assert.equal(
    await evaluate("document.querySelector('dialog[data-studio-panel=nodes] [data-palette-search]')!==null"),
    true,
    "Node drawer exposes searchable palette",
  );
  await evaluate(`(() => {
    const search=document.querySelector('dialog[data-studio-panel=nodes] [data-palette-search]');
    search.value='filter';search.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  assert.equal(
    await evaluate("document.querySelectorAll('dialog[data-studio-panel=nodes] [data-add=filter]').length"),
    1,
  );
  await pressEscape();
  await until("!document.querySelector('dialog[data-studio-panel=nodes]')?.open");
  const nodesFocus = await evaluate(`({
    opener:document.activeElement.matches('[data-studio-open=nodes]'),
    active:document.activeElement.outerHTML.slice(0,160),
    menuOpen:document.querySelector('.we-studio-menu').open
  })`);
  assert.equal(nodesFocus.opener, true, `Escape returns focus to Nodes opener: ${JSON.stringify(nodesFocus)}`);
  assert.equal(
    await evaluate("document.querySelectorAll('.we-canvas [data-node]').length"),
    initialCanvas.nodes,
    "Escape closes drawer without changing canvas",
  );
  assert.equal(
    await evaluate("localStorage.getItem('spyder.workflow-editor.draft')"),
    initialCanvas.draft,
    "Escape preserves saved draft state",
  );
  await openStudioPanel("nodes");
  await evaluate("document.querySelector('dialog[data-studio-panel=nodes] [data-add=filter]').click()");
  await until("!document.querySelector('dialog[data-studio-panel=nodes]')?.open");
  assert.equal(
    await evaluate("document.querySelectorAll('.we-canvas [data-node]').length"),
    initialCanvas.nodes + 1,
    "Choosing a searched node adds it and closes the drawer",
  );
  assert.equal(
    await evaluate("document.activeElement.matches('.we-node-filter')"),
    true,
    "New node receives focus after drawer closes",
  );
  assert.equal(
    await evaluate("JSON.parse(localStorage.getItem('spyder.workflow-editor.draft')).nodes.length"),
    initialCanvas.nodes + 1,
    "Node addition persists in draft",
  );
  await openStudioPanel("inspector");
  const inspectorCounts = await evaluate("({nodes:document.querySelectorAll('.we-canvas [data-node]').length,edges:document.querySelectorAll('.we-canvas .we-wire').length})");
  for (const selector of ["[data-edit-selected]", "[data-copy-node]"]) {
    await evaluate(`document.querySelector('dialog[data-studio-panel=inspector] .we-inspector ${selector}')?.focus()`);
    await pressDelete();
    assert.deepEqual(
      await evaluate("({nodes:document.querySelectorAll('.we-canvas [data-node]').length,edges:document.querySelectorAll('.we-canvas .we-wire').length})"),
      inspectorCounts,
      `Delete key while ${selector} is focused preserves selected node and connections`,
    );
  }
  await closeStudioPanel("inspector");
  await evaluate("document.querySelector('.we-studio-menu').open=true;document.querySelector('[data-undo]').click()");
  assert.equal(
    await evaluate("document.querySelectorAll('.we-canvas [data-node]').length"),
    initialCanvas.nodes,
    "Undo restores canvas after drawer insertion",
  );
  await openStudioPanel("nodes");
  await evaluate(`(()=>{const search=document.querySelector('dialog[data-studio-panel=nodes] [data-palette-search]');search.value='';search.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await until("!!document.querySelector('dialog[data-studio-panel=nodes] [data-add=camera]')");
  const dragAdd = await evaluate(`(() => {
    const dialog=document.querySelector('dialog[data-studio-panel=nodes]');
    const add=dialog.querySelector('[data-add=camera]'),canvas=document.querySelector('[data-canvas]');
    const transfer=new DataTransfer();
    add.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    const closedDuringDrag=!dialog.open;
    const rect=canvas.getBoundingClientRect();
    canvas.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,
      clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2}));
    return {closedDuringDrag,nodes:document.querySelectorAll('.we-canvas [data-node]').length};
  })()`);
  assert.equal(dragAdd.closedDuringDrag, true, "Dragging a node closes the palette dialog");
  assert.equal(dragAdd.nodes, initialCanvas.nodes + 1, "Drag-add still creates a canvas node");
  await evaluate("document.querySelector('.we-studio-menu').open=true;document.querySelector('[data-undo]').click()");
  await openStudioPanel("settings");
  assert.equal(
    await evaluate("!!(document.querySelector('dialog[data-studio-panel=settings] [data-name]') && document.querySelector('dialog[data-studio-panel=settings] .we-history-settings'))"),
    true,
    "Settings drawer retains workflow identity and history controls",
  );
  // Check final theme colors without sampling halfway through a state transition.
  await command("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"reduce"}]}, sessionId);
  for (const theme of ["light", "dark"]) {
    const controls = await evaluate(`(() => {
      document.documentElement.dataset.theme=${JSON.stringify(theme)};
      const select=document.querySelector('[data-workflow]');
      const box=document.querySelector('[data-camera]');
      const checked=box.checked;
      box.checked=true;
      const selected=getComputedStyle(select), check=getComputedStyle(box);
      const result={appearance:selected.appearance, arrow:!!select.querySelector("svg"), popup:select.getAttribute("aria-haspopup"),
        padding:parseFloat(selected.paddingRight), red:check.backgroundColor,
        whiteCheck:check.backgroundImage.includes('white'), width:box.getBoundingClientRect().width};
      box.disabled=true;
      result.disabledCursor=getComputedStyle(box).cursor;
      box.disabled=false; box.checked=checked;
      return result;
    })()`);
    assert.equal(controls.popup, "dialog");
    assert.equal(controls.arrow, true);
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
  await closeStudioPanel("settings");
  await openStudioPanel("models");
  await assertDrawerFill("models", ".we-library", "desktop Models drawer");
  const modelCount = await evaluate("document.querySelectorAll('dialog[data-studio-panel=models] [data-library-model]').length");
  assert.equal(
    await evaluate("!!document.querySelector('dialog[data-studio-panel=models] [data-library-search]') && !!document.querySelector('dialog[data-studio-panel=models] [data-library-filter-engine]')"),
    true,
    "Models drawer exposes search and engine filters",
  );
  await evaluate(`(() => {
    const add=document.querySelector('.we-library-add'),register=add.querySelector('details');
    add.open=true;register.open=true;
    document.querySelector('[data-library-name]').value='Unfinished registration';
    const search=document.querySelector('[data-library-search]');search.value='render persistence check';search.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await until("document.querySelectorAll('dialog[data-studio-panel=models] [data-library-model]').length===0");
  assert.deepEqual(
    await evaluate("({addOpen:document.querySelector('.we-library-add').open,registerOpen:document.querySelector('.we-library-add details').open,name:document.querySelector('[data-library-name]').value})"),
    { addOpen: true, registerOpen: true, name: "Unfinished registration" },
    "Open Add/Register forms and unsaved name survive model-library rerender",
  );
  await evaluate(`(() => {
    const search=document.querySelector('dialog[data-studio-panel=models] [data-library-search]');
    search.value='no matching model for drawer regression';search.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  assert.equal(
    await evaluate("document.querySelectorAll('dialog[data-studio-panel=models] [data-library-model]').length"),
    0,
    "Model search filters library rows",
  );
  await evaluate("document.querySelector('dialog[data-studio-panel=models] [data-library-clear]').click()");
  assert.equal(
    await evaluate("document.querySelectorAll('dialog[data-studio-panel=models] [data-library-model]').length"),
    modelCount,
    "Clearing model filters restores results",
  );
  await evaluate("document.querySelector('.we-library-add').open=false;document.querySelector('.we-library-add details').open=false");
  await closeStudioPanel("models");
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
  await openStudioPanel("settings");
  await evaluate(
    "document.querySelector('[data-name]').value='Unfinished workflow';document.querySelector('[data-name]').dispatchEvent(new Event('input',{bubbles:true}))",
  );
  await closeStudioPanel("settings");
  await openTemplates();
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
    "var input=document.querySelector('[data-template-search]');input.value='unknown recording';input.dispatchEvent(new Event('input',{bubbles:true}))",
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
    await evaluate("document.activeElement.matches('.we-studio-menu > summary')"),
    true,
  );
  await openTemplates();
  await evaluate("document.querySelector('[data-load-template=pre-event-person]').click()");
  const loaded = await evaluate(
    "JSON.parse(localStorage.getItem('spyder.workflow-editor.draft'))",
  );
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.nodes.at(-1).params.pre_event_seconds, 10);
  assert.equal(loaded.nodes.at(-1).params.duration_seconds, 20);
  assert.equal(loaded.name, "Pre-event unknown face recording");
  assert.equal(
    loaded.nodes.find((n) => n.type === "model").params.model_id,
    "builtin-scrfd-500mf",
  );
  assert.equal(
    loaded.nodes.find((n) => n.type === "detections").params.engine,
    "insightface",
  );
  assert.ok(loaded.edges.some((e) => e.input === "classifier"));
  await evaluate("document.querySelector('.we-node-filter').click()");
  await openStudioPanel("inspector");
  const inspectorLayout = await evaluate(`(() => {
    const panel=document.querySelector('.we-inspector'),rule=panel.querySelector('.we-rule');
    return {widths:[...rule.querySelectorAll('input,select')].map(e=>e.getBoundingClientRect().width),
      removeHeight:panel.querySelector('[data-delete-node]').getBoundingClientRect().height,
      panelOverflow:panel.scrollWidth>panel.clientWidth+1,scrollWidth:panel.scrollWidth,clientWidth:panel.clientWidth,
      children:[...panel.children].map(e=>({class:e.className,width:e.getBoundingClientRect().width,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}))};
  })()`);
  assert.ok(
    inspectorLayout.widths.every((w) => w >= 100),
    JSON.stringify(inspectorLayout),
  );
  assert.ok(inspectorLayout.removeHeight < 60, JSON.stringify(inspectorLayout));
  assert.equal(inspectorLayout.panelOverflow, false, JSON.stringify(inspectorLayout));
  await evaluate(
    "document.querySelector('.we-inspector').scrollIntoView({block:'start'})",
  );
  await delay(100);
  const inspectorShot = await command(
    "Page.captureScreenshot",
    { format: "png" },
    sessionId,
  );
  await writeFile(
    path.join(assets, "..", "node-inspector-fixed.png"),
    Buffer.from(inspectorShot.data, "base64"),
  );

  await closeStudioPanel("inspector");
  await evaluate(
    "document.querySelector('.we-node-filter').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(
    await evaluate("document.querySelector('[data-rule-key=operator]').value"),
    "is_unknown",
  );
  assert.equal(
    await evaluate("document.querySelector('[data-rule-key=value]').disabled"),
    true,
  );
  await evaluate(
    "document.querySelector('[data-settings-modal] header [data-close-settings]').click()",
  );
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
      const aligned=Math.abs(r.x+r.width/2-i.x-i.width/2)<1 && Math.abs(r.y+r.height/2-i.y-i.height/2)<1
        && Math.abs(r.y+r.height/2-c.y-c.height/2)<1 && r.width===${size} && r.height===${size}
        && r.bottom<=input.top+1 && (!f.querySelector('.we-field-drop'));
      return aligned ? [] : [{label:b.ariaLabel,field:f.querySelector('.we-field-label').textContent.trim(),button:[r.x,r.y,r.width,r.height],icon:[i.x,i.y,i.width,i.height],caption:[c.x,c.y,c.width,c.height],input:[input.x,input.y,input.width,input.height]}];
    }))()`);
    assert.deepEqual(
      failures,
      [],
      `Help controls center on icons/captions and stay clear of inputs: ${JSON.stringify(failures)}`,
    );
  }
  for (const theme of ["light", "dark"]) {
    await evaluate(
      `document.documentElement.dataset.theme=${JSON.stringify(theme)}`,
    );
    await assertHelpAlignment(44);
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
  await openTemplates();
  await evaluate("document.querySelector('[data-load-template=pre-event-person]').click()");
  await evaluate("document.querySelector('.we-node-event').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
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
  await assertHelpAlignment(44);
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
  async function assertSettingsFit(selector, context) {
    const failures = await evaluate(`(() => {
      const pane=document.querySelector(${JSON.stringify(selector)}),grid=pane.querySelector('.we-parameter-fields'),bounds=grid.getBoundingClientRect();
      const failures=[];
      for (const field of grid.querySelectorAll('input:not([type=checkbox]),select,textarea')) {
        const r=field.getBoundingClientRect();
        if(r.width<100||r.left<bounds.left-1||r.right>bounds.right+1) failures.push(field.dataset.param||field.dataset.ruleKey||'field');
      }
      for (const rule of grid.querySelectorAll('.we-rule')) {
        const rects=[...rule.children].filter(e=>!e.matches('.number-stepper')).map(e=>e.getBoundingClientRect());
        for(let i=0;i<rects.length;i++) for(let j=i+1;j<rects.length;j++) {
          const a=rects[i],b=rects[j];
          if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1) failures.push('overlapping rule fields');
        }
      }
      if(grid.scrollWidth>grid.clientWidth+1) failures.push('grid overflow');
      return failures;
    })()`);
    assert.deepEqual(failures, [], context);
  }
  async function assertStudioPanelFit(name, context) {
    const fit = await evaluate(`(() => {
      const dialog=document.querySelector('dialog[data-studio-panel="${name}"]'),r=dialog.getBoundingClientRect();
      dialog.scrollTop=dialog.scrollHeight;
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,
        pageOverflow:document.documentElement.scrollWidth>innerWidth+1,
        panelOverflow:dialog.scrollWidth>dialog.clientWidth+1,
        contentHeight:dialog.clientHeight,scrollHeight:dialog.scrollHeight,scrollTop:dialog.scrollTop};
    })()`);
    assert.ok(fit.left >= -1 && fit.right <= fit.viewportWidth + 1 && fit.top >= -1 && fit.bottom <= fit.viewportHeight + 1,
      `${context}: panel bounds ${JSON.stringify(fit)}`);
    assert.equal(fit.pageOverflow, false, `${context}: page overflow ${JSON.stringify(fit)}`);
    assert.equal(fit.panelOverflow, false, `${context}: panel overflow ${JSON.stringify(fit)}`);
    assert.ok(fit.contentHeight > 0, `${context}: no visible dialog content`);
    if (fit.scrollHeight > fit.contentHeight + 1)
      assert.ok(fit.scrollTop > 0, `${context}: dialog content cannot scroll`);
  }
  const nodeTypes = [
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
  ];
  for (const type of nodeTypes) {
    await openStudioPanel("nodes");
    await evaluate(`document.querySelector('dialog[data-studio-panel=nodes] [data-add=${type}]').click()`);
    await closeStudioPanel("nodes");
    if (type === "filter")
      {
        await openStudioPanel("inspector");
        await evaluate(
          "document.querySelector('.we-inspector [data-add-rule]').click();document.querySelector('.we-inspector [data-add-rule]').click()",
        );
        await closeStudioPanel("inspector");
      }
    for (const viewport of [
      { width: 1280, height: 800, mobile: false },
      { width: 960, height: 700, mobile: false },
      { width: 390, height: 520, mobile: true },
      { width: 320, height: 420, mobile: true },
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
        await evaluate(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        await openStudioPanel("inspector");
        await assertSettingsFit(
          ".we-inspector",
          `${type}/inspector/${viewport.width}/${theme}`,
        );
        await closeStudioPanel("inspector");
        await evaluate(
          "document.querySelector('.we-node.selected').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
        );
        await assertHelpAlignment(44);
        await assertSettingsFit(
          ".we-node-settings",
          `${type}/dialog/${viewport.width}/${theme}`,
        );
        await evaluate(
          "document.querySelector('[data-settings-modal] header [data-close-settings]').click()",
        );
      }
    }
    await command(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 },
      sessionId,
    );
  }
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 520, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  await openTemplates();
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
    { width: 375, height: 720, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  for (const name of ["nodes", "settings", "inspector", "models", "activity"]) {
    await openStudioPanel(name);
    await assertStudioPanelFit(name, `phone ${name}`);
    if (name === "nodes") await assertDrawerFill(name, ".we-sidebar", "phone Nodes drawer");
    if (name === "models") await assertDrawerFill(name, ".we-library", "phone Models drawer");
    await closeStudioPanel(name);
  }
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 1024, height: 320, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await openTemplates();
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
  await evaluate("document.querySelector('[data-template-modal] footer button').click()");
  for (const name of ["nodes", "settings", "inspector", "models", "activity"]) {
    await openStudioPanel(name);
    await assertStudioPanelFit(name, `short landscape ${name}`);
    if (name === "nodes") await assertDrawerFill(name, ".we-sidebar", "short landscape Nodes drawer");
    if (name === "models") await assertLibraryFitsContent("short landscape Models drawer");
    await closeStudioPanel(name);
  }
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 375, height: 720, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  await openStudioPanel("nodes");
  await assertStudioPanelFit("nodes", "375x720 Nodes drawer");
  await assertDrawerFill("nodes", ".we-sidebar", "375x720 Nodes drawer");
  await closeStudioPanel("nodes");
  await openStudioPanel("models");
  await assertStudioPanelFit("models", "375x720 Models drawer");
  await assertDrawerFill("models", ".we-library", "375x720 Models drawer");
  const registerReach = await evaluate(`(() => {
    const content=document.querySelector('dialog[data-studio-panel=models] .we-studio-content'),outer=document.querySelector('.we-library-add'),inner=outer.querySelector('details');
    outer.open=true;inner.open=true;content.scrollTop=0;
    const selectors=['[data-upload-model]','[data-library-file]','[data-library-name]','[data-library-path]','[data-register-model]'];
    const controls=selectors.map(selector=>{const element=document.querySelector(selector);element.scrollIntoView({block:'center'});const r=element.getBoundingClientRect(),c=content.getBoundingClientRect();return {selector,width:r.width,height:r.height,inside:r.width>0&&r.height>0&&r.top>=c.top-1&&r.bottom<=c.bottom+1,scrollTop:content.scrollTop}});
    content.scrollTop=content.scrollHeight;
    const pages=document.querySelector('.we-library-pages').getBoundingClientRect(),c=content.getBoundingClientRect();
    const library=document.querySelector('.we-library');
    return {controls,pagesVisible:pages.width>0&&pages.height>0&&pages.bottom<=c.bottom+1,scrollTop:content.scrollTop,scrollHeight:content.scrollHeight,clientHeight:content.clientHeight,overflowY:getComputedStyle(content).overflowY,libraryScroll:[library.scrollTop,library.scrollHeight,library.clientHeight,getComputedStyle(library).overflowY],pagesRect:[pages.top,pages.bottom],contentRect:[c.top,c.bottom],detailsOpen:outer.open&&inner.open};
  })()`);
  assert.equal(registerReach.detailsOpen, true, "Add and register sections can both expand on mobile");
  assert.ok(registerReach.controls.every((control) => control.inside), `Every Add/Register control can be scrolled into view: ${JSON.stringify(registerReach)}`);
  assert.equal(registerReach.pagesVisible, true, `Model library pagination reachable at drawer end: ${JSON.stringify(registerReach)}`);
  assert.ok(registerReach.scrollTop > 0 && registerReach.scrollHeight > registerReach.clientHeight, `Model drawer content scrolls naturally: ${JSON.stringify(registerReach)}`);
  await closeStudioPanel("models");
  await openStudioPanel("inspector");
  await evaluate("location.hash='system'");
  await until("!!document.querySelector('.backup-file-label input[type=file]')");
  await command("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"no-preference"}]}, sessionId);
  assert.equal(await evaluate(`(() => {
    document.querySelector('[data-system-tab=storage]').click();
    return document.querySelector('#system-storage-panel').getAnimations().length===1;
  })()`),true,"System section changes animate incoming content");
  await command("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion",value:"reduce"}]}, sessionId);
  assert.equal(await evaluate(`(() => {
    document.querySelector('[data-system-tab=backups]').click();
    return document.querySelector('#system-backups').getAnimations().length===0 && document.querySelector('#system-storage-panel').getAnimations().length===0;
  })()`),true,"Reduced motion and leaving a section cancel movement");
  await command("Emulation.setEmulatedMedia", {features:[]}, sessionId);
  assert.equal(
    await evaluate("document.querySelectorAll('dialog[data-studio-panel][open]').length"),
    0,
    "Leaving Vision Lab removes all open studio dialogs",
  );
  assert.equal(
    await evaluate("document.querySelector('#main-content').querySelector('[inert]')===null"),
    true,
    "Leaving Vision Lab does not leave inert content behind",
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
      "(() => {document.querySelector('[data-system-tab=backups]').click();document.querySelector('#browser-settings-tools').open=true;const input=document.querySelector('.backup-file-label input');input.parentElement.parentElement.hidden=false;const r=input.getBoundingClientRect();return r.width>0 && r.right<=innerWidth;})()",
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
        if (route === "vision-lab") {
          await evaluate(
            "document.querySelector('#vision-gallery-tab').click()",
          );
          await until(
            "!!document.querySelector('#face-gallery-tools .dt-card')",
          );
          assert.equal(
            await evaluate(
              "document.querySelector('#face-gallery-tools [data-create]').disabled",
            ),
            true,
          );
        }
        if (route === "camera-setup") {
          await until(
            "!!document.querySelector('#onvif-camera-tools .dt-card')",
          );
          assert.equal(
            await evaluate(
              "document.querySelector('#onvif-camera-tools [data-discover]').disabled",
            ),
            true,
          );
        }
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
  // Icon actions retain their names and work in the static export, at both sizes.
  await evaluate("location.hash='vision-lab'");
  await until("!!document.querySelector('#vision-workflow-tab')");
  await evaluate("document.querySelector('#vision-workflow-tab').click()");
  await until("!!document.querySelector('[data-undo].we-action-button')");
  const sprite = await readFile(path.join(assets, "icons.svg"), "utf8");
  for (const viewport of [
    {width: 1280, height: 800, deviceScaleFactor: 1, mobile: false},
    {width: 375, height: 720, deviceScaleFactor: 1, mobile: true},
  ]) {
    await command("Emulation.setDeviceMetricsOverride", viewport, sessionId);
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const actions = await evaluate(`([...document.querySelectorAll('.workflow-editor .we-action-button')]
      .filter(b=>b.getClientRects().length).map(b=>({name:b.getAttribute('aria-label'),
      href:b.querySelector('use')?.getAttribute('href'), width:b.getBoundingClientRect().width,
      height:b.getBoundingClientRect().height, caption:getComputedStyle(b.querySelector('.we-action-label')).position})))`);
    assert.ok(actions.length >= 10);
    for (const action of actions) {
      assert.ok(action.name, "Every icon action has an accessible name");
      assert.ok(action.width >= 43.9 && action.height >= 43.9, `${action.name}: touch target`);
      assert.equal(action.caption, "absolute", `${action.name}: text is visually hidden`);
      assert.ok(sprite.includes(`id="${action.href.split('#')[1]}"`), `${action.name}: bundled SVG symbol`);
    }
    await evaluate("document.querySelector('[data-undo]').focus()");
    const tooltip = await evaluate(`(() => {const t=document.querySelector('#we-action-tooltip'),r=t.getBoundingClientRect();
      return {label:t.textContent,open:t.matches(':popover-open'),inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,
      described:document.querySelector('[data-undo]').getAttribute('aria-describedby')};})()`);
    assert.equal(tooltip.label, "Undo");
    assert.equal(tooltip.open, true);
    assert.equal(tooltip.inside, true);
    assert.equal(tooltip.described, "we-action-tooltip");
    await command("Input.dispatchKeyEvent", {type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27}, sessionId);
    assert.equal(await evaluate("document.querySelector('#we-action-tooltip').hidden"), true);
    // Icon actions keep the existing delegated handler and open the drawer.
    await evaluate("document.querySelector('[data-studio-open=inspector]').click()");
    await until("document.querySelector('[data-studio-panel=inspector]').open");
    await evaluate("document.querySelector('[data-studio-panel=inspector] [data-connect]').focus()");
    assert.equal(await evaluate("document.querySelector('#we-action-tooltip').textContent"), "Connect");
    await closeStudioPanel("inspector");
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
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
