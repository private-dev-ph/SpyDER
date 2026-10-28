// Touch camera controls regression. Run: node tests/touch-camera-controls-browser.mjs <showcase-dir>
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
const profile = await mkdtemp(path.join(os.tmpdir(), "spyder-touch-camera-controls-"));
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


  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);
  await command('Emulation.setTouchEmulationEnabled',{enabled:true},sessionId);
  await until("!!window.spyderWall && document.querySelectorAll('.camera-controls-toggle').length===2");
  await evaluate("location.hash='control-room'");
  await until("!document.querySelector('#control-room').hidden");
  await delay(260);
  async function tap(selector) {
    const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+Math.min(10,r.height/2)}})()`);
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]},sessionId);
    await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},sessionId);
    await delay(180);
  }
  const first='.camera-card:nth-child(1)', second='.camera-card:nth-child(2)';
  assert.equal(await evaluate("matchMedia('(hover: none), (pointer: coarse)').matches"),true);
  assert.equal(await evaluate("[...document.querySelectorAll('.camera-footer')].every(f=>getComputedStyle(f).visibility==='hidden' && !f.checkVisibility({visibilityProperty:true}))"),true,'Touch controls start hidden and unfocusable');
  await tap(first+' .camera-controls-toggle');
  assert.equal(await evaluate("document.querySelector('.camera-card').classList.contains('is-controls-visible') && document.querySelector('.camera-controls-toggle').getAttribute('aria-expanded')==='true' && getComputedStyle(document.querySelector('.camera-footer')).visibility==='visible'"),true,'Tapping a feed reveals controls and updates expanded state');
  await tap(first+' .camera-controls-toggle');
  assert.equal(await evaluate("document.querySelectorAll('.is-controls-visible').length"),0,'Tapping the feed again hides controls');
  await tap(first+' .camera-controls-toggle');
  await tap(second+' .camera-controls-toggle');
  assert.equal(await evaluate("document.querySelectorAll('.is-controls-visible').length===1 && document.querySelectorAll('.camera-card')[1].classList.contains('is-controls-visible')"),true,'Tapping another feed moves the controls to that feed');
  await tap('#control-room h1');
  assert.equal(await evaluate("document.querySelectorAll('.is-controls-visible').length"),0,'Tapping elsewhere hides controls');
  await evaluate("document.querySelector('.camera-controls-toggle').focus()");
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'},sessionId);
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13},sessionId);
  assert.equal(await evaluate("document.querySelector('.camera-controls-toggle').getAttribute('aria-expanded')"),'true','Keyboard activates the native reveal button');
  await evaluate("document.querySelector('.settings-camera').click()");
  await until("document.querySelector('#settings-dialog').open");
  await evaluate("document.querySelector('#settings-dialog').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch'}))");
  assert.equal(await evaluate("document.querySelector('.camera-card').classList.contains('is-controls-visible')"),true,'Settings dialog interaction preserves its visible return control');
  await evaluate("document.querySelector('#settings-dialog').close()");
  await evaluate("document.querySelector('#wall-reorder').click()");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.tile-priority-tools')).visibility"),'visible','Reorder handles remain available in arrange mode');
  await evaluate("[...document.querySelectorAll('.wall-reorder-banner button')].find(b=>b.textContent==='Cancel').click()");
  await evaluate("location.hash='layouts'");
  await until("!!document.querySelector('#layout-preview')");
  assert.equal(await evaluate("document.querySelectorAll('.is-controls-visible').length"),0,'Leaving the workspace clears revealed controls');
  await evaluate("location.hash='control-room'");
  await until("!document.querySelector('#control-room').hidden");
  await command('Emulation.setTouchEmulationEnabled',{enabled:false},sessionId);
  await command('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false},sessionId);
  await delay(180);
  const hover=await evaluate("(()=>{const c=document.querySelector('.camera-card');c.scrollIntoView({block:'center'});const r=c.querySelector('.video-stage').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+15}})()");
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',...hover},sessionId);
  await delay(180);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.camera-footer')).opacity"),'1','Desktop hover still reveals the footer');
  assert.equal(await evaluate("document.querySelector('.camera-controls-toggle').checkVisibility()"),false,'Desktop does not add a tap overlay');
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2},sessionId);
  await evaluate("document.activeElement.blur()");
  await delay(180);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.camera-footer')).opacity"),'0','Desktop pointer leave hides the footer');
  assert.equal(networkPaths.some(url=>url.startsWith('/api/')),false);
  console.log('PASS: touch reveal/hide, one feed at a time, outside dismissal, keyboard, settings focus, reorder handles, route reset, and desktop hover');
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
