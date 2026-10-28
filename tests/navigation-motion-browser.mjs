// Navigation responsiveness regression. Run: node tests/navigation-motion-browser.mjs <showcase-dir>
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
const profile = await mkdtemp(path.join(os.tmpdir(), "spyder-navigation-motion-"));
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
  const traceEvents = [];
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Tracing.dataCollected") traceEvents.push(...message.params.value);
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
  await until("!!window.spyderWorkflows && document.querySelector('#vision-mode-content')?.childElementCount>0");
  await delay(300);
  // Trace the actual section switch before applying a deterministic expensive-mount fixture.
  await command('Tracing.start',{categories:'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.frame',transferMode:'ReportEvents'},sessionId);
  const measurement=await evaluate(`(async()=>{
    const gaps=[];let previous=performance.now(),running=true;
    const sample=time=>{gaps.push(time-previous);previous=time;if(running)requestAnimationFrame(sample)};
    requestAnimationFrame(sample);
    const start=performance.now();document.querySelector('#vision-workflow-tab').click();
    const handlerMs=performance.now()-start;
    await new Promise(r=>setTimeout(r,500));running=false;
    return {handlerMs,maxFrameGap:Math.max(...gaps),frames:gaps.length};
  })()`);
  await command('Tracing.end',{},sessionId);
  await delay(100);
  await writeFile(path.join(assets,'navigation-motion-trace.json'), JSON.stringify({traceEvents}));
  console.log('Actual workflow navigation:',JSON.stringify(measurement));
  await evaluate("document.querySelector('#vision-motion-tab').click()");
  await until("!!document.querySelector('.vision-lab')");
  await delay(300);
  const result=await evaluate(`(()=>{
    window.mountCalls=0;
    const original=spyderWorkflows.mount;
    spyderWorkflows.mount=(...args)=>{mountCalls++;const stop=performance.now()+80;while(performance.now()<stop){}return original.apply(spyderWorkflows,args)};
    document.querySelector('#vision-workflow-tab').click();
    const nav=document.querySelector('.vision-nav');
    return {mountsDuringClick:mountCalls,selected:document.querySelector('#vision-workflow-tab').getAttribute('aria-selected'),target:nav.style.getPropertyValue('--nav-x')};
  })()`);
  console.log('Expensive mount fixture:',JSON.stringify(result));
  assert.equal(result.mountsDuringClick,0,'Navigation must paint its selected state before expensive section mounting');
  assert.equal(result.selected,'true');
  assert.ok(parseFloat(result.target)>6,'Indicator immediately targets the selected tab');
  await until("mountCalls===1 && !!document.querySelector('.workflow-editor')");
  await delay(400);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.vision-nav'),'::before').willChange.includes('transform')"),true,'Indicator has a compositor hint');
  const rapid=await evaluate(`(()=>{
    const start=mountCalls;
    document.querySelector('#vision-gallery-tab').click();
    document.querySelector('#vision-workflow-tab').click();
    document.querySelector('#vision-motion-tab').click();
    return start;
  })()`);
  await until("document.querySelector('#vision-mode-content').getAttribute('aria-labelledby')==='vision-motion-tab' && !document.querySelector('#vision-mode-content').hasAttribute('aria-busy')");
  assert.equal(await evaluate('mountCalls'),rapid,'Rapid retargeting cancels obsolete expensive mounts');
  await evaluate("document.querySelector('#vision-workflow-tab').click();location.hash='system'");
  await until("!!document.querySelector('.system-nav')");
  await delay(150);
  assert.equal(await evaluate('mountCalls'),rapid,'Leaving Vision Lab cancels pending section work');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.system-nav'),'::before').transitionDuration"),'0s','Reduced motion disables the indicator glide');
  console.log('PASS: navigation responds before expensive work and completes the latest section switch');
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
