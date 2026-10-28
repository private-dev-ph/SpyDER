// Theme transition regression. Run: node tests/theme-transition-browser.mjs <showcase-dir>
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
const profile = await mkdtemp(path.join(os.tmpdir(), "spyder-theme-transition-"));
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


  await command('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false},sessionId);
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]},sessionId);
  await until("!!window.spyder && spyder.cameras().length===2");
  await evaluate("window.themeErrors=[];window.addEventListener('error',e=>themeErrors.push(e.message));window.addEventListener('unhandledrejection',e=>themeErrors.push(String(e.reason)));location.hash='control-room'");
  await delay(350);
  assert.equal(await evaluate("document.documentElement.dataset.theme"),'light');
  assert.equal(await evaluate("document.documentElement.classList.contains('theme-transition')"),false,'Startup does not animate the saved theme');
  const cameras=await evaluate("spyder.cameras().map(c=>({id:c.id,state:c.state}))");
  const geometry=await evaluate("document.querySelector('.topbar').getBoundingClientRect().toJSON()");
  assert.equal(await evaluate("typeof document.startViewTransition"),'function','Native theme crossfade is available');
  await evaluate("document.querySelector('#theme').focus();document.querySelector('#theme').click()");
  await until("document.documentElement.dataset.theme==='dark' && document.getAnimations().some(a=>a.animationName==='theme-reveal')");
  assert.equal(await evaluate("document.documentElement.classList.contains('theme-transition')"),true,'Theme switch uses one coordinated page crossfade');
  await until("!document.documentElement.classList.contains('theme-transition')");
  assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"),'rgb(20, 19, 19)');
  assert.equal(await evaluate("localStorage.getItem('spyder-theme')"),'dark');
  assert.equal(await evaluate("document.querySelector('#theme').getAttribute('aria-label')"),'Switch to light mode');
  assert.equal(await evaluate("document.querySelector('meta[name=theme-color]').content"),'#141313');
  assert.deepEqual(await evaluate("document.querySelector('.topbar').getBoundingClientRect().toJSON()"),geometry,'Theme animation does not shift the header');
  assert.deepEqual(await evaluate("spyder.cameras().map(c=>({id:c.id,state:c.state}))"),cameras,'Camera ownership and running state stay intact');
  assert.equal(await evaluate("document.activeElement.id"),'theme','Theme button keeps keyboard focus');
  await evaluate("document.querySelector('#theme').click()");
  await until("document.documentElement.dataset.theme==='light' && !document.documentElement.classList.contains('theme-transition')");
  assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"),'rgb(247, 245, 239)');
  await evaluate("document.querySelector('#theme').click();document.querySelector('#theme').click();document.querySelector('#theme').click()");
  await until("document.documentElement.dataset.theme==='dark' && !document.documentElement.classList.contains('theme-transition')");
  assert.equal(await evaluate("localStorage.getItem('spyder-theme')"),'dark','Rapid toggles keep the latest requested theme');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);
  assert.equal(await evaluate("document.querySelector('#theme').click();document.documentElement.dataset.theme==='light' && !document.documentElement.classList.contains('theme-transition')"),true,'Reduced motion switches immediately');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]},sessionId);
  await evaluate("window.nativeThemeTransition=document.startViewTransition;document.startViewTransition=undefined;document.querySelector('#theme').click()");
  await delay(90);
  const intermediate=await evaluate("getComputedStyle(document.body).backgroundColor");
  assert.notEqual(intermediate,'rgb(247, 245, 239)','Fallback starts blending palette colors');
  assert.notEqual(intermediate,'rgb(20, 19, 19)','Fallback has intermediate colors instead of snapping');
  await until("!document.documentElement.classList.contains('theme-color-transition')");
  assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"),'rgb(20, 19, 19)','Fallback reaches the exact target palette');
  await evaluate("document.querySelector('#theme').click()");
  await delay(70);
  await evaluate("document.querySelector('#theme').click()");
  await until("!document.documentElement.classList.contains('theme-color-transition')");
  assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"),'rgb(20, 19, 19)','Fallback retargets cleanly during rapid toggles');
  await evaluate("document.startViewTransition=nativeThemeTransition;document.querySelector('#theme').click()");
  await until("document.documentElement.classList.contains('theme-transition')");
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);
  await until("!document.documentElement.classList.contains('theme-transition')");
  assert.equal(await evaluate("document.documentElement.dataset.theme"),'light','Enabling reduced motion settles an active transition');
  assert.deepEqual(await evaluate('themeErrors'),[],'Rapid toggles and skipped snapshots produce no browser errors');
  await command('Page.reload',{},sessionId);
  await until("!!window.spyder && document.querySelector('#theme').getAttribute('aria-label')==='Switch to dark mode'");
  assert.equal(await evaluate("document.documentElement.dataset.theme==='light' && !document.documentElement.classList.contains('theme-transition') && !document.documentElement.classList.contains('theme-color-transition')"),true,'Saved preference restores without a startup animation');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]},sessionId);
  await evaluate("location.hash='vision-lab'");
  await until("!!document.querySelector('#vision-workflow-tab')");
  await evaluate("document.querySelector('#vision-workflow-tab').click()");
  await until("!!document.querySelector('.we-canvas') && !document.querySelector('#vision-mode-content').hasAttribute('aria-busy')");
  const draft=await evaluate("window.themeCanvas=document.querySelector('.we-canvas');localStorage.getItem('spyder.workflow-editor.draft')");
  await evaluate("document.querySelector('#theme').click()");
  await until("document.documentElement.dataset.theme==='dark' && !document.documentElement.classList.contains('theme-transition')");
  assert.equal(await evaluate("document.querySelector('.we-canvas')===themeCanvas"),true,'Theme animation preserves the mounted workflow canvas');
  assert.equal(await evaluate("localStorage.getItem('spyder.workflow-editor.draft')"),draft,'Theme animation preserves workflow drafts');
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:1,mobile:true},sessionId);
  await evaluate("document.querySelector('#theme').click()");
  await until("document.documentElement.dataset.theme==='light' && !document.documentElement.classList.contains('theme-transition')");
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"),true,'Mobile theme transition does not create page overflow');
  assert.equal(networkPaths.some(url=>url.startsWith('/api/')),false,'Theme transitions remain browser-only');
  console.log('PASS: theme crossfade, palette fallback, both directions, rapid toggles, layout stability, camera ownership, reduced motion, saved preference, and showcase isolation');
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
