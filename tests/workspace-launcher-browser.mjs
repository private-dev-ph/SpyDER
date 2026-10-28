// Mobile workspace launcher regression. Run: node tests/workspace-launcher-browser.mjs <showcase-dir>
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
const profile = await mkdtemp(path.join(os.tmpdir(), "spyder-workspace-launcher-"));
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


  await command('Emulation.setDeviceMetricsOverride',{width:375,height:800,deviceScaleFactor:1,mobile:true},sessionId);
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]},sessionId);
  await until("!!window.spyder && !!document.querySelector('#workspace-switcher')");
  await evaluate("location.hash='control-room'");
  await until("document.querySelector('[data-workspace-name]').textContent==='Control Room'");
  assert.equal(await evaluate("document.querySelector('#workspace-select').closest('label').hidden"),true,'Enhanced launcher replaces the mobile select');
  for(const theme of ['light','dark']){
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('#workspace-switch-trigger').click()`);
    await until("document.querySelector('#workspace-switcher').matches(':modal')");
    assert.equal(await evaluate("document.querySelector('#workspace-switch-trigger').getAttribute('aria-expanded')"),'true');
    assert.equal(await evaluate("document.querySelectorAll('#workspace-switcher [data-workspace-destination]').length"),7);
    assert.equal(await evaluate("document.activeElement.dataset.workspaceDestination"),'control-room','Current workspace receives initial focus');
    await delay(280);
    await until("[...document.querySelectorAll('#workspace-switcher svg use')].every(use=>use.getBBox().width>0 && use.getBBox().height>0)");
    assert.equal(await evaluate("[...document.querySelectorAll('#workspace-switcher svg use')].every(use=>use.getBBox().width>0 && use.getBBox().height>0)"),true,'Workspace and close icons render actual SVG geometry');
    const shot=await command('Page.captureScreenshot',{format:'png'},sessionId);
    await writeFile(path.join(assets,'workspace-launcher-'+theme+'.png'),Buffer.from(shot.data,'base64'));
    for(let i=0;i<9;i++){
      await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},sessionId);
      await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},sessionId);
      assert.equal(await evaluate("document.querySelector('#workspace-switcher').contains(document.activeElement)"),true,'Keyboard focus stays in the modal');
    }
    await evaluate("document.querySelector('#workspace-switcher button').focus()");
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',modifiers:8,windowsVirtualKeyCode:9},sessionId);
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9},sessionId);
    assert.equal(await evaluate("document.activeElement.dataset.workspaceDestination"),'system','Shift+Tab wraps to the final destination');
    await command('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},sessionId);
    await until("!document.querySelector('#workspace-switcher').open && document.querySelector('#workspace-switch-trigger').getAttribute('aria-expanded')==='false'");
    assert.equal(await evaluate("document.activeElement.id"),'workspace-switch-trigger','Escape restores the opener');
    await delay(260);
  }
  await command('Emulation.setTouchEmulationEnabled',{enabled:true},sessionId);
  async function openSheet() {
    await evaluate("document.querySelector('#workspace-switch-trigger').click()");
    await delay(280);
    return evaluate(`(()=>{const d=document.querySelector('#workspace-switcher'),h=d.querySelector('header').getBoundingClientRect();return {x:h.left+h.width/2,y:h.top+12,top:d.getBoundingClientRect().top}})()`);
  }
  async function startDrag(point, distance) {
    await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]},sessionId);
    await command('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x,y:point.y+distance}]},sessionId);
    await delay(35);
  }
  let dragPoint=await openSheet();
  const originalSheetTop=dragPoint.top;
  await startDrag(dragPoint,28);
  const offset=await evaluate("document.querySelector('#workspace-switcher').getBoundingClientRect().top");
  assert.ok(Math.abs(offset-dragPoint.top-28)<2,'Sheet follows the finger directly');
  await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},sessionId);
  await delay(280);
  assert.equal(await evaluate("document.querySelector('#workspace-switcher').open && !document.querySelector('#workspace-switcher').classList.contains('workspace-sheet-dragging')"),true,'Short pull rebounds without dismissal');
  assert.ok(Math.abs(await evaluate("document.querySelector('#workspace-switcher').getBoundingClientRect().top")-dragPoint.top)<1,'Rebound restores the original sheet position');
  await startDrag(dragPoint,40);
  await command('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]},sessionId);
  await delay(280);
  assert.equal(await evaluate("document.querySelector('#workspace-switcher').open && !document.querySelector('#workspace-switcher').classList.contains('workspace-sheet-dragging')"),true,'Cancelled pointer gesture settles safely');
  await startDrag(dragPoint,160);
  await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},sessionId);
  await until("!document.querySelector('#workspace-switcher').open && document.querySelector('#workspace-switch-trigger').getAttribute('aria-expanded')==='false'");
  assert.equal(await evaluate("document.activeElement.id"),'workspace-switch-trigger','Drag dismissal restores focus to the launcher');
  assert.equal(await evaluate("location.hash"),'#control-room','Dragging does not navigate');
  await delay(280);
  dragPoint=await openSheet();
  assert.ok(Math.abs(dragPoint.top-originalSheetTop)<1,'Reopening clears dismissal translation');
  await startDrag(dragPoint,64);
  await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},sessionId);
  await until("!document.querySelector('#workspace-switcher').open");
  await delay(280);
  await command('Emulation.setDeviceMetricsOverride',{width:667,height:320,deviceScaleFactor:1,mobile:true},sessionId);
  await openSheet();
  const scrollStart=await evaluate(`(()=>{const n=document.querySelector('.workspace-switcher-grid'),r=n.getBoundingClientRect();n.scrollTop=0;return {x:r.left+r.width/2,y:r.bottom-16}})()`);
  await command('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[scrollStart]},sessionId);
  await command('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:scrollStart.x,y:scrollStart.y-70}]},sessionId);
  await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},sessionId);
  await delay(150);
  assert.equal(await evaluate("document.querySelector('.workspace-switcher-grid').scrollTop>0 && document.querySelector('#workspace-switcher').open && !document.querySelector('#workspace-switcher').classList.contains('workspace-sheet-dragging')"),true,'Workspace list still scrolls without starting dismissal');
  await evaluate("document.querySelector('#workspace-switcher').close()");
  await delay(280);
  await command('Emulation.setTouchEmulationEnabled',{enabled:false},sessionId);
  dragPoint=await openSheet();
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragPoint.x,y:dragPoint.y},sessionId);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',x:dragPoint.x,y:dragPoint.y,button:'left',clickCount:1},sessionId);
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragPoint.x,y:dragPoint.y+160,buttons:1},sessionId);
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:dragPoint.x,y:dragPoint.y+160,button:'left',clickCount:1},sessionId);
  await until("!document.querySelector('#workspace-switcher').open");
  await delay(280);
  for(const [width,height] of [[320,568],[390,700],[667,320],[768,1024]]){
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true},sessionId);
    await evaluate("document.querySelector('#workspace-switch-trigger').click()");
    await delay(280);
    const fit=await evaluate(`(()=>{
      const d=document.querySelector('#workspace-switcher'), r=d.getBoundingClientRect();
      const controls=[...d.querySelectorAll('a,button')];
      return {fits:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,targets:controls.every(c=>{const b=c.getBoundingClientRect();return b.width>=44&&b.height>=44}),overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    assert.deepEqual(fit,{fits:true,targets:true,overflow:false},width+'x'+height+' sheet fits and has touch-sized controls');
    assert.equal(await evaluate(`(()=>{const a=document.querySelector('[data-workspace-destination=system]');a.scrollIntoView({block:'nearest'});const r=a.getBoundingClientRect(),d=document.querySelector('#workspace-switcher').getBoundingClientRect();return r.top>=d.top&&r.bottom<=d.bottom})()`),true,'Final workspace can be scrolled into view');
    await evaluate("document.querySelector('#workspace-switcher').close()");
    await delay(260);
  }
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:1,mobile:true},sessionId);
  await evaluate("document.querySelector('#workspace-switch-trigger').click()");
  await delay(280);
  await command('Input.dispatchMouseEvent',{type:'mousePressed',x:2,y:2,button:'left',clickCount:1},sessionId);
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:2,y:2,button:'left',clickCount:1},sessionId);
  await until("!document.querySelector('#workspace-switcher').open");
  await delay(260);
  for(const key of ['vision-lab','camera-setup','recordings','events','layouts','system','control-room']){
    await evaluate(`document.querySelector('#workspace-switch-trigger').click();document.querySelector('[data-workspace-destination=${key}]').click()`);
    await until(`location.hash==='#${key}' && !document.querySelector('#workspace-switcher').open && document.querySelector('#workspace-select').value==='${key}'`);
    assert.equal(await evaluate("document.querySelector('#workspace-switcher [aria-current=page]').dataset.workspaceDestination"),key,'Current marker follows route');
    await delay(260);
  }
  await evaluate("document.querySelector('#workspace-switch-trigger').click()");
  await command('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false},sessionId);
  await until("!document.querySelector('#workspace-switcher').open");
  assert.equal(await evaluate("document.querySelector('#workspace-nav').checkVisibility() && !document.querySelector('#workspace-switch-trigger').checkVisibility()"),true,'Desktop keeps its sidebar and closes the mobile modal');
  await command('Emulation.setDeviceMetricsOverride',{width:375,height:800,deviceScaleFactor:1,mobile:true},sessionId);
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#workspace-switcher')).transitionDuration"),'0s','Reduced motion disables sheet animation');
  await command('Emulation.setTouchEmulationEnabled',{enabled:true},sessionId);
  dragPoint=await openSheet();
  await startDrag(dragPoint,24);
  await command('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]},sessionId);
  assert.equal(await evaluate("document.querySelector('#workspace-switcher').open && getComputedStyle(document.querySelector('#workspace-switcher')).transform==='none'"),true,'Reduced motion rebounds immediately while preserving drag control');
  await evaluate("document.querySelector('#workspace-switcher').close()");
  assert.equal(networkPaths.some(url=>url.startsWith('/api/')),false,'Static workspace navigation makes no native API calls');
  console.log('PASS: workspace launcher, touch/mouse drag dismissal, rebound, cancellation, flick, independent scrolling, focus, all routes, themes, reduced motion and showcase isolation');
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
