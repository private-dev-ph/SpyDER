import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const root = path.resolve("src/spyder_cctv/assets");
const profile = await mkdtemp(
  path.join(os.tmpdir(), "spyder-device-tools-browser-"),
);
const html =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/device-tools.css"><style>:root{--surface:#fffefa;--canvas:#f7f5ef;--ink:#201d1a;--muted:#726d64;--border:#e4dfd4;--control-border:#8c8274;--focus:#830000;--accent:#be1a1a;--accent-hover:#830000;--danger:#bc0202;--gold-soft:#f8ebab}html[data-theme=dark]{--surface:#1e1c1b;--canvas:#141313;--ink:#f5efe4;--muted:#b0a69b;--border:#37312c;--focus:#f7d87f;--danger:#ff827b}</style></head><body><main><div id="face-gallery-tools"></div><div id="onvif-camera-tools"></div></main><script>' +
  'window.calls=[];window.runtimeErrors=[];window.addEventListener("error",e=>runtimeErrors.push(e.message));window.spyder={cameras:()=>[{id:"cam-1",name:"Lobby"}]};if(location.search.includes("showcase"))window.spyderShowcase={};window.fetch=async(url,opts={})=>{const method=opts.method||"GET",path=String(url),body=opts.body?JSON.parse(opts.body):null;calls.push({path,method,body});let data={};' +
  'if(path==="/api/models")data={models:[{id:"det-1",name:"Detector",engine:"insightface",metadata:{model_type:"face_detection"}},{id:"rec-1",name:"Recognizer",engine:"insightface",metadata:{model_type:"face_recognition"}}]};' +
  'else if(path==="/api/faces/galleries"&&method==="GET")data={galleries:[{id:"g1",name:"Lobby",identity_count:1,sample_count:1}]};' +
  'else if(path==="/api/faces/galleries/g1"&&method==="GET")data={id:"g1",name:"Lobby",detector_model_id:"det-1",recognition_model_id:"rec-1",identities:[{id:"i1",name:"Ada",samples:[{id:"s1"}]}]};' +
  'else if(path==="/api/faces/galleries"&&method==="POST")data={id:"g1"};else if(path.endsWith("/enroll")&&method==="POST")data=body.enrollment_token?{}:{requires_selection:true,enrollment_token:"token-1",faces:[{index:0,bbox:[1,2,30,40],confidence:.97},{index:1,bbox:[50,5,80,40],confidence:.82}]};' +
  'else if(path==="/api/onvif/discover")data={devices:[{endpoint:"http://192.168.1.8/onvif/device_service",name:"Mock cam"}]};else if(path==="/api/onvif/connect")data={session_id:"s-1",device:{name:"Mock cam"},profiles:[{token:"p-1",name:"Main",ptz:true},{token:"p-2",name:"No PTZ",ptz:true,ptz_caps:{pan_tilt:false,zoom:false}}],ptz:{pan_tilt:true,zoom:false}};else if(path==="/api/onvif/sessions")data={sessions:[{session_id:"s-1",device:{name:"Mock cam"},profiles:[{token:"p-1",name:"Main",ptz:true}],ptz:{pan_tilt:true,zoom:false}}]};else if(path==="/api/onvif/add")data={message:"Added"};return new Response(JSON.stringify(data),{status:200,headers:{"Content-Type":"application/json"}})};</script><script src="/device-tools.js"></script></body></html>';
