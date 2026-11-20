// Navigation responsiveness regression. Run: node scripts/tests/navigation-motion-browser.mjs <showcase-dir>
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
  async function assertThemeContrast(selector) {
    const colors=await evaluate(`(() => {
      const root=document.documentElement, previous=root.dataset.theme, nav=document.querySelector(${JSON.stringify(selector)});
      const results=['light','dark'].map(theme=>{
        root.dataset.theme=theme;
        return {theme,outside:getComputedStyle(nav.querySelector('[role=tab]')).color,
          surface:getComputedStyle(nav).backgroundColor,inside:getComputedStyle(nav.querySelector('.nav-contrast-layer > span')).color,
          indicator:getComputedStyle(nav,'::before').backgroundColor};
      });
      if(previous===undefined)delete root.dataset.theme;else root.dataset.theme=previous;
      return results;
    })()`);
    const luminance=color=>color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
    const ratio=(a,b)=>{const l=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (l[0]+.05)/(l[1]+.05)};
    for(const color of colors){
      assert.ok(ratio(color.outside,color.surface)>=4.5,selector+' '+color.theme+' outside text is readable');
      assert.ok(ratio(color.inside,color.indicator)>=4.5,selector+' '+color.theme+' covered text is readable');
      assert.ok(luminance(color.inside)-luminance(color.outside)>.3,selector+' '+color.theme+' crossing the indicator visibly brightens the text');
    }
  }
  await assertThemeContrast('.vision-nav');
  const contrast=await evaluate(`(async()=>{
    const nav=document.querySelector('.vision-nav'), layer=nav.querySelector('.nav-contrast-layer');
    if(!layer)return {exists:false};
    const middle=layer.children[1], bounds=middle.getBoundingClientRect(), origin=layer.getBoundingClientRect();
    const center=bounds.left-origin.left+bounds.width/2;
    document.querySelector('#vision-gallery-tab').click();
    let coveredIntermediate=false, synced=true, samples=0;
    const end=performance.now()+430;
    while(performance.now()<end){
      await new Promise(requestAnimationFrame);
      const matrix=new DOMMatrix(getComputedStyle(nav,'::before').transform);
      const clip=getComputedStyle(layer).clipPath;
      const left=clip.match(/ ([\\d.-]+)px round/), top=clip.match(/^inset\\(([\\d.-]+)px/);
      synced &&= !!left && !!top && Math.abs(Number(left[1])-matrix.m41)<.75 && Math.abs(Number(top[1])-matrix.m42)<.75;
      const width=parseFloat(nav.style.getPropertyValue('--nav-width'));
      if(matrix.m41<center && matrix.m41+width>center && document.querySelector('#vision-workflow-tab').getAttribute('aria-selected')==='false')coveredIntermediate=true;
      samples++;
    }
    return {exists:true,hidden:layer.getAttribute('aria-hidden'),white:getComputedStyle(middle).color,pointerEvents:getComputedStyle(layer).pointerEvents,coveredIntermediate,synced,samples,buttons:layer.querySelectorAll('button').length};
  })()`);
  assert.equal(contrast.exists,true,'Navigator has a clipped contrast layer');
  assert.equal(contrast.hidden,'true','Decorative copies are hidden from assistive technology');
  assert.equal(contrast.white,'rgb(255, 255, 255)','Covered text is white');
  assert.equal(contrast.pointerEvents,'none','Contrast layer does not intercept tab input');
  assert.equal(contrast.buttons,0,'Copies do not create duplicate controls');
  assert.equal(contrast.coveredIntermediate,true,'Passing over an intermediate tab reveals white text without selecting it');
  assert.equal(contrast.synced,true,'Text clipping tracks the red indicator on every sampled frame');
  await evaluate("document.querySelector('#vision-motion-tab').click()");
  await until("!!document.querySelector('.vision-lab') && !document.querySelector('#vision-mode-content').hasAttribute('aria-busy')");
  await delay(400);
  const hoverPoint=await evaluate("(()=>{const r=document.querySelector('#vision-workflow-tab').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
  await command('Input.dispatchMouseEvent',{type:'mouseMoved',...hoverPoint},sessionId);
  await delay(180);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#vision-workflow-tab')).backgroundColor"),'rgba(0, 0, 0, 0)','Hover must not paint a second destination highlight over the sliding indicator');
  await command('Input.dispatchMouseEvent',{type:'mousePressed',...hoverPoint,button:'left',clickCount:1},sessionId);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#vision-workflow-tab')).transform"),'none','Pressing a tab must not shift it away from the indicator');
  await command('Input.dispatchMouseEvent',{type:'mouseReleased',...hoverPoint,button:'left',clickCount:1},sessionId);
  const highlightSamples=await evaluate(`(async()=>{
    const samples=[];const end=performance.now()+200;
    while(performance.now()<end){await new Promise(requestAnimationFrame);samples.push(getComputedStyle(document.querySelector('#vision-workflow-tab')).backgroundColor)}
    return samples;
  })()`);
  assert.ok(highlightSamples.every(color=>color==='rgba(0, 0, 0, 0)'),'Destination button remains transparent throughout the glide');
  await until("!!document.querySelector('.workflow-editor') && !document.querySelector('#vision-mode-content').hasAttribute('aria-busy')");
  await evaluate("document.querySelector('#vision-motion-tab').click()");
  await until("!!document.querySelector('.vision-lab') && !document.querySelector('#vision-mode-content').hasAttribute('aria-busy')");
  await delay(400);
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
  await assertThemeContrast('.system-nav');
  for(const width of [1280,390]){
    await command('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false},sessionId);
    await delay(400);
    const geometry=await evaluate(`(()=>{
      const nav=document.querySelector('.system-nav'), copies=[...nav.querySelector('.nav-contrast-layer').children];
      return [...nav.querySelectorAll(':scope > [role=tab]')].every((tab,i)=>{
        const a=tab.getBoundingClientRect(),b=copies[i].getBoundingClientRect();
        return Math.abs(a.left-b.left)<1 && Math.abs(a.top-b.top)<1 && Math.abs(a.width-b.width)<1 && Math.abs(a.height-b.height)<1 && getComputedStyle(tab).font===getComputedStyle(copies[i]).font;
      });
    })()`);
    assert.equal(geometry,true,'Contrast labels align exactly at '+width+'px, including wrapped System rows');
  }
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.system-nav button')).webkitTapHighlightColor"),'rgba(0, 0, 0, 0)','Native tap highlight does not flash over the shared indicator');
  await evaluate("document.querySelector('[data-system-tab=overview]').focus()");
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'},sessionId);
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight'},sessionId);
  assert.equal(await evaluate("document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle!=='none'"),true,'Keyboard navigation retains its visible focus outline');
  await delay(150);
  assert.equal(await evaluate('mountCalls'),rapid,'Leaving Vision Lab cancels pending section work');
  await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.system-nav'),'::before').transitionDuration"),'0s','Reduced motion disables the indicator glide');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.nav-contrast-layer')).transitionDuration"),'0s','Reduced motion keeps text clipping instant too');
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
