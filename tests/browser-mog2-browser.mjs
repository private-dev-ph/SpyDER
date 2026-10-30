// Reviewed approach presets: real clip/browser integration. Run: node tests/demo-motion-presets-browser.mjs <showcase-dir>
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
  if (process.argv.includes("--ui-only")) {
    await until("document.querySelectorAll('.camera-card').length===2");
    await command(
      "Emulation.setDeviceMetricsOverride",
      { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await evaluate("document.querySelectorAll('.settings-camera')[1].click()");
    await until("document.querySelector('#browser-motion-engine')");
    await evaluate(
      "document.querySelector('#browser-motion-engine').value='mog2';document.querySelector('#browser-motion-engine').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#browser-motion-apply').click()",
    );
    await until("spyder.cameras()[1].motion_analysis?.state==='ready'");
    await evaluate(
      "document.querySelector('.browser-motion-panel').scrollIntoView({block:'center'})",
    );
    await delay(200);
    let screenshot = await command(
      "Page.captureScreenshot",
      { format: "png" },
      sessionId,
    );
    await writeFile(
      path.join(assets, "..", "mog2-settings-desktop.png"),
      Buffer.from(screenshot.data, "base64"),
    );
    await command(
      "Emulation.setDeviceMetricsOverride",
      { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
      sessionId,
    );
    await evaluate(
      "document.querySelector('.browser-motion-panel').scrollIntoView({block:'center'})",
    );
    await delay(200);
    assert.equal(
      await evaluate("document.documentElement.scrollWidth<=innerWidth"),
      true,
    );
    screenshot = await command(
      "Page.captureScreenshot",
      { format: "png" },
      sessionId,
    );
    await writeFile(
      path.join(assets, "..", "mog2-settings-mobile.png"),
      Buffer.from(screenshot.data, "base64"),
    );
    const id=await evaluate("spyder.cameras()[1].id");
    const before=await evaluate("spyderShowcase.fetch('/api/recordings').then(r=>r.json()).then(s=>s.items.length)");
    await evaluate(`spyderShowcase.request('/api/recordings/start',{camera_ids:['${id}']})`);
    await delay(2500);await evaluate("spyderShowcase.request('/api/recordings/stop')");
    assert.ok(await evaluate(`spyderShowcase.fetch('/api/recordings').then(r=>r.json()).then(s=>s.items.length>${before} && s.items.some(i=>i.kind==='recording'&&i.size_bytes>0))`));
    assert.equal(await evaluate(`spyderShowcase.fetch('/api/cameras').then(r=>r.json()).then(cs=>cs.find(c=>c.id==='${id}').motion_analysis.engine)`),'mog2');
    console.log("PASS: MOG2 camera settings, diagnostics, desktop/mobile layouts, recording with MOG2 active, main-page eval restriction.");
  } else {
    const clips = await evaluate(
      "spyderBrowserMotion.clips().map(c=>({id:c.id,name:c.name}))",
    );
    for (const clip of clips)
      await evaluate(
        `(async()=>{let cs=await spyderShowcase.fetch('/api/cameras').then(r=>r.json());if(!cs.some(c=>c.demo_clip_id==='${clip.id}'))await spyderShowcase.request('/api/cameras',{name:${JSON.stringify(clip.name)},source:'demo://${clip.id}',fps:10,pipeline:'motion',autostart:true});})()`,
      );
    const ids = await evaluate(
      "spyderShowcase.fetch('/api/cameras').then(r=>r.json()).then(cs=>cs.filter(c=>c.metadata.motion_region).map(c=>c.id))",
    );
    assert.equal(ids.length, 6);
    await command(
      "Emulation.setDeviceMetricsOverride",
      { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await delay(6000);
    const comparison = {};
    comparison.frame_difference = await evaluate(
      `Promise.all(${JSON.stringify(ids)}.map(async id=>{const c=(await spyderShowcase.fetch('/api/cameras').then(r=>r.json())).find(c=>c.id===id);return {scene:c.demo_clip_id,...c.motion_analysis};}))`,
    );
    // Exercise the actual settings panel for the first camera; remaining feeds use the same API.
    await evaluate(
      `(()=>{const card=Array.from(document.querySelectorAll('.camera-card')).find(el=>el.querySelector('.camera-name')?.textContent===spyder.cameras().find(c=>c.id==='${ids[0]}').name);card.querySelector('.settings-camera').click();})()`,
    );
    await until("document.querySelector('#browser-motion-engine')");
    await evaluate(
      "document.querySelector('#browser-motion-engine').value='mog2';document.querySelector('#browser-motion-engine').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#browser-motion-apply').click()",
    );
    for (const id of ids.slice(1))
      await evaluate(
        `spyderShowcase.request('/api/cameras/${id}/motion',{engine:'mog2',input_width:320,inference_fps:5})`,
      );
    for (const clip of clips)
      await evaluate(
        `spyderWorkflowStore.get('demo-approach-${clip.id}').then(g=>spyderDemoWorkflowRuntime.enable(g))`,
      );
    await until(
      `spyderShowcase.fetch('/api/cameras').then(r=>r.json()).then(cs=>cs.filter(c=>${JSON.stringify(ids)}.includes(c.id)).every(c=>c.motion_analysis.processing_ms>=0 && c.motion_analysis.state!=='error'))`,
    );
    await evaluate(
      "window.mogPeaks={};window.unsubPeaks=spyderShowcase.subscribeFrames(f=>{if(f.camera.motion_analysis?.engine==='mog2'&&f.camera.motion_analysis.state==='ready'){const id=f.camera.demo_clip_id;const p=mogPeaks[id] ||= {peak:0,samples:0,regions:0};p.peak=Math.max(p.peak,f.motion_fraction);p.samples++;p.regions=Math.max(p.regions,f.camera.motion_analysis.region_count||0);}})",
    );
    await delay(20000);
    comparison.mog2_320 = await evaluate(
      "spyderShowcase.fetch('/api/cameras').then(r=>r.json()).then(cs=>cs.filter(c=>c.motion_analysis.engine==='mog2').map(c=>({scene:c.demo_clip_id,...c.motion_analysis})))",
    );
    const events = await evaluate(
      "spyderShowcase.fetch('/api/events').then(r=>r.json()).then(d=>d.events)",
    );
    console.log(
      "Measured ROI foreground peaks:",
      JSON.stringify(await evaluate("mogPeaks")),
    );
    console.log(
      "Initial MOG2 events:",
      JSON.stringify(events.map((e) => e.workflow_id)),
    );
    for (const clip of clips)
      assert.ok(
        events.some((e) => e.workflow_id === "demo-approach-" + clip.id),
        "MOG2 must produce a real ROI event for " + clip.id,
      );
    console.log(
      "MOG2 320px:",
      JSON.stringify(
        comparison.mog2_320.map((c) => ({
          scene: c.scene,
          mean_ms: c.mean_processing_ms,
          p95_ms: c.p95_processing_ms,
          fps: c.effective_fps,
          frames: c.processed_frames,
          heap: c.heap_bytes,
        })),
      ),
    );
    await evaluate("document.querySelector('#settings-dialog').close()");
    for (const id of ids)
      await evaluate(
        `spyderShowcase.request('/api/cameras/${id}/motion',{engine:'mog2',input_width:480,inference_fps:5})`,
      );
    await delay(16000);
    comparison.mog2_480 = await evaluate(
      "spyderShowcase.fetch('/api/cameras').then(r=>r.json()).then(cs=>cs.filter(c=>c.motion_analysis.engine==='mog2').map(c=>({scene:c.demo_clip_id,...c.motion_analysis})))",
    );
    assert.ok(
      comparison.mog2_480.every((c) => c.width === 480 && c.state !== "error"),
    );
    console.log(
      "MOG2 480px:",
      JSON.stringify(
        comparison.mog2_480.map((c) => ({
          scene: c.scene,
          mean_ms: c.mean_processing_ms,
          p95_ms: c.p95_processing_ms,
          fps: c.effective_fps,
          frames: c.processed_frames,
          heap: c.heap_bytes,
        })),
      ),
    );
    await evaluate("location.reload()");
    await until(
      `window.spyderShowcase && spyderShowcase.fetch('/api/cameras').then(r=>r.json()).then(cs=>cs.filter(c=>c.motion_analysis?.engine==='mog2').length===6 && cs.every(c=>c.state==='running'))`,
    );
    for (const id of ids)
      await evaluate(
        `spyderShowcase.request('/api/cameras/${id}/motion',{engine:'frame-difference'})`,
      );
    assert.ok(
      (
        await evaluate("spyderShowcase.fetch('/api/cameras').then(r=>r.json())")
      ).every((c) => c.motion_analysis.engine === "frame-difference"),
    );
    blockMog2Worker = true;
    await evaluate(
      `spyderShowcase.request('/api/cameras/${ids[0]}/motion',{engine:'mog2'})`,
    );
    await until(
      `spyderShowcase.fetch('/api/cameras').then(r=>r.json()).then(cs=>cs.find(c=>c.id==='${ids[0]}').motion_analysis.state==='error')`,
    );
    const capture = await evaluate(
      `spyderShowcase.request('/api/captures',{camera_ids:['${ids[0]}']})`,
    );
    assert.ok(
      capture.size_bytes > 0,
      "MOG2 failure cannot stop clean captures",
    );
    await evaluate(
      `spyderShowcase.request('/api/cameras/${ids[0]}/motion',{engine:'frame-difference'})`,
    );
    const mediaBefore = await evaluate(
      "spyderShowcase.fetch('/api/recordings').then(r=>r.json()).then(s=>s.items.length)",
    );
    await evaluate(
      `spyderShowcase.request('/api/recordings/start',{camera_ids:${JSON.stringify(ids)}})`,
    );
    await delay(2500);
    await evaluate("spyderShowcase.request('/api/recordings/stop')");
    assert.ok(
      await evaluate(
        `spyderShowcase.fetch('/api/recordings').then(r=>r.json()).then(s=>s.items.length>${mediaBefore})`,
      ),
    );
    comparison.browser = await evaluate(
      "({userAgent:navigator.userAgent,logical_processors:navigator.hardwareConcurrency})",
    );
    await writeFile(
      path.join(assets, "..", "browser-mog2-benchmark.json"),
      JSON.stringify(comparison, null, 2),
    );
    assert.equal(
      networkPaths.some((p) => p.startsWith("/api/")),
      false,
    );
    console.log(
      "PASS: six real MOG2/ROI workflows, 320/480px measurements, settings UI, persisted selection, explicit failure with live capture, fallback recording, no server APIs.",
    );
  }
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