const server = http.createServer(async (req, res) => {
  const name = new URL(req.url, "http://localhost").pathname;
  if (name === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
    return;
  }
  const file =
    name === "/device-tools.js"
      ? "device-tools.js"
      : name === "/device-tools.css"
        ? "device-tools.css"
        : null;
  if (!file) return res.writeHead(404).end();
  res.setHeader(
    "Content-Type",
    file.endsWith(".css") ? "text/css" : "text/javascript",
  );
  res.end(await readFile(path.join(root, file)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const chrome = spawn(
  process.env.CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless=new",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
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
    await fetch("http://127.0.0.1:" + port + "/json/version")
  ).json();
  socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let serial = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (!m.id) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
  };
  function command(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++serial,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("Timed out: " + method));
        }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const t = await command("Target.createTarget", { url: "about:blank" }),
    attached = await command("Target.attachToTarget", {
      targetId: t.targetId,
      flatten: true,
    }),
    sid = attached.sessionId;
  const evaluate = async (expr) => {
    const r = await command(
      "Runtime.evaluate",
      { expression: expr, returnByValue: true, awaitPromise: true },
      sid,
    );
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const until = async (expr) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expr)) return;
      await delay(50);
    }
    throw Error(
      "Timed out: " +
        expr +
        "; " +
        JSON.stringify(
          await evaluate("({text:document.body.innerText.slice(0,400),calls})"),
        ),
    );
  };
  const click = (selector) =>
    evaluate(
      "(()=>{const e=document.querySelector(" +
        JSON.stringify(selector) +
        ");if(!e)throw Error('Missing button '+" +
        JSON.stringify(selector) +
        ");e.click()})()",
    );
  await command(
    "Page.navigate",
    { url: "http://127.0.0.1:" + server.address().port + "/" },
    sid,
  );
  await until("!!document.querySelector('#onvif-camera-tools .dt-card')");
  assert.equal(await evaluate("calls.length"), 0);
  await click("#face-gallery-tools [data-refresh]");
  await until("!!document.querySelector('#face-gallery-tools [data-gid=g1]')");
  await click("#face-gallery-tools [data-gid=g1]");
  await until(
    "document.querySelector('#face-gallery-tools').innerText.includes('Ada')",
  );
  await click("#face-gallery-tools [data-create]");
  await until("!!document.querySelector('.dt-dialog[open]')");
  await evaluate(
    "(()=>{const d=document.querySelector('.dt-dialog');d.querySelector('[name=name]').value='New gallery';d.querySelector('[name=detector_model_id]').value='det-1';d.querySelector('[name=recognition_model_id]').value='rec-1';d.querySelector('[value=create]').click()})()",
  );
  await until(
    "!document.querySelector('.dt-dialog') && calls.some(x=>x.path==='/api/faces/galleries' && x.method==='POST')",
  );
  await until(
    "document.querySelector('#face-gallery-tools [data-detail]').innerText.includes('Enroll face')",
  );
  await evaluate(
    "(()=>{const f=document.querySelector('[data-enroll]');f.elements.identity_name.value='Bea';f.elements.camera_id.value='cam-1';f.querySelector('button[type=submit],button').click()})()",
  );
  await until("!!document.querySelector('[data-confirm-face]')");
  const cand = await evaluate(
    "document.querySelector('[data-choice]').innerText",
  );
  assert.match(cand, /97%/);
  assert.match(cand, /1, 2, 30, 40/);
  await click("#face-gallery-tools [data-confirm-face]");
  await until(
    "document.querySelector('.dt-status').textContent.includes('Face enrolled')",
  );
  const retry = await evaluate(
    "calls.filter(x=>x.path.endsWith('/enroll')).at(-1).body",
  );
  assert.deepEqual(retry, {
    identity_name: "Bea",
    enrollment_token: "token-1",
    face_index: 0,
  });
  await click("#onvif-camera-tools [data-discover]");
  await until("document.querySelector('[data-devices]').options.length>1");
  await evaluate(
    "(()=>{document.querySelector('[data-devices]').value='http://192.168.1.8/onvif/device_service';document.querySelector('[data-devices]').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-user]').value='operator';document.querySelector('[data-pass]').value='secret';document.querySelector('[data-connect]').click()})()",
  );
  await until("!!document.querySelector('.dt-connected [data-move]')");
  assert.equal(
    await evaluate(
      "document.querySelector('.dt-ptz [aria-label=\"Zoom in\"]').disabled",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.dt-ptz [aria-label=\"Stop\"]').disabled",
    ),
    false,
  );
  await click(".dt-connected [data-add]");
  await click('.dt-ptz [aria-label="Tilt up"]');
  await until("calls.some(x=>x.path==='/api/onvif/move')");
  assert.equal(
    await evaluate("document.querySelector('[data-pass]').value"),
    "",
  );
  const move = await evaluate("calls.find(x=>x.path==='/api/onvif/move').body");
  assert.equal(move.duration_ms, 250);
  assert.equal(move.tilt, 1);
  await click('.dt-ptz [aria-label="Stop"]');
  assert.equal(
    await evaluate("calls.some(x=>x.path==='/api/onvif/stop')"),
    true,
  );
  await click("#onvif-camera-tools [data-refresh-sessions]");
  await until("!!document.querySelector('[data-sessions] option[value=s-1]')");
  await evaluate(
    "(()=>{const s=document.querySelector('[data-sessions]');s.value='s-1';s.dispatchEvent(new Event('change',{bubbles:true}))})()",
  );
  assert.equal(
    await evaluate("document.querySelector('[data-pass]').value"),
    "",
  );
  for (const v of [
    { width: 1280, height: 800 },
    { width: 390, height: 700 },
    { width: 1100, height: 450 },
  ]) {
    await command(
      "Emulation.setDeviceMetricsOverride",
      { ...v, deviceScaleFactor: 1, mobile: false },
      sid,
    );
    for (const theme of ["light", "dark"]) {
      await evaluate(
        "document.documentElement.dataset.theme=" + JSON.stringify(theme),
      );
      const box = await evaluate(
        "(()=>{const r=document.querySelector('#onvif-camera-tools .dt-card').getBoundingClientRect();return {width:document.documentElement.scrollWidth,innerWidth,left:r.left,right:r.right}})()",
      );
      assert.ok(
        box.width <= v.width,
        JSON.stringify(v) + "/" + theme + " overflow " + JSON.stringify(box),
      );
      assert.ok(
        box.left >= 0 && box.right <= v.width + 1,
        JSON.stringify(v) + "/" + theme + " panel outside viewport",
      );
      await click("#face-gallery-tools [data-create]");
      await until("!!document.querySelector('.dt-dialog[open]')");
      const fits = await evaluate(
        "(()=>{let d=document.querySelector('.dt-dialog'),r=d.getBoundingClientRect();let ok=r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;d.close();return ok})()",
      );
      assert.equal(
        fits,
        true,
        JSON.stringify(v) + "/" + theme + " gallery dialog overflow",
      );
      await until("!document.querySelector('.dt-dialog')");
    }
  }
  assert.equal(
    await evaluate("calls.some(x=>x.path.startsWith('/api/cameras/'))"),
    false,
  );
  assert.deepEqual(await evaluate("runtimeErrors"), []);
  await command(
    "Page.navigate",
    { url: "http://127.0.0.1:" + server.address().port + "/?showcase" },
    sid,
  );
  await until("!!document.querySelector('#onvif-camera-tools .dt-card')");
  assert.equal(
    await evaluate("calls.length"),
    0,
    "Showcase must make zero API calls",
  );
  assert.equal(
    await evaluate(
      "Array.from(document.querySelectorAll('.dt-card button')).every(b=>b.disabled)",
    ),
    true,
  );
  console.log(
    "PASS: mocked gallery enrollment token flow, ONVIF discovery/connect/PTZ, six viewport/theme checks, showcase zero API calls",
  );
} finally {
  socket?.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await delay(150);
  assert.ok(path.basename(profile).startsWith("spyder-device-tools-browser-"));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
