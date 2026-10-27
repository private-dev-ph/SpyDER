// Motion & ROI browser regression. Run: node tests/motion-roi-browser.mjs <showcase-dir>
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
const fixtureScript = await readFile(new URL("./fixtures/motion-roi-browser.js", import.meta.url), "utf8");
const fixtureHTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/dashboard.css"><link rel="stylesheet" href="/workspaces.css"><link rel="stylesheet" href="/vision-lab.css"><link rel="stylesheet" href="/form-controls.css"><script src="/motion-fixture.js" defer></script><script src="/vision-lab.js" defer></script><script src="/form-controls.js" defer></script></head><body><main id="workspace-content"></main></body></html>`;
const networkPaths = [];
const profile = await mkdtemp(path.join(os.tmpdir(), "spyder-motion-browser-"));
const server = http.createServer(async (req, res) => {
  networkPaths.push(req.url);
  const name =
    new URL(req.url, "http://localhost").pathname.slice(1) || "index.html";
  if (!/^[\w.-]+$/.test(name)) return res.writeHead(404).end();
  try {
    const body = name === "motion-fixture.js" ? fixtureScript : name === "motion-test.html" ? fixtureHTML : await readFile(path.join(assets, name));
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
    url: `http://127.0.0.1:${server.address().port}/motion-test.html`,
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
  await until("!!document.querySelector('.vl-draw-roi:not(:disabled)')");
  await until("document.querySelector('.vl-image').naturalWidth===640");
  const edit = (name, value) => evaluate(`(() => {const e=document.querySelector('[name=${name}]');e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const saved = () => evaluate("motionRequests.filter(r=>r.method==='POST'&&/cameras.*analysis$/.test(r.path))");
  assert.equal((await saved()).length, 0);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-vl-disclosure]')].filter(d=>d.open).map(d=>d.dataset.vlDisclosure)"), []);
  assert.equal(await evaluate("document.querySelectorAll('form [name]').length"), 18, "Every analysis and ROI control remains available");
  for (const viewport of [
    {width: 375, height: 800, deviceScaleFactor: 1, mobile: true},
    {width: 320, height: 640, deviceScaleFactor: 1, mobile: true},
    {width: 768, height: 800, deviceScaleFactor: 1, mobile: true},
    {width: 1280, height: 850, deviceScaleFactor: 1, mobile: false},
    {width: 1024, height: 360, deviceScaleFactor: 1, mobile: false},
  ]) {
    await command("Emulation.setDeviceMetricsOverride", viewport, sessionId);
    await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    for (const theme of ["light", "dark"]) {
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      const fit = await evaluate(`(() => ({overflow:document.documentElement.scrollWidth>innerWidth+1,
        controls:[...document.querySelectorAll('.vision-lab button,.vision-lab select,.vision-lab input:not([type=checkbox]),.vision-lab summary')]
        .filter(e=>e.checkVisibility()&&!e.classList.contains('number-stepper-button')).map(e=>({name:e.name||e.textContent.trim(),width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))}))()`);
      assert.equal(fit.overflow, false, `${viewport.width}/${theme}: overflow`);
      for (const c of fit.controls) assert.ok(c.height>=43.9, `${viewport.width}/${theme}/${c.name}: touch height ${c.height}`);
      await evaluate("document.querySelector('[data-vl-disclosure=advanced]').open=true;document.querySelector('[data-vl-disclosure=roi]').open=true;document.querySelector('[data-vl-disclosure=capacity]').open=true;document.querySelector('[data-vl-disclosure=diagnostics]').open=true");
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      await until("[...document.querySelectorAll('.vision-lab input[type=number]')].every(input=>input.labels[0]?.nextElementSibling?.matches('[data-number-stepper]'))");
      const steppers = await evaluate(`([...document.querySelectorAll('.vision-lab input[type=number]')].map(input=>{
        const field=input.getBoundingClientRect(), control=input.labels[0].nextElementSibling.getBoundingClientRect();
        return {name:input.name,top:Math.abs(control.top-field.top),bottom:Math.abs(control.bottom-field.bottom),right:Math.abs(control.right-field.right)};
      }))`);
      for (const stepper of steppers)
        assert.ok(stepper.top<.6&&stepper.bottom<.6&&stepper.right<.6, `${viewport.width}/${theme}: seamless stepper ${JSON.stringify(stepper)}`);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
      assert.equal(await evaluate("document.querySelector('[data-metric=regions]').textContent"), "1");
      await evaluate("document.querySelectorAll('[data-vl-disclosure]').forEach(d=>d.open=false)");
    }
  }
  await command("Emulation.setDeviceMetricsOverride", {width:375,height:800,deviceScaleFactor:1,mobile:true}, sessionId);
  await command("Emulation.setTouchEmulationEnabled", {enabled:true,maxTouchPoints:1}, sessionId);
  await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  assert.ok((await evaluate("getComputedStyle(document.querySelector('.vl-stage')).touchAction")).includes("pan-y"));
  await evaluate("document.querySelector('.vl-stage').scrollIntoView({block:'center',behavior:'instant'})");
  const scrollStart = await evaluate("({y:scrollY,rect:document.querySelector('.vl-stage').getBoundingClientRect().toJSON()})");
  await command("Input.synthesizeScrollGesture", {x:scrollStart.rect.left+40,y:scrollStart.rect.top+40,yDistance:-100,gestureSourceType:"touch"}, sessionId);
  await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  if (await evaluate(`scrollY<=${scrollStart.y}+20`)) {
    const startY = scrollStart.rect.top + scrollStart.rect.height * .8;
    const x = scrollStart.rect.left + 40;
    await command("Input.dispatchTouchEvent", {type:"touchStart",touchPoints:[{x,y:startY}]}, sessionId);
    for (let step=1;step<=5;step++) {
      await command("Input.dispatchTouchEvent", {type:"touchMove",touchPoints:[{x,y:startY-step*16}]}, sessionId);
      await delay(30);
    }
    await command("Input.dispatchTouchEvent", {type:"touchEnd",touchPoints:[]}, sessionId);
    await delay(150);
  }
  const scrollEnd = await evaluate("({y:scrollY,height:document.documentElement.scrollHeight})");
  assert.ok(scrollEnd.y>scrollStart.y+20, `Touch scroll across an inactive preview: ${JSON.stringify({scrollStart,scrollEnd})}`);
  await click('.vl-draw-roi');
  assert.equal(await evaluate("document.querySelector('.vl-draw-roi').getAttribute('aria-pressed')"), "true");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.vl-stage')).touchAction"), "none");
  await evaluate("document.querySelector('.vl-stage').scrollIntoView({block:'center',behavior:'instant'})");
  const rect = await evaluate("document.querySelector('.vl-stage').getBoundingClientRect().toJSON()");
  await command("Input.dispatchTouchEvent", {type:"touchStart",touchPoints:[{x:rect.left+rect.width*.2,y:rect.top+rect.height*.2}]}, sessionId);
  await command("Input.dispatchTouchEvent", {type:"touchMove",touchPoints:[{x:rect.left+rect.width*.8,y:rect.top+rect.height*.8}]}, sessionId);
  await command("Input.dispatchTouchEvent", {type:"touchEnd",touchPoints:[]}, sessionId);
  const roi = await evaluate("['roi_x','roi_y','roi_w','roi_h'].map(n=>+document.querySelector('[name='+n+']').value)");
  for (let i=0;i<4;i++) assert.ok(Math.abs(roi[i]-[20,20,60,60][i])<1, `Touch ROI: ${roi}`);
  assert.equal(await evaluate("document.querySelector('.vl-stage').dataset.drawing"), "false");
  assert.equal((await saved()).length, 0, "Drawing only stages changes");
  await click('.vl-draw-roi');
  await command("Input.dispatchKeyEvent", {type:"rawKeyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27}, sessionId);
  assert.equal(await evaluate("document.querySelector('.vl-stage').dataset.drawing"), "false");
  assert.equal(await evaluate("document.activeElement.classList.contains('vl-draw-roi')"), true);
  await click('.vl-clear-roi');
  assert.equal(await evaluate("document.querySelector('.vl-roi-summary').textContent"), "Full frame");
  await evaluate("document.querySelector('[data-vl-disclosure=roi]').open=true");
  for (const [name,value] of Object.entries({roi_x:10,roi_y:15,roi_w:50,roi_h:40})) await edit(name,value);
  await evaluate("document.querySelector('[data-vl-disclosure=advanced]').open=true");
  await edit('inference_fps',6);
  await edit('history',450);
  for (const mode of ['mask','side-by-side','original']) {
    await evaluate(`document.querySelector('.vl-view-mode').value='${mode}';document.querySelector('.vl-view-mode').dispatchEvent(new Event('change',{bubbles:true}))`);
    await until(`document.querySelector('.vl-image-pair').dataset.mode==='${mode}'`);
    if(mode!=='original') await until("!!document.querySelector('.vl-mask-image').naturalWidth");
  }
  await evaluate("document.querySelector('form').requestSubmit()");
  await until("motionRequests.some(r=>r.method==='POST'&&/cameras.*analysis$/.test(r.path))");
  const body = (await saved()).at(-1).body.settings;
  assert.deepEqual(body.roi,[.1,.15,.5,.4]);
  assert.equal(body.history,450);
  assert.equal(body.inference_fps,6);
  await evaluate("document.querySelector('[data-vl-disclosure=capacity]').open=true");
  await click('.vl-assess');
  await evaluate("window.capacityFocus=document.querySelector('.vl-recommend');capacityFocus.focus()");
  await delay(1400);
  assert.equal(await evaluate("document.activeElement===capacityFocus&&capacityFocus.isConnected"), true, "Runtime polls preserve recommendation focus");
  await click('.vl-recommend');
  assert.equal(await evaluate("document.querySelector('[name=input_width]').value"), "320");
  assert.equal(await evaluate("document.querySelector('[name=inference_fps]').value"), "4");
  assert.equal((await saved()).length, 1, "Recommendations do not apply themselves");
  assert.equal(await evaluate("!!document.querySelector('.vl-disable,.vl-more-actions')"), false);
  await click('[name=enabled]');
  assert.equal(await evaluate("document.querySelector('[name=enabled]').checked"), true);
  await click('[name=enabled]');
  assert.equal(await evaluate("document.querySelector('[name=enabled]').checked"), false);
  await click('.vl-reset');
  assert.equal(await evaluate("document.querySelector('[name=threshold]').value"), "16");
  assert.equal(await evaluate("document.querySelector('[data-vl-disclosure=advanced]').open"), true, "Open sections survive reset rerender");
  assert.equal((await saved()).length,1);
  await evaluate("document.querySelector('#vl-camera').value='fixture-south';document.querySelector('#vl-camera').dispatchEvent(new Event('change',{bubbles:true}))");
  await until("document.querySelector('.vl-pipeline-value').textContent==='motion'");
  assert.equal(await evaluate("document.querySelector('.vl-stage').dataset.drawing"), "false");
  assert.deepEqual(await evaluate("motionErrors"), []);
  assert.equal(networkPaths.some(p=>p.startsWith('/api/')),false,"No real runtime or saved cameras were used");
  console.log('PASS: Motion & ROI responsive layouts, touch drawing, precise ROI, preview modes, isolated Apply, capacity recommendations, single analysis toggle, staged reset and camera switching.');
} finally {
  socket?.close();
  chrome.kill();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  await delay(200);
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
