// Real mouse hit-testing regression. Run: node tests/fullscreen-browser.mjs <showcase-dir>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    throw new Error("Timed out: " + expression);
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
  await until("!!window.spyderLayouts && spyder.cameras().length===2");
  await evaluate(
    "window.layoutErrors=[];window.addEventListener('error',e=>layoutErrors.push(e.message));navigator.mediaDevices.getUserMedia=()=>{throw new Error('Unexpected camera access')};location.hash='layouts'",
  );
  await until("!!document.querySelector('#dummy-count')");
  await change("layout-viewport", "9 / 16");
  assert.ok(
    await evaluate(
      "(() => {const r=document.querySelector('#layout-preview').getBoundingClientRect();return Math.abs(r.width/r.height-9/16)<0.02;})()",
    ),
    "Portrait preview must preserve the selected screen ratio",
  );
  await change("layout-viewport", "16 / 9");
  await change("dummy-ratio", "1:1");
  await click("Add dummy cameras");
  assert.equal(
    await evaluate("document.querySelectorAll('#layout-preview > div').length"),
    6,
  );
  assert.equal(
    (await visible()).length,
    2,
    "Draft dummies must not change actual wall",
  );
  await evaluate(
    "document.querySelector('#layout-name').value='Security wall';document.querySelector('#layout-name').dispatchEvent(new Event('input'))",
  );
  await evaluate(
    "const row=[...document.querySelectorAll('.layout-camera-row')].find(r=>r.dataset.id==='cam-demo-south');row.querySelector('input').click()",
  );
  await click("Featured view");
  await change("layout-featured", "dummy-unused");
  await evaluate(
    "const select=document.querySelector('#layout-featured');select.value=[...select.options].find(o=>o.value.startsWith('dummy-')).value;select.dispatchEvent(new Event('change'));const rows=[...document.querySelectorAll('.layout-camera-row')];rows[2].querySelector('button').click()",
  );
  await click("Save & apply");
  assert.equal((await visible()).length, 5);
  assert.equal(
    await evaluate("spyder.cameras().length"),
    2,
    "Layout must not change camera/CV/recording registry",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#cameras > [data-dummy]').length",
    ),
    4,
  );
  const beforeGap = await evaluate(
    "document.querySelector('#cameras').style.getPropertyValue('--layout-gap')",
  );
  await change("layout-gap", 24);
  await click("Save draft");
  assert.equal(
    await evaluate(
      "document.querySelector('#cameras').style.getPropertyValue('--layout-gap')",
    ),
    beforeGap,
    "Draft save must not update active wall",
  );
  await click("Save & apply");
  assert.equal(
    await evaluate(
      "document.querySelector('#cameras').style.getPropertyValue('--layout-gap')",
    ),
    "24px",
  );
  await evaluate("location.hash='control-room'");
  await until("!document.querySelector('#control-room').hidden");
  await command("Page.reload", {}, sessionId);
  await until(
    "!!window.spyderLayouts && spyder.cameras().length===2 && document.querySelectorAll('#cameras > [data-dummy]').length===4",
  );
  await evaluate(
    "window.layoutErrors=[];window.addEventListener('error',e=>layoutErrors.push(e.message));navigator.mediaDevices.getUserMedia=()=>{throw new Error('Unexpected camera access')}",
  );
  assert.equal(
    (await visible()).length,
    5,
    "Applied visibility and dummies survive reload",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#wall-layout-choice').selectedOptions[0].text",
    ),
    "Security wall",
  );
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await evaluate("spyderWall.enter()");
  await delay(150);
  assert.equal(
    await evaluate("!!document.querySelector('#wall-layout-fullscreen')"),
    true,
  );
  const bounds = await evaluate(
    "(() => {const wall=document.querySelector('#cameras').getBoundingClientRect();return [...document.querySelectorAll('#cameras>.camera-card:not([hidden])')].map(c=>{const r=c.getBoundingClientRect();return r.bottom<=wall.bottom+1&&r.right<=wall.right+1;});})()",
  );
  assert.ok(
    bounds.every(Boolean),
    "Featured fullscreen tiles must stay inside wall",
  );
  await evaluate("spyderWall.exit();location.hash='layouts'");
  await until("!!document.querySelector('#layout-mode')");
  await change("layout-mode", "sequence");
  await change("layout-interval", 3);
  await click("Save & apply");
  await evaluate("location.hash='control-room'");
  await until("!document.querySelector('#control-room').hidden");
  const first = (await visible()).at(-1);
  await click("Next view");
  assert.notEqual((await visible()).at(-1), first);
  await click("Pause rotation");
  const paused = (await visible()).at(-1);
  await delay(3300);
  assert.equal(
    (await visible()).at(-1),
    paused,
    "Paused rotation must hold its camera",
  );
  await evaluate(
    "spyderWall.enter();document.querySelector('#wall-rotation-pause').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#wall-rotation-pause').textContent",
    ),
    "Pause rotation",
  );
  await evaluate("spyderWall.exit();location.hash='layouts'");
  await until("!!document.querySelector('#layout-mode')");
  await change("layout-mode", "featured");
  await click("Save & apply");
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 700, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await delay(100);
  assert.equal(
    await evaluate("document.documentElement.scrollWidth<=innerWidth"),
    true,
    "Editor must fit mobile width",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#layout-preview').dataset.layoutColumns",
    ),
    "1",
  );
  await evaluate("location.hash='control-room'");
  await until("!document.querySelector('#control-room').hidden");
  assert.equal(
    await evaluate("document.querySelector('#cameras').dataset.layoutColumns"),
    "1",
  );
  assert.equal(
    await evaluate("document.documentElement.scrollWidth<=innerWidth"),
    true,
    "Wall must fit mobile width",
  );
  await evaluate("location.hash='layouts'");
  await until("!!document.querySelector('#layout-import')");
  await evaluate(
    `(() => {const config=JSON.parse(localStorage.getItem('spyder-layouts-v1-showcase')).applied;config.name='Imported wall';const file=new File([JSON.stringify(config)],'wall.json',{type:'application/json'});const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('#layout-import');input.files=transfer.files;input.dispatchEvent(new Event('change'));})()`,
  );
  await until("document.querySelector('#layout-name').value==='Imported wall'");
  assert.equal(
    await evaluate(
      "document.querySelector('#wall-layout-choice').selectedOptions[0].text",
    ),
    "Security wall",
    "Import is draft only",
  );
  await click("Save & apply");
  assert.equal(
    await evaluate(
      "document.querySelector('#wall-layout-choice').selectedOptions[0].text",
    ),
    "Imported wall",
  );
  await change("dummy-count", 21);
  await click("Add dummy cameras");
  assert.ok(
    await evaluate(
      "document.querySelector('#layout-status').textContent.includes('24 total')",
    ),
  );
  await change("dummy-count", 20);
  await click("Add dummy cameras");
  await click("Save & apply");
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#cameras > [data-dummy]').length",
    ),
    24,
  );
  assert.equal(await evaluate("spyder.cameras().length"), 2);
  await evaluate("location.hash='control-room'");
  await until("!document.querySelector('#control-room').hidden");
  await change("wall-layout-choice", "");
  assert.equal((await visible()).length, 2);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#cameras > [data-dummy]').length",
    ),
    0,
  );
  assert.deepEqual(await evaluate("layoutErrors"), []);
  assert.equal(
    networkPaths.some((url) => url.startsWith("/api/")),
    false,
    "Static demo must not contact camera APIs",
  );
  console.log(
    "PASS: layout drafts/apply, generated cameras, featured fullscreen, reload persistence, rotation controls, mobile, imports and automatic-wall reset.",
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
