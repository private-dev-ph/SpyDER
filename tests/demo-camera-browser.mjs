// Mobile camera layout regression. Run: node tests/mobile-camera-layout-browser.mjs <showcase-dir>
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
const profile = await mkdtemp(path.join(os.tmpdir(), "spyder-demo-cameras-"));
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
      ".mp4": "video/mp4",
      ".json": "application/json",
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

  await command("Page.bringToFront", {}, sessionId);
  await until(
    "window.spyder && spyder.cameras().length===2 && spyder.cameras().every(c=>c.state==='running')",
  );
  const list = () =>
    evaluate("spyderShowcase.fetch('/api/cameras').then(r=>r.json())");
  assert.ok(
    (await list()).every(
      (c) =>
        c.source_kind === "sample" && c.footage_credit?.license === "CC BY 3.0",
    ),
  );
  const first = (await list())[0].id;
  await evaluate(
    `spyderShowcase.request('/api/cameras/${first}/settings',{settings:{brightness:0,zoom:50,pan:0}})`,
  );
  const dark = await evaluate(
    `spyderShowcase.getFrameSource('${first}').then(c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let sum=0;for(let i=0;i<d.length;i+=4)sum+=d[i]+d[i+1]+d[i+2];return sum/d.length;})`,
  );
  await evaluate(
    `spyderShowcase.request('/api/cameras/${first}/settings',{settings:{brightness:100,zoom:50,pan:0}})`,
  );
  await delay(200);
  const light = await evaluate(
    `spyderShowcase.getFrameSource('${first}').then(c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let sum=0;for(let i=0;i<d.length;i+=4)sum+=d[i]+d[i+1]+d[i+2];return sum/d.length;})`,
  );
  assert.ok(
    light > dark * 1.3,
    `Software settings affect actual frame pixels (${dark},${light})`,
  );
  for (let i = 2; i < 8; i++)
    await evaluate(
      `spyderShowcase.request('/api/cameras',{name:spyderDemoCameraCatalog.cameras[${i}].name,source:'demo://'+spyderDemoCameraCatalog.cameras[${i}].id,fps:5,pipeline:'motion',autostart:true})`,
    );
  await until(
    "spyderShowcase.fetch('/api/cameras').then(r=>r.json()).then(cs=>cs.length===8&&cs.every(c=>c.state==='running'))",
  );
  const ids = (await list()).map((c) => c.id);
  await evaluate(
    `spyderShowcase.request('/api/captures',{camera_ids:${JSON.stringify(ids)}})`,
  );
  await evaluate(
    `spyderShowcase.request('/api/recordings/start',{camera_ids:${JSON.stringify(ids)}})`,
  );
  await delay(3500);
  await evaluate("spyderShowcase.request('/api/recordings/stop')");
  const media = await evaluate(
    "spyderShowcase.fetch('/api/recordings').then(r=>r.json())",
  );
  assert.ok(media.items.some((i) => i.kind === "capture" && i.size_bytes > 0));
  assert.ok(
    media.items.some((i) => i.kind === "recording" && i.size_bytes > 0),
    JSON.stringify(media),
  );
  await delay(8500);
  assert.ok(
    (await list()).every((c) => c.state === "running" && c.frames > 20),
    "All eight cameras loop past EOF",
  );
  await evaluate(
    "document.querySelector('#add-camera').click();document.querySelector('#source-type').value='sample';document.querySelector('#source-type').dispatchEvent(new Event('change',{bubbles:true}))",
  );
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 700, deviceScaleFactor: 1, mobile: true },
    sessionId,
  );
  assert.equal(
    await evaluate("document.querySelector('#camera-source').required"),
    false,
  );
  assert.equal(
    await evaluate("document.documentElement.scrollWidth<=innerWidth"),
    true,
  );
  await evaluate("document.querySelector('#add-dialog').close()");
  await evaluate("location.reload()");
  await until(
    "window.spyderShowcase && spyderShowcase.fetch('/api/cameras').then(r=>r.json()).then(cs=>cs.length===8&&cs.every(c=>c.state==='running'))",
  );
  assert.deepEqual(
    (await list()).map((c) => c.id),
    ids,
    "Demo camera IDs persist across reload",
  );
  assert.equal(
    networkPaths.some((url) => url.startsWith("/api/")),
    false,
    "No native API requests reach static host",
  );
  console.log(
    "PASS: eight real demo cameras loop, tune, capture, record, persist, fit mobile and use no server APIs.",
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
