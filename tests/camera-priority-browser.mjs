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
const profile = await mkdtemp(
  path.join(os.tmpdir(), "spyder-priority-browser-"),
);
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
      }, 10000);
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
    if (
      expression.includes("await ") &&
      !expression.trim().startsWith("(async")
    )
      expression = "(async()=>{" + expression + "})()";
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
    for (let i = 0; i < 120; i++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw Error("Timed out: " + expression);
  }
  const visible = () =>
    evaluate(
      "[...document.querySelectorAll('#cameras>.camera-card:not([hidden])')].map(card=>card.dataset.id)",
    );
  const clickText = (text) =>
    evaluate(
      `(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(text)});if(!button)throw Error('Missing button');button.click();})()`,
    );
  await until("!!window.spyderLayouts && spyder.cameras().length===2");
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await evaluate(`(async()=>{
    window.priorityErrors=[];window.addEventListener('error',e=>priorityErrors.push(e.message));
    navigator.mediaDevices.getUserMedia=()=>{throw Error('Unexpected camera access')};
    for(const camera of spyder.cameras())await spyderShowcase.request('/api/cameras/'+camera.id+'/stop',{});
    window.testActive=new Set();window.testCv=new Set();window.testStale=new Set();window.previewHits=[];window.previewInFlight=0;window.previewMax=0;
    const original=spyderShowcase.fetch;
    spyderShowcase.fetch=async(path,...args)=>{
      if(path==='/api/cameras'){
        const response=await original(path,...args);const cameras=await response.json();
        cameras.forEach(camera=>{camera.state='running';camera.frame_age_seconds=testStale.has(camera.id)?5:0;camera.metadata={motion_fraction:testActive.has(camera.id)?.6:0,cv:{state:'ready',result_age_seconds:0,detections:testCv.has(camera.id)?[{label:'Person'}]:[]}};});
        return new Response(JSON.stringify(cameras),{headers:{'Content-Type':'application/json'}});
      }
      if(path.startsWith('/api/cameras/')&&path.endsWith('/frame')){previewHits.push(performance.now());previewInFlight++;previewMax=Math.max(previewMax,previewInFlight);try{await new Promise(resolve=>setTimeout(resolve,350));return await original(path,...args)}finally{previewInFlight--;}}
      return original(path,...args);
    };
  })()`);
  const drag = async (source, target) =>
    evaluate(`(()=>{
    const a=[...document.querySelectorAll('#cameras>.camera-card')].find(card=>card.dataset.id===${JSON.stringify(source)});
    const b=[...document.querySelectorAll('#cameras>.camera-card')].find(card=>card.dataset.id===${JSON.stringify(target)});
    const rect=b.getBoundingClientRect(),transfer=new DataTransfer();
    a.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));
    b.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.left+2,clientY:rect.top+5}));
    b.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.left+2,clientY:rect.top+5}));
    a.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));
  })()`);
  for (const count of [128, 256]) {
    await evaluate(
      `(async()=>{const current=spyder.cameras().length;for(let i=current;i<${count};i++)await spyderShowcase.request('/api/cameras',{name:'Synthetic camera '+i,source:'demo',fps:1,pipeline:'none',autostart:false});window.renderStarted=performance.now();await spyder.refresh();})()`,
    );
    await until(
      `spyder.cameras().length===${count} && document.querySelectorAll('#cameras>.camera-card').length===${count}`,
    );
    const renderTime = await evaluate("performance.now()-renderStarted");
    assert.equal((await visible()).length, count);
    const ids = await evaluate("spyder.cameras().map(camera=>camera.id)");
    for (const id of [ids[0], ids[4]])
      await evaluate(
        `document.querySelector('[data-id="${id}"] .tile-pin').click()`,
      );
    await evaluate("document.querySelector('#wall-activity-priority').click()");
    await evaluate(
      `testActive=new Set([${JSON.stringify(ids[count - 1])}]);await spyder.refresh()`,
    );
    await until(
      `spyder.cameras().find(camera=>camera.id===${JSON.stringify(ids[count - 1])})?.metadata.motion_fraction===0.6`,
    );
    let sorted = await visible();
    assert.equal(sorted[0], ids[0]);
    assert.equal(sorted[4], ids[4]);
    assert.equal(sorted[1], ids[count - 1]);
    await evaluate("document.querySelector('#wall-reorder').click()");
    const frozen = await visible();
    await evaluate(
      `testActive=new Set([${JSON.stringify(ids[count - 2])}]);await spyder.refresh()`,
    );
    await until(
      `spyder.cameras().find(camera=>camera.id===${JSON.stringify(ids[count - 2])})?.metadata.motion_fraction===0.6`,
    );
    assert.deepEqual(
      await visible(),
      frozen,
      "Activity must not reorder during manual editing",
    );
    await drag(ids[count - 3], frozen[2]);
    await clickText("Cancel");
    const snapshot = await evaluate(
      "JSON.parse(localStorage.getItem('spyder-layouts-v1-showcase')).applied",
    );
    assert.equal(
      snapshot.pinned.includes(ids[count - 3]),
      false,
      "Cancel must not persist auto-pin",
    );
    await evaluate("document.querySelector('#wall-reorder').click()");
    const before = await visible();
    await drag(ids[count - 3], before[2]);
    await clickText("Apply order & pins");
    assert.equal((await visible())[2], ids[count - 3]);
    assert.ok(
      await evaluate(
        `JSON.parse(localStorage.getItem('spyder-layouts-v1-showcase')).applied.pinned.includes(${JSON.stringify(ids[count - 3])})`,
      ),
    );
    await evaluate(
      `testActive=new Set();testCv=new Set([${JSON.stringify(ids[count - 4])}]);await spyder.refresh()`,
    );
    await until(
      `spyder.cameras().find(camera=>camera.id===${JSON.stringify(ids[count - 4])})?.metadata.cv.detections.length===1`,
    );
    assert.equal(
      (await visible())[2],
      ids[count - 3],
      "CV promotion cannot displace moved pin",
    );
    await evaluate(
      `window.dispatchEvent(new CustomEvent('spyder:activity-snapshot',{detail:{session_id:'browser-${count}',activities:[]}}));window.dispatchEvent(new CustomEvent('spyder:activity-snapshot',{detail:{session_id:'browser-${count}',activities:[{id:'event-${count}',camera_id:${JSON.stringify(ids[count - 5])},created_at:Date.now()/1000}]}}));`,
    );
    assert.equal(
      (await visible())[1],
      ids[count - 5],
      "Fresh workflow activity promotes into an unpinned slot",
    );
    assert.equal((await visible())[2], ids[count - 3]);
    const started = await evaluate("performance.now()");
    await delay(1200);
    const requests = await evaluate(
      `previewHits.filter(time=>time>=${started}&&time<${started}+1000).length`,
    );
    assert.ok(
      requests <= 24,
      `Preview budget exceeded: ${requests} requests per second`,
    );
    assert.ok(await evaluate("previewMax>=2 && previewMax<=6"));
    await evaluate("window.scrollTo(0,document.body.scrollHeight)");
    await until("!document.querySelector('.pinned-dock').hidden");
    assert.equal(
      await evaluate("document.querySelectorAll('.pinned-dock-tile').length"),
      3,
    );
    await evaluate("location.hash='layouts'");
    await until("!!document.querySelector('#layout-mode')");
    await evaluate(
      "(()=>{const field=document.querySelector('#layout-mode');field.value='sequence';field.dispatchEvent(new Event('change'));})()",
    );
    await clickText("Save & apply");
    await evaluate("location.hash='control-room'");
    await until("!document.querySelector('#control-room').hidden");
    assert.equal(
      (await visible()).length,
      4,
      "Pins plus one rotating feed stay visible",
    );
    assert.ok(
      [ids[0], ids[4], ids[count - 3]].every(
        (id) => snapshot.pinned.includes(id) || id === ids[count - 3],
      ),
    );
    const pinsBefore = (await visible()).slice(0, 3);
    await clickText("Next view");
    assert.deepEqual((await visible()).slice(0, 3), pinsBefore);
    await evaluate("spyderWall.enter()");
    await delay(100);
    assert.equal(
      await evaluate("document.querySelector('.pinned-dock').hidden"),
      true,
    );
    assert.equal((await visible()).length, 4);
    assert.ok(
      await evaluate(
        "(()=>{const wall=document.querySelector('#cameras').getBoundingClientRect();return [...document.querySelectorAll('#cameras>.camera-card:not([hidden])')].every(card=>{const rect=card.getBoundingClientRect();return rect.right<=wall.right+1&&rect.bottom<=wall.bottom+1;});})()",
      ),
    );
    await evaluate(
      "spyderWall.exit();document.querySelector('#wall-layout-choice').value='';document.querySelector('#wall-layout-choice').dispatchEvent(new Event('change'));testActive.clear();testCv.clear();window.scrollTo(0,0)",
    );
    assert.equal((await visible()).length, count);
    console.log(
      `${count} synthetic cameras: rendered in ${renderTime.toFixed(1)} ms; ${requests} preview requests in sampled second; pins, activity, drag/apply/cancel, dock and rotation passed.`,
    );
  }
  await command(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 700, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await delay(100);
  await evaluate("document.querySelector('#wall-reorder').click()");
  await evaluate(
    "document.querySelector('#cameras>.camera-card .tile-order-step[aria-label=\"Move camera later\"]').click()",
  );
  await clickText("Apply order & pins");
  assert.ok(
    await evaluate("document.documentElement.scrollWidth<=innerWidth"),
    "Mobile wall must not overflow",
  );
  assert.deepEqual(await evaluate("priorityErrors"), []);
  assert.equal(
    networkPaths.some((url) => url.startsWith("/api/")),
    false,
  );
  console.log(
    "PASS: 128/256-camera browser stress, bounded previews, mobile controls and static CSP. No physical camera, CV engine or external API used.",
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
