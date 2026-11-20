// Template picker browser regression. Run: node scripts/tests/workflow-templates-browser.mjs <showcase-dir>
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
  for (let i = 0; i < 300; i++) {
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
    for (let i = 0; i < 300; i++) {
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
  await evaluate(
    `(async()=>{for(let i=0;i<1000;i++)await spyderWorkflowStore.save({id:'flow-'+i,name:'Workflow '+String(i).padStart(4,'0'),enabled:false,camera_ids:[],nodes:[],edges:[]})})()`,
  );
  await evaluate(
    "document.querySelector('[data-open-workflow-manager]').click()",
  );
  await until("document.querySelectorAll('.wm-row').length===25");
  assert.match(
    await evaluate("document.querySelector('.wm-summary').textContent"),
    /^1000 workflows/,
  );
  await evaluate(
    "document.querySelector('[name=size]').value='50';document.querySelector('[name=size]').dispatchEvent(new Event('change',{bubbles:true}))",
  );
  await until("document.querySelectorAll('.wm-row').length===50");
  for (const [theme, width, height] of [
    ["light", 1280, 800],
    ["dark", 390, 640],
    ["light", 640, 340],
    ["dark", 320, 480],
  ]) {
    await command(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: width < 500 },
      sessionId,
    );
    await evaluate(
      `document.documentElement.dataset.theme=${JSON.stringify(theme)}`,
    );
    await evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    const layout = await evaluate(
      `(()=>{const d=document.querySelector('dialog'),l=document.querySelector('.wm-list'),r=l.getBoundingClientRect();return{overflow:document.documentElement.scrollWidth>innerWidth,dialogHeight:d.getBoundingClientRect().height,listHeight:r.height,listScroll:l.scrollHeight>l.clientHeight,close:!!document.querySelector('.wm-close svg')}})()`,
    );
    assert.equal(
      layout.overflow,
      false,
      JSON.stringify({ theme, width, height, layout }),
    );
    assert.ok(layout.dialogHeight <= height);
    assert.ok(layout.listHeight > 35);
    assert.equal(layout.listScroll, true);
    assert.equal(layout.close, true);
    if (width === 1280) {
      const shot = await command(
        "Page.captureScreenshot",
        { format: "png" },
        sessionId,
      );
      await writeFile(
        path.join(assets, "../workflow-manager-desktop.png"),
        Buffer.from(shot.data, "base64"),
      );
    }
  }
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await evaluate(
    "document.querySelector('[name=query]').value='Workflow 0920';document.querySelector('[name=query]').dispatchEvent(new Event('input',{bubbles:true}))",
  );
  await until("document.querySelectorAll('.wm-row').length===1");
  await evaluate("document.querySelector('[data-action=open]').click()");
  await until("!document.querySelector('.workflow-manager')");
  assert.equal(
    await evaluate("document.querySelector('[data-name]').value"),
    "Workflow 0920",
  );
  await evaluate(
    "document.querySelector('[data-open-workflow-manager]').click()",
  );
  await until("document.querySelector('.wm-row')");
  await evaluate(
    "document.querySelector('[name=query]').value='Workflow 0920';document.querySelector('[name=query]').dispatchEvent(new Event('input',{bubbles:true}))",
  );
  await until("document.querySelectorAll('.wm-row').length===1");
  await evaluate(
    "document.querySelector('[data-action=rename]').click();document.querySelector('.wm-rename input').value='Renamed front door';document.querySelector('.wm-rename').requestSubmit()",
  );
  await until(
    "document.querySelector('[data-name]').value==='Renamed front door'",
  );
  await evaluate(
    "document.querySelector('[name=query]').value='Renamed front door';document.querySelector('[name=query]').dispatchEvent(new Event('input',{bubbles:true}))",
  );
  await until(
    "document.querySelector('.wm-row strong')?.textContent==='Renamed front door'",
  );
  await evaluate("document.querySelector('[data-action=duplicate]').click()");
  await until("!document.querySelector('.workflow-manager')");
  assert.equal(
    await evaluate("document.querySelector('[data-name]').value"),
    "Renamed front door (copy)",
  );
  assert.equal(
    await evaluate("spyderWorkflowStore.page({}).then(x=>x.counts.total)"),
    1001,
  );
  await evaluate("document.querySelector('[data-remove]').click()");
  await until("document.querySelector('.wm-delete-confirm:not([hidden])')");
  await evaluate("document.querySelector('[data-confirm-delete]').click()");
  await until("document.querySelector('[data-name]').value==='New workflow'");
  assert.equal(
    await evaluate("spyderWorkflowStore.page({}).then(x=>x.counts.total)"),
    1000,
  );
  await evaluate(
    "document.querySelector('.wm-close').click();location.hash='control-room'",
  );
  await until("!document.querySelector('[data-open-workflow-manager]')");
  await evaluate("location.hash='vision-lab'");
  await until("document.querySelector('#vision-workflow-tab')");
  await evaluate("document.querySelector('#vision-workflow-tab').click()");
  await until("document.querySelector('[data-open-workflow-manager]')");
  await evaluate(
    "document.querySelector('[data-open-workflow-manager]').click()",
  );
  await until(
    "document.querySelector('.wm-summary')?.textContent.startsWith('1000 workflows')",
  );
  assert.deepEqual(await evaluate("templateErrors"), []);
  assert.equal(
    networkPaths.some((url) => url.startsWith("/api/")),
    false,
  );
  console.log(
    "Workflow manager editor integration passed: 1000 workflows, bounded rows, themes/mobile/short window, rename, duplicate, confirmed delete, route persistence, no API or camera use.",
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
