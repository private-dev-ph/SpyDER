// Reviewed approach presets: real clip/browser integration. Run: node scripts/tests/demo-motion-presets-browser.mjs <showcase-dir>
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
    res.setHeader("Accept-Ranges", "bytes");
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    if (range) {
      const start = Number(range[1]),
        end = range[2]
          ? Math.min(body.length - 1, Number(range[2]))
          : body.length - 1;
      if (start >= body.length) {
        res.writeHead(416, { "Content-Range": `bytes */${body.length}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${body.length}`,
        "Content-Length": end - start + 1,
      });
      res.end(body.subarray(start, end + 1));
    } else {
      res.setHeader("Content-Length", body.length);
      res.end(body);
    }
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
    url: "about:blank",
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
      "(async()=>({ready:document.readyState,workflow:!!window.spyderWorkflows,app:!!window.spyder,cameras:await window.spyderShowcase?.fetch('/api/cameras').then(r=>r.json()),formError:document.querySelector('#form-error')?.textContent,text:document.body.innerText.slice(0,500)}))()",
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

  await command("Page.enable", {}, sessionId);
  await command(
    "Emulation.setFocusEmulationEnabled",
    { enabled: true },
    sessionId,
  );
  await command("Page.bringToFront", {}, sessionId);
  await command(
    "Page.navigate",
    { url: `http://127.0.0.1:${server.address().port}/#control-room` },
    sessionId,
  );
  await until(
    "window.spyderDemoWorkflowRuntime && window.spyderWorkflowStore && window.spyder && spyder.cameras().length===2 && spyder.cameras().every(c=>c.state==='running')",
  );
  await until("spyderDemoWorkflowRuntime.presetsReady.then(()=>true)");
  const clips = await evaluate(
    "spyderBrowserMotion.clips().map(c=>({id:c.id,name:c.name}))",
  );
  assert.equal(clips.length, 6);
  for (const clip of clips) {
    await evaluate(
      `(async()=>{const cs=await spyderShowcase.fetch('/api/cameras').then(r=>r.json());if(!cs.some(c=>c.demo_clip_id===${JSON.stringify(clip.id)})) await spyderShowcase.request('/api/cameras',{name:${JSON.stringify(clip.name)},source:'demo://${clip.id}',fps:10,pipeline:'motion',autostart:true});})()`,
    );
    await evaluate(
      `spyderWorkflowStore.get('demo-approach-${clip.id}').then(g=>spyderDemoWorkflowRuntime.enable(g))`,
    );
  }
  await until(
    "spyder.cameras().filter(c=>c.metadata.motion_region).length===6",
  );

  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await evaluate(
    "document.querySelector('.camera-card').scrollIntoView({block:'start'})",
  );
  await until(
    "Array.from(document.querySelectorAll('.camera-image')).every(img=>!img.hidden) && document.querySelectorAll('.demo-motion-region').length===6",
  );
  const screenshot = await command(
    "Page.captureScreenshot",
    { format: "png" },
    sessionId,
  );
  await writeFile(
    path.join(assets, "..", "demo-motion-presets-control-room.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  await delay(19000);
  const rows = await evaluate(
    "spyderShowcase.fetch('/api/events').then(r=>r.json()).then(d=>d.events)",
  );
  for (const clip of clips)
    assert.ok(
      rows.some(
        (e) => e.workflow_id === "demo-approach-" + clip.id && e.media?.length,
      ),
      "Preset needs a real ROI-triggered capture: " + clip.id,
    );
  console.log(
    "Preset event counts:",
    JSON.stringify(
      Object.fromEntries(
        clips.map((c) => [
          c.id,
          rows.filter((e) => e.workflow_id === "demo-approach-" + c.id).length,
        ]),
      ),
    ),
  );
  assert.equal(await evaluate("spyderDemoWorkflowRuntime.active().length"), 6);
  const graph = await evaluate(
    "spyderWorkflowStore.get('demo-approach-porch-parcel')",
  );
  graph.name = "My edited porch preset";
  await evaluate(`spyderDemoWorkflowRuntime.disable('${graph.id}')`);
  await evaluate(
    `spyderWorkflowStore.save(${JSON.stringify({ ...graph, enabled: false })})`,
  );
  await evaluate("spyderWorkflowStore.remove('demo-approach-covered-porch')");
  await evaluate("location.reload()");
  await until("window.spyderDemoWorkflowRuntime?.presetsReady?.then(()=>true)");
  assert.equal(
    await evaluate(
      "spyderWorkflowStore.get('demo-approach-porch-parcel').then(g=>g.name)",
    ),
    "My edited porch preset",
  );
  assert.equal(
    await evaluate(
      "spyderWorkflowStore.get('demo-approach-covered-porch').then(g=>!!g)",
    ),
    false,
  );
  assert.equal(
    await evaluate(
      "spyderDemoWorkflowRuntime.active().includes('demo-approach-porch-parcel')",
    ),
    false,
  );
  assert.equal(
    networkPaths.some((p) => p.startsWith("/api/")),
    false,
  );
  console.log(
    "PASS: all six real person clips produce approach-region events and captures across loops; view-only ROI guides render; edits/deletion/disabling survive reload; no server API requests.",
  );
} finally {
  assert.ok(
    path
      .resolve(profile)
      .startsWith(path.join(os.tmpdir(), "spyder-demo-cameras-")),
    "Only close this test browser profile",
  );
  socket?.close();
  if (process.platform === "win32" && chrome.exitCode === null) {
    await new Promise((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/PID", String(chrome.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
  } else chrome.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await delay(300);
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
