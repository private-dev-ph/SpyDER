// Real OpenCV MIL in a browser worker. Run: node tests/browser-mil-browser.mjs <showcase-dir>
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
let blockMog2Worker = false;
const workerPolicy = headers.match(
  /\/mog2-worker\.js\r?\n\s+Content-Security-Policy: ([^\r\n]+)/,
)[1];
const profile = await mkdtemp(path.join(os.tmpdir(), "spyder-demo-cameras-"));
const server = http.createServer(async (req, res) => {
  networkPaths.push(req.url);
  const name =
    new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[\w.-]+$/.test(name)) return res.writeHead(404).end();
  try {
    if (blockMog2Worker && name === "mog2-worker.js") {
      res.writeHead(404).end();
      return;
    }
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
    res.setHeader(
      "Content-Security-Policy",
      name === "mog2-worker.js" ? workerPolicy : policy,
    );
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
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        allowUnsafeEvalBlockedByCSP: false,
      },
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
    "window.spyderDemoWorkflowRuntime && window.spyderBrowserMog2 && spyderDemoWorkflowRuntime.presetsReady.then(()=>true)",
  );
  assert.equal(
    networkPaths.some((p) => p.includes("opencv-4.12.0")),
    false,
    "Default demo must not download OpenCV",
  );
  assert.equal(
    await evaluate(
      "(()=>{try{new Function('return 1')();return false}catch{return true}})()",
    ),
    true,
    "Main page must remain eval-free",
  );
  await until(
    "spyder.cameras().length===2 && spyder.cameras().every(c=>c.state==='running')",
  );
  const porchId = await evaluate(
    "spyder.cameras().find(c=>c.demo_clip_id==='porch-parcel').id",
  );
  const otherId = await evaluate(
    "spyder.cameras().find(c=>c.demo_clip_id!=='porch-parcel').id",
  );
  assert.equal(
    await evaluate(
      `spyderShowcase.request('/api/cameras/${otherId}/motion',{engine:'mog2',tracking:true}).then(()=>false,()=>true)`,
    ),
    true,
  );
  await evaluate("document.querySelectorAll('.settings-camera')[1].click()");
  await until("document.querySelector('[data-motion-config=tracking]')");
  await evaluate(
    "document.querySelector('#browser-motion-engine').value='mog2';document.querySelector('#browser-motion-engine').dispatchEvent(new Event('change',{bubbles:true}));const t=document.querySelector('[data-motion-config=tracking]');t.checked=true;t.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#browser-motion-apply').click()",
  );
  await until(
    `spyder.cameras().find(c=>c.id==='${porchId}').motion_analysis.config.tracking===true`,
  );
  await evaluate(
    "document.querySelector('#settings-dialog').close();window.trackSamples=[];window.offSamples=spyderShowcase.subscribeFrames(f=>{const a=f.camera.motion_analysis;if(a?.config?.tracking)trackSamples.push({time:performance.now(),id:f.camera.id,epoch:f.frameId,state:a.tracking_state,count:a.track_count||0,tracks:a.tracks||[],ms:a.tracking_ms,fps:a.tracking_fps,heap:a.heap_bytes});if(trackSamples.length>1000)trackSamples.shift();})",
  );
  await delay(22000);
  const samples = await evaluate("trackSamples");
  console.log(
    "MIL samples:",
    JSON.stringify(
      samples
        .filter((s) => s.count)
        .filter(
          (s, i, a) =>
            i === 0 || s.tracks[0].id !== a[i - 1].tracks[0].id || i % 8 === 0,
        ),
    ),
  );
  assert.ok(
    samples.some((s) => s.count === 1),
    "Real porch feed must acquire a MIL target",
  );
  assert.ok(samples.every((s) => s.count <= 1 && s.id === porchId));
  assert.ok(samples.filter((s) => s.count).every((s) => s.fps <= 2.1));
  const ids = [...new Set(samples.flatMap((s) => s.tracks.map((t) => t.id)))];
  assert.ok(
    ids.length >= 2,
    "Clip loops must reset and reacquire a new temporary track",
  );
  assert.ok(
    ids.some(
      (id) =>
        samples.filter((s) => s.tracks.some((t) => t.id === id)).length >= 3,
    ),
    "A track ID must persist between frames",
  );
  const duplicate = await evaluate(
    "spyderShowcase.request('/api/cameras',{source:'demo://porch-parcel',name:'Another porch',fps:10,pipeline:'motion',autostart:true})",
  );
  assert.equal(
    await evaluate(
      `spyderShowcase.request('/api/cameras/${duplicate.id}/motion',{engine:'mog2',tracking:true}).then(()=>false,()=>true)`,
    ),
    true,
    "Only one porch camera can enable tracking",
  );
  assert.equal(
    await evaluate(
      `spyderShowcase.request('/api/cameras/${porchId}/motion',{engine:'mog2',tracking:true,max_tracks:2}).then(()=>false,()=>true)`,
    ),
    true,
  );
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await evaluate(
    "document.querySelectorAll('.camera-card')[1].scrollIntoView({block:'center'})",
  );
  await delay(600);
  const shot = await command(
    "Page.captureScreenshot",
    { format: "png" },
    sessionId,
  );
  await writeFile(
    path.join(assets, "..", "mil-porch-control-room.png"),
    Buffer.from(shot.data, "base64"),
  );
  const status = await evaluate(
    `spyderShowcase.fetch('/api/cameras').then(r=>r.json()).then(cs=>cs.find(c=>c.id==='${porchId}').motion_analysis)`,
  );
  await writeFile(
    path.join(assets, "..", "mil-demo-measurements.json"),
    JSON.stringify({ status, samples }, null, 2),
  );
  await evaluate(
    `spyderShowcase.request('/api/recordings/start',{camera_ids:['${porchId}']})`,
  );
  await delay(2200);
  await evaluate("spyderShowcase.request('/api/recordings/stop')");
  assert.ok(
    await evaluate(
      "spyderShowcase.fetch('/api/recordings').then(r=>r.json()).then(s=>s.items.some(i=>i.kind==='recording'&&i.size_bytes>0))",
    ),
  );
  await evaluate("location.reload()");
  await until(
    `window.spyderShowcase && spyderShowcase.fetch('/api/cameras').then(r=>r.json()).then(cs=>cs.find(c=>c.id==='${porchId}')?.motion_analysis.config.tracking===true)`,
  );
  await evaluate(
    `spyderShowcase.request('/api/cameras/${porchId}/motion',{engine:'mog2',tracking:false})`,
  );
  assert.equal(
    await evaluate(
      `spyderShowcase.fetch('/api/cameras').then(r=>r.json()).then(cs=>cs.find(c=>c.id==='${porchId}').motion_analysis.config.tracking)`,
    ),
    false,
  );
  await evaluate(
    `spyderShowcase.request('/api/cameras/${duplicate.id}/motion',{engine:'mog2',tracking:true})`,
  );
  await evaluate(`spyderShowcase.request('/api/cameras/${duplicate.id}/stop')`);
  assert.equal(
    networkPaths.some((p) => p.startsWith("/api/")),
    false,
  );
  console.log(
    "PASS: real one-object MIL tracks porch only, persists IDs then resets across loops, rejects other sources/duplicate owners/limit overrides, records clean media, persists selection and releases the tracker.",
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
